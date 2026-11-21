import {
  applyStyleValue, clamp, constrainMarker, constrainRegionPosition, defaultStrokeWidth, effectiveMarkerDiameter,
  isAlignment, isDistributionDirection, isLineStyle, markerAfterRegionMove, markerRadius, placementBounds, regionBetween, updatedGeometry,
} from "../annotation";
import type {
  AnnotationItem, Edit, GeometryChange, NumericStyleProperty, PlacementSubject,
  PlacementTarget, Point, Region, ShapePart, ShapeStyle,
} from "../annotation";
import type { DocumentState, EditorMessage, HostMessage, OriginalImage } from "../protocol";
import { materialIcon } from "../material-icons";

declare function acquireVsCodeApi(): { postMessage(message: EditorMessage): void };
const vscode = acquireVsCodeApi();

function element<T extends Element>(id: string): T {
  const node = document.querySelector<T>("#" + id);
  if (!node) throw new Error("Missing editor element: " + id);
  return node;
}

const editor = element<HTMLElement>("editor");
const viewport = element<HTMLElement>("viewport");
const surface = element<HTMLElement>("surface");
const canvas = element<HTMLCanvasElement>("original");
const annotations = element<SVGSVGElement>("annotations");
const rows = element<HTMLTableSectionElement>("rows");
const notice = element<HTMLElement>("notice");
const empty = element<HTMLElement>("empty");
const splitter = element<HTMLElement>("splitter");
const jsonActions = element<HTMLElement>("json-actions");
const zoom = element<HTMLOutputElement>("zoom");
const selectButton = element<HTMLButtonElement>("select");
const drawButton = element<HTMLButtonElement>("draw");
const panButton = element<HTMLButtonElement>("pan");
const removeButton = element<HTMLButtonElement>("remove");
const zoomIn = element<HTMLButtonElement>("zoom-in");
const zoomOut = element<HTMLButtonElement>("zoom-out");
const fitButton = element<HTMLButtonElement>("fit");
const imageStyle = element<HTMLFieldSetElement>("image-style");
const imageStyleToggle = element<HTMLButtonElement>("image-style-toggle");
const imageColor = element<HTMLInputElement>("image-color");
const imageLine = element<HTMLSelectElement>("image-line");
const imageStrokeWidth = element<HTMLInputElement>("image-stroke-width");
const imageMarkerDiameter = element<HTMLInputElement>("image-marker-diameter");
const alignmentTools = element<HTMLElement>("alignment");
const selectionCount = element("selection-count");
const placementTarget = element<HTMLSelectElement>("placement-target");
const itemProperties = element<HTMLElement>("item-properties");
const itemStyle = element<HTMLFieldSetElement>("item-style");
const geometryForm = element<HTMLFormElement>("geometry");
const geometryFields = element<HTMLFieldSetElement>("geometry-fields");
const geometryTitle = element("geometry-title");
const geometryError = element<HTMLElement>("geometry-error");
const regionFields = {
  x: element<HTMLInputElement>("region-x"), y: element<HTMLInputElement>("region-y"),
  width: element<HTMLInputElement>("region-width"), height: element<HTMLInputElement>("region-height"),
};
const markerFields = { x: element<HTMLInputElement>("marker-x"), y: element<HTMLInputElement>("marker-y") };
const overrideColor = element<HTMLInputElement>("override-color");
const itemColor = element<HTMLInputElement>("item-color");
const itemLine = element<HTMLSelectElement>("item-line");
const itemStrokeWidth = element<HTMLInputElement>("item-stroke-width");
const itemMarkerDiameter = element<HTMLInputElement>("item-marker-diameter");

const numericStyleFields = [
  { input: imageStrokeWidth, property: "strokeWidth", scope: "image" },
  { input: imageMarkerDiameter, property: "markerDiameter", scope: "image" },
  { input: itemStrokeWidth, property: "strokeWidth", scope: "item" },
  { input: itemMarkerDiameter, property: "markerDiameter", scope: "item" },
] as const;
const styleDrafts = new Map<HTMLInputElement, string | undefined>();

let state: DocumentState | undefined;
let original: OriginalImage | undefined;
let originalError: string | undefined;
let editError: string | undefined;
let editStatus: string | undefined;
let imageRequest = 0;
const selection = { region: new Set<string>(), marker: new Set<string>() };
const shapeParts = ["region", "marker"] as const;
let mode: "select" | "draw" | "pan" = "select";
let scale = 1;
let offset: Point = { x: 0, y: 0 };
let geometrySelection = "";
const changedInputs = new Set<HTMLInputElement>();

type Gesture =
  | { kind: "pan"; start: Point; offset: Point }
  | { kind: "add"; start: Point; preview?: Region }
  | { kind: "select-box"; start: Point; additive: boolean; subject?: { id: string; part: ShapePart }; preview?: Region }
  | { kind: "move"; start: Point; item: AnnotationItem; preview?: Region }
  | { kind: "resize"; anchor: Point; item: AnnotationItem; preview?: Region }
  | { kind: "marker"; start: Point; item: AnnotationItem; preview?: Point };
