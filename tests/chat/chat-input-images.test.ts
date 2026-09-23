// tests/chat/chat-input-images.test.ts
// 02 号票（输入区粘贴图片）的附件区内核单测：
//   - 纯文本 / 非图片剪贴板内容不拦截（不 preventDefault，不产出附件项）；
//   - 粘贴 image/png → 压缩后生成一个附件项（缩略图 data URL + 删除键）；
//   - 删除后计数归零（附件区回到 hidden）；
//   - 上限拒绝并提示（张数 >4 / 单条合计 >4MB / 压缩器判定的单张超限 / 解码失败）；
//   - 流式中（发送流程进行中）粘贴图片被拒并提示；
//   - takeImages（发送受理）读清一体，且清空后在途压缩的迟到结果不回填。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import {
  IMAGE_STREAMING_REJECT_MESSAGE,
  createChatInputImages,
  type PasteClipboardItem,
  type PasteEventLike
} from "../../extension/chat/chat-input-images.js";
import { ImageRejectError, type CompressedImage } from "../../extension/chat/image-compress.js";

const MB = 1024 * 1024;

type CompressFn = (blob: Blob) => Promise<CompressedImage>;

function makeFile(name = "shot.png", type = "image/png"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
}

function fileItem(file: File, type = file.type): PasteClipboardItem {
  return { kind: "file", type, getAsFile: () => file };
}

function textItem(text = "hello"): PasteClipboardItem {
  return { kind: "string", type: "text/plain", getAsFile: () => null };
}

interface TestPasteEvent {
  clipboardData: PasteEventLike["clipboardData"];
  preventDefault: Mock<() => void>;
}

function makePasteEvent(items: PasteClipboardItem[] | null): TestPasteEvent {
  return { clipboardData: items ? { items } : null, preventDefault: vi.fn(() => {}) };
}

// 压缩替身：产出固定体积的 WebP ImagePart（真实压缩管线由 image-compress 单测覆盖）
function fakeCompress(bytes = 1024, data = "QUJD"): Mock<CompressFn> {
  return vi.fn<CompressFn>(async () => ({
    part: { mime: "image/webp", data },
    bytes
  }));
}

function makeRuntime(overrides: { compress?: Mock<CompressFn>; isStreaming?: () => boolean } = {}) {
  const strip = document.createElement("div");
  strip.className = "chat-image-strip";
  strip.hidden = true;
  const onReject = vi.fn((_message: string) => {});
  const compress = overrides.compress ?? fakeCompress();
  const images = createChatInputImages({
    strip,
    compress,
    isStreaming: overrides.isStreaming,
    onReject
  });
  return { images, strip, onReject, compress };
}

// 压缩是异步的：handler 返回后等微任务队列落定
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("粘贴入口（仅 image/* 拦截）", () => {
  it("粘贴纯文本：不拦截、不产出附件项、无提示", async () => {
    const { images, strip, onReject } = makeRuntime();
    const event = makePasteEvent([textItem("这是一段文字")]);

    images.handlePaste(event);
    await flush();

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(images.count()).toBe(0);
    expect(strip.hidden).toBe(true);
    expect(onReject).not.toHaveBeenCalled();
  });

  it("无 clipboardData（非粘贴来源的 paste 事件）：不抛错、不拦截", async () => {
    const { images, onReject } = makeRuntime();
    const event = makePasteEvent(null);

    expect(() => images.handlePaste(event)).not.toThrow();
    await flush();

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(images.count()).toBe(0);
    expect(onReject).not.toHaveBeenCalled();
  });

  it("粘贴 image/png：拦截并生成一个附件项（缩略图 data URL + 删除键）", async () => {
    const { images, strip, onReject, compress } = makeRuntime();
    const event = makePasteEvent([textItem(), fileItem(makeFile())]);

    images.handlePaste(event);
    await flush();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(compress).toHaveBeenCalledTimes(1);
    expect(images.count()).toBe(1);
    expect(onReject).not.toHaveBeenCalled();
    expect(strip.hidden).toBe(false);
    const items = strip.querySelectorAll(".chat-image-item");
    expect(items).toHaveLength(1);
    expect(strip.querySelector(".chat-image-thumb")?.getAttribute("src")).toBe("data:image/webp;base64,QUJD");
    expect(strip.querySelector<HTMLElement>(".chat-image-remove")?.dataset.chatImageRemove).toBe("0");
  });

  it("粘贴多张图：按剪贴板顺序各自成为一项", async () => {
    const { images, strip } = makeRuntime({
      compress: vi
        .fn()
        .mockResolvedValueOnce({ part: { mime: "image/webp", data: "AAA" }, bytes: 1 })
        .mockResolvedValueOnce({ part: { mime: "image/webp", data: "BBB" }, bytes: 1 })
    });

    images.handlePaste(makePasteEvent([fileItem(makeFile("a.png")), fileItem(makeFile("b.png"))]));
    await flush();

    expect(images.count()).toBe(2);
    expect(
      [...strip.querySelectorAll(".chat-image-thumb")].map((node) => node.getAttribute("src"))
    ).toEqual(["data:image/webp;base64,AAA", "data:image/webp;base64,BBB"]);
  });

  it("非图片文件项（如 text/plain 的 file）不拦截", async () => {
    const { images, onReject } = makeRuntime();
    const event = makePasteEvent([fileItem(makeFile("notes.txt", "text/plain"), "text/plain")]);

    images.handlePaste(event);
    await flush();

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(images.count()).toBe(0);
    expect(onReject).not.toHaveBeenCalled();
  });
});

