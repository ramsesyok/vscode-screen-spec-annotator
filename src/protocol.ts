import type { AnnotationDocument, Edit, ImageIdentity, MarkerAnchor } from "./annotation";

export interface OriginalImage {
  identity: ImageIdentity;
  mime: "image/png" | "image/jpeg";
  bytes: ArrayBuffer;
}

export interface DocumentState {
  version: number;
  data?: AnnotationDocument;
  error?: string;
}

export type EditorMessage =
  | { type: "ready" }
  | { type: "openJson" }
  | { type: "edit"; request: number; version: number; edit: Edit }
  | { type: "copyRects"; request: number; version: number; ids: string[] }
  | { type: "save" | "saveDefaultStyle" | "pasteRects" | "preparePng" | "exportCsv"; request: number; version: number }
  | { type: "writePng"; request: number; version: number; sourceVersion: number; png: ArrayBuffer };

export type HostMessage =
  | { type: "state"; state: DocumentState }
  | { type: "image"; imagePath: string; image?: OriginalImage; error?: string }
  | { type: "markerPreset"; id: string; anchor: MarkerAnchor }
  | { type: "copyRects"; id: string }
  | { type: "pasteRects" }
  | { type: "result"; request: number; state: DocumentState; selectedIds?: string[]; error?: string; exportPng?: boolean };

// Validate payloads when executing the request, so a malformed edit still gets
// a result for its request number and does not stall the Webview queue.
export type DocumentRequest = {
  request: number;
  version: number;
} & (
  | { type: "edit"; edit?: unknown }
  | { type: "copyRects"; ids?: unknown }
  | { type: "save" | "saveDefaultStyle" | "pasteRects" | "preparePng" | "exportCsv" }
  | { type: "writePng"; sourceVersion?: unknown; png?: unknown }
);

export function isDocumentRequest(message: unknown): message is DocumentRequest {
  return typeof message === "object" && message !== null && "type" in message &&
    (message.type === "edit" || message.type === "save" || message.type === "saveDefaultStyle" ||
      message.type === "copyRects" || message.type === "pasteRects" ||
      message.type === "preparePng" || message.type === "writePng" || message.type === "exportCsv") &&
    "request" in message && Number.isSafeInteger(message.request) &&
    "version" in message && Number.isSafeInteger(message.version);
}