let gesture: (Gesture & { pointer: number; pointerStart: Point }) | undefined;

type QueuedOperation = { kind: "save" | "saveDefaultStyle" } | { kind: "edit"; edit: Edit };
const pending: QueuedOperation[] = [];
let current: { operation: QueuedOperation; request: number } | undefined;
let nextRequest = 0;

function enqueue(operation: QueuedOperation): void {
  const previous = pending.at(-1);
  if (operation.kind === "edit" && operation.edit.kind === "name" &&
      previous?.kind === "edit" && previous.edit.kind === "name" && previous.edit.id === operation.edit.id) {
    pending[pending.length - 1] = operation;
  } else {
    pending.push(operation);
  }
  editError = undefined;
  editStatus = undefined;
  sendNext();
  renderNotice();
}

function sendNext(): void {
  if (current || !state) return;
  const operation = pending.shift();
  if (!operation) return;
  const request = ++nextRequest;
  current = { operation, request };
  const version = state.version;
  if (operation.kind === "edit") {
    vscode.postMessage({ type: "edit", request, version, edit: operation.edit });
  } else {
    vscode.postMessage({ type: operation.kind, request, version });
  }
}

function queuedEdits(): Edit[] {
  return [current?.operation, ...pending].flatMap(operation => operation?.kind === "edit" ? [operation.edit] : []);
}

function applyState(next: DocumentState): void {
  if (state && next.version < state.version) return;
  if (next.data?.imagePath !== state?.data?.imagePath) {
    original = undefined;
    originalError = undefined;
    surface.hidden = true;
    ++imageRequest;
  }
  state = next;
  const ids = new Set(state.data?.items.map(item => item.id));
  for (const part of shapeParts) {
    for (const id of selection[part]) {
      if (!ids.has(id)) selection[part].delete(id);
    }
  }
  render();
}

window.addEventListener("message", event => {
  const message: HostMessage = event.data;
  if (!message || typeof message !== "object") return;
  switch (message.type) {
    case "state":
      applyState(message.state);
      sendNext();
      break;
    case "image":
      if (message.imagePath === state?.data?.imagePath) void displayImage(message.image, message.error);
      break;
    case "markerPreset": {
      const multiple = selection.region.size + selection.marker.size > 1;
      const ids = multiple && selection.region.size ? [...selection.region] : [message.id];
      if (hasEditableGeometry() && applyGeometry()) {
        enqueue({ kind: "edit", edit: { kind: "markerPreset", ids, anchor: message.anchor } });
      }
      break;
    }
    case "result":
      if (current?.request !== message.request) return;
      const { operation } = current;
      current = undefined;
      if (message.error) {
        editError = message.error;
        // Skip pending saves when an earlier edit in the queue fails.
        for (let i = pending.length - 1; i >= 0; i--) {
          if (pending[i].kind !== "edit") pending.splice(i, 1);
        }
      } else if (operation.kind === "saveDefaultStyle") {
        editStatus = "新規画像の既定スタイルを VS Code の設定に保存しました。";
      }
      if (message.selectedId) {
        setSelection(message.selectedId, "pair", false);
      }
      applyState(message.state);
      sendNext();
      break;
  }
});

async function displayImage(image?: OriginalImage, error?: string): Promise<void> {
  const request = ++imageRequest;
  original = undefined;
  originalError = error;
  surface.hidden = true;
  render();
  if (!image) return;
  try {
    const bitmap = await createImageBitmap(new Blob([image.bytes], { type: image.mime }), {
      imageOrientation: "from-image",
    });
    try {
      if (request !== imageRequest) return;
      if (bitmap.width !== image.identity.width || bitmap.height !== image.identity.height) {
        throw new Error("画像ヘッダーとデコード後の寸法が一致しません。");
      }
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("画像の描画を開始できませんでした。");
      context.drawImage(bitmap, 0, 0);
      annotations.setAttribute("viewBox", `0 0 ${bitmap.width} ${bitmap.height}`);
      original = image;
      surface.hidden = false;
      fit();
    } finally {
      bitmap.close();
    }
  } catch (error) {
    if (request === imageRequest) {
      originalError = error instanceof Error ? error.message : "原画像を表示できません。";
    }
  }
  render();
}

function hasEditableGeometry(): boolean {
  const data = state?.data;
  return !!(original && data && original.identity.width === data.coordinateSize.width &&
    original.identity.height === data.coordinateSize.height);
}

