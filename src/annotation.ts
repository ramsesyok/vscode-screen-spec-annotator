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

export type LineStyle = "solid" | "dashed" | "dotted";
export type Alignment = "left" | "center-x" | "right" | "top" | "center-y" | "bottom";
export type DistributionDirection = "horizontal" | "vertical";

export interface ShapeStyle {
  color: string;
  lineStyle: LineStyle;
}

const itemIdPattern = /^[A-Za-z0-9_-]{6}$/;

export interface AnnotationItem {
  id: string;
  number: number;
  name: string;
  region: Region;
  marker: Point;
  values: Record<string, string>;
  style?: Partial<ShapeStyle>;
}

export interface AnnotationDocument {
  version: 2;
  imagePath: string;
  confirmedImage: ImageIdentity;
  coordinateSize: Size;
  coordinateReviewPending: boolean;
  highestIssuedNumber: number;
  style: ShapeStyle;
  items: AnnotationItem[];
}

export type Edit =
  | { kind: "add"; region: Region }
  | { kind: "region"; id: string; region: Region }
  | { kind: "marker"; id: string; marker: Point }
  | { kind: "geometry"; id: string; region?: Region; marker?: Point }
  | { kind: "align"; ids: string[]; alignment: Alignment }
  | { kind: "distribute"; ids: string[]; direction: DistributionDirection }
  | { kind: "style"; id?: string; property: "color"; value: string | null }
  | { kind: "style"; id?: string; property: "lineStyle"; value: LineStyle | null }
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

function isColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

export function isLineStyle(value: unknown): value is LineStyle {
  return value === "solid" || value === "dashed" || value === "dotted";
}

export function isAlignment(value: unknown): value is Alignment {
  return value === "left" || value === "center-x" || value === "right" ||
    value === "top" || value === "center-y" || value === "bottom";
}

export function isDistributionDirection(value: unknown): value is DistributionDirection {
  return value === "horizontal" || value === "vertical";
}

function isItemId(value: unknown): value is string {
  return typeof value === "string" && itemIdPattern.test(value);
}

export function isRelativeImagePath(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !/^([a-z]:|\/)/i.test(value) &&
    !value.includes("\\") && !value.includes("\0");
}

function isItem(value: unknown): value is AnnotationItem {
  return isRecord(value) && isItemId(value.id) &&
    isInteger(value.number, 1) && typeof value.name === "string" &&
    isRegion(value.region) && isPoint(value.marker) &&
    isRecord(value.values) && Object.values(value.values).every(item => typeof item === "string") &&
    (value.style === undefined || (isRecord(value.style) &&
      (value.style.color === undefined || isColor(value.style.color)) &&
      (value.style.lineStyle === undefined || isLineStyle(value.style.lineStyle))));
}

export function parseAnnotation(text: string): AnnotationDocument {
  const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!isRecord(value) || value.version !== 2) {
    throw new Error("この版では形式バージョン2の注釈ファイルを開けます。");
  }
  const { imagePath, confirmedImage, coordinateSize, coordinateReviewPending, highestIssuedNumber, style, items } = value;
  if (!isRelativeImagePath(imagePath) || !isIdentity(confirmedImage) ||
      !isSize(coordinateSize) || typeof coordinateReviewPending !== "boolean" ||
      !isInteger(highestIssuedNumber, 0) || !isRecord(style) ||
      !isColor(style.color) || !isLineStyle(style.lineStyle) ||
      !Array.isArray(items) || !items.every(isItem)) {
    throw new Error("原画像の情報、座標、スタイル、項目IDの形式を確認してください。");
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
  return { ...value, version: 2, imagePath, confirmedImage, coordinateSize,
    coordinateReviewPending, highestIssuedNumber, style: { ...style, color: style.color, lineStyle: style.lineStyle }, items };
}

export function newAnnotation(imagePath: string, image: ImageIdentity): AnnotationDocument {
  return {
    version: 2,
    imagePath,
    confirmedImage: image,
    coordinateSize: { width: image.width, height: image.height },
    coordinateReviewPending: false,
    highestIssuedNumber: 0,
    style: { color: "#113a60", lineStyle: "solid" },
    items: [],
  };
}

