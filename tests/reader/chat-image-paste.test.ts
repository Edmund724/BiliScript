import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain } from "../helpers/reader-skeleton.js";
import { callbackStyleSendMessage } from "../helpers/chrome-runtime-host.js";
import { createMemoryStorageArea, type ChromeHostStorageArea } from "../helpers/memory-storage-area.js";
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

const DEFAULT_PROVIDERS_PAYLOAD = [{ id: "p1", name: "平台一", model: "模型一", enabled: true }];
let providersPayload: Array<Record<string, unknown>> = DEFAULT_PROVIDERS_PAYLOAD;

type Sendstub = ReturnType<typeof vi.fn>;
function stubChromeByType(): void {
  const chromeStub = window.chrome as unknown as {
    runtime: { sendMessage: Sendstub; connect: Sendstub };
    storage: {
      local: ChromeHostStorageArea;
      sync: { set: Sendstub };
      onChanged: { addListener: Sendstub; removeListener: Sendstub };
    };
  };
  chromeStub.runtime.sendMessage = callbackStyleSendMessage({
    "ai-providers-list": () => ({ ok: true, providers: providersPayload })
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
  chromeStub.storage.local = createMemoryStorageArea();
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

const WEBP_BYTES = [0x89, 0x50, 0x4e, 0x47];

function stubCanvasPrimitives(): void {
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 2400, height: 1200 }))
  );
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

async function waitForImageReady(strip: HTMLElement): Promise<void> {
  await waitFor(() => strip.querySelector(".chat-image-open .chat-image-thumb") !== null);
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
  it("Ctrl+V 图片：立即回车受处理中守卫，完成后发送 WebP 并清空附件区", async () => {
    await activateChat();
    const input = inputEl();
    const strip = imageStrip();
    expect(strip.hidden).toBe(true);

    const event = dispatchPaste(input, [textItem(), imageItem("image/png")]);
    expect(event.defaultPrevented).toBe(true);
    expect(strip.hidden).toBe(false);
    expect(strip.querySelectorAll(".chat-image-item")).toHaveLength(1);
    expect(strip.querySelector(".chat-image-skeleton")).not.toBeNull();

    input.value = "这张图里是什么";
    sendEnter();
    expect(ports).toHaveLength(0);
    expect(document.querySelector(".chat-context-notice")?.textContent).toContain("图片处理中…");

    await waitForImageReady(strip);
    const open = strip.querySelector<HTMLButtonElement>(".chat-image-open.chat-image-preview");
    expect(open).not.toBeNull();
    expect(open?.querySelector(".chat-image-thumb")?.getAttribute("src")).toBe(
      "data:image/webp;base64,iVBORw=="
    );

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
    await waitForImageReady(strip);

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
    expect(messages.querySelector(".chat-context-notice")?.textContent).toContain("正在生成回答");
    expect(strip.hidden).toBe(true);
    expect(strip.querySelectorAll(".chat-image-item")).toHaveLength(0);
  });

  it("字幕等待期间粘贴图片：真实压缩后保留，不并入已受理的原回合", async () => {
    state.clip.title = "测试视频";
    state.clip.bvid = "BV1test000000";
    state.clip.cid = "101";
    state.clip.subtitleFetchState = "loading";
    state.clip.subtitleBody = [];
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();

    const input = inputEl();
    const strip = imageStrip();
    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    input.value = "闸中问题";
    sendEnter();
    await waitFor(() => document.querySelector<HTMLElement>(".chat-subtitle-wait")?.hidden === false);
    expect(ports).toHaveLength(0);

    dispatchPaste(input, [imageItem()]);
    await waitForImageReady(strip);

    const statusBus = await import("../../extension/shared/subtitle-status-bus.js");
    state.clip.subtitleFetchState = "ready";
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "大家好" }];
    statusBus.publishSubtitleStatusPhase("asr-done");
    await waitFor(() => ports.length === 1 && ports[0].postMessage.mock.calls.length === 1);

    const posted = ports[0].postMessage.mock.calls[0][0] as { images?: unknown[] };
    expect(posted.images).toBeUndefined();
    expect(strip.querySelectorAll(".chat-image-item")).toHaveLength(1);
    expect(messages.textContent).toContain("已发送原文，保留了后来修改的草稿与图片");
  });

  it("快捷动作遇到草稿与图片附件：直接发出纯文本快捷提示词，文字草稿与图片附件均原样保留", async () => {
    await activateChat();
    const chat = await lazyChat.ensureReaderChatTab();
    const input = inputEl();
    const strip = imageStrip();
    dispatchPaste(input, [imageItem()]);
    await waitForImageReady(strip);
    input.value = "草稿与图片都保留";

    const accepted = await chat.runQuickActionPrompt("整理这期视频的内容，输出结构化总结。");

    expect(accepted).toBe(true);
    expect(input.value).toBe("草稿与图片都保留");
    expect(strip.querySelectorAll(".chat-image-item")).toHaveLength(1);
    expect(strip.hidden).toBe(false);
    expect(ports).toHaveLength(1);
    const posted = ports[0].postMessage.mock.calls[0][0] as { prompt?: string; images?: unknown[] };
    expect(posted.prompt).toBe("整理这期视频的内容，输出结构化总结。");
    expect(posted.images).toBeUndefined();
  });

  it("会话已激活时确认新会话：附件随输入框一起清空", async () => {
    await activateChat();
    const input = inputEl();
    const strip = imageStrip();
    dispatchPaste(input, [imageItem()]);
    await waitForImageReady(strip);
    input.value = "草稿一句";

    const newChatBtn = document.getElementById(ids.readingChatNewBtn) as HTMLButtonElement;
    newChatBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(document.querySelectorAll(".confirm-dialog-host")).toHaveLength(1);
    expect(strip.hidden).toBe(false);
    expect(input.value).toBe("草稿一句");

    document.querySelector<HTMLButtonElement>(".confirm-dialog-confirm")!.click();

    await waitFor(() => strip.hidden === true);
    expect(strip.querySelectorAll(".chat-image-item")).toHaveLength(0);
    expect(input.value).toBe("");
  });
});

