import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import * as vscode from "vscode";
import { applyAnnotationEdit, isAnnotationIds, isEdit, isMarkerAnchor, parseAnnotation, pasteAnnotations } from "./annotation";
import type { AnnotationDocument, AnnotationItem } from "./annotation";
import type { DocumentRequest, DocumentState, HostMessage } from "./protocol";
import { checkExportImage, writeAnnotatedPng, writeOutput } from "./annotation-output";
import { metadataCsv } from "./metadata-csv";

type Result = Extract<HostMessage, { type: "result" }>;
export const styleSetting = "defaultStyle";

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function serialize(data: AnnotationDocument): string {
  return JSON.stringify(data, null, 2) + "\n";
}

export function readDocument(document: vscode.TextDocument): DocumentState {
  try {
    return { version: document.version, data: parseAnnotation(document.getText()) };
  } catch (error) {
    return { version: document.version, error: `${basename(document.uri.fsPath)}: ${messageOf(error)}` };
  }
}

export class DocumentOperations {
  private readonly operations = new WeakMap<vscode.TextDocument, Promise<void>>();
  private copiedItems: AnnotationItem[] = [];
  private clipboardOperations: Promise<void> = Promise.resolve();

  enqueue(document: vscode.TextDocument, message: DocumentRequest, post: (result: Result) => void): void {
    const previous = this.operations.get(document) ?? Promise.resolve();
    const clipboardAction = message.type === "copyRects" || message.type === "pasteRects";
    const pending = Promise.all([previous, clipboardAction ? this.clipboardOperations : undefined]).then(async () => {
      try {
        post(await this.execute(document, message));
      } catch (error) {
        post({ type: "result", request: message.request, state: readDocument(document), error: messageOf(error) });
      }
    });
    this.operations.set(document, pending);
    if (clipboardAction) this.clipboardOperations = pending;
  }

  private async execute(document: vscode.TextDocument, message: DocumentRequest): Promise<Result> {
    const { request, version } = message;
    const edit = message.type === "edit" ? message.edit : undefined;
    if (message.type === "save") {
      if (!await document.save()) throw new Error("注釈ファイルを保存できませんでした。");
      return { type: "result", request, state: readDocument(document) };
    }

    const state = readDocument(document);
    if (!state.data) throw new Error(state.error);
    if (state.version !== version) throw new Error("注釈が更新されました。最新の内容を確認してください。");
    if (message.type === "preparePng" || message.type === "exportCsv") {
      const csv = message.type === "exportCsv";
      if (!csv) await checkExportImage(document.uri.fsPath, state.data);
      else if (!state.data.screenId.trim()) throw new Error("一覧出力の前に画面IDを入力してください。");
      if (document.isDirty) {
        const save = "保存して出力";
        const choice = await vscode.window.showWarningMessage(`${csv ? "CSV" : "PNG"}の出力前に注釈を保存しますか？`, { modal: true }, save);
        if (choice !== save) return { type: "result", request, state: readDocument(document) };
        if (document.version !== version) throw new Error("注釈が更新されました。最新の状態で再出力してください。");
        if (!await document.save()) throw new Error("注釈ファイルを保存できませんでした。");
      }
      const saved = readDocument(document);
      if (!saved.data || document.isDirty) throw new Error("保存済みの注釈を取得できませんでした。");
      if (csv) {
        await writeOutput(document, saved.version, saved.data, "csv", Buffer.from(metadataCsv(saved.data)));
        return { type: "result", request, state: readDocument(document) };
      }
      return { type: "result", request, state: saved, exportPng: true };
    }
    if (message.type === "writePng") {
      if (message.sourceVersion !== state.version || document.isDirty) {
        throw new Error("注釈が更新されました。最新の状態で再出力してください。");
      }
      await writeAnnotatedPng(document, version, state.data, message.png);
      return { type: "result", request, state: readDocument(document) };
    }
    if (message.type === "saveDefaultStyle") {
      await vscode.workspace.getConfiguration("screenSpecAnnotator")
        .update(styleSetting, state.data.style, vscode.ConfigurationTarget.Global);
      return { type: "result", request, state: readDocument(document) };
    }
    if (message.type === "copyRects") {
      if (!isAnnotationIds(message.ids)) throw new Error("コピーする矩形を選択してください。");
      const ids = new Set(message.ids);
      const items = state.data.items.filter(item => ids.has(item.id));
      if (items.length !== ids.size) throw new Error("対象の矩形が見つかりません。");
      this.copiedItems = items;
      return { type: "result", request, state };
    }

    const generateId = () => randomBytes(5).toString("base64url").slice(0, 6);
    let selectedIds: string[] | undefined;
    if (message.type === "pasteRects") {
      selectedIds = pasteAnnotations(state.data, this.copiedItems, generateId);
    } else {
      if (!isEdit(edit)) throw new Error("編集操作の内容が無効です。");
      if (edit.kind === "renumber" && edit.previewVersion !== state.version) {
        throw new Error("注釈が更新されました。番号の変更内容をもう一度確認してください。");
      }
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
    return { type: "result", request, state: readDocument(document), selectedIds };
  }
}
