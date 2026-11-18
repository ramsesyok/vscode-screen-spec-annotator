import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { imageSize } from "image-size";
import { isRelativeImagePath } from "./annotation";
import type { OriginalImage } from "./protocol";

export function supportsImage(path: string): boolean {
  return [".png", ".jpg", ".jpeg"].includes(extname(path).toLowerCase());
}

export function relativeImagePath(annotationPath: string, originalPath: string): string {
  const path = relative(dirname(annotationPath), originalPath).split(sep).join("/");
  if (!isRelativeImagePath(path)) {
    throw new Error("原画像への相対パスを作れません。同じドライブ内を指定してください。");
  }
  return path;
}

export function resolveImagePath(annotationPath: string, imagePath: string): string {
  return resolve(dirname(annotationPath), imagePath);
}

export async function readOriginalImage(path: string): Promise<OriginalImage> {
  if (!supportsImage(path)) throw new Error("PNGまたはJPEGの原画像を指定してください。");
  const file = await readFile(path);
  const image = imageSize(file);
  if (image.type !== "jpg" && image.type !== "png") {
    throw new Error("原画像の内容をPNGまたはJPEGとして読み込めません。");
  }
  const swapAxes = image.orientation !== undefined && image.orientation >= 5 && image.orientation <= 8;
  return {
    identity: {
      width: swapAxes ? image.height : image.width,
      height: swapAxes ? image.width : image.height,
      sha256: createHash("sha256").update(file).digest("hex"),
    },
    mime: image.type === "jpg" ? "image/jpeg" : "image/png",
    bytes: Uint8Array.from(file).buffer,
  };
}
