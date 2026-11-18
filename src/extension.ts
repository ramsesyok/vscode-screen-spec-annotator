import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import * as vscode from "vscode";
import { applyAnnotationEdit, isEdit, newAnnotation, parseAnnotation } from "./annotation";
import { readOriginalImage, relativeImagePath, resolveImagePath, supportsImage } from "./original-image";
import type { DocumentState, HostMessage } from "./protocol";

const viewType = "screenSpecAnnotator.annotations";
const annotationSuffix = ".annotations.json";

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
      await writeFile(destination.fsPath, serialize(newAnnotation(relative, original.identity)), { flag: "wx" });
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

  constructor(private readonly extensionUri: vscode.Uri) {}

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
      if ((message.type !== "edit" && message.type !== "save") ||
          !("request" in message) || typeof message.request !== "number" ||
          !Number.isSafeInteger(message.request) ||
          !("version" in message) || typeof message.version !== "number" ||
          !Number.isSafeInteger(message.version)) return;

      const { request, version } = message;
      const edit = "edit" in message ? message.edit : undefined;
      const previous = this.operations.get(document) ?? Promise.resolve();
      const pending = previous.then(async () => {
        try {
          if (message.type === "save") {
            if (!await document.save()) throw new Error("注釈ファイルを保存できませんでした。");
            post({ type: "result", request, state: readDocument(document) });
            return;
          }

          const state = readDocument(document);
          if (!state.data) throw new Error(state.error);
          if (state.version !== version) throw new Error("注釈が更新されました。最新の内容を確認してください。");
          if (!isEdit(edit)) throw new Error("編集操作の内容が無効です。");

          const selectedId = applyAnnotationEdit(state.data, edit, randomUUID);
          const text = serialize(state.data);
          if (text !== document.getText()) {
            const transaction = new vscode.WorkspaceEdit();
            const range = new vscode.Range(0, 0, document.lineCount, 0);
            transaction.replace(document.uri, document.validateRange(range), text);
            if (!await vscode.workspace.applyEdit(transaction)) {
              throw new Error("注釈ファイルに変更を反映できませんでした。");
            }
          }
          post({ type: "result", request, state: readDocument(document), selectedId });
        } catch (error) {
          post({ type: "result", request, state: readDocument(document), error: messageOf(error) });
        }
      });
      this.operations.set(document, pending);
    });

    panel.onDidDispose(() => {
      active = false;
      changes.dispose();
      messages.dispose();
    });
    panel.webview.html = this.html(panel.webview);
  }

  private html(webview: vscode.Webview): string {
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
<main id="editor">
  <section id="image-panel" aria-label="画像と注釈">
    <div class="toolbar" role="group" aria-label="画像操作">
      <button id="draw" type="button" aria-pressed="true">矩形を追加</button>
      <button id="pan" type="button" aria-pressed="false">パン</button>
      <button id="zoom-out" type="button" aria-label="縮小">−</button>
      <button id="zoom-in" type="button" aria-label="拡大">＋</button>
      <button id="fit" type="button">全体表示</button>
      <output id="zoom" aria-label="表示倍率"></output>
      <button id="remove" type="button">選択項目を削除</button>
    </div>
    <div id="notice" role="status" hidden></div>
    <div id="json-actions" hidden><button id="json" type="button">JSONエディターで開く</button></div>
    <div id="viewport" aria-label="原画像上の矩形と丸番号">
      <div id="surface" hidden>
        <canvas id="original"></canvas>
        <svg id="annotations" aria-label="注釈の位置"></svg>
      </div>
    </div>
  </section>
  <div id="splitter" role="separator" aria-orientation="horizontal" aria-label="画像と表の高さを調整" aria-valuemin="20" aria-valuemax="80" aria-valuenow="65" tabindex="0"></div>
  <section id="table-panel" aria-label="対応表">
    <table>
      <thead><tr><th scope="col">番号</th><th scope="col">名称</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <p id="empty">画像上をドラッグして矩形を追加できます。</p>
  </section>
</main>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(viewType, new AnnotationEditor(context.extensionUri), {
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
}
