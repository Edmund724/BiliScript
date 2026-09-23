// tests/chat/chat-runtime-input-images.test.ts
// 图片附件的发送侧接线（image-input 02 号票）：
//   - deps.takeInputImages（组合根注入的附件区读清一体）在发送受理时被调用一次，
//     返回的 ImagePart[] 随 chat 消息的 images 字段下发；
//   - 无附件 / 未注入 takeInputImages：消息不带 images 字段（无图线格式不变）；
//   - 被前置闸拦下（无平台 / 上下文读取失败）的发送不消费附件区——用户粘的图
//     不会因为一次被拒的发送被清掉。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { normalizeMarkdownForSectionPaste } from "../../extension/notes/paste.js";
import type { CreateChatRuntimeDeps } from "../../extension/chat/chat-runtime.js";
import type { ChatSessionState } from "../../extension/chat/chat-state.js";

let createChatRuntime: typeof import("../../extension/chat/chat-runtime.js").createChatRuntime;
let chatSessionState: ChatSessionState;

interface FakePort {
  name: string;
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (fn: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
}

const IMAGE = { mime: "image/webp", data: "QUJD" };

function makeDeps(overrides: Partial<CreateChatRuntimeDeps> = {}) {
  const messages = document.createElement("div");
  const input = document.createElement("textarea");
  const ports: FakePort[] = [];
  const deps = {
    messages,
    input,
    store: { persistCurrent: vi.fn(async () => {}), isCurrent: () => true },
    ui: {
      setStreamingUiState: vi.fn(),
      showConversationContextNotice: vi.fn(),
      removeConversationContextNotice: vi.fn(),
      hidePresetPopover: vi.fn(),
      hideHistoryPopover: vi.fn(),
      removeCenteredState: vi.fn(),
      removeSuggestions: vi.fn(),
      resetConversationView: vi.fn(),
      autosizeInput: vi.fn()
    },
    ensureCurrentContextForSend: vi.fn(async () => true),
    getProviderId: () => "test-provider",
    getTimestampNavDeps: () => ({}),
    normalizeMarkdownForSectionPaste,
    connectPort: vi.fn(async () => {
      const port: FakePort = {
        name: "offscreen-chat",
        postMessage: vi.fn(),
        disconnect: vi.fn(),
        onMessage: { addListener: (_fn: (msg: unknown) => void) => {} },
        onDisconnect: { addListener: (_fn: () => void) => {} }
      };
      ports.push(port);
      return port;
    }),
    ...overrides
  };
  return { deps: deps as CreateChatRuntimeDeps, input, ports, ui: deps.ui };
}

function firstPosted(ports: FakePort[]): Record<string, unknown> {
  return ports[0].postMessage.mock.calls[0][0] as Record<string, unknown>;
}

beforeEach(async () => {
  resetModuleState();
  createChatRuntime = (await import("../../extension/chat/chat-runtime.js")).createChatRuntime;
  chatSessionState = (await import("../../extension/chat/chat-state.js")).chatSessionState;
  chatSessionState.contextData = { title: "测试视频", url: "https://www.bilibili.com/video/BV1test" };
  chatSessionState.chatHistory = [];
  chatSessionState.currentContextKey = "video:BV1test";
});

describe("发送受理时消费附件区", () => {
  it("有附件：takeInputImages 被调用一次，images 随消息下发", async () => {
    const takeInputImages = vi.fn(() => [IMAGE]);
    const { deps, input, ports } = makeDeps({ takeInputImages });
    input.value = "这张图里是什么";

    await createChatRuntime(deps).sendMessage();

    expect(takeInputImages).toHaveBeenCalledTimes(1);
    expect(firstPosted(ports)).toMatchObject({
      action: "chat",
      prompt: "这张图里是什么",
      images: [IMAGE]
    });
  });

  it("无附件（take 返回空数组）：不带 images 字段", async () => {
    const { deps, input, ports } = makeDeps({ takeInputImages: () => [] });
    input.value = "总结一下";

    await createChatRuntime(deps).sendMessage();

    expect("images" in firstPosted(ports)).toBe(false);
  });

  it("未注入 takeInputImages（旧组合根）：不带 images 字段", async () => {
    const { deps, input, ports } = makeDeps();
    input.value = "总结一下";

    await createChatRuntime(deps).sendMessage();

    expect("images" in firstPosted(ports)).toBe(false);
  });
});

describe("被拒绝的发送不消费附件区", () => {
  it("无可用平台：不调用 takeInputImages（附件留给下一次发送）", async () => {
    const takeInputImages = vi.fn(() => [IMAGE]);
    const { deps, input, ports } = makeDeps({ takeInputImages, getProviderId: () => "" });
    input.value = "这张图里是什么";

    await createChatRuntime(deps).sendMessage();

    expect(ports).toHaveLength(0);
    expect(takeInputImages).not.toHaveBeenCalled();
  });

  it("上下文读取失败：不调用 takeInputImages", async () => {
    const takeInputImages = vi.fn(() => [IMAGE]);
    const { deps, input, ports } = makeDeps({
      takeInputImages,
      ensureCurrentContextForSend: vi.fn(async () => false)
    });
    input.value = "这张图里是什么";

    await createChatRuntime(deps).sendMessage();

    expect(ports).toHaveLength(0);
    expect(takeInputImages).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 本轮图片写回 chatHistory（image-input 04 号票）：图片进历史是「追问重发」与
// 「落盘后刷新仍能看到图」的前提——此前 takeInputImages 读后即清，历史里没有图。
// ===========================================================================
describe("本轮图片写回 chatHistory", () => {
  it("带图发送 → done：图片挂在那条 user 消息上并落盘", async () => {
    const { deps, input } = makeDeps({ takeInputImages: () => [IMAGE] });
    input.value = "这张图里是什么";
    const runtime = createChatRuntime(deps);

    await runtime.sendMessage();
    runtime.handleChatPortMessage({ type: "token", data: "是截图" });
    runtime.handleChatPortMessage({ type: "done" });

    expect(chatSessionState.chatHistory).toEqual([
      { role: "user", content: "这张图里是什么", images: [IMAGE] },
      { role: "assistant", content: "是截图" }
    ]);
    expect(deps.store.persistCurrent).toHaveBeenCalledTimes(1);
  });

  it("无图发送 → done：user 消息不带 images 字段（历史线格式与改动前一致）", async () => {
    const { deps, input } = makeDeps({ takeInputImages: () => [] });
    input.value = "总结一下";
    const runtime = createChatRuntime(deps);

    await runtime.sendMessage();
    runtime.handleChatPortMessage({ type: "token", data: "好" });
    runtime.handleChatPortMessage({ type: "done" });

    expect(chatSessionState.chatHistory).toEqual([
      { role: "user", content: "总结一下" },
      { role: "assistant", content: "好" }
    ]);
    expect("images" in chatSessionState.chatHistory[0]).toBe(false);
  });

  it("收口清空代际图片：下一轮无图发送不继承上一轮的图", async () => {
    const takeInputImages = vi.fn(() => [IMAGE]);
    const { deps, input } = makeDeps({ takeInputImages });
    input.value = "第一轮带图";
    const runtime = createChatRuntime(deps);
    await runtime.sendMessage();
    runtime.handleChatPortMessage({ type: "token", data: "答一" });
    runtime.handleChatPortMessage({ type: "done" });

    takeInputImages.mockReturnValue([]);
    deps.input.value = "第二轮纯文本";
    await runtime.sendMessage();
    runtime.handleChatPortMessage({ type: "token", data: "答二" });
    runtime.handleChatPortMessage({ type: "done" });

    expect(chatSessionState.chatHistory).toEqual([
      { role: "user", content: "第一轮带图", images: [IMAGE] },
      { role: "assistant", content: "答一" },
      { role: "user", content: "第二轮纯文本" },
      { role: "assistant", content: "答二" }
    ]);
  });
});

// ===========================================================================
// 400 兜底（image-input 05 号票）：平台回 400 且本轮带图时，用户可见的错误文案要
// 带一条可操作线索（「可能是模型不支持图片」）——判定与文案在 chat/image-support.js，
// 这里钉住渲染侧真的把 hint 拼进了那条 .chat-msg-error。
// ===========================================================================
describe("平台 400 的用户可见文案（带图时补可操作线索）", () => {
  async function sendWithImagesAndFail(error: string, images: { mime: string; data: string }[]) {
    const { deps, input } = makeDeps({ takeInputImages: () => images });
    input.value = "这张图里是什么";
    const runtime = createChatRuntime(deps);
    await runtime.sendMessage();
    runtime.handleChatPortMessage({ type: "error", error });
    return deps.messages;
  }

  it("HTTP 400 + 平台文案无线索：文案含「可能是模型不支持图片」与出路", async () => {
    const messages = await sendWithImagesAndFail("HTTP 400: [openai] invalid_request_error", [IMAGE]);

    const errorNode = messages.querySelector(".chat-msg-error") as HTMLElement;
    expect(errorNode.textContent).toContain("HTTP 400");
    expect(errorNode.textContent).toContain("可能是模型不支持图片");
    expect(errorNode.textContent).toContain("移除图片后重试");
  });

  it("平台 detail 已含图片线索：只透传平台文案，不追加固定提示", async () => {
    const messages = await sendWithImagesAndFail(
      "HTTP 400: [openai] this model does not support image input",
      [IMAGE]
    );

    const errorNode = messages.querySelector(".chat-msg-error") as HTMLElement;
    expect(errorNode.textContent).toContain("does not support image input");
    expect(errorNode.textContent).not.toContain("可能是模型不支持图片");
  });

  it("无图 + HTTP 400：不补提示（图片不是这条错误的原因）", async () => {
    const messages = await sendWithImagesAndFail("HTTP 400: [openai] invalid_request_error", []);

    const errorNode = messages.querySelector(".chat-msg-error") as HTMLElement;
    expect(errorNode.textContent).toBe("错误：HTTP 400: [openai] invalid_request_error");
  });
});
