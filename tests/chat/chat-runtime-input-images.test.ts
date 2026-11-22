import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { normalizeMarkdownForSectionPaste } from "../../extension/notes/paste.js";
import type { CreateChatRuntimeDeps } from "../../extension/chat/chat-runtime.js";
import type { ChatSessionState } from "../../extension/chat/chat-state.js";

let createChatRuntime: typeof import("../../extension/chat/chat-runtime.js").createChatRuntime;
let chatSessionState: ChatSessionState;
let chatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").chatSessionStateForTests;
let resetChatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").resetChatSessionStateForTests;

interface FakePort {
  name: string;
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (fn: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
  emitMessage: (msg: unknown) => void;
}

const IMAGE = { mime: "image/webp", data: "QUJD" };

function makeImageQueue(initial: { mime: string; data: string }[]) {
  let attachments = [...initial];
  const getInputImages = vi.fn(() => [...attachments]);
  const takeInputImages = vi.fn((snapshot: { mime: string; data: string }[]) => {
    const consumed = new Set(snapshot);
    attachments = attachments.filter((image) => !consumed.has(image));
    return snapshot;
  });
  return {
    getInputImages,
    takeInputImages,
    setImages(next: { mime: string; data: string }[]) {
      attachments = [...next];
    }
  };
}

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
      hideHistoryPopover: vi.fn(),
      removeCenteredState: vi.fn(),
      removeSuggestions: vi.fn(),
      requestViewReset: vi.fn(),
      autosizeInput: vi.fn()
    },
    ensureCurrentContextForSend: vi.fn(async () => ({ pass: true }) as const),
    getProviderId: () => "test-provider",
    getSelectedModel: () => "test-model",
    getTimestampNavDeps: () => ({}),
    normalizeMarkdownForSectionPaste,
    connectPort: vi.fn(async () => {
      const messageListeners: Array<(msg: unknown) => void> = [];
      const port: FakePort = {
        name: "offscreen-chat",
        postMessage: vi.fn(),
        disconnect: vi.fn(),
        onMessage: { addListener: (fn: (msg: unknown) => void) => { messageListeners.push(fn); } },
        onDisconnect: { addListener: (_fn: () => void) => {} },
        emitMessage: (msg: unknown) => {
          for (const fn of [...messageListeners]) {
            fn(msg);
          }
        }
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
  const stateModule = await import("../../extension/chat/chat-state.js");
  chatSessionState = stateModule.chatSessionState;
  chatSessionStateForTests = stateModule.chatSessionStateForTests;
  resetChatSessionStateForTests = stateModule.resetChatSessionStateForTests;
  resetChatSessionStateForTests();
  chatSessionStateForTests.contextData = { title: "测试视频", url: "https://www.bilibili.com/video/BV1test" };
  chatSessionStateForTests.currentContextKey = "video:BV1test";
});

describe("发送受理时消费附件区", () => {
  it("有附件：takeInputImages 按受理快照被调用一次，images 随消息下发", async () => {
    const queue = makeImageQueue([IMAGE]);
    const { deps, input, ports } = makeDeps({
      getInputImages: queue.getInputImages,
      takeInputImages: queue.takeInputImages
    });
    input.value = "这张图里是什么";

    await createChatRuntime(deps).sendTurn(input.value);

    expect(queue.takeInputImages).toHaveBeenCalledTimes(1);
    expect(queue.takeInputImages).toHaveBeenCalledWith([IMAGE]);
    expect(firstPosted(ports)).toMatchObject({
      action: "chat",
      prompt: "这张图里是什么",
      images: [IMAGE]
    });
  });

  it("无附件（快照为空数组）：不带 images 字段", async () => {
    const queue = makeImageQueue([]);
    const { deps, input, ports } = makeDeps({
      getInputImages: queue.getInputImages,
      takeInputImages: queue.takeInputImages
    });
    input.value = "总结一下";

    await createChatRuntime(deps).sendTurn(input.value);

    expect("images" in firstPosted(ports)).toBe(false);
  });

  it("未注入图片回调：不带 images 字段", async () => {
    const { deps, input, ports } = makeDeps();
    input.value = "总结一下";

    await createChatRuntime(deps).sendTurn(input.value);

    expect("images" in firstPosted(ports)).toBe(false);
  });
});

describe("等待期间的发送快照", () => {
  it("原回合只发送受理时文本与图片，后续编辑和新图片全部保留", async () => {
    const laterImage = { mime: "image/webp", data: "TkVX" };
    let attachments = [IMAGE];
    let releaseGate!: (value: { pass: true }) => void;
    const getInputImages = vi.fn(() => attachments);
    const takeInputImages = vi.fn((snapshot: typeof IMAGE[]) => {
      attachments = attachments.filter((image) => !snapshot.includes(image));
      return snapshot;
    });
    const { deps, input, ports, ui } = makeDeps({
      getInputImages,
      takeInputImages,
      ensureCurrentContextForSend: vi.fn(() => new Promise<{ pass: true }>((resolve) => {
        releaseGate = resolve;
      }))
    });
    input.value = "原始问题";
    const sending = createChatRuntime(deps).sendTurn(input.value);
    await vi.waitFor(() => expect(deps.ensureCurrentContextForSend).toHaveBeenCalled());

    input.value = "等待期间的新草稿";
    attachments = [...attachments, laterImage];
    releaseGate({ pass: true });
    await expect(sending).resolves.toBe("accepted");

    expect(firstPosted(ports)).toMatchObject({ prompt: "原始问题", images: [IMAGE] });
    expect(deps.messages.querySelector(".chat-msg-user .chat-image-thumb")?.getAttribute("src")).toBe("data:image/webp;base64,QUJD");
    expect(takeInputImages).toHaveBeenCalledWith([IMAGE]);
    expect(input.value).toBe("等待期间的新草稿");
    expect(attachments).toEqual([laterImage]);
    expect(ui.showConversationContextNotice).toHaveBeenCalledWith("已发送原文，保留了后来修改的草稿与图片", 4000);
  });

  it("用户取消等待：文本与图片不消费，也不发起 port", async () => {
    const queue = makeImageQueue([IMAGE]);
    const { deps, input, ports } = makeDeps({
      getInputImages: queue.getInputImages,
      takeInputImages: queue.takeInputImages,
      ensureCurrentContextForSend: vi.fn(async () => ({ pass: false, kind: "cancelled" }) as const)
    });
    input.value = "保留这条草稿";

    await expect(createChatRuntime(deps).sendTurn(input.value)).resolves.toBe("blocked");

    expect(input.value).toBe("保留这条草稿");
    expect(queue.takeInputImages).not.toHaveBeenCalled();
    expect(ports).toHaveLength(0);
  });
});

describe("被拒绝的发送不消费附件区", () => {
  it("无可用平台：不调用 takeInputImages（附件留给下一次发送）", async () => {
    const queue = makeImageQueue([IMAGE]);
    const { deps, input, ports } = makeDeps({
      getInputImages: queue.getInputImages,
      takeInputImages: queue.takeInputImages,
      getProviderId: () => ""
    });
    input.value = "这张图里是什么";

    await createChatRuntime(deps).sendTurn(input.value);

    expect(ports).toHaveLength(0);
    expect(queue.takeInputImages).not.toHaveBeenCalled();
  });

  it("上下文读取失败：不调用 takeInputImages", async () => {
    const queue = makeImageQueue([IMAGE]);
    const { deps, input, ports } = makeDeps({
      getInputImages: queue.getInputImages,
      takeInputImages: queue.takeInputImages,
      ensureCurrentContextForSend: vi.fn(async () => ({ pass: false, kind: "read-failed" }) as const)
    });
    input.value = "这张图里是什么";

    await createChatRuntime(deps).sendTurn(input.value);

    expect(ports).toHaveLength(0);
    expect(queue.takeInputImages).not.toHaveBeenCalled();
  });
});

describe("本轮图片写回 chatHistory", () => {
  it("带图发送 → done：图片挂在那条 user 消息上并落盘", async () => {
    const queue = makeImageQueue([IMAGE]);
    const { deps, input, ports } = makeDeps({
      getInputImages: queue.getInputImages,
      takeInputImages: queue.takeInputImages
    });
    input.value = "这张图里是什么";
    const runtime = createChatRuntime(deps);

    await runtime.sendTurn(input.value);
    ports.at(-1)!.emitMessage({ type: "token", data: "是截图" });
    ports.at(-1)!.emitMessage({ type: "done" });

    expect(chatSessionState.chatHistory).toEqual([
      { role: "user", content: "这张图里是什么", images: [IMAGE], contextKey: "video:BV1test" },
      { role: "assistant", content: "是截图" }
    ]);
    expect(deps.store.persistCurrent).toHaveBeenCalledTimes(1);
  });

  it("无图发送 → done：user 消息不带 images 字段，contextKey 独立保存", async () => {
    const queue = makeImageQueue([]);
    const { deps, input, ports } = makeDeps({
      getInputImages: queue.getInputImages,
      takeInputImages: queue.takeInputImages
    });
    input.value = "总结一下";
    const runtime = createChatRuntime(deps);

    await runtime.sendTurn(input.value);
    ports.at(-1)!.emitMessage({ type: "token", data: "好" });
    ports.at(-1)!.emitMessage({ type: "done" });

    expect(chatSessionState.chatHistory).toEqual([
      { role: "user", content: "总结一下", contextKey: "video:BV1test" },
      { role: "assistant", content: "好" }
    ]);
    expect("images" in chatSessionState.chatHistory[0]).toBe(false);
  });

  it("收口清空代际图片：下一轮无图发送不继承上一轮的图", async () => {
    const queue = makeImageQueue([IMAGE]);
    const { deps, input, ports } = makeDeps({
      getInputImages: queue.getInputImages,
      takeInputImages: queue.takeInputImages
    });
    input.value = "第一轮带图";
    const runtime = createChatRuntime(deps);
    await runtime.sendTurn(input.value);
    ports.at(-1)!.emitMessage({ type: "token", data: "答一" });
    ports.at(-1)!.emitMessage({ type: "done" });

    queue.setImages([]);
    deps.input.value = "第二轮纯文本";
    await runtime.sendTurn(input.value);
    ports.at(-1)!.emitMessage({ type: "token", data: "答二" });
    ports.at(-1)!.emitMessage({ type: "done" });

    expect(chatSessionState.chatHistory).toEqual([
      { role: "user", content: "第一轮带图", images: [IMAGE], contextKey: "video:BV1test" },
      { role: "assistant", content: "答一" },
      { role: "user", content: "第二轮纯文本", contextKey: "video:BV1test" },
      { role: "assistant", content: "答二" }
    ]);
  });
});

describe("平台 400 的用户可见文案（带图时补可操作线索）", () => {
  async function sendWithImagesAndFail(error: string, images: { mime: string; data: string }[]) {
    const queue = makeImageQueue(images);
    const { deps, input, ports } = makeDeps({
      getInputImages: queue.getInputImages,
      takeInputImages: queue.takeInputImages
    });
    input.value = "这张图里是什么";
    const runtime = createChatRuntime(deps);
    await runtime.sendTurn(input.value);
    ports.at(-1)!.emitMessage({ type: "error", error });
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
