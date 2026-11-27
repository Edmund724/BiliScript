import { beforeEach, describe, expect, it, vi } from "vitest";
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
  fetchHotCommentsWithLedger: async () => {
    if (!gatewayMock.getCurrentAid()) {
      return { comments: [], note: "无法获取视频 aid" };
    }
    try {
      return { comments: await gatewayMock.fetchHotComments(20) };
    } catch (error) {
      return { comments: [], note: String((error as Error)?.message || error) };
    }
  }
}));
vi.mock("../../extension/bilibili/gateway-core.js", () => ({
  bgFetchJson: gatewayCoreMock.bgFetchJson,
  isBiliUrl: gatewayCoreMock.isBiliUrl
}));

let state: TestState;
let lazyChat: typeof import("../../extension/reader/lazy-chat-tab.js");
let chatSessionState: typeof import("../../extension/chat/chat-state.js").chatSessionState;

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
    "ai-providers-list": () => ({ ok: true, providers: [{ id: "p1", name: "平台一", model: "模型一", enabled: true }] }),
    "get-settings": () => ({ ok: true, settings: {} }),
    "subtitle-cache": () => ({ handled: false })
  });
  chromeStub.runtime.connect = vi.fn(() => ({
    name: "offscreen-chat",
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: { addListener: () => {} },
    onDisconnect: { addListener: () => {} }
  }));
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

import { contentEventBus } from "../../extension/shared/content-event-bus.js";

function dispatchClipChange(page: number): void {
  const url = `https://www.bilibili.com/video/BV1test000000/?p=${page}&biliscript_reader=1`;
  setLocationUrl(url);
  contentEventBus.emit("host:url-change", { url });
}

function seedReadyContext(): void {
  state.clip.title = "测试视频";
  state.clip.bvid = "BV1test000000";
  state.clip.cid = "101";
  state.clip.aid = "7100";
  state.clip.subtitleFetchState = "ready";
  state.clip.subtitleBody = [{ from: 0, to: 10, content: "大家好" }];
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-biliscript-reader-mode");
  document.body.removeAttribute("data-biliscript-reader-mode");
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  chatSessionState = (await import("../../extension/chat/chat-state.js")).chatSessionState;
  lazyChat = await import("../../extension/reader/lazy-chat-tab.js");
  (await import("../../extension/ui/ui-renderer.js")).ensureUiReady({ forceRecreate: true });
  mountPlayerChain();
  stubChromeByType();
});

describe("URL 变化强刷调度（并回组合根后的 120ms 防抖）", () => {
  it("快速连发 biliscript:urlchange 只触发一轮全量同步（防抖重置，热评拉取恰 +1 次）", async () => {
    gatewayMock.getCurrentAid.mockReturnValue(7100);
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    await waitFor(() => gatewayMock.fetchHotComments.mock.calls.length >= 1);
    const baseline = gatewayMock.fetchHotComments.mock.calls.length;
    chat.closeChatSession();

    const reopened = await lazyChat.ensureReaderChatTab();
    await reopened.ensureChatTabActivated();
    const reopenedBaseline = gatewayMock.fetchHotComments.mock.calls.length;

    dispatchClipChange(2);
    dispatchClipChange(3);
    dispatchClipChange(4);
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(gatewayMock.fetchHotComments.mock.calls.length).toBe(reopenedBaseline + 1);
    expect(reopenedBaseline).toBeGreaterThanOrEqual(baseline);
    reopened.closeChatSession();
  });

  it("防抖到期的强刷反映最新 clip 状态（live 上下文快照更新为新标题）", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    await waitFor(() => gatewayMock.fetchHotComments.mock.calls.length >= 1);

    state.clip.title = "防抖后的新标题";
    dispatchClipChange(2);
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(chatSessionState.liveContextData?.title).toBe("防抖后的新标题");
    chat.closeChatSession();
  });

  it("关闭会话取消已排入的上下文同步防抖：关闭后不再发起网络强刷，重开仍按恢复流程装载上下文", async () => {
    gatewayMock.getCurrentAid.mockReturnValue(7100);
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    await waitFor(() => gatewayMock.fetchHotComments.mock.calls.length >= 1);
    const baseline = gatewayMock.fetchHotComments.mock.calls.length;

    state.clip.title = "关闭前排入的新标题";
    dispatchClipChange(2);

    chat.closeChatSession();

    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(gatewayMock.fetchHotComments.mock.calls.length).toBe(baseline);
    expect(chatSessionState.liveContextData?.title).toBe("测试视频");

    await chat.ensureChatTabActivated();
    expect(chatSessionState.liveContextData?.title).toBe("测试视频");

    state.clip.title = "重开后的新标题";
    dispatchClipChange(3);
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(chatSessionState.liveContextData?.title).toBe("重开后的新标题");
    expect(gatewayMock.fetchHotComments.mock.calls.length).toBe(baseline + 1);
    chat.closeChatSession();
  });

  it("同片内部 URL 更新不触发强刷", async () => {
    gatewayMock.getCurrentAid.mockReturnValue(7100);
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    await waitFor(() => gatewayMock.fetchHotComments.mock.calls.length >= 1);
    const baseline = gatewayMock.fetchHotComments.mock.calls.length;

    contentEventBus.emit("host:url-change", { url: location.href });
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(gatewayMock.fetchHotComments.mock.calls.length).toBe(baseline);
    chat.closeChatSession();
  });

  it("切 P 立即使字幕等待中的旧问题失效，新片 asr-done 不再发送旧问题", async () => {
    seedReadyContext();
    state.clip.subtitleFetchState = "loading";
    state.clip.subtitleBody = [];
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    const { ids } = await import("../../extension/reader/state.js");
    const statusBus = await import("../../extension/shared/subtitle-status-bus.js");
    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    const chromeStub = window.chrome as unknown as { runtime: { connect: Sendstub } };

    input.value = "旧分 P 的等待问题";
    input.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true
    }));
    await waitFor(() => document.querySelector<HTMLElement>(".chat-subtitle-wait")?.hidden === false);
    expect(chromeStub.runtime.connect).not.toHaveBeenCalled();

    dispatchClipChange(2);
    state.clip.cid = "102";
    state.clip.title = "第二分 P";
    state.clip.subtitleFetchState = "ready";
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "新分 P 字幕" }];
    statusBus.publishSubtitleStatusPhase("asr-done");
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(chromeStub.runtime.connect).not.toHaveBeenCalled();
    chat.closeChatSession();
  });
});
