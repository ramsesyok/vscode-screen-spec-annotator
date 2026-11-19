import {
  clamp, constrainMarker, isAlignment, isDistributionDirection, isLineStyle, markerFits, markerRadius,
  regionBetween, regionFits,
} from "../annotation";
import type { AnnotationItem, Edit, Point, Region, ShapeStyle } from "../annotation";
import type { DocumentState, EditorMessage, HostMessage, OriginalImage } from "../protocol";

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
const alignmentTools = element<HTMLElement>("alignment");
const selectionCount = element("selection-count");
const itemProperties = element<HTMLElement>("item-properties");
const geometryForm = element<HTMLFormElement>("geometry");
const geometryFields = element<HTMLFieldSetElement>("geometry-fields");
const geometryTitle = element("geometry-title");
const geometryError = element<HTMLElement>("geometry-error");
const regionX = element<HTMLInputElement>("region-x");
const regionY = element<HTMLInputElement>("region-y");
const regionWidth = element<HTMLInputElement>("region-width");
const regionHeight = element<HTMLInputElement>("region-height");
const markerX = element<HTMLInputElement>("marker-x");
const markerY = element<HTMLInputElement>("marker-y");
const overrideColor = element<HTMLInputElement>("override-color");
const itemColor = element<HTMLInputElement>("item-color");
const itemLine = element<HTMLSelectElement>("item-line");

let state: DocumentState | undefined;
let original: OriginalImage | undefined;
let originalError: string | undefined;
let editError: string | undefined;
let imageRequest = 0;
const selection = new Set<string>();
let mode: "draw" | "pan" = "draw";
let scale = 1;
let offset: Point = { x: 0, y: 0 };
let geometryItem: AnnotationItem | undefined;
let geometryDirty = false;

type Gesture =
  | { kind: "pan"; start: Point; offset: Point }
  | { kind: "add"; start: Point; preview?: Region }
  | { kind: "move"; start: Point; item: AnnotationItem; preview?: Region }
  | { kind: "resize"; anchor: Point; item: AnnotationItem; preview?: Region }
  | { kind: "marker"; start: Point; item: AnnotationItem; preview?: Point };
let gesture: (Gesture & { pointer: number }) | undefined;

type QueuedOperation = { kind: "save" } | { kind: "edit"; edit: Edit };
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
  if (operation.kind === "save") {
    vscode.postMessage({ type: "save", request, version });
  } else {
    vscode.postMessage({ type: "edit", request, version, edit: operation.edit });
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
  for (const id of selection) {
    if (!ids.has(id)) selection.delete(id);
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
    case "result":
      if (current?.request !== message.request) return;
      current = undefined;
      if (message.error) {
        editError = message.error;
        // Never save after a failed operation without another explicit save request.
        for (let i = pending.length - 1; i >= 0; i--) {
          if (pending[i].kind === "save") pending.splice(i, 1);
        }
      }
      if (message.selectedId) {
        selection.clear();
        selection.add(message.selectedId);
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
  notice.textContent = state?.error ?? originalError ?? editError ?? imageStatus ??
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
  removeButton.disabled = selection.size !== 1;
  zoomIn.disabled = zoomOut.disabled = fitButton.disabled = !original;
  drawButton.disabled = !hasEditableGeometry();
  panButton.disabled = !original;
}

interface RowControls {
  row: HTMLTableRowElement;
  checkbox: HTMLInputElement;
  number: HTMLButtonElement;
  name: HTMLTextAreaElement;
  composing: boolean;
}
const rowElements = new Map<string, RowControls>();

function renderRowSelection(id: string, controls: RowControls): void {
  const selected = selection.has(id);
  controls.row.classList.toggle("selected", selected);
  controls.checkbox.checked = selected;
  controls.number.setAttribute("aria-pressed", String(selected));
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
      checkbox.addEventListener("change", () => select(item.id, true));
      row.insertCell().append(checkbox);
      const number = document.createElement("button");
      number.type = "button";
      number.className = "row-number";
      number.addEventListener("click", event => select(item.id, event.ctrlKey || event.metaKey || event.shiftKey));
      row.insertCell().append(number);
      const name = document.createElement("textarea");
      name.rows = 1;
      name.addEventListener("focus", () => select(item.id));
      const commit = () => enqueue({ kind: "edit", edit: { kind: "name", id: item.id, name: name.value } });
      const entry = { row, checkbox, number, name, composing: false };
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
    controls.number.textContent = String(item.number);
    controls.name.setAttribute("aria-label", `${item.number}番の名称`);
    if (!editingNames.has(item.id) && !controls.composing && controls.name.value !== item.name) {
      controls.name.value = item.name;
    }
  });
  empty.hidden = items.length > 0;
}