describe("单个删除与清空", () => {
  it("删除后计数归零，附件区回到 hidden", async () => {
    const { images, strip } = makeRuntime();
    images.handlePaste(makePasteEvent([fileItem(makeFile())]));
    await flush();
    expect(images.count()).toBe(1);

    images.removeAt(0);

    expect(images.count()).toBe(0);
    expect(strip.hidden).toBe(true);
    expect(strip.querySelectorAll(".chat-image-item")).toHaveLength(0);
  });

  it("删除中间一项：剩余项按下标重排（删除键 data 值与渲染下标一致）", async () => {
    const { images, strip } = makeRuntime({
      compress: vi
        .fn()
        .mockResolvedValueOnce({ part: { mime: "image/webp", data: "AAA" }, bytes: 1 })
        .mockResolvedValueOnce({ part: { mime: "image/webp", data: "BBB" }, bytes: 1 })
        .mockResolvedValueOnce({ part: { mime: "image/webp", data: "CCC" }, bytes: 1 })
    });
    images.handlePaste(
      makePasteEvent([fileItem(makeFile("a.png")), fileItem(makeFile("b.png")), fileItem(makeFile("c.png"))])
    );
    await flush();

    images.removeAt(1);

    expect(
      [...strip.querySelectorAll(".chat-image-thumb")].map((node) => node.getAttribute("src"))
    ).toEqual(["data:image/webp;base64,AAA", "data:image/webp;base64,CCC"]);
    expect(
      [...strip.querySelectorAll<HTMLElement>(".chat-image-remove")].map((node) => node.dataset.chatImageRemove)
    ).toEqual(["0", "1"]);
  });

  it("越界下标（键已随重渲作废）不改变附件区", async () => {
    const { images } = makeRuntime();
    images.handlePaste(makePasteEvent([fileItem(makeFile())]));
    await flush();

    images.removeAt(5);
    images.removeAt(-1);
    images.removeAt(Number.NaN);

    expect(images.count()).toBe(1);
  });
});

