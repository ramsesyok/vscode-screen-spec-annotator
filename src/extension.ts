import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import * as vscode from "vscode";
import { applyAnnotationEdit, isAnnotationIds, isEdit, isMarkerAnchor, markerAnchors, newAnnotation, parseAnnotation, pasteAnnotations } from "./annotation";
import type { AnnotationItem, MarkerAnchor } from "./annotation";
import { materialIcon } from "./material-icons";
import type { MaterialIconName } from "./material-icons";
import { readOriginalImage, relativeImagePath, resolveImagePath, supportsImage } from "./original-image";
import type { DocumentState, HostMessage } from "./protocol";

const viewType = "screenSpecAnnotator.annotations";
const annotationSuffix = ".annotations.json";
const styleSetting = "defaultStyle";

function iconButton(icon: MaterialIconName, label: string, attributes: string, type = "button", title = label): string {
  return `<button type="${type}" class="icon-button" ${attributes} aria-label="${label}" title="${title}">${materialIcon(icon)}</button>`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAlreadyPresent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function serialize(data: ReturnType<typeof newAnnotation>): string {
  return JSON.stringify(data, null, 2) + "\n";
}

function readDocument(document: vscode.TextDocument): DocumentState {
  try {
    return { version: document.version, data: parseAnnotation(document.getText()) };
  } catch (error) {
    return { version: document.version, error: `${basename(document.uri.fsPath)}: ${messageOf(error)}` };
  }
}

async function createAnnotation(uri?: vscode.Uri): Promise<void> {
  if (!uri) {
    const selection = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "PNG・JPEG": ["png", "jpg", "jpeg"] },
      openLabel: "原画像を選択",
    });
    uri = selection?.[0];
  }
  if (!uri) return;
  if (uri.scheme !== "file" || !supportsImage(uri.fsPath)) {
    throw new Error("ローカルのPNGまたはJPEGを選択してください。");
  }

  const original = await readOriginalImage(uri.fsPath);
  const initialName = basename(uri.fsPath, extname(uri.fsPath)) + annotationSuffix;
  let destination = vscode.Uri.file(join(dirname(uri.fsPath), initialName));
  for (;;) {
    const selection = await vscode.window.showSaveDialog({
      defaultUri: destination,
      filters: { "画面注釈 JSON": ["json"] },
      saveLabel: "注釈ファイルを作成",
    });
    if (!selection) return;
    if (selection.scheme !== "file") throw new Error("ローカルの仕様フォルダーを指定してください。");
    const filename = basename(selection.fsPath);
    const stem = filename.replace(/(?:\.annotations)?\.json$/i, "");
    if (!stem || stem === "." || stem === "..") throw new Error("注釈ファイル名を入力してください。");
    destination = vscode.Uri.file(join(dirname(selection.fsPath), stem + annotationSuffix));

    const relative = relativeImagePath(destination.fsPath, uri.fsPath);
    try {
      const defaults = vscode.workspace.getConfiguration("screenSpecAnnotator").get(styleSetting);
      await writeFile(destination.fsPath, serialize(newAnnotation(relative, original.identity, defaults)), { flag: "wx" });
      break;
    } catch (error) {
      if (!isAlreadyPresent(error)) throw error;
      const choice = await vscode.window.showWarningMessage(
        `${basename(destination.fsPath)} は既に存在します。`,
        "既存のファイルを開く",
        "別名で作成",
      );
      if (choice === "既存のファイルを開く") break;
      if (choice !== "別名で作成") return;
    }
  }
  await vscode.commands.executeCommand("vscode.openWith", destination, viewType);
}

class AnnotationEditor implements vscode.CustomTextEditorProvider {
  private readonly operations = new WeakMap<vscode.TextDocument, Promise<void>>();
  private readonly panels = new Map<string, (message: HostMessage) => void>();
  private copiedItems: AnnotationItem[] = [];
  private clipboardOperations: Promise<void> = Promise.resolve();

  constructor(private readonly extensionUri: vscode.Uri) {}

  moveMarker(anchor: MarkerAnchor, args: unknown): void {
    if (typeof args !== "object" || args === null ||
        !("annotationPanel" in args) || typeof args.annotationPanel !== "string" ||
        !("annotationMarker" in args) || typeof args.annotationMarker !== "string") return;
    this.panels.get(args.annotationPanel)?.({ type: "markerPreset", id: args.annotationMarker, anchor });
  }