describe("闸内上下文变化（apply-live → restartChat）与附件", () => {
  function switchPageCid(cid: string): void {
    state.clip.cid = cid;
    state.clip.subtitleBody = [{ from: 0, to: 10, content: `第 ${cid} P 的字幕` }];
  }

  it("发送带图 + 闸内 context 变化：发出的 chat 消息仍带 images，附件随受理清空", async () => {
    await activateChat();
    const input = inputEl();
    const strip = imageStrip();
    dispatchPaste(input, [imageItem()]);
    await waitForImageReady(strip);

    switchPageCid("202");
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
    expect(strip.hidden).toBe(true);
    expect(strip.querySelectorAll(".chat-image-item")).toHaveLength(0);
    expect(input.value).toBe("");
  });

  it("发送带图 + 闸内 context 变化 + 无字幕拦截：附件不消费、输入框文本保留", async () => {
    await activateChat();
    const input = inputEl();
    const strip = imageStrip();
    dispatchPaste(input, [imageItem()]);
    await waitForImageReady(strip);

    state.clip.cid = "202";
    state.clip.subtitleFetchState = "empty";
    state.clip.subtitleBody = [];
    input.value = "这张图里是什么";
    sendEnter();
    await waitFor(() => Boolean(document.querySelector(".chat-input-card .chat-context-notice")));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(ports).toHaveLength(0);
    expect(input.value).toBe("这张图里是什么");
    expect(strip.hidden).toBe(false);
    expect(strip.querySelectorAll(".chat-image-item")).toHaveLength(1);
  });
});

describe("发图门控（目录乐观放行）", () => {
  it("目录仅文本的模型带图发送：提示「可能不支持图片」，消息照常下发", async () => {
    providersPayload = [
      {
        id: "p1",
        name: "DeepSeek",
        model: "deepseek-v4-pro",
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
    await waitForImageReady(strip);

    input.value = "这张图里是什么";
    sendEnter();

    await waitFor(() => Boolean(messages.querySelector(".chat-context-notice")));
    expect(messages.querySelector(".chat-context-notice")?.textContent).toContain("可能不支持图片");

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
    await waitForImageReady(strip);

    input.value = "这张图里是什么";
    sendEnter();
    await waitFor(() => ports.length === 1 && ports[0].postMessage.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(messages.querySelector(".chat-context-notice")).toBeNull();
  });
});