describe("上限拒绝与提示", () => {
  it("超过 4 张：第 5 张被拒并提示，已收 4 张不变", async () => {
    const { images, onReject } = makeRuntime();
    images.handlePaste(makePasteEvent([fileItem(makeFile())]));
    await flush();

    for (let index = 0; index < 3; index += 1) {
      images.handlePaste(makePasteEvent([fileItem(makeFile())]));
      await flush();
    }
    expect(images.count()).toBe(4);

    images.handlePaste(makePasteEvent([fileItem(makeFile())]));
    await flush();

    expect(images.count()).toBe(4);
    expect(onReject).toHaveBeenCalledWith("一条消息最多 4 张图片");
  });

  it("同一次粘贴内含 5 张：只收前 4 张，第 5 张提示拒绝", async () => {
    const { images, onReject } = makeRuntime();
    const five = Array.from({ length: 5 }, () => fileItem(makeFile()));

    images.handlePaste(makePasteEvent(five));
    await flush();

    expect(images.count()).toBe(4);
    expect(onReject).toHaveBeenCalledWith("一条消息最多 4 张图片");
  });

  it("单条合计超过 4MB：超出的那张被拒并提示（先收下的保留）", async () => {
    const { images, onReject } = makeRuntime({ compress: fakeCompress(2 * MB) });

    for (let index = 0; index < 3; index += 1) {
      images.handlePaste(makePasteEvent([fileItem(makeFile())]));
      await flush();
    }

    expect(images.count()).toBe(2); // 2MB + 2MB ≤ 4MB；第三张 6MB > 4MB
    expect(onReject).toHaveBeenCalledWith("图片合计超过 4MB，无法发送");
  });

  it("压缩器判定单张超限（single-too-large）→ 提示且不落项", async () => {
    const { images, onReject } = makeRuntime({
      compress: vi.fn(async () => {
        throw new ImageRejectError("single-too-large", "压缩后仍有 2MB");
      })
    });

    images.handlePaste(makePasteEvent([fileItem(makeFile())]));
    await flush();

    expect(images.count()).toBe(0);
    expect(onReject).toHaveBeenCalledWith("图片压缩后仍超过 1MB，无法发送");
  });

  it("解码失败 → 可见提示（不静默丢）", async () => {
    const { images, onReject } = makeRuntime({
      compress: vi.fn(async () => {
        throw new ImageRejectError("decode-failed", "Invalid image");
      })
    });

    images.handlePaste(makePasteEvent([fileItem(makeFile())]));
    await flush();

    expect(images.count()).toBe(0);
    expect(onReject).toHaveBeenCalledWith("图片解码失败，请换一张图片重试");
  });

  it("非归类异常（压缩替身抛出普通错误）→ 统一按处理失败提示", async () => {
    const { onReject, images } = makeRuntime({
      compress: vi.fn(async () => {
        throw new Error("boom");
      })
    });

    images.handlePaste(makePasteEvent([fileItem(makeFile())]));
    await flush();

    expect(images.count()).toBe(0);
    expect(onReject).toHaveBeenCalledWith("图片处理失败，请换一张图片重试");
  });

  it("同一批里一张失败不影响其余图片继续入库", async () => {
    const { images, onReject } = makeRuntime({
      compress: vi
        .fn()
        .mockRejectedValueOnce(new ImageRejectError("decode-failed", "bad"))
        .mockResolvedValueOnce({ part: { mime: "image/webp", data: "QUJD" }, bytes: 4 })
    });

    images.handlePaste(makePasteEvent([fileItem(makeFile("bad.png")), fileItem(makeFile("ok.png"))]));
    await flush();

    expect(images.count()).toBe(1);
    expect(onReject).toHaveBeenCalledTimes(1);
  });
});

describe("流式闸（发送中不允许再加图）", () => {
  it("回答生成中粘贴图片：拦截 + 提示，不产出附件项", async () => {
    const { images, onReject, compress } = makeRuntime({ isStreaming: () => true });
    const event = makePasteEvent([fileItem(makeFile())]);

    images.handlePaste(event);
    await flush();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(compress).not.toHaveBeenCalled();
    expect(images.count()).toBe(0);
    expect(onReject).toHaveBeenCalledWith(IMAGE_STREAMING_REJECT_MESSAGE);
  });

  it("回答生成中粘贴纯文本：照旧不拦截（输入框在流式中仍可打字/粘贴）", async () => {
    const { images, onReject } = makeRuntime({ isStreaming: () => true });
    const event = makePasteEvent([textItem()]);

    images.handlePaste(event);
    await flush();

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
  });
});

describe("takeImages（发送受理的读清一体）", () => {
  it("返回 ImagePart[] 并清空附件区", async () => {
    const { images, strip } = makeRuntime();
    images.handlePaste(makePasteEvent([fileItem(makeFile())]));
    await flush();

    const parts = images.takeImages();

    expect(parts).toEqual([{ mime: "image/webp", data: "QUJD" }]);
    expect(images.count()).toBe(0);
    expect(strip.hidden).toBe(true);
  });

  it("空附件区 takeImages 返回空数组（无附件消息不带 images 字段）", () => {
    const { images } = makeRuntime();
    expect(images.takeImages()).toEqual([]);
  });

  it("清空后在途压缩的迟到结果不回填（发送后清空的附件区不被上一次粘贴重新填上）", async () => {
    let release: (value: CompressedImage) => void = () => {};
    const compress = vi.fn(
      () =>
        new Promise<CompressedImage>((resolve) => {
          release = resolve;
        })
    );
    const { images, strip } = makeRuntime({ compress });

    images.handlePaste(makePasteEvent([fileItem(makeFile())]));
    expect(images.takeImages()).toEqual([]); // 压缩未落位：本条消息不带图

    release({ part: { mime: "image/webp", data: "QUJD" }, bytes: 4 });
    await flush();

    expect(images.count()).toBe(0);
    expect(strip.hidden).toBe(true);
  });

  it("clear（新会话清场）同样作废在途压缩", async () => {
    let release: (value: CompressedImage) => void = () => {};
    const compress = vi.fn(
      () =>
        new Promise<CompressedImage>((resolve) => {
          release = resolve;
        })
    );
    const { images } = makeRuntime({ compress });

    images.handlePaste(makePasteEvent([fileItem(makeFile())]));
    images.clear();
    release({ part: { mime: "image/webp", data: "QUJD" }, bytes: 4 });
    await flush();

    expect(images.count()).toBe(0);
  });
});