function renderNotice(): void {
  const data = state?.data;
  const changed = original && data && original.identity.sha256 !== data.confirmedImage.sha256;
  let imageStatus: string | undefined;
  if (original && data && !hasEditableGeometry()) {
    imageStatus = "原画像と注釈の基準寸法が異なります。矩形と丸番号の編集を一時停止しています。";
  } else if (changed) {
    imageStatus = "原画像が更新されています。保存済みの注釈位置を確認してください。";
  }
  notice.textContent = state?.error ?? originalError ?? editError ?? imageStatus ?? editStatus ??
    (original ? "" : "原画像を読み込んでいます…");
  notice.hidden = !notice.textContent;
  jsonActions.hidden = !state?.error;
}

function render(): void {
  renderNotice();
  renderAnnotations();
  renderRows();
  renderImageStyle();
  renderProperties();
  zoomIn.disabled = zoomOut.disabled = fitButton.disabled = !original;
  selectButton.disabled = !original;
  drawButton.disabled = !hasEditableGeometry();
  panButton.disabled = !original;
}

interface RowControls {
  row: HTMLTableRowElement;
  checkbox: HTMLInputElement;
  number: HTMLButtonElement;
  numberLabel: HTMLSpanElement;
  name: HTMLTextAreaElement;
  composing: boolean;
}
const rowElements = new Map<string, RowControls>();

function renderRowSelection(id: string, controls: RowControls): void {
  const selected = hasSelectedShape(id);
  const both = selection.region.has(id) && selection.marker.has(id);
  controls.row.classList.toggle("selected", selected);
  controls.checkbox.checked = both;
  controls.checkbox.indeterminate = selected && !both;
  controls.number.setAttribute("aria-pressed", selected && !both ? "mixed" : String(both));
}

function renderRows(): void {
  const items = state?.data?.items ?? [];
  const editingNames = new Set(queuedEdits().flatMap(edit => edit.kind === "name" ? [edit.id] : []));
  const visibleIds = new Set(items.map(item => item.id));
  for (const [id, controls] of rowElements) {
    if (!visibleIds.has(id)) {
      controls.row.remove();
      rowElements.delete(id);
    }
  }
  items.forEach((item, index) => {
    let controls = rowElements.get(item.id);
    if (!controls) {
      const row = rows.insertRow();
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.addEventListener("change", () => select(item.id, "pair", true));
      row.insertCell().append(checkbox);
      const number = document.createElement("button");
      number.type = "button";
      number.className = "row-number icon-button";
      number.innerHTML = materialIcon("tag");
      const numberLabel = document.createElement("span");
      number.append(numberLabel);
      number.addEventListener("click", event => select(item.id, "pair", event.ctrlKey || event.metaKey || event.shiftKey));
      row.insertCell().append(number);
      const name = document.createElement("textarea");
      name.rows = 1;
      name.addEventListener("focus", () => select(item.id));
      const commit = () => enqueue({ kind: "edit", edit: { kind: "name", id: item.id, name: name.value } });
      const entry = { row, checkbox, number, numberLabel, name, composing: false };
      name.addEventListener("compositionstart", () => { entry.composing = true; });
      name.addEventListener("compositionend", () => {
        entry.composing = false;
        commit();
      });
      name.addEventListener("input", event => {
        if (!entry.composing && !(event as InputEvent).isComposing) commit();
      });
      row.insertCell().append(name);
      controls = entry;
      rowElements.set(item.id, controls);
    }
    if (rows.rows[index] !== controls.row) rows.insertBefore(controls.row, rows.rows[index] ?? null);
    renderRowSelection(item.id, controls);
    controls.checkbox.setAttribute("aria-label", `${item.number}番を選択`);
    controls.numberLabel.textContent = String(item.number);
    controls.number.title = `${item.number}番の図形を選択`;
    controls.number.setAttribute("aria-label", controls.number.title);
    controls.name.setAttribute("aria-label", `${item.number}番の名称`);
    if (!editingNames.has(item.id) && !controls.composing && controls.name.value !== item.name) {
      controls.name.value = item.name;
    }
  });
  empty.hidden = items.length > 0;
}

function hasSelectedShape(id: string): boolean {
  return selection.region.has(id) || selection.marker.has(id);
}

function selectedItems(): AnnotationItem[] {
  return state?.data?.items.filter(item => hasSelectedShape(item.id)) ?? [];
}

function setSelection(id: string | undefined, part: PlacementTarget, toggle: boolean): void {
  if (!toggle) {
    selection.region.clear();
    selection.marker.clear();
  }
  if (id) {
    const parts = part === "pair" ? shapeParts : [part];
    const remove = toggle && parts.every(selectedPart => selection[selectedPart].has(id));
    for (const selectedPart of parts) {
      if (remove) selection[selectedPart].delete(id);
      else selection[selectedPart].add(id);
    }
  }
}

function select(id: string | undefined, part: PlacementTarget = "pair", toggle = false): void {
  setSelection(id, part, toggle);
  renderSelection();
}

function renderSelection(): void {
  renderAnnotations();
  for (const [rowId, controls] of rowElements) renderRowSelection(rowId, controls);
  renderProperties();
}

