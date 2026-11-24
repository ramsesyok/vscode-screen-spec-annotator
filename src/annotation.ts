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
export type ShapePart = "region" | "marker";
export type PlacementSubject = { id: string; part: ShapePart };
export type GeometryChange = { id: string; region?: Partial<Region>; marker?: Partial<Point> };

export const markerAnchors = {
  "top-left": [0, 0],
  "middle-left": [0, 0.5],
  "bottom-left": [0, 1],
  "top-right": [1, 0],
  "middle-right": [1, 0.5],
  "bottom-right": [1, 1],
  "top-center": [0.5, 0],
  center: [0.5, 0.5],
  "bottom-center": [0.5, 1],
} as const;
export type MarkerAnchor = keyof typeof markerAnchors;

export function isMarkerAnchor(value: unknown): value is MarkerAnchor {
  return typeof value === "string" && Object.hasOwn(markerAnchors, value);
}

export interface ShapeStyle {
  color: string;
  lineStyle: LineStyle;
  strokeWidth?: number;
  markerDiameter?: number | null;
  markerStrokeColor?: string;
  markerFillColor?: string;
  markerTextColor?: string;
}

export const defaultStrokeWidth = 2;
export const defaultMarkerColors = { markerFillColor: "#ffffff", markerTextColor: "#0b253d" };
export type NumericStyleProperty = "strokeWidth" | "markerDiameter";
export type StyleEdit = { kind: "style"; id?: string; imageBasis?: string } & (
  | { property: "color" | "markerStrokeColor" | "markerFillColor" | "markerTextColor"; value: string }
  | { property: "lineStyle"; value: LineStyle }
  | { property: NumericStyleProperty; value: number | null }
);
export type ItemStyleToggle = { kind: "itemStyle"; id: string; enabled: boolean; imageBasis?: string };

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
  screenId: string;
  version: 2;
  imagePath: string;
  confirmedImage: ImageIdentity;
  coordinateSize: Size;
  coordinateReviewPending: boolean;
  highestIssuedNumber: number;
  style: ShapeStyle;
  items: AnnotationItem[];
}

type PlacementEdit = { subjects: PlacementSubject[] } & (
  | { kind: "align"; alignment: Alignment }
  | { kind: "distribute"; direction: DistributionDirection }
);

