// 消息操作反馈归属（06 号票：全局状态条只承载壳层与跨域反馈，对话域任务反馈
// 留在对话 tab 上下文）：
//   - 复制回复成功：就地反馈 = 按钮 flash（图标换对勾、aria-label 变「已复制」），
//     不再写全局状态条（与字幕复制的全局短暂反馈是两条纹理，06 号票只保留后者）；
//   - 导出 Markdown 失败：经渲染片 onNotice dep 落到对话 tab 自己的通知通道
//     （装配方接到 showConversationContextNotice），不借全局状态条。
//
// 手法：与 tests/chat/chat-runtime-stream-invariants.test.ts 同款协议级 harness
//（假 port 驱动 sendTurn → token → done），终态消息节点的操作行是真实装配。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { normalizeMarkdownForSectionPaste } from "../../extension/notes/paste.js";
import type { ChatPort } from "../../extension/chat/chat-runtime.js";

let createChatRuntime: typeof import("../../extension/chat/chat-runtime.js").createChatRuntime;
let chatSessionState: typeof import("../../extension/chat/chat-state.js").chatSessionState;
let resetChatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").resetChatSessionStateForTests;

interface FakePort {
  name: string;
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (fn: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
}

function makeDeps() {
  const messages = document.createElement("div");
  const input = document.createElement("textarea");
  return {
    messages,
    input,
    store: {
      persistCurrent: vi.fn(async () => {}),
      isCurrent: vi.fn(() => true)
    },
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
    getTimestampNavDeps: () => ({}),
    normalizeMarkdownForSectionPaste,
    connectPort: vi.fn(async () => {
      const port: FakePort = {
        name: "offscreen-chat",
        onMessage: { addListener: () => {} },
        onDisconnect: { addListener: () => {} },
        postMessage: vi.fn(),
        disconnect: vi.fn()
      };
      return port as unknown as ChatPort;
    })
  };
}

type RuntimeDeps = ReturnType<typeof makeDeps>;

async function makeFinishedAssistant(deps: RuntimeDeps) {
  const runtime = createChatRuntime(deps);
  deps.input.value = "问题";
  await runtime.sendTurn(deps.input.value);
  runtime.handleChatPortMessage({ type: "token", data: "回答正文" });
  runtime.handleChatPortMessage({ type: "done" });
  const node = deps.messages.querySelector(".chat-msg-assistant") as HTMLElement;
  return { runtime, node };
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  ({ createChatRuntime } = await import("../../extension/chat/chat-runtime.js"));
  ({ chatSessionState, resetChatSessionStateForTests } = await import("../../extension/chat/chat-state.js"));
  resetChatSessionStateForTests();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("消息操作反馈归属（06 号票）", () => {
  it("复制回复成功：按钮就地 flash（aria-label 变「已复制」），通知通道与历史不被惊动", async () => {
    const deps = makeDeps();
    const { node } = await makeFinishedAssistant(deps);
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    const copyBtn = node.querySelector<HTMLButtonElement>(".chat-msg-copy-btn")!;
    expect(copyBtn).not.toBeNull();
    copyBtn.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("回答正文"));

    // 就地反馈：图标置换 + aria-label/title 变「已复制」
    expect(copyBtn.getAttribute("aria-label")).toBe("已复制");
    expect(copyBtn.classList.contains("is-copied")).toBe(true);
    // 不借通知通道（也不写全局状态条——渲染片已无 ui-status 依赖）
    expect(deps.ui.showConversationContextNotice).not.toHaveBeenCalled();
  });

  it("复制保留原 Markdown，用户消息也复制原文而不升级标题", async () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);
    await runtime.sendTurn("# 用户标题");
    runtime.handleChatPortMessage({ type: "token", data: "## 回答标题\n\n**粗体**" });
    runtime.handleChatPortMessage({ type: "done" });
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    const assistant = deps.messages.querySelector(".chat-msg-assistant")!;
    assistant.querySelector<HTMLButtonElement>(".chat-msg-copy-btn")!.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("## 回答标题\n\n**粗体**"));

    const user = deps.messages.querySelector(".chat-msg-user")!;
    user.querySelector<HTMLButtonElement>(".chat-msg-copy-btn")!.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("# 用户标题"));
  });

  it("复制失败：经对话通知通道提示检查权限，可重试", async () => {
    const deps = makeDeps();
    const { node } = await makeFinishedAssistant(deps);
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    const copyBtn = node.querySelector<HTMLButtonElement>(".chat-msg-copy-btn")!;
    copyBtn.click();

    await vi.waitFor(() => expect(deps.ui.showConversationContextNotice).toHaveBeenCalledWith(
      "复制失败，请检查浏览器剪贴板权限后重试",
      4000
    ));
    expect(copyBtn.disabled).toBe(false);
  });

  it("导出 Markdown 失败：onNotice 落到对话 tab 通知通道，文案带病因", async () => {
    const deps = makeDeps();
    const { node } = await makeFinishedAssistant(deps);
    // 强制 createObjectURL 抛错，让装配方 exportAssistant 同步失败
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      throw new Error("blob 分配失败");
    });

    const exportBtn = node.querySelector<HTMLButtonElement>(".chat-msg-export-btn")!;
    expect(exportBtn.disabled).toBe(false);
    exportBtn.click();

    expect(deps.ui.showConversationContextNotice).toHaveBeenCalledTimes(1);
    const notice = deps.ui.showConversationContextNotice.mock.calls[0][0] as string;
    expect(notice).toContain("导出失败：");
    expect(notice).toContain("blob 分配失败");
  });
});