function placementSubjects(items = selectedItems()): PlacementSubject[] {
  const target = placementTarget.value;
  if (target === "pair") return items.map(({ id }) => ({ id, part: "pair" }));
  return items.flatMap<PlacementSubject>(({ id }) => {
    if ((target === "selected" || target === "region") && selection.region.has(id)) return [{ id, part: "region" }];
    if ((target === "selected" || target === "marker") && selection.marker.has(id)) return [{ id, part: "marker" }];
    return [];
  });
}

function pendingGeometry(items: AnnotationItem[], edits: Edit[]): AnnotationItem[] {
  const draft = new Map(items.map(item => [item.id, item]));
  for (const edit of edits) {
    if (edit.kind !== "geometry") continue;
    for (const change of edit.changes) {
      const item = draft.get(change.id);
      if (item) {
        const region = { ...item.region, ...change.region };
        draft.set(item.id, { ...item, region, marker: { ...markerAfterRegionMove(item, region), ...change.marker } });
      }
    }
  }
  return [...draft.values()];
}

function pendingStyle<T extends Partial<ShapeStyle>>(saved: T, id?: string, edits = queuedEdits()): T {
  const style = { ...saved };
  for (const edit of edits) {
    if (edit.kind === "style" && edit.id === id) applyStyleValue(style, edit);
  }
  return style;
}

function renderStyleNumber(input: HTMLInputElement, value: number | undefined): void {
  if (styleDrafts.has(input)) return;
  const current = value === undefined ? "" : String(value);
  if (input.value !== current) input.value = current;
}

function renderProperties(): void {
  const data = state?.data;
  const items = selectedItems();
  const canEditGeometry = hasEditableGeometry();
  imageStyleToggle.disabled = !data;
  imageStyle.disabled = !data;
  const shapeCount = selection.region.size + selection.marker.size;
  const subjects = placementSubjects(items);
  alignmentTools.hidden = shapeCount < 2;
  selectionCount.textContent = `${shapeCount}図形を選択`;
  for (const button of alignmentTools.querySelectorAll("button")) {
    const minimumSelection = button.dataset.distribute ? 3 : 2;
    button.disabled = !canEditGeometry || subjects.length < minimumSelection;
  }

  const item = items.length === 1 ? items[0] : undefined;
  itemProperties.hidden = !shapeCount;
  itemStyle.hidden = !item;
  for (const input of [itemStrokeWidth, itemMarkerDiameter]) {
    if (styleDrafts.get(input) !== item?.id) styleDrafts.delete(input);
  }
  removeButton.disabled = !items.length;
  geometryFields.disabled = !canEditGeometry;
  const key = items.map(({ id }) =>
    `${id}:${Number(selection.region.has(id))}${Number(selection.marker.has(id))}`).join(",");
  if (key !== geometrySelection) {
    geometrySelection = key;
    changedInputs.clear();
    geometryError.hidden = true;
  }
  geometryTitle.textContent = item ? `${item.number}番の位置とサイズ（px）` : "選択した図形の位置とサイズ（px）";
  const edits = queuedEdits();
  const draft = pendingGeometry(items, edits);
  renderCoordinates(regionFields, draft.filter(entry => selection.region.has(entry.id)).map(entry => entry.region));
  renderCoordinates(markerFields, draft.filter(entry => selection.marker.has(entry.id)).map(entry => entry.marker));
  if (!item || !data) return;
  const style = pendingStyle(data.style, undefined, edits);
  const overrides = pendingStyle(item.style ?? {}, item.id, edits);
  overrideColor.checked = overrides.color !== undefined;
  itemColor.disabled = !overrideColor.checked;
  itemColor.value = overrides.color ?? style.color;
  itemLine.value = overrides.lineStyle ?? "";
  renderStyleNumber(itemStrokeWidth, overrides.strokeWidth);
  renderStyleNumber(itemMarkerDiameter, overrides.markerDiameter);
}

function renderCoordinates<Key extends string>(fields: Record<Key, HTMLInputElement>, values: Record<Key, number>[]): void {
  for (const key of Object.keys(fields) as Key[]) {
    const input = fields[key];
    input.disabled = values.length === 0;
    if (changedInputs.has(input)) continue;
    const first = values[0]?.[key];
    const mixed = !values.every(value => value[key] === first);
    const next = first === undefined || mixed ? "" : String(first);
    if (input.value !== next) input.value = next;
    input.placeholder = mixed ? "混在" : "";
  }
}

function renderImageStyle(): void {
  const style = state?.data?.style;
  if (!style) return;
  const draft = pendingStyle(style);
  imageColor.value = draft.color;
  imageLine.value = draft.lineStyle;
  renderStyleNumber(imageStrokeWidth, draft.strokeWidth ?? defaultStrokeWidth);
  renderStyleNumber(imageMarkerDiameter, draft.markerDiameter);
}

