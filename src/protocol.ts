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
  | { type: "save" | "saveDefaultStyle" | "pasteRects"; request: number; version: number };

export type HostMessage =
  | { type: "state"; state: DocumentState }
  | { type: "image"; imagePath: string; image?: OriginalImage; error?: string }
  | { type: "markerPreset"; id: string; anchor: MarkerAnchor }
  | { type: "copyRects"; id: string }
  | { type: "pasteRects" }
  | { type: "result"; request: number; state: DocumentState; selectedIds?: string[]; error?: string };