function select(id: string | undefined, toggle = false): void {
  if (!toggle) selection.clear();
  if (id) {
    if (toggle && selection.has(id)) selection.delete(id);
    else selection.add(id);
  }
  renderAnnotations();
  for (const [rowId, controls] of rowElements) renderRowSelection(rowId, controls);
  renderProperties();
  removeButton.disabled = selection.size !== 1;
}

function effectiveStyle(style: ShapeStyle, item: AnnotationItem): ShapeStyle {
  return {
    color: item.style?.color ?? style.color,
    lineStyle: item.style?.lineStyle ?? style.lineStyle,
  };
}

function renderProperties(): void {
  const data = state?.data;
  const canEditGeometry = hasEditableGeometry();
  imageStyleToggle.disabled = !data;
  imageStyle.disabled = !data;
  alignmentTools.hidden = selection.size < 2;
  selectionCount.textContent = `${selection.size}件の矩形`;
  for (const button of alignmentTools.querySelectorAll("button")) {
    const minimumSelection = button.dataset.distribute ? 3 : 2;
    button.disabled = !canEditGeometry || selection.size < minimumSelection;
  }

  const item = selection.size === 1 ? data?.items.find(entry => selection.has(entry.id)) : undefined;
  itemProperties.hidden = !item;
  if (item?.id !== geometryItem?.id) geometryDirty = false;
  geometryFields.disabled = !canEditGeometry;
  if (!item || !data) {
    geometryItem = undefined;
    return;
  }
  geometryTitle.textContent = `${item.number}番の位置とサイズ（px）`;
  const edits = queuedEdits();
  const geometryPending = edits.some(edit => edit.kind === "geometry" && edit.id === item.id);
  if (!geometryDirty && !geometryPending) {
    const { region, marker } = item;
    regionX.value = String(region.x);
    regionY.value = String(region.y);
    regionWidth.value = String(region.width);
    regionHeight.value = String(region.height);
    markerX.value = String(marker.x);
    markerY.value = String(marker.y);
    geometryItem = item;
    geometryError.hidden = true;
  }
  const style = { ...data.style };
  const overrides = { ...item.style };
  for (const edit of edits) {
    if (edit.kind !== "style") continue;
    const target = edit.id === undefined ? style : edit.id === item.id ? overrides : undefined;
    if (!target) continue;
    if (edit.value === null) delete overrides[edit.property];
    else if (edit.property === "color") target.color = edit.value;
    else target.lineStyle = edit.value;
  }
  overrideColor.checked = overrides.color !== undefined;
  itemColor.disabled = !overrideColor.checked;
  itemColor.value = overrides.color ?? style.color;
  itemLine.value = overrides.lineStyle ?? "";
}

function renderImageStyle(): void {
  const style = state?.data?.style;
  if (!style) return;
  imageColor.value = style.color;
  imageLine.value = style.lineStyle;
  for (const edit of queuedEdits()) {
    if (edit.kind !== "style" || edit.id !== undefined || edit.value === null) continue;
    if (edit.property === "color") imageColor.value = edit.value;
    else imageLine.value = edit.value;
  }
}