function changedCoordinates<Key extends string>(fields: Record<Key, HTMLInputElement>): Partial<Record<Key, number>> | undefined {
  const coordinates: Partial<Record<Key, number>> = {};
  for (const key of Object.keys(fields) as Key[]) {
    const input = fields[key];
    if (changedInputs.has(input) && input.value !== "") coordinates[key] = input.valueAsNumber;
  }
  return Object.keys(coordinates).length ? coordinates : undefined;
}

function applyGeometry(): boolean {
  if (!changedInputs.size) return true;
  const data = state?.data;
  if (!data || !hasEditableGeometry() || !geometryForm.reportValidity()) return false;
  const size = data.coordinateSize;
  const edits = queuedEdits();
  const common = pendingStyle(data.style, undefined, edits);
  const region = changedCoordinates(regionFields);
  const marker = changedCoordinates(markerFields);
  const changes: GeometryChange[] = [];
  try {
    for (const item of pendingGeometry(selectedItems(), edits)) {
      const change = { id: item.id, region: selection.region.has(item.id) ? region : undefined,
        marker: selection.marker.has(item.id) ? marker : undefined };
      if (!change.region && !change.marker) continue;
      const draft = { ...item, style: pendingStyle(item.style ?? {}, item.id, edits) };
      const diameter = effectiveMarkerDiameter(common, draft);
      if (diameter !== effectiveMarkerDiameter(data.style, item)) {
        draft.marker = constrainMarker(draft.marker, draft.number, size, diameter);
      }
      updatedGeometry(draft, change, size, common);
      changes.push(change);
    }
  } catch (error) {
    geometryError.textContent = error instanceof Error ? error.message : "座標を確認してください。";
    geometryError.hidden = false;
    return false;
  }
  changedInputs.clear();
  geometryError.hidden = true;
  if (changes.length) enqueue({ kind: "edit", edit: { kind: "geometry", changes } });
  renderProperties();
  return true;
}

geometryForm.addEventListener("input", event => {
  if (event.target instanceof HTMLInputElement) changedInputs.add(event.target);
});
geometryForm.addEventListener("submit", event => {
  event.preventDefault();
  applyGeometry();
});

function commitStyleNumber(input: HTMLInputElement, property: NumericStyleProperty): boolean {
  if (!styleDrafts.has(input)) return true;
  const data = state?.data;
  if (!data) return false;
  const id = styleDrafts.get(input);
  const value = input.value === "" ? null : input.valueAsNumber;
  const label = property === "strokeWidth" ? "線の太さ" : "丸番号の直径";
  if (input.validity.badInput || (value !== null && (!Number.isFinite(value) || value <= 0))) {
    editError = `${label}には0より大きい値を入力してください。`;
  } else if (property === "markerDiameter" && value !== null &&
      value > Math.min(data.coordinateSize.width, data.coordinateSize.height)) {
    editError = "丸番号の直径は画像の短辺以下にしてください。";
  } else {
    styleDrafts.delete(input);
    enqueue({ kind: "edit", edit: { kind: "style", id, property, value } });
    return true;
  }
  renderNotice();
  return false;
}

for (const { input, property, scope } of numericStyleFields) {
  input.addEventListener("input", () => {
    const [item] = selectedItems();
    if (scope === "item" && !item) return;
    styleDrafts.set(input, scope === "item" ? item.id : undefined);
  });
  input.addEventListener("change", () => { commitStyleNumber(input, property); });
  input.addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    commitStyleNumber(input, property);
  });
}

element<HTMLButtonElement>("save-default-style").addEventListener("click", () => {
  if (numericStyleFields.filter(field => field.scope === "image")
    .every(({ input, property }) => commitStyleNumber(input, property))) {
    enqueue({ kind: "saveDefaultStyle" });
  }
});
imageStyleToggle.addEventListener("click", () => {
  imageStyle.hidden = !imageStyle.hidden;
  imageStyleToggle.setAttribute("aria-expanded", String(!imageStyle.hidden));
});
imageColor.addEventListener("change", () => enqueue({
  kind: "edit", edit: { kind: "style", property: "color", value: imageColor.value },
}));
imageLine.addEventListener("change", () => {
  if (isLineStyle(imageLine.value)) enqueue({
    kind: "edit", edit: { kind: "style", property: "lineStyle", value: imageLine.value },
  });
});
overrideColor.addEventListener("change", () => {
  const [item] = selectedItems();
  if (!item) return;
  itemColor.disabled = !overrideColor.checked;
  enqueue({ kind: "edit", edit: { kind: "style", id: item.id, property: "color",
    value: overrideColor.checked ? itemColor.value : null } });
});
itemColor.addEventListener("change", () => {
  const [item] = selectedItems();
  if (item && overrideColor.checked) enqueue({
    kind: "edit", edit: { kind: "style", id: item.id, property: "color", value: itemColor.value },
  });
});
itemLine.addEventListener("change", () => {
  const [item] = selectedItems();
  if (!item) return;
  const value = itemLine.value;
  if (value === "" || isLineStyle(value)) enqueue({
    kind: "edit", edit: { kind: "style", id: item.id, property: "lineStyle", value: value || null },
  });
});
placementTarget.addEventListener("change", renderProperties);
for (const button of alignmentTools.querySelectorAll("button")) {
  button.addEventListener("click", () => {
    if (button.disabled || !applyGeometry()) return;
    const subjects = placementSubjects();
    const alignment = button.dataset.align;
    const direction = button.dataset.distribute;
    if (isAlignment(alignment)) enqueue({
      kind: "edit", edit: { kind: "align", subjects, alignment },
    });
    if (isDistributionDirection(direction)) enqueue({
      kind: "edit", edit: { kind: "distribute", subjects, direction },
    });
  });
}

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

