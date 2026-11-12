import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { normalizeMarkdownForSectionPaste } from "../../extension/notes/paste.js";
import { renderMarkdown } from "../../extension/ui/markdown.js";
import type { CreateChatRuntimeDeps } from "../../extension/chat/chat-runtime.js";

type ChatRuntime = ReturnType<typeof import("../../extension/chat/chat-runtime.js").createChatRuntime>;

let createChatRuntime: typeof import("../../extension/chat/chat-runtime.js").createChatRuntime;

function makeDeps(): CreateChatRuntimeDeps & {
  messages: HTMLElement;
  input: HTMLTextAreaElement;
  onContinue: ReturnType<typeof vi.fn>;
} {
  const messages = document.createElement("div");
  const input = document.createElement("textarea");
  const onContinue = vi.fn();
  return {
    messages,
    input,
    onContinue,
    store: {
      persistCurrent: vi.fn(async () => {}),
      isCurrent: () => true
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
    connectPort: vi.fn(() => ({
      name: "offscreen-chat",
      onMessage: { addListener: () => {} },
      onDisconnect: { addListener: () => {} },
      postMessage: vi.fn(),
      disconnect: vi.fn()
    }))
  };
}

function areaOf(runtime: ChatRuntime) {
  return runtime.messageArea;
}

beforeEach(async () => {
  resetModuleState();
  const mod = await import("../../extension/chat/chat-runtime.js");
  createChatRuntime = mod.createChatRuntime;
});

describe("Ticket 02: 中断时思考过程保留与操作栏改造", () => {
  it("仅有思考内容被中断：保留思考节点、标记已停止、默认展开且支持折叠、仅呈现重试与继续生成", () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);
    const area = areaOf(runtime);
    const turn = area.appendAssistantMessage({ source: "live" });

    turn.appendThinking("这里是正在生成的思考过程步骤1与步骤2...");

    const outcome = turn.stop("用户中断", { historyIndex: 0 });

    expect(outcome).toEqual({ raw: "", body: false });

    const node = deps.messages.querySelector(".chat-msg-assistant") as HTMLDivElement;
    expect(node).toBeTruthy();

    // 思考 DOM 保留且文字完整
    const thinkingEl = node.querySelector(".chat-thinking") as HTMLDivElement;
    expect(thinkingEl).toBeTruthy();
    expect(node.contains(thinkingEl)).toBe(true);

    const textEl = thinkingEl.querySelector(".chat-thinking-text");
    expect(textEl?.textContent).toBe("这里是正在生成的思考过程步骤1与步骤2...");

    // 思考框标记为“已停止”
    const labelTextEl = thinkingEl.querySelector(".chat-thinking-label-text");
    expect(labelTextEl?.textContent).toBe("已停止");

    // 默认保持展开（含 collapsible 类，但不含 collapsed 类）
    expect(thinkingEl.classList.contains("chat-thinking-collapsible")).toBe(true);
    expect(thinkingEl.classList.contains("chat-thinking-collapsed")).toBe(false);

    // 支持手动折叠与展开
    thinkingEl.click();
    expect(thinkingEl.classList.contains("chat-thinking-collapsed")).toBe(true);
    expect(thinkingEl.querySelector(".chat-thinking-label-text")?.textContent).toBe("已停止");

    thinkingEl.click();
    expect(thinkingEl.classList.contains("chat-thinking-collapsed")).toBe(false);

    // 停止徽标存在
    const stoppedBadge = node.querySelector(".chat-msg-stopped");
    expect(stoppedBadge?.textContent).toBe("用户中断");

    // 操作栏：仅保留重新生成（重试）与继续生成，隐藏复制、朗读与导出
    const actionBtns = node.querySelectorAll<HTMLButtonElement>(".chat-msg-action-btn");
    expect(actionBtns).toHaveLength(2);
    expect(actionBtns[0].getAttribute("aria-label")).toBe("重新生成");
    expect(actionBtns[0].classList.contains("chat-msg-regenerate-btn")).toBe(true);
    expect(actionBtns[1].getAttribute("aria-label")).toBe("继续生成");
    expect(actionBtns[1].classList.contains("chat-msg-continue-btn")).toBe(true);

    expect(node.querySelector(".chat-msg-copy-btn")).toBeNull();
    expect(node.querySelector(".chat-msg-speak-btn")).toBeNull();
    expect(node.querySelector(".chat-msg-export-btn")).toBeNull();

    // 点击继续生成触发 deps.onContinue 回调
    actionBtns[1].click();
    expect(deps.onContinue).toHaveBeenCalledTimes(1);
    expect(deps.onContinue).toHaveBeenCalledWith(0, node);
  });

  it("有部分正文时中断：正文渲染，思考折叠，保留复制、朗读、重试、继续与导出", () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);
    const area = areaOf(runtime);
    const turn = area.appendAssistantMessage({ source: "live" });

    turn.appendThinking("前置思考");
    turn.appendToken("这是已输出的部分正文回答");

    const outcome = turn.stop("网络异常", { historyIndex: 0 });
    expect(outcome).toEqual({ raw: "这是已输出的部分正文回答", body: true });

    const node = deps.messages.querySelector(".chat-msg-assistant") as HTMLDivElement;
    expect(node).toBeTruthy();

    // 正文正常渲染
    const bodyEl = node.querySelector(".chat-msg-assistant-body");
    expect(bodyEl?.innerHTML).toBe(renderMarkdown("这是已输出的部分正文回答"));

    // 思考框已折叠
    const thinkingEl = node.querySelector(".chat-thinking");
    expect(thinkingEl?.classList.contains("chat-thinking-collapsed")).toBe(true);

    // 停止徽标
    expect(node.querySelector(".chat-msg-stopped")?.textContent).toBe("网络异常");

    const actionBtns = node.querySelectorAll<HTMLButtonElement>(".chat-msg-action-btn");
    expect([...actionBtns].map((button) => button.getAttribute("aria-label"))).toEqual([
      "复制回复", "朗读回答", "重新生成", "继续生成", "导出 Markdown"
    ]);
    expect(actionBtns[0].disabled).toBe(false);
    expect(actionBtns[1].disabled).toBe(false);
    expect(actionBtns[4].disabled).toBe(false);
  });

  it("正常完成生成：保留复制、朗读、重新生成、导出全部4个按钮，不出现继续生成按钮", () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);
    const area = areaOf(runtime);
    const turn = area.appendAssistantMessage({ source: "live" });

    turn.appendToken("完整回复内容");
    turn.finish({ raw: "完整回复内容", historyIndex: 0 });

    const node = deps.messages.querySelector(".chat-msg-assistant") as HTMLDivElement;
    expect(node).toBeTruthy();

    const actionBtns = node.querySelectorAll<HTMLButtonElement>(".chat-msg-action-btn");
    expect(actionBtns).toHaveLength(4);
    expect([...actionBtns].map((b) => b.getAttribute("aria-label"))).toEqual([
      "复制回复",
      "朗读回答",
      "重新生成",
      "导出 Markdown"
    ]);

    expect(node.querySelector(".chat-msg-continue-btn")).toBeNull();
    expect(node.querySelector(".chat-msg-stopped")).toBeNull();
  });

  it("setRegenerationDisabled 能联动禁用和启用继续生成按钮与重新生成按钮", () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);
    const area = areaOf(runtime);
    const turn = area.appendAssistantMessage({ source: "live" });

    turn.appendThinking("思考中");
    turn.stop("已停止生成", { historyIndex: 0 });

    const regenBtn = deps.messages.querySelector<HTMLButtonElement>(".chat-msg-regenerate-btn")!;
    const contBtn = deps.messages.querySelector<HTMLButtonElement>(".chat-msg-continue-btn")!;

    expect(regenBtn.disabled).toBe(false);
    expect(contBtn.disabled).toBe(false);

    area.setRegenerationDisabled(true);
    expect(regenBtn.disabled).toBe(true);
    expect(contBtn.disabled).toBe(true);

    area.setRegenerationDisabled(false);
    expect(regenBtn.disabled).toBe(false);
    expect(contBtn.disabled).toBe(false);
  });
});
