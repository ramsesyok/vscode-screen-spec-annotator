import { strict as assert } from "node:assert";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { applyAnnotationEdit, newAnnotation, parseAnnotation } from "../src/annotation";
import { DocumentOperations, serialize } from "../src/document-operations";
import type { DocumentRequest, HostMessage } from "../src/protocol";

// VS Code loads run() through --extensionTestsPath.
export async function run(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "screen-spec-host-"));
  const data = newAnnotation("original.png", { width: 200, height: 100, sha256: "a".repeat(64) });
  applyAnnotationEdit(data, { kind: "add", region: { x: 10, y: 10, width: 20, height: 20 } }, () => "source");
  const operations = new DocumentOperations();
  function submit(document: vscode.TextDocument, message: DocumentRequest) {
    return new Promise<Extract<HostMessage, { type: "result" }>>(resolve => {
      operations.enqueue(document, message, resolve);
    });
  }
  async function open(name: string) {
    const path = join(directory, name + ".annotations.json");
    await writeFile(path, serialize(data));
    return vscode.workspace.openTextDocument(vscode.Uri.file(path));
  }

  const source = await open("source");
  const target = await open("target");
  const originalVersion = source.version;
  const rename = submit(source, { type: "edit", request: 1, version: originalVersion,
    edit: { kind: "name", id: "source", name: "更新" } });
  const outdated = submit(source, { type: "edit", request: 2, version: originalVersion,
    edit: { kind: "name", id: "source", name: "old" } });
  assert.equal((await rename).error, undefined);
  assert.match((await outdated).error ?? "", /最新/);
  assert.ok(source.isDirty);
  assert.equal(parseAnnotation(source.getText()).items[0].name, "更新");

  const copy = submit(source, { type: "copyRects", request: 3, version: source.version, ids: ["source"] });
  const paste = submit(target, { type: "pasteRects", request: 4, version: target.version });
  assert.equal((await copy).error, undefined);
  const pasted = await paste;
  assert.equal(pasted.error, undefined);
  const item = parseAnnotation(target.getText()).items[1];
  assert.equal(item.name, "更新");
  assert.equal(item.number, 2);
  assert.deepEqual(pasted.selectedIds, [item.id]);
  assert.notEqual(item.id, "source");

  const beforeError = target.getText();
  assert.ok((await submit(target, { type: "edit", request: 5, version: target.version })).error);
  assert.equal(target.getText(), beforeError);
  const saved = await submit(target, { type: "save", request: 6, version: originalVersion });
  assert.equal(saved.error, undefined);
  assert.equal(target.isDirty, false);
  assert.deepEqual(parseAnnotation(await readFile(target.uri.fsPath, "utf8")), saved.state.data);
  await source.save();
  console.log("Screen Spec Annotator host checks passed");
}