function appendSelectionHighlight(group: SVGGElement, tag: "rect" | "circle", geometry: Record<string, number>): void {
  group.append(
    svg(tag, { ...geometry, class: "selection-halo", "aria-hidden": "true" }),
    svg(tag, { ...geometry, class: "selection-outline", "aria-hidden": "true" }),
  );
}

function renderAnnotations(): void {
  annotations.replaceChildren();
  const data = state?.data;
  if (!data || !original) return;
  const resizeEnabled = selection.region.size === 1 && selectedItems().length === 1 &&
    mode !== "pan" && hasEditableGeometry();
  const markers = svg("g", {});
  const selectedRegions: SVGGElement[] = [];
  const selectedMarkers: SVGGElement[] = [];
  for (const item of data.items) {
    const regionSelected = selection.region.has(item.id);
    const markerSelected = selection.marker.has(item.id);
    const group = svg("g", { "data-id": item.id });
    const markerGroup = svg("g", { "data-id": item.id });
    const active = gesture && "item" in gesture && gesture.item.id === item.id ? gesture : undefined;
    const rect = (active?.kind === "move" || active?.kind === "resize") ? active.preview ?? item.region : item.region;
    let marker = item.marker;
    if (active?.kind === "move" && active.preview) marker = markerAfterRegionMove(active.item, active.preview);
    if (active?.kind === "marker" && active.preview) marker = active.preview;
    const style = { ...data.style, ...item.style };
    const strokeWidth = style.strokeWidth ?? defaultStrokeWidth;
    const dashArray = { solid: "none", dashed: "7 4", dotted: "1 4" }[style.lineStyle];
    const stroke = { stroke: style.color, "stroke-dasharray": dashArray, "stroke-width": strokeWidth };
    group.append(svg("rect", { ...rect, ...stroke, class: "region", "data-drag": "move" }));
    if (regionSelected) appendSelectionHighlight(group, "rect", { ...rect });
    const radius = markerRadius(item.number, data.coordinateSize, style.markerDiameter);
    const circle = { cx: marker.x, cy: marker.y, r: radius };
    const markerShape = svg("circle", { ...circle, ...stroke, class: "marker", "data-drag": "marker" });
    if (hasEditableGeometry()) markerShape.setAttribute("data-vscode-context", JSON.stringify({
      webviewSection: "annotationMarker", annotationMarker: item.id, preventDefaultContextMenuItems: true,
    }));
    markerGroup.append(markerShape);
    if (markerSelected) appendSelectionHighlight(markerGroup, "circle", circle);
    const label = svg("text", {
      x: marker.x, y: marker.y, class: "marker-text",
      "font-size": radius * Math.min(1.1, 2.5 / String(item.number).length),
    });
    label.textContent = String(item.number);
    markerGroup.append(label);
    if (markerSelected) selectedMarkers.push(markerGroup);
    else markers.append(markerGroup);
    if (regionSelected && resizeEnabled) {
      for (const x of [0, 1]) {
        for (const y of [0, 1]) {
          group.append(svg("circle", {
            cx: rect.x + rect.width * x, cy: rect.y + rect.height * y, r: 5 / scale,
            class: "handle", "data-drag": "resize", "data-x": x, "data-y": y,
          }));
        }
      }
    }
    if (regionSelected) selectedRegions.push(group);
    else annotations.append(group);
  }
  markers.append(...selectedMarkers);
  annotations.append(...selectedRegions, markers);
  if (gesture?.kind === "add" && gesture.preview) {
    annotations.append(svg("rect", { ...gesture.preview, stroke: data.style.color,
      "stroke-width": data.style.strokeWidth ?? defaultStrokeWidth, class: "region preview" }));
  }
  if (gesture?.kind === "select-box" && gesture.preview) {
    annotations.append(svg("rect", { ...gesture.preview, class: "selection-box",
      stroke: data.style.color, fill: data.style.color }));
  }
}

function applyTransform(): void {
  surface.style.transform = `translate(${offset.x}px, ${offset.y}px) scale(${scale})`;
  zoom.value = `${Math.round(scale * 100)}%`;
  renderAnnotations();
}

