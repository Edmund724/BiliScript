// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_EDGE,
  IMAGE_OUTPUT_MIME,
  IMAGE_WEBP_QUALITY,
  ImageRejectError,
  createImageCompressor,
  fitImageSize,
  type ImageCompressEnv,
  type ImageDecodeResult
} from "../../extension/chat/image-compress.js";

function makeBlob(bytes: number[], type = IMAGE_OUTPUT_MIME): Blob {
  return new Blob([new Uint8Array(bytes)], { type });
}

function makeSource(): CanvasImageSource {
  return document.createElement("img");
}

function makeEnv(overrides: Partial<ImageCompressEnv> = {}): ImageCompressEnv {
  const decoded: ImageDecodeResult = { width: 2400, height: 1200, source: makeSource() };
  return {
    decode: vi.fn(async () => decoded),
    encodeWebp: vi.fn(async () => makeBlob([1, 2, 3, 4])),
    ...overrides
  };
}

async function expectReject(promise: Promise<unknown>, reason: string): Promise<ImageRejectError> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err
  );
  expect(error).toBeInstanceOf(ImageRejectError);
  expect((error as ImageRejectError).reason).toBe(reason);
  return error as ImageRejectError;
}

describe("fitImageSize（长边 ≤1568 的等比降采样算式）", () => {
  it("长边超限：按比例缩到 1568（横图 / 竖图 / 极端长宽比）", () => {
    expect(fitImageSize(2400, 1200)).toEqual({ width: IMAGE_MAX_EDGE, height: 784 });
    expect(fitImageSize(1200, 2400)).toEqual({ width: 784, height: IMAGE_MAX_EDGE });
    expect(fitImageSize(3000, 1000)).toEqual({ width: IMAGE_MAX_EDGE, height: 523 });
  });

  it("长边不超限：原尺寸返回（不放大）", () => {
    expect(fitImageSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitImageSize(IMAGE_MAX_EDGE, IMAGE_MAX_EDGE)).toEqual({
      width: IMAGE_MAX_EDGE,
      height: IMAGE_MAX_EDGE
    });
  });

  it("缩放结果不为 0（极端长宽比下最小的那条边至少 1px）", () => {
    expect(fitImageSize(20000, 4).height).toBe(1);
  });
});

describe("createImageCompressor（解码 → 降采样 → WebP q0.9 → base64）", () => {
  it("超限图按降采样尺寸编码，产出 WebP 的 ImagePart（data 为 base64 原文）", async () => {
    const env = makeEnv();
    const compressed = await createImageCompressor(env).compress(makeBlob([7, 7], "image/png"));

    expect(env.encodeWebp).toHaveBeenCalledTimes(1);
    expect(env.encodeWebp).toHaveBeenCalledWith({
      source: expect.anything(),
      width: IMAGE_MAX_EDGE,
      height: 784,
      quality: IMAGE_WEBP_QUALITY
    });
    expect(compressed.part.mime).toBe("image/webp");
    expect(compressed.part.data).not.toContain("data:");
    expect(atob(compressed.part.data)).toBe("\x01\x02\x03\x04");
    expect(compressed.bytes).toBe(4);
  });

  it("未超限图按原尺寸编码（不经过缩放）", async () => {
    const env = makeEnv({
      decode: vi.fn(async () => ({ width: 800, height: 600, source: makeSource() }))
    });
    await createImageCompressor(env).compress(makeBlob([1]));

    expect(env.encodeWebp).toHaveBeenCalledWith({
      source: expect.anything(),
      width: 800,
      height: 600,
      quality: IMAGE_WEBP_QUALITY
    });
  });

  it("压缩后仍超 1MB：以 single-too-large 拒绝（不产出半截 ImagePart）", async () => {
    const env = makeEnv({
      encodeWebp: vi.fn(async () => makeBlob(new Array(IMAGE_MAX_BYTES + 1).fill(0)))
    });

    await expectReject(createImageCompressor(env).compress(makeBlob([1])), "single-too-large");
  });

  it("解码失败（损坏/不支持的格式）→ decode-failed，不静默丢", async () => {
    const env = makeEnv({
      decode: vi.fn(async () => {
        throw new Error("Invalid image");
      })
    });

    const error = await expectReject(createImageCompressor(env).compress(makeBlob([1])), "decode-failed");
    expect(error.message).toContain("Invalid image");
  });

  it("编码失败（canvas/toBlob 不可用）→ encode-failed", async () => {
    const env = makeEnv({
      encodeWebp: vi.fn(async () => {
        throw new Error("canvas 2d 不可用");
      })
    });

    await expectReject(createImageCompressor(env).compress(makeBlob([1])), "encode-failed");
  });

  it("默认环境：无 createImageBitmap（jsdom/旧环境）时归类为 decode-failed，不抛原始异常", async () => {
    vi.stubGlobal("createImageBitmap", undefined);
    try {
      await expectReject(createImageCompressor().compress(makeBlob([1])), "decode-failed");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("大图 base64 分块编码正确（>32KB 触发分块路径）", async () => {
    const bytes = new Uint8Array(70000).map((_, index) => index % 251);
    const env = makeEnv({ encodeWebp: vi.fn(async () => new Blob([bytes])) });

    const compressed = await createImageCompressor(env).compress(makeBlob([1]));

    const decoded = atob(compressed.part.data);
    expect(decoded.length).toBe(bytes.length);
    expect(decoded.charCodeAt(0)).toBe(bytes[0]);
    expect(decoded.charCodeAt(69999)).toBe(bytes[69999]);
  });
});