function applyGeometry(): boolean {
  const item = geometryItem;
  const size = state?.data?.coordinateSize;
  if (!item || !size || !hasEditableGeometry() || !geometryForm.reportValidity()) return false;
  const region = {
    x: regionX.valueAsNumber, y: regionY.valueAsNumber,
    width: regionWidth.valueAsNumber, height: regionHeight.valueAsNumber,
  };
  const marker = { x: markerX.valueAsNumber, y: markerY.valueAsNumber };
  const regionChanged = (Object.keys(region) as (keyof Region)[]).some(key => region[key] !== item.region[key]);
  const markerChanged = marker.x !== item.marker.x || marker.y !== item.marker.y;
  if (regionChanged && !regionFits(region, size)) {
    geometryError.textContent = "幅と高さは正の値にし、矩形を画像の内側に収めてください。";
  } else if (markerChanged && !markerFits(marker, item.number, size)) {
    geometryError.textContent = "丸番号全体が画像の内側に収まる座標を指定してください。";
  } else {
    geometryDirty = false;
    geometryError.hidden = true;
    if (regionChanged || markerChanged) {
      geometryItem = { ...item, region, marker };
      enqueue({
        kind: "edit",
        edit: { kind: "geometry", id: item.id,
          region: regionChanged ? region : undefined, marker: markerChanged ? marker : undefined },
      });
    }
    return true;
  }
  geometryError.hidden = false;
  return false;
}

