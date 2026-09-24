// tests/reader/chat-image-paste.test.ts
// 02 号票的集成回归：真实模板（ensureUiReady）+ 对话 tab 组合根上，粘贴图片的
// 端到端链路——textarea 的 paste 监听（lifecycle bindEvents）→ 压缩（image-compress
// 真实管线）→ 附件区缩略图 → 容器委托删除 → 回车发送带走 images 字段并清空附件区。
//
// jsdom 没有 createImageBitmap / canvas 2d / toBlob：本文件按既有 canvas 测试先例
// 直接 mock 这三个 DOM 原语（不注入替身），从而跑的是真实的压缩管线；纯文本粘贴
// 不拦截、流式闸、删除键委托也在同一宿主上锁定。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

const { gatewayMock, gatewayCoreMock } = vi.hoisted(() => ({
  gatewayMock: {
    getCurrentAid: vi.fn(() => 0),
    fetchHotComments: vi.fn(async (_count?: number) => [])
  },
  gatewayCoreMock: {
    bgFetchJson: vi.fn(),
    isBiliUrl: vi.fn(() => true)
  }
}));

vi.mock("../../extension/bilibili/gateway.js", () => ({
  getCurrentAid: gatewayMock.getCurrentAid,
  fetchHotComments: gatewayMock.fetchHotComments,
  fetchHotCommentsWithLedger: async () => ({ comments: [], note: "无法获取视频 aid" })
}));
vi.mock("../../extension/bilibili/gateway-core.js", () => ({
  bgFetchJson: gatewayCoreMock.bgFetchJson,
  isBiliUrl: gatewayCoreMock.isBiliUrl
}));

let state: TestState;
let ids: typeof import("../../extension/reader/state.js").ids;
let uiRenderer: typeof import("../../extension/ui/ui-renderer.js");
let lazyChat: typeof import("../../extension/reader/lazy-chat-tab.js");

interface FakePort {
  name: string;
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (fn: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
}
const ports: FakePort[] = [];

// ai-providers-list 载荷（stub 的 sendMessage 闭包按引用读）：缺省是目录查不到的
// 「模型一」，门控用例替换成落在真实目录里的平台/模型。
const DEFAULT_PROVIDERS_PAYLOAD = [{ id: "p1", name: "平台一", model: "模型一", enabled: true }];
let providersPayload: Array<Record<string, unknown>> = DEFAULT_PROVIDERS_PAYLOAD;

type Sendstub = ReturnType<typeof vi.fn>;
function stubChromeByType(): void {
  const chromeStub = window.chrome as unknown as {
    runtime: { sendMessage: Sendstub; connect: Sendstub };
    storage: {
      local: { get: Sendstub; set: Sendstub };
      sync: { set: Sendstub };
      onChanged: { addListener: Sendstub; removeListener: Sendstub };
    };
  };
  chromeStub.runtime.sendMessage = vi.fn((message: { type?: string }, callback?: (resp: unknown) => void) => {
    if (String(message?.type || "") === "ai-providers-list") {
      callback?.({ ok: true, providers: providersPayload });
    } else {
      callback?.({ ok: true });
    }
    return undefined;
  });
  chromeStub.runtime.connect = vi.fn(() => {
    const port: FakePort = {
      name: "offscreen-chat",
      postMessage: vi.fn(),
      disconnect: vi.fn(),
      onMessage: { addListener: (_fn: (msg: unknown) => void) => {} },
      onDisconnect: { addListener: (_fn: () => void) => {} }
    };
    ports.push(port);
    return port;
  });
  chromeStub.storage.local.get = vi.fn(async () => ({}));
  chromeStub.storage.local.set = vi.fn(async () => {});
  chromeStub.storage.sync.set = vi.fn(async () => {});
}

async function waitFor(predicate: () => boolean, { timeoutMs = 1000 } = {}): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition not met within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function seedReadyContext(): void {
  state.clip.title = "测试视频";
  state.clip.bvid = "BV1test000000";
  state.clip.cid = "101";
  state.clip.aid = "7100";
  state.clip.subtitleFetchState = "ready";
  state.clip.subtitleBody = [{ from: 0, to: 10, content: "大家好" }];
}

async function loadShell(): Promise<void> {
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  ids = (await import("../../extension/reader/state.js")).ids;
  uiRenderer = await import("../../extension/ui/ui-renderer.js");
  lazyChat = await import("../../extension/reader/lazy-chat-tab.js");
  uiRenderer.ensureUiReady({ forceRecreate: true });
  mountPlayerChain();
}

// 粘贴的 webp 编码结果（canvas.toBlob 替身产出）
const WEBP_BYTES = [0x89, 0x50, 0x4e, 0x47];

function stubCanvasPrimitives(): void {
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 2400, height: 1200 }))
  );
  // 同一张 canvas 2d 替身服务两条既有路径：图片压缩的 drawImage，以及模型 chip
  // 宽度度量的 measureText（model-select-width 在激活期跑）。
  vi.spyOn(window.HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
    measureText: vi.fn(() => ({ width: 0 }))
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(window.HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback: BlobCallback) => {
    callback(new Blob([new Uint8Array(WEBP_BYTES)], { type: "image/webp" }));
  });
}

