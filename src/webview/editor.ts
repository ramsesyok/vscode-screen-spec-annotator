import { clamp, constrainMarker, markerRadius, regionBetween } from "../annotation";
import type { AnnotationItem, Edit, Point, Region } from "../annotation";
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

let state: DocumentState | undefined;
let original: OriginalImage | undefined;
let originalError: string | undefined;
let editError: string | undefined;
let imageRequest = 0;
let selectedId: string | undefined;
let mode: "draw" | "pan" = "draw";
let scale = 1;
let offset: Point = { x: 0, y: 0 };

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

function awaitingName(id: string): boolean {
  return [current?.operation, ...pending].some(operation =>
    operation?.kind === "edit" && operation.edit.kind === "name" && operation.edit.id === id);
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
  if (!state.data?.items.some(item => item.id === selectedId)) selectedId = undefined;
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
      if (message.selectedId) selectedId = message.selectedId;
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
  removeButton.disabled = !selectedId;
  zoomIn.disabled = zoomOut.disabled = fitButton.disabled = !original;
  drawButton.disabled = !hasEditableGeometry();
  panButton.disabled = !original;
}

interface RowControls {
  row: HTMLTableRowElement;
  number: HTMLButtonElement;
  name: HTMLTextAreaElement;
  composing: boolean;
}
const rowElements = new Map<string, RowControls>();

function renderRows(): void {
  const items = state?.data?.items ?? [];
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
      const number = document.createElement("button");
      number.type = "button";
      number.className = "row-number";
      number.addEventListener("click", () => select(item.id));
      row.insertCell().append(number);
      const name = document.createElement("textarea");
      name.rows = 1;
      name.addEventListener("focus", () => select(item.id));
      const commit = () => enqueue({ kind: "edit", edit: { kind: "name", id: item.id, name: name.value } });
      const entry = { row, number, name, composing: false };
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
    controls.row.classList.toggle("selected", item.id === selectedId);
    controls.number.textContent = String(item.number);
    controls.number.setAttribute("aria-pressed", String(item.id === selectedId));
    controls.name.setAttribute("aria-label", `${item.number}番の名称`);
    if (!awaitingName(item.id) && !controls.composing && controls.name.value !== item.name) {
      controls.name.value = item.name;
    }
  });
  empty.hidden = items.length > 0;
}

function select(id: string | undefined): void {
  selectedId = id;
  renderAnnotations();
  for (const [rowId, controls] of rowElements) {
    const selected = rowId === id;
    controls.row.classList.toggle("selected", selected);
    controls.number.setAttribute("aria-pressed", String(selected));
  }
  removeButton.disabled = !id;
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
  const items = Array.from(data.items);
  const selectedIndex = items.findIndex(item => item.id === selectedId);
  if (selectedIndex >= 0) items.push(...items.splice(selectedIndex, 1));
  for (const item of items) {
    const group = svg("g", { "data-id": item.id, class: item.id === selectedId ? "selected" : "" });
    const active = gesture && "item" in gesture && gesture.item.id === item.id ? gesture : undefined;
    const rect = (active?.kind === "move" || active?.kind === "resize") ? active.preview ?? item.region : item.region;
    const marker = active?.kind === "marker" ? active.preview ?? item.marker : item.marker;
    group.append(svg("rect", { ...rect, class: "region", "data-drag": "move" }));
    const radius = markerRadius(item.number, data.coordinateSize);
    group.append(svg("circle", { cx: marker.x, cy: marker.y, r: radius, class: "marker", "data-drag": "marker" }));
    const label = svg("text", {
      x: marker.x, y: marker.y, class: "marker-text",
      "font-size": radius * Math.min(1.1, 2.5 / String(item.number).length),
    });
    label.textContent = String(item.number);
    group.append(label);
    if (item.id === selectedId && mode === "draw" && hasEditableGeometry()) {
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
    annotations.append(svg("rect", { ...gesture.preview, class: "region preview" }));
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
  if (selectedId) enqueue({ kind: "edit", edit: { kind: "remove", id: selectedId } });
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
  enqueue({ kind: "save" });
}, true);

vscode.postMessage({ type: "ready" });