geometryForm.addEventListener("input", () => { geometryDirty = true; });
geometryForm.addEventListener("submit", event => {
  event.preventDefault();
  applyGeometry();
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
  if (!geometryItem) return;
  itemColor.disabled = !overrideColor.checked;
  enqueue({ kind: "edit", edit: { kind: "style", id: geometryItem.id, property: "color",
    value: overrideColor.checked ? itemColor.value : null } });
});
itemColor.addEventListener("change", () => {
  if (geometryItem && overrideColor.checked) enqueue({
    kind: "edit", edit: { kind: "style", id: geometryItem.id, property: "color", value: itemColor.value },
  });
});
itemLine.addEventListener("change", () => {
  if (!geometryItem) return;
  const value = itemLine.value;
  if (value === "" || isLineStyle(value)) enqueue({
    kind: "edit", edit: { kind: "style", id: geometryItem.id, property: "lineStyle", value: value || null },
  });
});
for (const button of alignmentTools.querySelectorAll("button")) {
  button.addEventListener("click", () => {
    if (button.disabled) return;
    const alignment = button.dataset.align;
    const direction = button.dataset.distribute;
    if (isAlignment(alignment)) enqueue({
      kind: "edit", edit: { kind: "align", ids: [...selection], alignment },
    });
    if (isDistributionDirection(direction)) enqueue({
      kind: "edit", edit: { kind: "distribute", ids: [...selection], direction },
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

function renderAnnotations(): void {
  annotations.replaceChildren();
  const data = state?.data;
  if (!data || !original) return;
  const items = [...data.items];
  items.sort((a, b) => Number(selection.has(a.id)) - Number(selection.has(b.id)));
  for (const item of items) {
    const selected = selection.has(item.id);
    const group = svg("g", { "data-id": item.id, class: selected ? "selected" : "" });
    const active = gesture && "item" in gesture && gesture.item.id === item.id ? gesture : undefined;
    const rect = (active?.kind === "move" || active?.kind === "resize") ? active.preview ?? item.region : item.region;
    const marker = active?.kind === "marker" ? active.preview ?? item.marker : item.marker;
    const style = effectiveStyle(data.style, item);
    const dashArray = { solid: "none", dashed: "7 4", dotted: "1 4" }[style.lineStyle];
    const stroke = { stroke: style.color, "stroke-dasharray": dashArray };
    if (selected) group.append(svg("rect", { ...rect, class: "selection-outline" }));
    group.append(svg("rect", { ...rect, ...stroke, class: "region", "data-drag": "move" }));
    const radius = markerRadius(item.number, data.coordinateSize);
    if (selected) group.append(svg("circle", { cx: marker.x, cy: marker.y, r: radius, class: "selection-outline" }));
    group.append(svg("circle", { cx: marker.x, cy: marker.y, r: radius, ...stroke, class: "marker", "data-drag": "marker" }));
    const label = svg("text", {
      x: marker.x, y: marker.y, class: "marker-text",
      "font-size": radius * Math.min(1.1, 2.5 / String(item.number).length),
    });
    label.textContent = String(item.number);
    group.append(label);
    if (selected && selection.size === 1 && mode === "draw" && hasEditableGeometry()) {
      for (const x of [0, 1]) {
        for (const y of [0, 1]) {
          group.append(svg("circle", {
            cx: rect.x + rect.width * x, cy: rect.y + rect.height * y, r: 5 / scale,
            class: "handle", "data-drag": "resize", "data-x": x, "data-y": y,
          }));
        }
      }
    }
    annotations.append(group);
  }
  if (gesture?.kind === "add" && gesture.preview) {
    annotations.append(svg("rect", { ...gesture.preview, stroke: data.style.color, class: "region preview" }));
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
  const point = viewportPoint(event);
  if (mode === "pan" || event.button === 1) {
    gesture = { kind: "pan", pointer: event.pointerId, start: point, offset };
  } else {
    const target = event.target as SVGElement;
    const id = target.closest<SVGGElement>("[data-id]")?.dataset.id;
    const item = state?.data?.items.find(entry => entry.id === id);
    if (item && (event.ctrlKey || event.metaKey || event.shiftKey)) {
      select(item.id, true);
      event.preventDefault();
      return;
    }
    select(id);
    if (!hasEditableGeometry()) return;
    const start = imagePoint(point);
    if (!item) {
      const { width, height } = original.identity;
      if (start.x < 0 || start.y < 0 || start.x > width || start.y > height) return;
      gesture = { kind: "add", pointer: event.pointerId, start };
    } else if (target.dataset.drag === "resize") {
      const anchor = {
        x: item.region.x + (target.dataset.x === "0" ? item.region.width : 0),
        y: item.region.y + (target.dataset.y === "0" ? item.region.height : 0),
      };
      gesture = { kind: "resize", pointer: event.pointerId, anchor, item };
    } else {
      const kind = target.dataset.drag === "marker" ? "marker" : "move";
      gesture = { kind, pointer: event.pointerId, start, item };
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
    case "resize": gesture.preview = regionBetween(gesture.anchor, boundPoint(position)); break;
    case "marker": {
      const { item, start } = gesture;
      gesture.preview = constrainMarker({
        x: item.marker.x + position.x - start.x, y: item.marker.y + position.y - start.y,
      }, item.number, original.identity);
      break;
    }
    case "move": {
      const { region } = gesture.item;
      gesture.preview = {
        ...region,
        x: clamp(region.x + position.x - gesture.start.x, 0, original.identity.width - region.width),
        y: clamp(region.y + position.y - gesture.start.y, 0, original.identity.height - region.height),
      };
      break;
    }
  }
  renderAnnotations();
}

viewport.addEventListener("pointermove", preview);
viewport.addEventListener("pointerup", event => {
  if (gesture?.pointer !== event.pointerId) return;
  preview(event);
  const completed = gesture;
  gesture = undefined;
  if (completed.kind !== "pan" && completed.preview) {
    if (completed.kind === "marker") {
      enqueue({ kind: "edit", edit: { kind: "marker", id: completed.item.id, marker: completed.preview } });
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
  drawButton.setAttribute("aria-pressed", String(mode === "draw"));
  panButton.setAttribute("aria-pressed", String(mode === "pan"));
  viewport.classList.toggle("pan", mode === "pan");
  renderAnnotations();
}
drawButton.addEventListener("click", () => setMode("draw"));
panButton.addEventListener("click", () => setMode("pan"));
removeButton.addEventListener("click", () => {
  const [id] = selection;
  if (id && selection.size === 1) enqueue({ kind: "edit", edit: { kind: "remove", id } });
});
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
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.isComposing ||
      event.key.toLowerCase() !== "s" || !state?.data) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (geometryDirty && !applyGeometry()) return;
  enqueue({ kind: "save" });
}, true);

vscode.postMessage({ type: "ready" });
