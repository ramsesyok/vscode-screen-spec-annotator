import type { Edit } from "../annotation";
import type { EditorMessage } from "../protocol";

export type QueuedOperation = { kind: "save" | "saveDefaultStyle" | "pasteRects" | "preparePng" | "exportCsv" } |
  { kind: "writePng"; sourceVersion: number; png: ArrayBuffer } |
  { kind: "copyRects"; ids: string[] } | { kind: "edit"; edit: Edit };

export class OperationQueue {
  private readonly pending: QueuedOperation[] = [];
  private current?: { operation: QueuedOperation; request: number };
  private nextRequest = 0;
  private readonly send: (message: EditorMessage) => void;

  constructor(send: (message: EditorMessage) => void) {
    this.send = send;
  }

  enqueue(operation: QueuedOperation): void {
    const previous = this.pending.at(-1);
    if (operation.kind === "edit" && operation.edit.kind === "name" &&
        previous?.kind === "edit" && previous.edit.kind === "name" && previous.edit.id === operation.edit.id) {
      this.pending[this.pending.length - 1] = previous.edit.previousName === undefined ? operation :
        { kind: "edit", edit: { ...operation.edit, previousName: previous.edit.previousName } };
    } else {
      this.pending.push(operation);
    }
  }

  sendNext(version: number | undefined): void {
    if (this.current || version === undefined) return;
    const operation = this.pending.shift();
    if (!operation) return;
    const request = ++this.nextRequest;
    this.current = { operation, request };
    if (operation.kind === "edit") {
      this.send({ type: "edit", request, version, edit: operation.edit });
    } else if (operation.kind === "copyRects") {
      this.send({ type: operation.kind, request, version, ids: operation.ids });
    } else if (operation.kind === "writePng") {
      this.send({ type: operation.kind, request, version, sourceVersion: operation.sourceVersion, png: operation.png });
    } else {
      this.send({ type: operation.kind, request, version });
    }
  }

  complete(request: number, failed: boolean): QueuedOperation | undefined {
    if (!this.current || this.current.request !== request) return;
    const { operation } = this.current;
    this.current = undefined;
    if (failed) {
      const failedName = operation.kind === "edit" && operation.edit.kind === "name" ? operation.edit.id : undefined;
      for (let i = this.pending.length - 1; i >= 0; i--) {
        const waiting = this.pending[i];
        if (waiting.kind === "save" || waiting.kind === "saveDefaultStyle" || waiting.kind === "preparePng" || waiting.kind === "exportCsv" ||
            (waiting.kind === "edit" && waiting.edit.kind === "name" && waiting.edit.id === failedName)) {
          this.pending.splice(i, 1);
        }
      }
    }
    return operation;
  }

  queuedEdits(): Edit[] {
    return [this.current?.operation, ...this.pending].flatMap(op => op?.kind === "edit" ? [op.edit] : []);
  }
}