interface FakeClipboardItem {
  kind: string;
  type: string;
  getAsFile: () => File | null;
}

function imageItem(type = "image/png"): FakeClipboardItem {
  return { kind: "file", type, getAsFile: () => new File([new Uint8Array([1, 2, 3])], "shot.png", { type }) };
}

function textItem(): FakeClipboardItem {
  return { kind: "string", type: "text/plain", getAsFile: () => null };
}

// jsdom 无 ClipboardEvent / DataTransfer：用真实 Event（cancelable）挂上
// clipboardData 具名属性——组合根的 paste 监听读到的是同一份形状。
function dispatchPaste(target: HTMLElement, items: FakeClipboardItem[] | null): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: items ? { items } : null,
    configurable: true
  });
  target.dispatchEvent(event);
  return event;
}

function imageStrip(): HTMLElement {
  return document.getElementById(ids.readingChatImageStrip) as HTMLElement;
}

async function activateChat(): Promise<void> {
  seedReadyContext();
  const chat = await lazyChat.ensureReaderChatTab();
  await chat.ensureChatTabActivated();
}

function inputEl(): HTMLTextAreaElement {
  return document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
}

function sendEnter(): void {
  inputEl().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-biliscript-reader-mode");
  document.body.removeAttribute("data-biliscript-reader-mode");
  ports.length = 0;
  providersPayload = DEFAULT_PROVIDERS_PAYLOAD;
  stubCanvasPrimitives();
  await loadShell();
  stubChromeByType();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("粘贴图片（真实压缩管线 + 组合根接线）", () => {
  it("Ctrl+V 图片：拦截、压缩成 WebP 缩略图；回车发送带走 images 并清空附件区", async () => {
    await activateChat();
    const input = inputEl();
    const strip = imageStrip();
    expect(strip.hidden).toBe(true); // 初始无附件

    const event = dispatchPaste(input, [textItem(), imageItem("image/png")]);
    await waitFor(() => strip.querySelectorAll(".chat-image-item").length === 1);

    expect(event.defaultPrevented).toBe(true); // 含 image/*：拦截
    expect(strip.hidden).toBe(false);
    // 缩略图是压缩后的 WebP data URL（长边 2400→1568 后的 toBlob 产物）
    expect(strip.querySelector(".chat-image-thumb")?.getAttribute("src")).toBe(
      "data:image/webp;base64,iVBORw=="
    );

    input.value = "这张图里是什么";
    sendEnter();
    await waitFor(() => ports.length === 1 && ports[0].postMessage.mock.calls.length === 1);

    const posted = ports[0].postMessage.mock.calls[0][0] as {
      prompt?: string;
      images?: Array<{ mime: string; data: string }>;
    };
    expect(posted.prompt).toBe("这张图里是什么");
    expect(posted.images).toHaveLength(1);
    expect(posted.images?.[0].mime).toBe("image/webp");
    expect(atob(String(posted.images?.[0].data))).toBe("\x89PNG");

    // 发送后清空附件区 + 输入框
    expect(strip.hidden).toBe(true);
    expect(strip.querySelectorAll(".chat-image-item")).toHaveLength(0);
    expect(input.value).toBe("");
  });

  it("无附件的发送不带 images 字段（无图消息线格式不变）", async () => {
    await activateChat();
    const input = inputEl();
    input.value = "总结一下";
    sendEnter();

    await waitFor(() => ports.length === 1 && ports[0].postMessage.mock.calls.length === 1);
    const posted = ports[0].postMessage.mock.calls[0][0] as Record<string, unknown>;
    expect("images" in posted).toBe(false);
  });

  it("纯文本粘贴：不拦截（默认粘贴行为不变），附件区不动", async () => {
    await activateChat();
    const strip = imageStrip();

    const event = dispatchPaste(inputEl(), [textItem()]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(event.defaultPrevented).toBe(false);
    expect(strip.hidden).toBe(true);
    expect(strip.querySelectorAll(".chat-image-item")).toHaveLength(0);
  });

  it("删除键（容器委托）：点掉唯一一项后附件区回到 hidden，发送不带图", async () => {
    await activateChat();
    const input = inputEl();
    const strip = imageStrip();
    dispatchPaste(input, [imageItem()]);
    await waitFor(() => strip.querySelectorAll(".chat-image-item").length === 1);

    const removeBtn = strip.querySelector(".chat-image-remove") as HTMLButtonElement;
    removeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(strip.hidden).toBe(true);
    expect(strip.querySelectorAll(".chat-image-item")).toHaveLength(0);

    input.value = "继续问";
    sendEnter();
    await waitFor(() => ports.length === 1 && ports[0].postMessage.mock.calls.length === 1);
    const posted = ports[0].postMessage.mock.calls[0][0] as Record<string, unknown>;
    expect("images" in posted).toBe(false);
  });

  it("流式中粘贴图片：拒绝并给出可见提示（不产出附件项）", async () => {
    await activateChat();
    const input = inputEl();
    const strip = imageStrip();
    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;

    input.value = "先问一句";
    sendEnter();
    await waitFor(() => ports.length === 1);

    dispatchPaste(input, [imageItem()]);

    await waitFor(() => Boolean(messages.querySelector(".chat-context-notice")));
    expect(messages.querySelector(".chat-context-notice")?.textContent).toContain("回答生成中");
    expect(strip.hidden).toBe(true);
    expect(strip.querySelectorAll(".chat-image-item")).toHaveLength(0);
  });

  it("会话已激活时新会话清场：附件随输入框一起清空", async () => {
    await activateChat();
    const input = inputEl();
    const strip = imageStrip();
    dispatchPaste(input, [imageItem()]);
    await waitFor(() => strip.querySelectorAll(".chat-image-item").length === 1);

    const newChatBtn = document.getElementById(ids.readingChatNewBtn) as HTMLButtonElement;
    newChatBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    await waitFor(() => strip.hidden === true);
    expect(strip.querySelectorAll(".chat-image-item")).toHaveLength(0);
  });
});

// ===========================================================================
// 发图门控（image-input 05 号票）：发送受理时按选中模型的目录事实乐观放行——
// 目录明确登记「仅文本」才提示（不阻断，消息照发）；查不到静默。真实目录走
// ui/lazy-model-catalog 的动态 import，这里不替身。
// ===========================================================================
describe("发图门控（目录乐观放行）", () => {
  it("目录仅文本的模型带图发送：提示「可能不支持图片」，消息照常下发", async () => {
    providersPayload = [
      {
        id: "p1",
        name: "DeepSeek",
        model: "deepseek-v4-flash",
        presetId: "deepseek",
        baseUrl: "https://api.deepseek.com/v1",
        enabled: true
      }
    ];
    await activateChat();
    const input = inputEl();
    const strip = imageStrip();
    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;

    dispatchPaste(input, [imageItem()]);
    await waitFor(() => strip.querySelectorAll(".chat-image-item").length === 1);

    input.value = "这张图里是什么";
    sendEnter();

    await waitFor(() => Boolean(messages.querySelector(".chat-context-notice")));
    expect(messages.querySelector(".chat-context-notice")?.textContent).toContain("可能不支持图片");

    // 不阻断：消息照发、images 随行（提示只是提示）
    await waitFor(() => ports.length === 1 && ports[0].postMessage.mock.calls.length === 1);
    const posted = ports[0].postMessage.mock.calls[0][0] as { images?: unknown[] };
    expect(posted.images).toHaveLength(1);
  });

  it("目录查不到的模型（无数据平台）带图发送：静默，不发提示", async () => {
    await activateChat();
    const input = inputEl();
    const strip = imageStrip();
    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;

    dispatchPaste(input, [imageItem()]);
    await waitFor(() => strip.querySelectorAll(".chat-image-item").length === 1);

    input.value = "这张图里是什么";
    sendEnter();
    await waitFor(() => ports.length === 1 && ports[0].postMessage.mock.calls.length === 1);
    // 目录查询（动态 import）落在发送之后的微任务里：等一轮再看提示出口，
    // 否则「静默」可能只是还没查到。
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(messages.querySelector(".chat-context-notice")).toBeNull();
  });
});