export function isEdit(value: unknown): value is Edit {
  if (!isRecord(value)) return false;
  if (value.kind === "add") return isRegion(value.region);
  if (value.kind === "align" || value.kind === "distribute") {
    if (!Array.isArray(value.ids) || !value.ids.every(isItemId) || new Set(value.ids).size !== value.ids.length) {
      return false;
    }
    return value.kind === "align"
      ? value.ids.length >= 2 && isAlignment(value.alignment)
      : value.ids.length >= 3 && isDistributionDirection(value.direction);
  }
  if (value.kind === "style") {
    if (value.id !== undefined && !isItemId(value.id)) return false;
    if (value.value === null && value.id === undefined) return false;
    if (value.property === "color") return value.value === null || isColor(value.value);
    if (value.property === "lineStyle") return value.value === null || isLineStyle(value.value);
    return false;
  }
  if (!isItemId(value.id)) return false;
  switch (value.kind) {
    case "region": return isRegion(value.region);
    case "marker": return isPoint(value.marker);
    case "geometry":
      return (value.region !== undefined || value.marker !== undefined) &&
        (value.region === undefined || isRegion(value.region)) &&
        (value.marker === undefined || isPoint(value.marker));
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

export function regionFits(region: Region, size: Size): boolean {
  const { x, y, width, height } = region;
  return isRegion(region) && x >= 0 && y >= 0 &&
    x + width <= size.width + 1e-7 && y + height <= size.height + 1e-7;
}

export function markerFits(point: Point, number: number, size: Size): boolean {
  const constrained = constrainMarker(point, number, size);
  return Number.isFinite(point.x) && Number.isFinite(point.y) &&
    Math.abs(constrained.x - point.x) < 1e-7 && Math.abs(constrained.y - point.y) < 1e-7;
}

function alignRegions(items: AnnotationItem[], alignment: Alignment, size: Size): void {
  const horizontal = alignment === "left" || alignment === "center-x" || alignment === "right";
  const axis = horizontal ? "x" : "y";
  const length = horizontal ? "width" : "height";
  const isStart = alignment === "left" || alignment === "top";
  const isEnd = alignment === "right" || alignment === "bottom";
  const start = Math.min(...items.map(({ region }) => region[axis]));
  const end = Math.max(...items.map(({ region }) => region[axis] + region[length]));
  const regions = items.map(({ region }) => ({
    ...region,
    [axis]: isStart ? start : isEnd ? end - region[length] : start + (end - start - region[length]) / 2,
  }));
  applyRegions(items, regions, size);
}

function distributeRegions(items: AnnotationItem[], direction: DistributionDirection, size: Size): void {
  const axis = direction === "horizontal" ? "x" : "y";
  const length = direction === "horizontal" ? "width" : "height";
  // Only the filtered selection is sorted. Table order continues to follow data.items.
  items.sort((a, b) => a.region[axis] - b.region[axis]);
  const first = items[0].region;
  const last = items[items.length - 1].region;
  const totalLength = items.reduce((sum, { region }) => sum + region[length], 0);
  const freeSpace = last[axis] + last[length] - first[axis] - totalLength;
  if (freeSpace < -1e-7) {
    throw new Error("両端の矩形の間に十分な空きがありません。間隔を広げてから整列してください。");
  }
  const gap = Math.max(0, freeSpace) / (items.length - 1);
  let next = first[axis] + first[length] + gap;
  const regions = items.map(({ region }, index) => {
    if (index === 0 || index === items.length - 1) return region;
    const moved = { ...region, [axis]: next };
    next += region[length] + gap;
    return moved;
  });
  applyRegions(items, regions, size);
}

function applyRegions(items: AnnotationItem[], regions: Region[], size: Size): void {
  if (!regions.every(region => regionFits(region, size))) {
    throw new Error("変更後の矩形が画像の内側に収まるように調整してください。");
  }
  items.forEach((item, index) => { item.region = regions[index]; });
}

export function applyAnnotationEdit(
  data: AnnotationDocument,
  edit: Edit,
  generateId: () => string,
): string | undefined {
  const size = data.coordinateSize;
  if ((edit.kind === "add" || edit.kind === "region" || edit.kind === "geometry") &&
      edit.region && !regionFits(edit.region, size)) {
    throw new Error("矩形を画像の内側に収めてください。");
  }
  if (edit.kind === "align" || edit.kind === "distribute") {
    const ids = new Set(edit.ids);
    const items = data.items.filter(item => ids.has(item.id));
    if (items.length !== edit.ids.length) throw new Error("対象の項目が見つかりません。");
    if (edit.kind === "align") alignRegions(items, edit.alignment, size);
    else distributeRegions(items, edit.direction, size);
    return;
  }
  if (edit.kind === "style" && edit.id === undefined) {
    if (edit.value === null) throw new Error("共通スタイルには値を指定してください。");
    if (edit.property === "color") data.style.color = edit.value;
    else data.style.lineStyle = edit.value;
    return;
  }
  if (edit.kind === "add") {
    const number = data.highestIssuedNumber + 1;
    if (!Number.isSafeInteger(number)) throw new Error("新規項目に割り当てられる番号がありません。");
    const { region } = edit;
    const radius = markerRadius(number, size);
    const marker = constrainMarker({ x: region.x + region.width + radius, y: region.y }, number, size);
    const used = new Set(data.items.map(item => item.id));
    let id = generateId();
    for (let attempt = 1; used.has(id) && attempt < 10; attempt++) id = generateId();
    if (!isItemId(id) || used.has(id)) throw new Error("一意の項目IDを生成できませんでした。");
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
    case "geometry":
      if (edit.marker && !markerFits(edit.marker, item.number, size)) {
        throw new Error("丸番号が画像の内側に収まる座標を指定してください。");
      }
      if (edit.region) item.region = edit.region;
      if (edit.marker) item.marker = edit.marker;
      break;
    case "style": {
      const style = { ...item.style };
      if (edit.value === null) delete style[edit.property];
      else if (edit.property === "color") style.color = edit.value;
      else style.lineStyle = edit.value;
      if (style.color !== undefined || style.lineStyle !== undefined) item.style = style;
      else delete item.style;
      break;
    }
    case "name":
      item.name = edit.name;
      break;
    case "remove":
      data.items.splice(index, 1);
      break;
  }
}
