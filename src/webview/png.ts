import { markerRadius, opaquePercent, resolvedItemStyle } from "../annotation";
import type { AnnotationDocument, LineStyle } from "../annotation";

export function regionStrokePattern(lineStyle: LineStyle, strokeWidth: number): { dash: number[]; cap: CanvasLineCap } {
  // A zero-length dash with round caps draws a circle the diameter of the stroke.
  if (lineStyle === "dotted") return { dash: [0, Math.max(4, strokeWidth * 2)], cap: "round" };
  // DrawingML's Dash preset measures the dash and gap in multiples of the stroke width.
  if (lineStyle === "dashed") return { dash: [4 * strokeWidth, 3 * strokeWidth], cap: "butt" };
  return { dash: [], cap: "butt" };
}

export function markerFontSize(radius: number, number: number): number {
  return radius * Math.min(1.1, 2.5 / String(number).length);
}

export async function composePng(
  original: HTMLCanvasElement, data: AnnotationDocument, fontFamily: string,
): Promise<ArrayBuffer> {
  const output = document.createElement("canvas");
  output.width = original.width;
  output.height = original.height;
  const context = output.getContext("2d");
  if (!context) throw new Error("PNGの描画を開始できませんでした。");
  context.drawImage(original, 0, 0);
  context.textAlign = "center";
  context.textBaseline = "middle";
  const styledItems = data.items.map(item => ({ item, style: resolvedItemStyle(data.style, item.style) }));
  for (const { item, style } of styledItems) {
    const { x, y, width, height } = item.region;
    const { dash, cap } = regionStrokePattern(style.lineStyle, style.regionStrokeWidth);
    context.strokeStyle = style.color;
    context.globalAlpha = style.colorOpacity / opaquePercent;
    context.lineWidth = style.regionStrokeWidth;
    context.lineCap = cap;
    context.setLineDash(dash);
    context.strokeRect(x, y, width, height);
  }
  context.setLineDash([]);
  for (const { item, style } of styledItems) {
    context.strokeStyle = style.markerStrokeColor;
    context.lineWidth = style.markerStrokeWidth;
    const { x, y } = item.marker;
    const radius = markerRadius(item.number, data.coordinateSize, style.markerDiameter ?? undefined);
    context.beginPath();
    context.arc(x, y, radius, 0, 2 * Math.PI);
    context.fillStyle = style.markerFillColor;
    context.globalAlpha = style.markerFillOpacity / opaquePercent;
    context.fill();
    context.globalAlpha = style.markerStrokeOpacity / opaquePercent;
    context.stroke();
    context.font = `700 ${markerFontSize(radius, item.number)}px ${fontFamily}`;
    context.fillStyle = style.markerTextColor;
    context.globalAlpha = style.markerTextOpacity / opaquePercent;
    context.fillText(String(item.number), x, y);
  }
  const blob = await new Promise<Blob | null>(resolve => output.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("PNGを生成できませんでした。");
  return blob.arrayBuffer();
}
