// image-compress.ts — 图片压缩规格与压缩管线（image-input 03 号票定稿的唯一地址）。
//
// 规格（consumer 只读本模块常量，禁止再抄一份）：
//   - 编码：统一 WebP q0.9（canvas.toBlob("image/webp", 0.9)）；
//   - 尺寸：长边 ≤1568px，超出等比降采样；
//   - 体积：压缩后单张 ≤1MB（base64 膨胀 ~33% 由 03 号票计入请求体预算，不在此
//     收紧）；单条总量 ≤4MB 由消费方（chat-input-images 的附件列表）判定。
// 降采样位置是 content script（对话 UI 有 DOM canvas；background SW 无 DOM）。
//
// 接缝：jsdom 没有 createImageBitmap（解码）与 canvas 2d / toBlob（编码），故两个
// DOM 原语经 ImageCompressEnv 注入，其余（等比降采样算式、体积判定、base64 编码、
// 拒绝原因归类）全在本模块内——测试以替身覆盖两个原语即可跑通整条管线。
//
// 输出形状即 01 号票的 ImagePart（{ mime, data }，data 为 base64 原文不带前缀）。

import type { ImagePart } from "../ai/types.js";

// 长边上限（Anthropic 推荐上限，03 号票定稿）。
export const IMAGE_MAX_EDGE = 1568;
// WebP 编码质量（03 号票定稿）。
export const IMAGE_WEBP_QUALITY = 0.9;
// 单条消息张数上限（03 号票定稿；判定在 chat-input-images 的附件列表）。
export const IMAGE_MAX_COUNT = 4;
// 压缩后单张体积上限（1MB，二进制字节；判定在本模块的 compress）。
export const IMAGE_MAX_BYTES = 1024 * 1024;
// 压缩后单条总量上限（4MB，二进制字节；判定在 chat-input-images）。
export const IMAGE_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
// 统一转码后的 MIME（03 号票：三条协议均接受 WebP）。
export const IMAGE_OUTPUT_MIME = "image/webp";

// 拒绝原因（消费方据此选用户可见文案；归类只在本模块发生）。
export type ImageRejectReason =
  | "too-many"
  | "single-too-large"
  | "total-too-large"
  | "decode-failed"
  | "encode-failed";

// 图片被拒的类型化错误：msg 保留底层原因（日志用），reason 供消费方映射文案。
export class ImageRejectError extends Error {
  readonly reason: ImageRejectReason;

  constructor(reason: ImageRejectReason, message: string) {
    super(message);
    this.name = "ImageRejectError";
    this.reason = reason;
  }
}

// 单张图压缩产物：part 即请求体里的 ImagePart，bytes 为压缩后二进制体积
//（单条总量按它累加——base64 膨胀不参与上限判定，见头注）。
export interface CompressedImage {
  part: ImagePart;
  bytes: number;
}

export interface ImageDecodeResult {
  width: number;
  height: number;
  source: CanvasImageSource;
}

// 压缩管线的两个 DOM 原语（真实实现在本模块底部；jsdom/测试注入替身）。
export interface ImageCompressEnv {
  decode(blob: Blob): Promise<ImageDecodeResult>;
  encodeWebp(input: {
    source: CanvasImageSource;
    width: number;
    height: number;
    quality: number;
  }): Promise<Blob>;
}

// 等比降采样算式（纯函数，长边超限才缩放）：返回目标绘制尺寸。
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

// Blob → base64 原文（不含 data: 前缀，01 号票的 ImagePart.data 口径）。分块拼接
// 避免 String.fromCharCode 的参数个数上限（1MB 图 ~1.4MB base64）。
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

// 默认环境：Chrome 原生 createImageBitmap 解码 + 离屏 canvas 编码（降采样在
// drawImage 的目标尺寸上完成）。createImageBitmap 按全局惰性读取——测试经
// vi.stubGlobal 替换即可，无模块求值期捕获。
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

// 压缩管线：解码 → 长边降采样 → WebP q0.9 → base64。任一步失败都归为
// ImageRejectError（消费方一律给用户可见提示，绝不静默丢）。
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
