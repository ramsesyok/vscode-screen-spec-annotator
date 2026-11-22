import { randomUUID } from "node:crypto";
import { mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { imageSize } from "image-size";
import * as vscode from "vscode";
import type { AnnotationDocument } from "./annotation";
import { readOriginalImage, resolveImagePath } from "./original-image";

export async function checkExportImage(path: string, data: AnnotationDocument): Promise<void> {
  const { coordinateSize, confirmedImage, coordinateReviewPending } = data;
  const { identity } = await readOriginalImage(resolveImagePath(path, data.imagePath));
  if (coordinateReviewPending || identity.sha256 !== confirmedImage.sha256 ||
      identity.width !== coordinateSize.width || identity.height !== coordinateSize.height ||
      identity.width !== confirmedImage.width || identity.height !== confirmedImage.height) {
    throw new Error("原画像が確認済みの状態と一致しないため、PNGを出力できません。");
  }
}

async function outputFileState(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path, { bigint: true });
    return [info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export async function writeAnnotatedPng(
  document: vscode.TextDocument, version: number, data: AnnotationDocument, payload: unknown,
): Promise<void> {
  if (!(payload instanceof ArrayBuffer)) throw new Error("PNGのデータを受け取れませんでした。");
  const bytes = new Uint8Array(payload);
  const { width, height, type } = imageSize(bytes);
  if (type !== "png" || width !== data.coordinateSize.width || height !== data.coordinateSize.height) {
    throw new Error("PNGの形式または寸法が正しくありません。");
  }
  await writeOutput(document, version, data, "png", bytes);
}

export async function writeOutput(document: vscode.TextDocument, version: number, data: AnnotationDocument,
  format: "png" | "csv", bytes: Uint8Array): Promise<void> {
  const path = document.uri.fsPath;
  const folder = join(dirname(path), "output");
  const name = basename(path).replace(/\.annotations\.json$/i, "") + (format === "png" ? ".annotated.png" : ".csv");
  const destination = join(folder, name);
  const existing = await outputFileState(destination);
  if (existing !== undefined) {
    if (format === "png" && await realpath(destination) === await realpath(resolveImagePath(path, data.imagePath))) {
      throw new Error("出力先は参照中の原画像です。原画像を上書きできません。");
    }
    const overwrite = "上書き";
    const choice = await vscode.window.showWarningMessage(`${name} を上書きしますか？`, { modal: true }, overwrite);
    if (choice !== overwrite) return;
  }
  await mkdir(folder, { recursive: true });
  const temporary = join(folder, `.${randomUUID()}.${format}.tmp`);
  const file = await open(temporary, "wx");
  try {
    try {
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
    if (format === "png") await checkExportImage(path, data);
    const current = await outputFileState(destination);
    if (document.version !== version || document.isDirty || current !== existing) {
      throw new Error("注釈または出力先が更新されました。最新の状態で再出力してください。");
    }
    await vscode.workspace.fs.rename(vscode.Uri.file(temporary), vscode.Uri.file(destination),
      { overwrite: existing !== undefined });
  } finally {
    await unlink(temporary).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
  const openLabel = format === "png" ? "画像を開く" : "CSVを開く";
  void vscode.window.showInformationMessage(`${format.toUpperCase()}を出力しました。 output/${name}`, openLabel).then(choice => {
    if (choice === openLabel) return vscode.commands.executeCommand("vscode.open", vscode.Uri.file(destination));
  });
}
