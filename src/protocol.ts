import type { AnnotationDocument, Edit, ImageIdentity } from "./annotation";

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
  | { type: "save"; request: number; version: number };

export type HostMessage =
  | { type: "state"; state: DocumentState }
  | { type: "image"; imagePath: string; image?: OriginalImage; error?: string }
  | { type: "result"; request: number; state: DocumentState; selectedId?: string; error?: string };