  clipboardCommand(type: "copyRects" | "pasteRects", args: unknown): void {
    if (typeof args !== "object" || args === null ||
        !("annotationPanel" in args) || typeof args.annotationPanel !== "string") return;
    const post = this.panels.get(args.annotationPanel);
    if (type === "pasteRects") post?.({ type });
    else if ("annotationRegion" in args && typeof args.annotationRegion === "string") {
      post?.({ type, id: args.annotationRegion });
    }
  }

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const assetFolders = ["dist", "media"].map(folder => vscode.Uri.joinPath(this.extensionUri, folder));
    panel.webview.options = { enableScripts: true, localResourceRoots: assetFolders };

    let ready = false;
    let active = true;
    let loadedPath: string | undefined;
    let readGeneration = 0;

    const post = (message: HostMessage) => {
      if (active) void panel.webview.postMessage(message);
    };
    const panelToken = randomBytes(16).toString("hex");
    this.panels.set(panelToken, post);

    const publish = () => {
      if (!ready) return;
      const state = readDocument(document);
      post({ type: "state", state });
      const imagePath = state.data?.imagePath;
      if (!imagePath) {
        loadedPath = undefined;
        ++readGeneration;
        return;
      }
      if (imagePath === loadedPath) return;
      loadedPath = imagePath;
      const generation = ++readGeneration;
      void (async () => {
        try {
          if (document.uri.scheme !== "file") throw new Error("ローカルの注釈ファイルを開いてください。");
          const path = resolveImagePath(document.uri.fsPath, imagePath);
          const image = await readOriginalImage(path);
          if (generation === readGeneration) post({ type: "image", imagePath, image });
        } catch (error) {
          if (generation === readGeneration) post({
            type: "image", imagePath, error: `${imagePath}: ${messageOf(error)}`,
          });
        }
      })();
    };

    const changes = vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document === document && event.contentChanges.length) publish();
    });
    const messages = panel.webview.onDidReceiveMessage((message: unknown) => {
      if (typeof message !== "object" || message === null || !("type" in message)) return;
      if (message.type === "ready") {
        ready = true;
        loadedPath = undefined;
        publish();
        return;
      }
      if (message.type === "openJson") {
        void vscode.commands.executeCommand("vscode.openWith", document.uri, "default");
        return;
      }
      if ((message.type !== "edit" && message.type !== "save" && message.type !== "saveDefaultStyle" &&
           message.type !== "copyRects" && message.type !== "pasteRects") ||
          !("request" in message) || typeof message.request !== "number" ||
          !Number.isSafeInteger(message.request) ||
          !("version" in message) || typeof message.version !== "number" ||
          !Number.isSafeInteger(message.version)) return;

      const { request, version } = message;
      const edit = "edit" in message ? message.edit : undefined;
      const previous = this.operations.get(document) ?? Promise.resolve();
      const clipboardAction = message.type === "copyRects" || message.type === "pasteRects";
      const pending = Promise.all([previous, clipboardAction ? this.clipboardOperations : undefined]).then(async () => {
        try {
          if (message.type === "save") {
            if (!await document.save()) throw new Error("注釈ファイルを保存できませんでした。");
            post({ type: "result", request, state: readDocument(document) });
            return;
          }

          const state = readDocument(document);
          if (!state.data) throw new Error(state.error);
          if (state.version !== version) throw new Error("注釈が更新されました。最新の内容を確認してください。");
          if (message.type === "saveDefaultStyle") {
            await vscode.workspace.getConfiguration("screenSpecAnnotator")
              .update(styleSetting, state.data.style, vscode.ConfigurationTarget.Global);
            post({ type: "result", request, state: readDocument(document) });
            return;
          }
          if (message.type === "copyRects") {
            if (!("ids" in message) || !isAnnotationIds(message.ids)) throw new Error("コピーする矩形を選択してください。");
            const ids = new Set(message.ids);
            const items = state.data.items.filter(item => ids.has(item.id));
            if (items.length !== ids.size) throw new Error("対象の矩形が見つかりません。");
            this.copiedItems = items;
            post({ type: "result", request, state });
            return;
          }

          const generateId = () => randomBytes(5).toString("base64url").slice(0, 6);
          let selectedIds: string[] | undefined;
          if (message.type === "pasteRects") {
            selectedIds = pasteAnnotations(state.data, this.copiedItems, generateId);
          } else {
            if (!isEdit(edit)) throw new Error("編集操作の内容が無効です。");
            const configuredAnchor = edit.kind === "add"
              ? vscode.workspace.getConfiguration("screenSpecAnnotator").get("defaultMarkerPosition")
              : undefined;
            const anchor = isMarkerAnchor(configuredAnchor) ? configuredAnchor : undefined;
            const id = applyAnnotationEdit(state.data, edit, generateId, anchor);
            if (id) selectedIds = [id];
          }
          const text = serialize(state.data);
          if (text !== document.getText()) {
            const transaction = new vscode.WorkspaceEdit();
            const range = new vscode.Range(0, 0, document.lineCount, 0);
            transaction.replace(document.uri, document.validateRange(range), text);
            if (!await vscode.workspace.applyEdit(transaction)) {
              throw new Error("注釈ファイルに変更を反映できませんでした。");
            }
          }
          post({ type: "result", request, state: readDocument(document), selectedIds });
        } catch (error) {
          post({ type: "result", request, state: readDocument(document), error: messageOf(error) });
        }
      });
      this.operations.set(document, pending);
      if (clipboardAction) this.clipboardOperations = pending;
    });

    panel.onDidDispose(() => {
      active = false;
      this.panels.delete(panelToken);
      changes.dispose();
      messages.dispose();
    });
    panel.webview.html = this.html(panel.webview, panelToken);
  }

  private html(webview: vscode.Webview, panelToken: string): string {
    const nonce = randomBytes(16).toString("hex");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "editor.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "editor.css"));
    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource}; img-src blob:;">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Screen Spec Annotator</title>