function fit(): void {
  if (!original) return;
  const padding = 24;
  const { width, height } = original.identity;
  scale = Math.min(1, Math.max(1, viewport.clientWidth - padding) / width,
    Math.max(1, viewport.clientHeight - padding) / height);
  offset = { x: (viewport.clientWidth - width * scale) / 2, y: (viewport.clientHeight - height * scale) / 2 };
  applyTransform();
}

function zoomBy(factor: number, at: Point): void {
  if (!original) return;
  const next = clamp(scale * factor, Math.min(scale, 0.02), 10);
  const ratio = next / scale;
  offset = { x: at.x - (at.x - offset.x) * ratio, y: at.y - (at.y - offset.y) * ratio };
  scale = next;
  applyTransform();
}

function viewportPoint(event: MouseEvent): Point {
  const rect = viewport.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function imagePoint(point: Point): Point {
  return { x: (point.x - offset.x) / scale, y: (point.y - offset.y) / scale };
}

function boundPoint(point: Point): Point {
  if (!original) return point;
  return { x: clamp(point.x, 0, original.identity.width), y: clamp(point.y, 0, original.identity.height) };
}

viewport.addEventListener("pointerdown", event => {
  if (!original || gesture || (event.button !== 0 && event.button !== 1)) return;
  viewport.focus({ preventScroll: true });
  const point = viewportPoint(event);
  const target = event.target as SVGElement;
  const id = target.closest<SVGGElement>("[data-id]")?.dataset.id;
  const item = state?.data?.items.find(entry => entry.id === id);
  const part = target.dataset.drag === "marker" ? "marker" : "region";
  const pointer = { pointer: event.pointerId, pointerStart: point };
  if (event.button === 0 && (event.shiftKey || (mode === "select" && !item))) {
    gesture = { ...pointer, kind: "select-box", start: imagePoint(point), additive: event.shiftKey,
      subject: item && { id: item.id, part } };
  } else if (mode === "pan" || event.button === 1) {
    gesture = { ...pointer, kind: "pan", start: point, offset };
  } else {
    if (item && (event.ctrlKey || event.metaKey)) {
      select(item.id, part, true);
      event.preventDefault();
      return;
    }
    select(id, part);
    if (!hasEditableGeometry()) return;
    const start = imagePoint(point);
    if (!item) {
      const { width, height } = original.identity;
      if (start.x < 0 || start.y < 0 || start.x > width || start.y > height) return;
      gesture = { ...pointer, kind: "add", start };
    } else if (target.dataset.drag === "resize") {
      const anchor = {
        x: item.region.x + (target.dataset.x === "0" ? item.region.width : 0),
        y: item.region.y + (target.dataset.y === "0" ? item.region.height : 0),
      };
      gesture = { ...pointer, kind: "resize", anchor, item };
    } else {
      const kind = target.dataset.drag === "marker" ? "marker" : "move";
      gesture = { ...pointer, kind, start, item };
    }
  }
  viewport.setPointerCapture(event.pointerId);
  event.preventDefault();
});

function preview(event: PointerEvent): void {
  if (!original || !gesture || gesture.pointer !== event.pointerId) return;
  const point = viewportPoint(event);
  if (gesture.kind === "pan") {
    offset = { x: gesture.offset.x + point.x - gesture.start.x, y: gesture.offset.y + point.y - gesture.start.y };
    applyTransform();
    return;
  }
  const position = imagePoint(point);
  switch (gesture.kind) {
    case "add": gesture.preview = regionBetween(gesture.start, boundPoint(position)); break;
    case "select-box": gesture.preview = regionBetween(gesture.start, position); break;
    case "resize": gesture.preview = regionBetween(gesture.anchor, boundPoint(position)); break;
    case "marker": {
      const { item, start } = gesture;
      const style = state?.data?.style;
      gesture.preview = constrainMarker({
        x: item.marker.x + position.x - start.x, y: item.marker.y + position.y - start.y,
      }, item.number, original.identity, style && effectiveMarkerDiameter(style, item));
      break;
    }
    case "move": {
      const { item, start } = gesture;
      const data = state?.data;
      if (!data) return;
      const { region } = item;
      const positionToFit = { x: region.x + position.x - start.x, y: region.y + position.y - start.y };
      gesture.preview = {
        ...region,
        ...constrainRegionPosition(item, positionToFit, data.coordinateSize, data.style),
      };
      break;
    }
  }
  renderAnnotations();
}

function selectInBox(box: Region, additive: boolean): void {
  const data = state?.data;
  if (!data) return;
  if (!additive) setSelection(undefined, "pair", false);
  for (const item of data.items) {
    for (const part of shapeParts) {
      const bounds = placementBounds(item, part, data.coordinateSize, data.style);
      if (bounds.x >= box.x && bounds.y >= box.y &&
          bounds.x + bounds.width <= box.x + box.width &&
          bounds.y + bounds.height <= box.y + box.height) {
        selection[part].add(item.id);
      }
    }
  }
  renderSelection();
}

viewport.addEventListener("pointermove", preview);
viewport.addEventListener("pointerup", event => {
  if (gesture?.pointer !== event.pointerId) return;
  preview(event);
  const completed = gesture;
  gesture = undefined;
  const position = viewportPoint(event);
  const dragDistance = Math.hypot(position.x - completed.pointerStart.x, position.y - completed.pointerStart.y);
  if (completed.kind === "select-box") {
    const box = completed.preview;
    if (box && dragDistance >= 4) {
      selectInBox(box, completed.additive);
    } else if (completed.subject) {
      select(completed.subject.id, completed.subject.part, true);
    } else if (!completed.additive) {
      select(undefined);
    } else {
      renderAnnotations();
    }
    return;
  }
  if (completed.kind !== "pan" && completed.preview && (completed.kind === "add" || dragDistance >= 3)) {
    if (completed.kind === "marker") {
      enqueue({ kind: "edit", edit: { kind: "marker", id: completed.item.id, marker: completed.preview } });
    } else if (completed.kind === "move") {
      const { x, y } = completed.preview;
      enqueue({ kind: "edit", edit: { kind: "moveRegion", id: completed.item.id, position: { x, y } } });
    } else if (completed.preview.width >= 1 && completed.preview.height >= 1) {
      const edit: Edit = completed.kind === "add"
        ? { kind: "add", region: completed.preview }
        : { kind: "region", id: completed.item.id, region: completed.preview };
      enqueue({ kind: "edit", edit });
    }
  }
  renderAnnotations();
});
viewport.addEventListener("lostpointercapture", event => {
  if (gesture?.pointer === event.pointerId) {
    gesture = undefined;
    renderAnnotations();
  }
});
viewport.addEventListener("wheel", event => {
  if (!original) return;
  event.preventDefault();
  zoomBy(event.deltaY < 0 ? 1.2 : 1 / 1.2, viewportPoint(event));
}, { passive: false });

function setMode(next: typeof mode): void {
  mode = next;
  selectButton.setAttribute("aria-pressed", String(mode === "select"));
  drawButton.setAttribute("aria-pressed", String(mode === "draw"));
  panButton.setAttribute("aria-pressed", String(mode === "pan"));
  viewport.classList.toggle("draw", mode === "draw");
  viewport.classList.toggle("pan", mode === "pan");
  renderAnnotations();
}
selectButton.addEventListener("click", () => setMode("select"));
drawButton.addEventListener("click", () => setMode("draw"));
panButton.addEventListener("click", () => setMode("pan"));
function removeSelection(): void {
  const ids = selectedItems().map(({ id }) => id);
  if (!ids.length) return;
  select(undefined);
  enqueue({ kind: "edit", edit: { kind: "remove", ids } });
}
removeButton.addEventListener("click", removeSelection);
const center = () => ({ x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 });
zoomIn.addEventListener("click", () => zoomBy(1.25, center()));
zoomOut.addEventListener("click", () => zoomBy(0.8, center()));
fitButton.addEventListener("click", fit);
element("json").addEventListener("click", () => vscode.postMessage({ type: "openJson" }));

function setSplit(percent: number): void {
  const value = clamp(percent, 20, 80);
  editor.style.setProperty("--image-height", `${value}%`);
  splitter.setAttribute("aria-valuenow", String(Math.round(value)));
}
splitter.addEventListener("pointerdown", event => {
  if (event.button === 0) splitter.setPointerCapture(event.pointerId);
});
splitter.addEventListener("pointermove", event => {
  if (!splitter.hasPointerCapture(event.pointerId)) return;
  const rect = editor.getBoundingClientRect();
  setSplit(100 * (event.clientY - rect.top) / rect.height);
});
splitter.addEventListener("keydown", event => {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  event.preventDefault();
  const currentHeight = Number(splitter.getAttribute("aria-valuenow"));
  setSplit(currentHeight + (event.key === "ArrowUp" ? -5 : 5));
});

window.addEventListener("keydown", event => {
  if (event.isComposing) return;
  if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    if (event.key === "Escape" && (gesture || selection.region.size || selection.marker.size)) {
      if (gesture && viewport.hasPointerCapture(gesture.pointer)) viewport.releasePointerCapture(gesture.pointer);
      gesture = undefined;
      viewport.focus({ preventScroll: true });
      select(undefined);
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const target = event.target;
    if (event.key === "Delete" && !gesture && (selection.region.size || selection.marker.size) &&
        !(target instanceof Element && target.closest('input:not([type="checkbox"]), textarea, select, [contenteditable]'))) {
      removeSelection();
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
  }
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey ||
      event.key.toLowerCase() !== "s" || !state?.data) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (!numericStyleFields.every(({ input, property }) => commitStyleNumber(input, property))) return;
  if (!applyGeometry()) return;
  enqueue({ kind: "save" });
}, true);

vscode.postMessage({ type: "ready" });
