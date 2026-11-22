import { defaultMarkerColors, defaultStrokeWidth, effectiveMarkerDiameter, markerRadius } from "../annotation";
import type { AnnotationDocument, AnnotationItem, LineStyle, ShapeStyle } from "../annotation";

export const lineDashes: Record<LineStyle, number[]> = { solid: [], dashed: [7, 4], dotted: [1, 4] };

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
  const setStroke = (item: AnnotationItem): ShapeStyle => {
    const style = { ...data.style, ...item.style };
    context.strokeStyle = style.color;
    context.lineWidth = style.strokeWidth ?? defaultStrokeWidth;
    context.setLineDash(lineDashes[style.lineStyle]);
    return style;
  };

  context.drawImage(original, 0, 0);
  context.textAlign = "center";
  context.textBaseline = "middle";
  for (const item of data.items) {
    const { x, y, width, height } = item.region;
    setStroke(item);
    context.strokeRect(x, y, width, height);
  }
  for (const item of data.items) {
    const style = setStroke(item);
    const { x, y } = item.marker;
    const radius = markerRadius(item.number, data.coordinateSize, effectiveMarkerDiameter(data.style, item));
    context.beginPath();
    context.arc(x, y, radius, 0, 2 * Math.PI);
    context.fillStyle = style.markerFillColor ?? defaultMarkerColors.markerFillColor;
    context.fill();
    context.stroke();
    context.font = `700 ${markerFontSize(radius, item.number)}px ${fontFamily}`;
    context.fillStyle = style.markerTextColor ?? defaultMarkerColors.markerTextColor;
    context.fillText(String(item.number), x, y);
  }
  const blob = await new Promise<Blob | null>(resolve => output.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("PNGを生成できませんでした。");
  return blob.arrayBuffer();
}