export type Edit =
  | { kind: "add"; region: Region; origin?: string }
  | { kind: "region"; id: string; region: Region; origin?: string }
  | { kind: "moveRegion"; id: string; position: Point; origin?: string }
  | { kind: "marker"; id: string; marker: Point; origin?: string }
  | { kind: "markerPreset"; ids: string[]; anchor: MarkerAnchor }
  | { kind: "geometry"; changes: GeometryChange[] }
  | PlacementEdit
  | StyleEdit
  | ItemStyleToggle
  | { kind: "number"; id: string; previousNumber: number; number: number }
  | { kind: "renumber"; previewVersion: number }
  | { kind: "screenId"; value: string; previous: string }
  | { kind: "moveRow"; id: string; target: string; side: "before" | "after"; previousOrder: string[] }
  | { kind: "name"; id: string; name: string; previousName?: string }
  | { kind: "remove"; ids: string[]; imageBasis?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isInteger(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isOptionalSizeStyle(style: Record<string, unknown>, size: Size): boolean {
  return (style.strokeWidth === undefined || isPositiveNumber(style.strokeWidth)) &&
    (style.markerDiameter === undefined || style.markerDiameter === null ||
      (isPositiveNumber(style.markerDiameter) && style.markerDiameter <= Math.min(size.width, size.height)));
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

function hasValidMarkerColors(style: Record<string, unknown>): boolean {
  return (style.markerStrokeColor === undefined || isColor(style.markerStrokeColor)) &&
    (style.markerFillColor === undefined || isColor(style.markerFillColor)) &&
    (style.markerTextColor === undefined || isColor(style.markerTextColor));
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

function isPlacementSubject(value: unknown): value is PlacementSubject {
  return isRecord(value) && isItemId(value.id) && (value.part === "region" || value.part === "marker");
}

function isCoordinatePatch(value: unknown, keys: readonly string[]): boolean {
  return isRecord(value) && Object.keys(value).length > 0 &&
    Object.entries(value).every(([key, coordinate]) => keys.includes(key) && isFiniteNumber(coordinate));
}

function isGeometryChange(value: unknown): value is GeometryChange {
  return isRecord(value) && isItemId(value.id) &&
    (value.region !== undefined || value.marker !== undefined) &&
    (value.region === undefined || isCoordinatePatch(value.region, ["x", "y", "width", "height"])) &&
    (value.marker === undefined || isCoordinatePatch(value.marker, ["x", "y"]));
}

function isItemId(value: unknown): value is string {
  return typeof value === "string" && itemIdPattern.test(value);
}

export function isRelativeImagePath(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !/^([a-z]:|\/)/i.test(value) &&
    !value.includes("\\") && !value.includes("\0");
}

function isItem(value: unknown, size: Size): value is AnnotationItem {
  return isRecord(value) && isItemId(value.id) &&
    isInteger(value.number, 1) && typeof value.name === "string" &&
    isRegion(value.region) && isPoint(value.marker) &&
    isRecord(value.values) && Object.values(value.values).every(item => typeof item === "string") &&
    (value.style === undefined || (isRecord(value.style) &&
      (value.style.color === undefined || isColor(value.style.color)) &&
      (value.style.lineStyle === undefined || isLineStyle(value.style.lineStyle)) &&
      hasValidMarkerColors(value.style) && isOptionalSizeStyle(value.style, size)));
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
      !isColor(style.color) || !isLineStyle(style.lineStyle) || !hasValidMarkerColors(style) ||
      !isOptionalSizeStyle(style, coordinateSize) ||
      !Array.isArray(items) || !items.every((item): item is AnnotationItem => isItem(item, coordinateSize))) {
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
  const screenId = value.screenId === undefined ? "" : value.screenId;
  if (typeof screenId !== "string" || /[\r\n]/.test(screenId)) throw new Error("画面IDは1行の文字列で指定してください。");
  return { ...value, version: 2, screenId, imagePath, confirmedImage, coordinateSize,
    coordinateReviewPending, highestIssuedNumber, style: { ...style, color: style.color, lineStyle: style.lineStyle }, items };
}

export function newAnnotation(imagePath: string, image: ImageIdentity, defaults?: unknown): AnnotationDocument {
  const settings = isRecord(defaults) ? defaults : {};
  const style: ShapeStyle = {
    color: isColor(settings.color) ? settings.color : "#113a60",
    lineStyle: isLineStyle(settings.lineStyle) ? settings.lineStyle : "solid",
  };
  if (isPositiveNumber(settings.strokeWidth)) style.strokeWidth = settings.strokeWidth;
  if (isColor(settings.markerStrokeColor)) style.markerStrokeColor = settings.markerStrokeColor;
  if (isColor(settings.markerFillColor)) style.markerFillColor = settings.markerFillColor;
  if (isColor(settings.markerTextColor)) style.markerTextColor = settings.markerTextColor;
  if (isPositiveNumber(settings.markerDiameter)) {
    style.markerDiameter = Math.min(settings.markerDiameter, image.width, image.height);
  }
  return {
    version: 2,
    imagePath,
    confirmedImage: image,
    coordinateSize: { width: image.width, height: image.height },
    coordinateReviewPending: false,
    highestIssuedNumber: 0,
    screenId: "",
    style,
    items: [],
  };
}

export function isEdit(value: unknown): value is Edit {
  if (!isRecord(value)) return false;
  if (value.origin !== undefined && typeof value.origin !== "string") return false;
  if (value.imageBasis !== undefined && typeof value.imageBasis !== "string") return false;
  if (value.kind === "add") return isRegion(value.region);
  if (value.kind === "renumber") return isInteger(value.previewVersion, 1);
  if (value.kind === "itemStyle") return isItemId(value.id) && typeof value.enabled === "boolean";
  if (value.kind === "screenId") return typeof value.value === "string" && !/[\r\n]/.test(value.value) &&
    typeof value.previous === "string";
  if (value.kind === "remove" || value.kind === "markerPreset") {
    return isAnnotationIds(value.ids) &&
      (value.kind === "remove" || isMarkerAnchor(value.anchor));
  }
  if (value.kind === "geometry") {
    return Array.isArray(value.changes) && value.changes.length > 0 && value.changes.every(isGeometryChange) &&
      new Set(value.changes.map(change => change.id)).size === value.changes.length;
  }
  if (value.kind === "align" || value.kind === "distribute") {
    if (!Array.isArray(value.subjects) || !value.subjects.every(isPlacementSubject) ||
        new Set(value.subjects.map(({ id }) => id)).size !== value.subjects.length) {
      return false;
    }
    return value.kind === "align"
      ? value.subjects.length >= 2 && isAlignment(value.alignment)
      : value.subjects.length >= 3 && isDistributionDirection(value.direction);
  }
  if (value.kind === "style") {
    if (value.id !== undefined && !isItemId(value.id)) return false;
    if (value.property === "strokeWidth" || value.property === "markerDiameter") {
      return value.value === null || isPositiveNumber(value.value);
    }
    if (value.property === "color" || value.property === "markerStrokeColor" ||
        value.property === "markerFillColor" || value.property === "markerTextColor") {
      return isColor(value.value);
    }
    if (value.property === "lineStyle") return isLineStyle(value.value);
    return false;
  }
  if (!isItemId(value.id)) return false;
  switch (value.kind) {
    case "number": return isInteger(value.number, 1) && isInteger(value.previousNumber, 1);
    case "moveRow": return isItemId(value.target) && value.target !== value.id &&
      (value.side === "before" || value.side === "after") && isAnnotationIds(value.previousOrder);
    case "region": return isRegion(value.region);
    case "moveRegion": return isPoint(value.position);
    case "marker": return isPoint(value.marker);
    case "name": return typeof value.name === "string" &&
      (value.previousName === undefined || typeof value.previousName === "string");
    default: return false;
  }
}

export function isAnnotationIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isItemId) && new Set(value).size === value.length;
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

export function effectiveMarkerDiameter(common: ShapeStyle, item: AnnotationItem): number | undefined {
  const diameter = item.style?.markerDiameter;
  return diameter === undefined ? common.markerDiameter ?? undefined : diameter ?? undefined;
}

export function markerRadius(number: number, size: Size, diameter?: number): number {
  if (diameter !== undefined) return diameter / 2;
  const shortestSide = Math.min(size.width, size.height);
  const radius = Math.max(7, Math.min(20, shortestSide * 0.025));
  return Math.min(shortestSide / 2, radius + Math.max(0, String(number).length - 2) * 3);
}

export function constrainMarker(point: Point, number: number, size: Size, diameter?: number): Point {
  const radius = markerRadius(number, size, diameter);
  return {
    x: clamp(point.x, radius, size.width - radius),
    y: clamp(point.y, radius, size.height - radius),
  };
}

function markerAnchorPoint(region: Region, anchor: MarkerAnchor): Point {
  const [horizontal, vertical] = markerAnchors[anchor];
  return { x: region.x + region.width * horizontal, y: region.y + region.height * vertical };
}

function setItemNumber(data: AnnotationDocument, item: AnnotationItem, number: number): void {
  const size = data.coordinateSize;
  const diameter = effectiveMarkerDiameter(data.style, item);
  if (markerRadius(number, size, diameter) > markerRadius(item.number, size, diameter)) {
    item.marker = constrainMarker(item.marker, number, size, diameter);
  }
  item.number = number;
  data.highestIssuedNumber = Math.max(data.highestIssuedNumber, number);
}

export function regionFits(region: Region, size: Size): boolean {
  const { x, y, width, height } = region;
  return isRegion(region) && x >= 0 && y >= 0 &&
    x + width <= size.width + 1e-7 && y + height <= size.height + 1e-7;
}

function markerFits(point: Point, number: number, size: Size, diameter?: number): boolean {
  const constrained = constrainMarker(point, number, size, diameter);
  return Number.isFinite(point.x) && Number.isFinite(point.y) &&
    Math.abs(constrained.x - point.x) < 1e-7 && Math.abs(constrained.y - point.y) < 1e-7;
}

export function placementBounds(item: AnnotationItem, target: ShapePart | "pair", size: Size, style: ShapeStyle): Region {
  if (target === "region") return item.region;
  const radius = markerRadius(item.number, size, effectiveMarkerDiameter(style, item));
  const circle = {
    x: item.marker.x - radius, y: item.marker.y - radius,
    width: 2 * radius, height: 2 * radius,
  };
  if (target === "marker") return circle;
  const { region } = item;
  const x = Math.min(region.x, circle.x);
  const y = Math.min(region.y, circle.y);
  return {
    x, y,
    width: Math.max(region.x + region.width, circle.x + circle.width) - x,
    height: Math.max(region.y + region.height, circle.y + circle.height) - y,
  };
}

export function markerAfterRegionMove(item: AnnotationItem, position: Point): Point {
  return {
    x: item.marker.x + (position.x - item.region.x),
    y: item.marker.y + (position.y - item.region.y),
  };
}

export function constrainRegionPosition(item: AnnotationItem, position: Point, size: Size, style: ShapeStyle): Point {
  const bounds = placementBounds(item, "pair", size, style);
  const x = clamp(position.x - item.region.x, -bounds.x, size.width - bounds.x - bounds.width);
  const y = clamp(position.y - item.region.y, -bounds.y, size.height - bounds.y - bounds.height);
  return { x: item.region.x + x, y: item.region.y + y };
}

function alignedPositions(
  targets: { bounds: Region; movement: Region }[],
  alignment: Alignment,
  axis: "x" | "y",
  imageLength: number,
): number[] {
  const length = axis === "x" ? "width" : "height";
  const fraction = alignment === "left" || alignment === "top" ? 0
    : alignment === "right" || alignment === "bottom" ? 1 : 0.5;
  const start = Math.min(...targets.map(({ bounds }) => bounds[axis]));
  const end = Math.max(...targets.map(({ bounds }) => bounds[axis] + bounds[length]));
  const edges = targets.map(({ bounds, movement }) => ({
    anchor: bounds[axis] + fraction * bounds[length],
    movement,
  }));
  const min = Math.max(...edges.map(({ anchor, movement }) => anchor - movement[axis]));
  const max = Math.min(...edges.map(({ anchor, movement }) =>
    anchor + imageLength - movement[axis] - movement[length]));
  if (min > max + 1e-7) throw new Error("矩形と番号を画像内に収めたまま揃えられません。");
  const common = clamp(start + fraction * (end - start), min, max);
  return targets.map(({ bounds }) => common - fraction * bounds[length]);
}

function distributedPositions(bounds: Region[], axis: "x" | "y"): number[] {
  const length = axis === "x" ? "width" : "height";
  const first = bounds[0];
  const last = bounds[bounds.length - 1];
  const totalLength = bounds.reduce((sum, region) => sum + region[length], 0);
  const freeSpace = last[axis] + last[length] - first[axis] - totalLength;
  if (freeSpace < -1e-7) {
    throw new Error("両端の間に十分な空きがありません。間隔を広げてから整列してください。");
  }
  const gap = Math.max(0, freeSpace) / (bounds.length - 1);
  let next = first[axis] + first[length] + gap;
  return bounds.map((region, index) => {
    if (index === 0 || index === bounds.length - 1) return region[axis];
    const position = next;
    next += region[length] + gap;
    return position;
  });
}

export function updatedGeometry(item: AnnotationItem, change: GeometryChange, size: Size, style: ShapeStyle): Partial<Pick<AnnotationItem, ShapePart>> {
  const updated: Partial<Pick<AnnotationItem, ShapePart>> = {};
  if (change.region) {
    updated.region = { ...item.region, ...change.region };
    if (!regionFits(updated.region, size)) throw new Error("幅と高さは正の値にし、矩形を画像の内側に収めてください。");
  }
  const markerFollows = updated.region && (updated.region.x !== item.region.x || updated.region.y !== item.region.y);
  if (change.marker || markerFollows) {
    const marker = markerFollows && updated.region ? markerAfterRegionMove(item, updated.region) : item.marker;
    updated.marker = { ...marker, ...change.marker };
    if (!markerFits(updated.marker, item.number, size, effectiveMarkerDiameter(style, item))) {
      throw new Error("番号全体が画像の内側に収まる座標を指定してください。");
    }
  }
  return updated;
}

function applyGeometryChanges(items: Map<string, AnnotationItem>, changes: GeometryChange[], size: Size, style: ShapeStyle): void {
  const updates = changes.map(change => {
    const item = items.get(change.id);
    if (!item) throw new Error("対象の項目が見つかりません。");
    return { item, geometry: updatedGeometry(item, change, size, style) };
  });
  for (const { item, geometry } of updates) Object.assign(item, geometry);
}

function arrangeItems(items: Map<string, AnnotationItem>, edit: PlacementEdit, size: Size, style: ShapeStyle): void {
  const horizontal = edit.kind === "distribute" ? edit.direction === "horizontal"
    : edit.alignment === "left" || edit.alignment === "center-x" || edit.alignment === "right";
  const axis = horizontal ? "x" : "y";
  const length = horizontal ? size.width : size.height;
  const span = horizontal ? "width" : "height";
  const targets = edit.subjects.map(({ id, part }) => {
    const item = items.get(id);
    if (!item) throw new Error("対象の項目が見つかりません。");
    return { item, part, bounds: placementBounds(item, part, size, style),
      movement: placementBounds(item, part === "region" ? "pair" : part, size, style) };
  });
  if (edit.kind === "distribute") targets.sort((a, b) => a.bounds[axis] - b.bounds[axis]);
  const positions = edit.kind === "align"
    ? alignedPositions(targets, edit.alignment, axis, length)
    : distributedPositions(targets.map(entry => entry.bounds), axis);

  const changes = targets.map(({ item, part, bounds, movement }, index): GeometryChange => {
    const position = positions[index];
    const offset = position - bounds[axis];
    if (edit.kind === "distribute" && (movement[axis] + offset < -1e-7 ||
        movement[axis] + movement[span] + offset > length + 1e-7)) {
      throw new Error("両端を固定して等間隔にすると図形が画像外に出ます。番号や両端の位置を調整してください。");
    }
    return part === "region"
      ? { id: item.id, region: { [axis]: position } }
      : { id: item.id, marker: { [axis]: item.marker[axis] + offset } };
  });
  applyGeometryChanges(items, changes, size, style);
}

export function applyStyleValue(style: Partial<ShapeStyle>, edit: StyleEdit): void {
  if (edit.value === null) delete style[edit.property];
  else Object.assign(style, { [edit.property]: edit.value });
}

export function resolvedItemStyle(common: ShapeStyle, overrides?: Partial<ShapeStyle>) {
  const style = { ...common, ...overrides };
  return {
    ...overrides,
    color: style.color,
    lineStyle: style.lineStyle,
    markerStrokeColor: style.markerStrokeColor ?? style.color,
    markerFillColor: style.markerFillColor ?? defaultMarkerColors.markerFillColor,
    markerTextColor: style.markerTextColor ?? defaultMarkerColors.markerTextColor,
    strokeWidth: style.strokeWidth ?? defaultStrokeWidth,
    markerDiameter: style.markerDiameter ?? null,
  };
}

export function updatedItemStyle(
  common: ShapeStyle, overrides: Partial<ShapeStyle> | undefined, edit: StyleEdit | ItemStyleToggle,
): ShapeStyle | undefined {
  if (edit.kind === "itemStyle" && !edit.enabled) return undefined;
  const style = resolvedItemStyle(common, overrides);
  if (edit.kind === "style") {
    if (edit.property === "markerDiameter") style.markerDiameter = edit.value;
    else if (edit.property === "strokeWidth") style.strokeWidth = edit.value ?? defaultStrokeWidth;
    else applyStyleValue(style, edit);
  }
  return style;
}

function editAnnotationStyle(data: AnnotationDocument, edit: StyleEdit | ItemStyleToggle): void {
  const item = edit.id === undefined ? undefined : data.items.find(entry => entry.id === edit.id);
  if (edit.id !== undefined && !item) throw new Error("対象の項目が見つかりません。");
  const size = data.coordinateSize;
  if (edit.kind === "style" && edit.property === "markerDiameter" &&
      edit.value !== null && edit.value > Math.min(size.width, size.height)) {
    throw new Error("番号の直径は画像の短辺以下にしてください。");
  }
  const affectedItems = item ? [item] : edit.kind === "style" && edit.property === "markerDiameter" ? data.items : [];
  const before = affectedItems.map(entry => ({
    item: entry, diameter: effectiveMarkerDiameter(data.style, entry),
  }));
  if (item) {
    const style = updatedItemStyle(data.style, item.style, edit);
    if (style) item.style = style;
    else delete item.style;
  } else if (edit.kind === "style") {
    applyStyleValue(data.style, edit);
  }
  for (const { item: affected, diameter } of before) {
    const updatedDiameter = effectiveMarkerDiameter(data.style, affected);
    if (updatedDiameter !== diameter) {
      affected.marker = constrainMarker(affected.marker, affected.number, size, updatedDiameter);
    }
  }
}

function allocateItemId(used: Set<string>, generateId: () => string): string {
  let id = generateId();
  for (let attempt = 1; used.has(id) && attempt < 10; attempt++) id = generateId();
  if (!isItemId(id) || used.has(id)) throw new Error("一意の項目IDを生成できませんでした。");
  used.add(id);
  return id;
}

export function pasteAnnotations(data: AnnotationDocument, copied: readonly AnnotationItem[], generateId: () => string): string[] {
  if (!copied.length) throw new Error("コピーした矩形がありません。");
  const size = data.coordinateSize;
  const used = new Set(data.items.map(item => item.id));
  const items = copied.map((source, index) => {
    const number = data.highestIssuedNumber + index + 1;
    if (!Number.isSafeInteger(number)) throw new Error("新規項目に割り当てられる番号がありません。");
    const item = structuredClone(source);
    return { ...item, id: allocateItemId(used, generateId), number };
  });
  const bounds = items.map(item => placementBounds(item, "pair", size, data.style));
  const left = Math.min(...bounds.map(box => box.x));
  const top = Math.min(...bounds.map(box => box.y));
  const right = Math.max(...bounds.map(box => box.x + box.width));
  const bottom = Math.max(...bounds.map(box => box.y + box.height));
  if (right - left > size.width || bottom - top > size.height) {
    throw new Error("コピーした矩形と番号が貼り付け先の画像に収まりません。");
  }
  const offsetX = clamp(right < size.width ? 12 : -12, -left, size.width - right);
  const offsetY = clamp(bottom < size.height ? 12 : -12, -top, size.height - bottom);
  for (const item of items) {
    const x = item.region.x + offsetX;
    const y = item.region.y + offsetY;
    Object.assign(item, updatedGeometry(item, {
      id: item.id, region: { x, y }, marker: { x: item.marker.x + offsetX, y: item.marker.y + offsetY },
    }, size, data.style));
  }
  data.items.push(...items);
  data.highestIssuedNumber += items.length;
  return items.map(item => item.id);
}

// Snapshot the image basis and, for a drag, the geometry used to compute its destination.
export function geometryBasis(data: AnnotationDocument, item?: AnnotationItem): string {
  const { width, height } = data.coordinateSize;
  const basis = [data.imagePath, data.confirmedImage.sha256, width, height];
  if (item) {
    const { x, y, width, height } = item.region;
    basis.push(item.id, x, y, width, height, item.marker.x, item.marker.y,
      markerRadius(item.number, data.coordinateSize, effectiveMarkerDiameter(data.style, item)));
  }
  return JSON.stringify(basis);
}

export function applyAnnotationEdit(
  data: AnnotationDocument,
  edit: Edit,
  generateId: () => string,
  defaultMarkerAnchor: MarkerAnchor = "top-right",
): string | undefined {
  const size = data.coordinateSize;
  if ("imageBasis" in edit && edit.imageBasis !== undefined && edit.imageBasis !== geometryBasis(data)) {
    throw new Error("原画像の基準が更新されました。最新の画像を確認してください。");
  }
  if ("origin" in edit && edit.origin !== undefined) {
    const target = edit.kind === "add" ? undefined : data.items.find(item => item.id === edit.id);
    if (edit.origin !== geometryBasis(data, target)) {
      throw new Error("ドラッグ中に対象の図形または原画像が更新されました。最新の位置から操作し直してください。");
    }
  }
  if ((edit.kind === "add" || edit.kind === "region") && !regionFits(edit.region, size)) {
    throw new Error("矩形を画像の内側に収めてください。");
  }
  if (edit.kind === "renumber") {
    data.items.forEach((item, index) => setItemNumber(data, item, index + 1));
    return;
  }
  if (edit.kind === "screenId") {
    if (data.screenId !== edit.previous) throw new Error("画面IDが更新されました。最新の値を確認してください。");
    data.screenId = edit.value;
    return;
  }
  if (edit.kind === "align" || edit.kind === "distribute" || edit.kind === "geometry") {
    const items = new Map(data.items.map(item => [item.id, item]));
    if (edit.kind === "geometry") applyGeometryChanges(items, edit.changes, size, data.style);
    else arrangeItems(items, edit, size, data.style);
    return;
  }
  if (edit.kind === "style" || edit.kind === "itemStyle") {
    editAnnotationStyle(data, edit);
    return;
  }
  if (edit.kind === "remove" || edit.kind === "markerPreset") {
    const items = new Map(data.items.map(item => [item.id, item]));
    const targets = edit.ids.map(id => {
      const item = items.get(id);
      if (!item) throw new Error("対象の項目が見つかりません。");
      return item;
    });
    if (edit.kind === "remove") {
      const ids = new Set(edit.ids);
      data.items = data.items.filter(item => !ids.has(item.id));
    } else {
      const markers = targets.map(item => {
        const point = markerAnchorPoint(item.region, edit.anchor);
        const diameter = effectiveMarkerDiameter(data.style, item);
        if (edit.anchor !== "center") return constrainMarker(point, item.number, size, diameter);
        if (!markerFits(point, item.number, size, diameter)) {
          throw new Error("矩形の中央に番号が収まりません。番号の直径を小さくしてください。");
        }
        return point;
      });
      targets.forEach((item, index) => { item.marker = markers[index]; });
    }
    return;
  }
  if (edit.kind === "add") {
    const number = data.highestIssuedNumber + 1;
    if (!Number.isSafeInteger(number)) throw new Error("新規項目に割り当てられる番号がありません。");
    const { region } = edit;
    const marker = constrainMarker(markerAnchorPoint(region, defaultMarkerAnchor), number, size, data.style.markerDiameter ?? undefined);
    const used = new Set(data.items.map(item => item.id));
    const id = allocateItemId(used, generateId);
    data.items.push({ id, number, name: "", region, marker, values: {} });
    data.highestIssuedNumber = number;
    return id;
  }

  const index = data.items.findIndex(item => item.id === edit.id);
  if (index < 0) throw new Error("対象の項目が見つかりません。");
  const item = data.items[index];
  switch (edit.kind) {
    case "moveRow": {
      const target = data.items.findIndex(other => other.id === edit.target);
      if (target < 0 || data.items.length !== edit.previousOrder.length ||
          data.items.some((other, i) => other.id !== edit.previousOrder[i])) {
        throw new Error("行順が更新されました。最新の順序から操作し直してください。");
      }
      const insertion = target + (edit.side === "after" ? 1 : 0);
      data.items.splice(index, 1);
      data.items.splice(insertion > index ? insertion - 1 : insertion, 0, item);
      break;
    }
    case "number":
      if (item.number !== edit.previousNumber) throw new Error("番号が更新されました。最新の番号を確認してください。");
      if (!isInteger(edit.number, 1)) throw new Error("1以上の整数を入力してください。");
      if (data.items.some(other => other.id !== item.id && other.number === edit.number)) {
        throw new Error(`${edit.number}番は使用中です。別の番号を入力してください。`);
      }
      setItemNumber(data, item, edit.number);
      break;
    case "region":
      item.region = edit.region;
      break;
    case "moveRegion": {
      const position = constrainRegionPosition(item, edit.position, size, data.style);
      Object.assign(item, updatedGeometry(item, { id: item.id, region: position }, size, data.style));
      break;
    }
    case "marker":
      item.marker = constrainMarker(edit.marker, item.number, size, effectiveMarkerDiameter(data.style, item));
      break;
    case "name":
      if (edit.previousName !== undefined && edit.previousName !== item.name) {
        throw new Error("名称が更新されました。最新の名称を確認してください。");
      }
      item.name = edit.name;
      break;
  }
}
