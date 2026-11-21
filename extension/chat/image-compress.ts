import type { ImagePart } from "../ai/types.js";

export const IMAGE_MAX_EDGE = 1568;
export const IMAGE_WEBP_QUALITY = 0.9;
export const IMAGE_MAX_COUNT = 4;
export const IMAGE_MAX_BYTES = 1024 * 1024;
export const IMAGE_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
export const IMAGE_OUTPUT_MIME = "image/webp";

export type ImageRejectReason =
  | "too-many"
  | "single-too-large"
  | "total-too-large"
  | "decode-failed"
  | "encode-failed";

export class ImageRejectError extends Error {
  readonly reason: ImageRejectReason;

  constructor(reason: ImageRejectReason, message: string) {
    super(message);
    this.name = "ImageRejectError";
    this.reason = reason;
  }
}

export interface CompressedImage {
  part: ImagePart;
  bytes: number;
}

export interface ImageDecodeResult {
  width: number;
  height: number;
  source: CanvasImageSource;
}

export interface ImageCompressEnv {
  decode(blob: Blob): Promise<ImageDecodeResult>;
  encodeWebp(input: {
    source: CanvasImageSource;
    width: number;
    height: number;
    quality: number;
  }): Promise<Blob>;
}

export function fitImageSize(
  width: number,
  height: number,
  maxEdge: number = IMAGE_MAX_EDGE
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (!(longest > maxEdge)) {
    return { width, height };
  }
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export interface ImageCompressor {
  compress(blob: Blob): Promise<CompressedImage>;
}

const defaultEnv: ImageCompressEnv = {
  async decode(blob) {
    const createImageBitmapFn = (globalThis as { createImageBitmap?: (input: Blob) => Promise<ImageBitmap> })
      .createImageBitmap;
    if (typeof createImageBitmapFn !== "function") {
      throw new Error("createImageBitmap 不可用");
    }
    const bitmap = await createImageBitmapFn(blob);
    return { width: bitmap.width, height: bitmap.height, source: bitmap };
  },
  async encodeWebp({ source, width, height, quality }) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("canvas 2d 不可用");
    }
    ctx.drawImage(source, 0, 0, width, height);
    const encoded = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, IMAGE_OUTPUT_MIME, quality);
    });
    if (!encoded) {
      throw new Error("WebP 编码失败");
    }
    return encoded;
  }
};

export function createImageCompressor(env: ImageCompressEnv = defaultEnv): ImageCompressor {
  async function compress(blob: Blob): Promise<CompressedImage> {
    let decoded: ImageDecodeResult;
    try {
      decoded = await env.decode(blob);
    } catch (error) {
      throw new ImageRejectError("decode-failed", `图片解码失败：${String((error as Error)?.message || error)}`);
    }
    const size = fitImageSize(decoded.width, decoded.height);
    let encoded: Blob;
    try {
      encoded = await env.encodeWebp({
        source: decoded.source,
        width: size.width,
        height: size.height,
        quality: IMAGE_WEBP_QUALITY
      });
    } catch (error) {
      throw new ImageRejectError("encode-failed", `图片编码失败：${String((error as Error)?.message || error)}`);
    }
    if (encoded.size > IMAGE_MAX_BYTES) {
      throw new ImageRejectError("single-too-large", `压缩后仍有 ${encoded.size} 字节`);
    }
    return {
      part: { mime: IMAGE_OUTPUT_MIME, data: await blobToBase64(encoded) },
      bytes: encoded.size
    };
  }

  return { compress };
}
