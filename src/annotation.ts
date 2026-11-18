export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Region extends Point, Size {}

export interface ImageIdentity extends Size {
  sha256: string;
}

export interface AnnotationItem {
  id: string;
  number: number;
  name: string;
  region: Region;
  marker: Point;
  values: Record<string, string>;
}

export interface AnnotationDocument {
  version: 1;
  imagePath: string;
  confirmedImage: ImageIdentity;
  coordinateSize: Size;
  coordinateReviewPending: boolean;
  highestIssuedNumber: number;
  items: AnnotationItem[];
}

export type Edit =
  | { kind: "add"; region: Region }
  | { kind: "region"; id: string; region: Region }
  | { kind: "marker"; id: string; marker: Point }
  | { kind: "name"; id: string; name: string }
  | { kind: "remove"; id: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isInteger(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPoint(value: unknown): value is Point {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y);
}

function isRegion(value: unknown): value is Region {
  return isRecord(value) && isPoint(value) &&
    isFiniteNumber(value.width) && value.width > 0 &&
    isFiniteNumber(value.height) && value.height > 0;
}

function isSize(value: unknown): value is Size {
  return isRecord(value) && isInteger(value.width, 1) && isInteger(value.height, 1);
}

function isIdentity(value: unknown): value is ImageIdentity {
  return isRecord(value) && isSize(value) &&
    typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256);
}

export function isRelativeImagePath(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !/^([a-z]:|\/)/i.test(value) &&
    !value.includes("\\") && !value.includes("\0");
}

function isItem(value: unknown): value is AnnotationItem {
  return isRecord(value) && typeof value.id === "string" && value.id !== "" &&
    isInteger(value.number, 1) && typeof value.name === "string" &&
    isRegion(value.region) && isPoint(value.marker) &&
    isRecord(value.values) && Object.values(value.values).every(item => typeof item === "string");
}

export function parseAnnotation(text: string): AnnotationDocument {
  const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("注釈ファイルの形式バージョンは 1 が必要です。");
  }
  const { imagePath, confirmedImage, coordinateSize, coordinateReviewPending, highestIssuedNumber, items } = value;
  if (!isRelativeImagePath(imagePath) || !isIdentity(confirmedImage) ||
      !isSize(coordinateSize) || typeof coordinateReviewPending !== "boolean" ||
      !isInteger(highestIssuedNumber, 0) || !Array.isArray(items) || !items.every(isItem)) {
    throw new Error("原画像の情報、座標、または項目の形式を確認してください。");
  }
  const ids = new Set<string>();
  const numbers = new Set<number>();
  for (const item of items) {
    if (ids.has(item.id) || numbers.has(item.number) || item.number > highestIssuedNumber) {
      throw new Error("項目ID、表示番号、または発行済み最大番号が一致しません。");
    }
    ids.add(item.id);
    numbers.add(item.number);
  }
  return { ...value, version: 1, imagePath, confirmedImage, coordinateSize,
    coordinateReviewPending, highestIssuedNumber, items };
}

export function newAnnotation(imagePath: string, image: ImageIdentity): AnnotationDocument {
  return {
    version: 1,
    imagePath,
    confirmedImage: image,
    coordinateSize: { width: image.width, height: image.height },
    coordinateReviewPending: false,
    highestIssuedNumber: 0,
    items: [],
  };
}

export function isEdit(value: unknown): value is Edit {
  if (!isRecord(value)) return false;
  if (value.kind === "add") return isRegion(value.region);
  if (typeof value.id !== "string") return false;
  switch (value.kind) {
    case "region": return isRegion(value.region);
    case "marker": return isPoint(value.marker);
    case "name": return typeof value.name === "string";
    case "remove": return true;
    default: return false;
  }
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

export function regionBetween(start: Point, end: Point): Region {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(start.x - end.x),
    height: Math.abs(start.y - end.y),
  };
}

export function markerRadius(number: number, size: Size): number {
  const shortestSide = Math.min(size.width, size.height);
  const radius = Math.max(7, Math.min(20, shortestSide * 0.025));
  return Math.min(shortestSide / 2, radius + Math.max(0, String(number).length - 2) * 3);
}

export function constrainMarker(point: Point, number: number, size: Size): Point {
  const radius = markerRadius(number, size);
  return {
    x: clamp(point.x, radius, size.width - radius),
    y: clamp(point.y, radius, size.height - radius),
  };
}

export function applyAnnotationEdit(
  data: AnnotationDocument,
  edit: Edit,
  generateId: () => string,
): string | undefined {
  const size = data.coordinateSize;
  if (edit.kind === "add" || edit.kind === "region") {
    const { x, y, width, height } = edit.region;
    if (x < 0 || y < 0 || x + width > size.width + 1e-7 || y + height > size.height + 1e-7) {
      throw new Error("矩形を画像の内側に収めてください。");
    }
  }
  if (edit.kind === "add") {
    const number = data.highestIssuedNumber + 1;
    if (!Number.isSafeInteger(number)) throw new Error("新規項目に割り当てられる番号がありません。");
    const { region } = edit;
    const radius = markerRadius(number, size);
    const marker = constrainMarker({ x: region.x + region.width + radius, y: region.y }, number, size);
    const id = generateId();
    data.items.push({ id, number, name: "", region, marker, values: {} });
    data.highestIssuedNumber = number;
    return id;
  }

  const index = data.items.findIndex(item => item.id === edit.id);
  if (index < 0) throw new Error("対象の項目が見つかりません。");
  const item = data.items[index];
  switch (edit.kind) {
    case "region":
      item.region = edit.region;
      break;
    case "marker":
      item.marker = constrainMarker(edit.marker, item.number, size);
      break;
    case "name":
      item.name = edit.name;
      break;
    case "remove":
      data.items.splice(index, 1);
      break;
  }
}