<link rel="stylesheet" href="${style}">
</head>
<body>
<main id="editor" data-vscode-context='{"annotationPanel":"${panelToken}"}'>
  <div id="work-area">
    <section id="image-panel" aria-label="画像と注釈">
      <div class="toolbar" role="group" aria-label="画像操作">
        ${iconButton("highlight_alt", "図形を選択", 'id="select" aria-pressed="true"')}
        ${iconButton("add_box", "矩形を追加", 'id="draw" aria-pressed="false"')}
        ${iconButton("pan_tool", "パン", 'id="pan" aria-pressed="false"')}
        ${iconButton("zoom_out", "縮小", 'id="zoom-out"')}
        ${iconButton("zoom_in", "拡大", 'id="zoom-in"')}
        ${iconButton("fit_screen", "全体表示", 'id="fit"')}
        <output id="zoom" aria-label="表示倍率"></output>
        ${iconButton("delete_outline", "選択項目を削除", 'id="remove"')}
        <fieldset id="alignment" aria-label="位置揃えと整列" disabled>
          <div class="placement-buttons">
            <div class="alignment-buttons">
              ${iconButton("align_horizontal_left", "左揃え", 'data-align="left"')}
              ${iconButton("align_horizontal_center", "左右中央", 'data-align="center-x"')}
              ${iconButton("align_horizontal_right", "右揃え", 'data-align="right"')}
              ${iconButton("align_vertical_top", "上揃え", 'data-align="top"')}
              ${iconButton("align_vertical_center", "上下中央", 'data-align="center-y"')}
              ${iconButton("align_vertical_bottom", "下揃え", 'data-align="bottom"')}
            </div>
            <div class="distribution-buttons">
              ${iconButton("horizontal_distribute", "左右に整列", 'data-distribute="horizontal"', "button", "左右に整列（3つ以上の対象）")}
              ${iconButton("vertical_distribute", "上下に整列", 'data-distribute="vertical"', "button", "上下に整列（3つ以上の対象）")}
            </div>
          </div>
        </fieldset>
        <select id="marker-position" aria-label="丸番号の配置" disabled>
          <option value="" disabled selected>丸番号の配置</option>
          <option value="top-left">左上</option>
          <option value="middle-left">左中央</option>
          <option value="bottom-left">左下</option>
          <option value="top-right">右上</option>
          <option value="middle-right">右中央</option>
          <option value="bottom-right">右下</option>
          <option value="top-center">中央上</option>
          <option value="center">中央</option>
          <option value="bottom-center">中央下</option>
        </select>
      </div>
      <div id="notice" role="status" hidden></div>
      <div id="json-actions" hidden>${iconButton("data_object", "JSONエディターで開く", 'id="json"')}</div>
      <div id="viewport" aria-label="原画像上の矩形と丸番号" tabindex="0">
        <div id="surface" hidden>
          <canvas id="original"></canvas>
          <svg id="annotations" aria-label="注釈の位置"></svg>
        </div>
      </div>
    </section>
    <aside id="properties-panel" aria-labelledby="properties-title">
      <div class="panel-heading">
        <h2 id="properties-title">図形の編集</h2>
        ${iconButton("tune", "共通スタイル", 'id="image-style-toggle" aria-controls="image-style" aria-expanded="false"')}
      </div>
      <fieldset id="image-style" class="properties property-grid" hidden disabled>
        <legend>画像全体の共通スタイル</legend>
        <label>共通の色 <input id="image-color" type="color"></label>
        <label>丸番号の塗りつぶし色 <input id="image-marker-fill" type="color"></label>
        <label>丸番号の文字色 <input id="image-marker-text" type="color"></label>
        <label>共通の線種
          <select id="image-line" aria-label="共通の線種">
            <option value="solid">実線</option>
            <option value="dashed">破線</option>
            <option value="dotted">点線</option>
          </select>
        </label>
        <label>線の太さ（px） <input id="image-stroke-width" type="number" step="any" aria-label="共通の線の太さ"></label>
        <label>丸番号の直径（px） <input id="image-marker-diameter" type="number" step="any" aria-label="共通の丸番号の直径" placeholder="自動"></label>
        ${iconButton("save", "新規画像の既定スタイルにする", 'id="save-default-style"')}
      </fieldset>
      <p id="selection-count" role="status">図形を選択すると編集できます。</p>
      <div id="item-properties" hidden>
        <form id="geometry">
          <fieldset id="geometry-fields" class="properties property-grid">
            <legend id="geometry-title">位置とサイズ（px）</legend>
            <label>矩形 X <input id="region-x" type="number" step="any"></label>
            <label>矩形 Y <input id="region-y" type="number" step="any"></label>
            <label>幅 <input id="region-width" type="number" step="any"></label>
            <label>高さ <input id="region-height" type="number" step="any"></label>
            <label>丸番号 X <input id="marker-x" type="number" step="any"></label>
            <label>丸番号 Y <input id="marker-y" type="number" step="any"></label>
            ${iconButton("check", "座標を適用", "", "submit")}
          </fieldset>
          <div id="geometry-error" role="status" hidden></div>
        </form>
        <fieldset id="item-style" class="properties property-grid">
          <legend>項目のスタイル</legend>
          <label class="inline-control"><input id="override-color" type="checkbox"> 色を個別指定</label>
          <label>項目の色 <input id="item-color" type="color"></label>
          <label class="inline-control"><input id="override-marker-fill" type="checkbox"> 丸番号の塗りつぶし色を個別指定</label>
          <label>丸番号の塗りつぶし色 <input id="item-marker-fill" type="color"></label>
          <label class="inline-control"><input id="override-marker-text" type="checkbox"> 丸番号の文字色を個別指定</label>
          <label>丸番号の文字色 <input id="item-marker-text" type="color"></label>
          <label>項目の線種
            <select id="item-line" aria-label="項目の線種">
              <option value="">共通設定を使う</option>
              <option value="solid">実線</option>
              <option value="dashed">破線</option>
              <option value="dotted">点線</option>
            </select>
          </label>
          <label>線の太さ（px） <input id="item-stroke-width" type="number" step="any" aria-label="項目の線の太さ" placeholder="共通"></label>
          <label>丸番号の直径（px） <input id="item-marker-diameter" type="number" step="any" aria-label="項目の丸番号の直径" placeholder="共通"></label>
        </fieldset>
      </div>
    </aside>
  </div>
  <div id="splitter" role="separator" aria-orientation="horizontal" aria-label="画像と表の高さを調整" aria-valuemin="20" aria-valuemax="80" aria-valuenow="65" tabindex="0"></div>
  <section id="table-panel" aria-label="対応表">
    <table>
      <thead><tr><th scope="col">選択</th><th scope="col">番号</th><th scope="col">名称</th></tr></thead>
      <tbody id="rows"></tbody>
      <tfoot id="empty"><tr><td colspan="3">「矩形を追加」を選び、画像上をドラッグします。</td></tr></tfoot>
    </table>
  </section>
</main>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const editor = new AnnotationEditor(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(viewType, editor, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("screenSpecAnnotator.create", async (uri?: vscode.Uri) => {
      try {
        await createAnnotation(uri);
      } catch (error) {
        void vscode.window.showErrorMessage(`画面注釈を作成できませんでした。 ${messageOf(error)}`);
      }
    }),
  );
  for (const type of ["copyRects", "pasteRects"] as const) {
    context.subscriptions.push(vscode.commands.registerCommand(
      `screenSpecAnnotator.${type}`, (args: unknown) => editor.clipboardCommand(type, args),
    ));
  }
  for (const anchor of Object.keys(markerAnchors) as MarkerAnchor[]) {
    context.subscriptions.push(vscode.commands.registerCommand(
      `screenSpecAnnotator.markerPosition.${anchor}`, (args: unknown) => editor.moveMarker(anchor, args),
    ));
  }
}
