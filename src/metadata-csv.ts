import type { AnnotationDocument } from "./annotation";

export function metadataCsv(data: AnnotationDocument): string {
  if (!data.screenId.trim()) throw new Error("一覧出力の前に画面IDを入力してください。");
  const rows = [
    ["画面ID", "項目ID", "表示番号", "名称"],
    ...data.items.map(item => [data.screenId, item.id, String(item.number), item.name]),
  ];
  return "\uFEFF" + rows.map(row => row.map(cell => '"' + cell.replaceAll('"', '""') + '"').join(",")).join("\r\n") + "\r\n";
}
