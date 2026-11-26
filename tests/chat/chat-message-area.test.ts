// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { resetModuleState } from "../setup.js";
import { renderMarkdown } from "../../extension/ui/markdown.js";
import type { CreateChatRuntimeDeps } from "../../extension/chat/chat-runtime.js";

type RafSpy = MockInstance<(callback: () => void) => number>;
type ChatRuntime = ReturnType<typeof import("../../extension/chat/chat-runtime.js").createChatRuntime>;

let createChatRuntime: typeof import("../../extension/chat/chat-runtime.js").createChatRuntime;

function makeDeps(): CreateChatRuntimeDeps & { messages: HTMLElement; input: HTMLTextAreaElement } {
  const messages = document.createElement("div");
  const input = document.createElement("textarea");
  return {
    messages,
    input,
    store: {
      persistCurrent: vi.fn(async () => {}),
      isCurrent: () => true
    },
    ui: {
      setStreamingUiState: vi.fn(),
      messagesNotice: { show: vi.fn(), clear: vi.fn() },
      inputNotice: { show: vi.fn(), clear: vi.fn() },
      hideHistoryPopover: vi.fn(),
      removeCenteredState: vi.fn(),
      removeSuggestions: vi.fn(),
      showSetupBlockedState: vi.fn(),
      autosizeInput: vi.fn()
    },
    ensureCurrentContextForSend: vi.fn(async () => ({ pass: true }) as const),
    getProviderId: () => "test-provider",
    getSelectedModel: () => "test-model",
    getTimestampNavDeps: () => ({}),
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

function holdRaf(): RafSpy {
  return vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1) as unknown as RafSpy;
}

function runRafFrames(raf: RafSpy) {
  raf.mock.calls.splice(0).forEach((call) => call[0]());
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  ({ createChatRuntime } = await import("../../extension/chat/chat-runtime.js"));
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("消息区句柄：装配形状与来源语义", () => {
  it("用户消息：live 强制滚底并接管自动滚动；replay 静默追加（不滚不动标志）", () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);
    const area = areaOf(runtime);

    area.appendUserMessage("回放消息", { source: "replay" });
    const replayedUser = deps.messages.querySelector(".chat-msg-user")!;
    expect(replayedUser.textContent).toBe("回放消息");
    expect(Array.from(replayedUser.children).map((el) => el.className)).toEqual([
      "chat-msg-user-body",
      "chat-msg-actions"
    ]);
    expect(deps.messages.scrollTop).toBe(0);

    runtime.setAutoScroll(false);
    deps.messages.scrollTop = 42;
    const scrollToSpy = vi.fn();
    deps.messages.scrollTo = scrollToSpy;
    area.appendUserMessage("新消息", { source: "live" });
    expect(scrollToSpy).toHaveBeenCalledWith({ top: deps.messages.scrollHeight, behavior: "instant" });
    expect(deps.messages.querySelectorAll(".chat-msg-user")).toHaveLength(2);
  });

  it("用户消息显示已发送图片，查看器 Esc 关闭并归还缩略图焦点", () => {
    const deps = makeDeps();
    document.body.appendChild(deps.messages);
    const area = areaOf(createChatRuntime(deps));
    area.appendUserMessage("看图", {
      source: "replay",
      images: [{ mime: "image/webp", data: "QUJD" }]
    });
    const userNode = deps.messages.querySelector(".chat-msg-user")!;
    expect(Array.from(userNode.children).map((el) => el.className)).toEqual([
      "chat-image-strip chat-msg-user-images",
      "chat-msg-user-body",
      "chat-msg-actions"
    ]);
    const open = userNode.querySelector<HTMLButtonElement>(".chat-image-open")!;

    expect(open.querySelector(".chat-image-thumb")?.getAttribute("src")).toBe("data:image/webp;base64,QUJD");
    open.click();
    expect(document.querySelector(".chat-image-viewer-image")).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

    expect(document.querySelector(".chat-image-viewer")).toBeNull();
    expect(document.activeElement).toBe(open);
  });

  it("助手节点形状只有一个主人：live 带流式豁免类 + 光标，replay 不带；live 摘除上一条豁免", () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);
    const area = areaOf(runtime);

    area.appendAssistantMessage({ source: "live" });
    const first = deps.messages.querySelector<HTMLElement>(".chat-msg-assistant")!;
    expect(first.className).toBe("chat-msg chat-msg-assistant chat-msg-streaming");
    expect(first.querySelector(".chat-msg-cursor")).toBeTruthy();
    expect(first.querySelectorAll(".chat-msg-cursor > i")).toHaveLength(3);

    area.appendAssistantMessage({ source: "live" });
    const second = deps.messages.querySelectorAll<HTMLElement>(".chat-msg-assistant")[1];
    expect(first.classList.contains("chat-msg-streaming")).toBe(false);
    expect(second.classList.contains("chat-msg-streaming")).toBe(true);

    area.appendAssistantMessage({ source: "replay" });
    const replayed = deps.messages.querySelectorAll<HTMLElement>(".chat-msg-assistant")[2];
    expect(replayed.className).toBe("chat-msg chat-msg-assistant");
    expect(replayed.querySelector(".chat-msg-cursor")).toBeNull();
    expect(deps.messages.querySelectorAll(".chat-msg-assistant")).toHaveLength(3);
  });

  it("回放与流式装配逐字同形：同一原文经两个来源收尾后节点内部一致（回放不自拼节点）", () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);
    const area = areaOf(runtime);
    const raw = "第一段\n\n- 项目一\n\n结束";

    area.appendAssistantMessage({ source: "live" }).finish({ raw });
    const live = deps.messages.querySelector<HTMLElement>(".chat-msg-assistant")!;

    area.appendAssistantMessage({ source: "replay" }).finish({ raw, sources: [] });
    const replayed = deps.messages.querySelectorAll<HTMLElement>(".chat-msg-assistant")[1];

    expect(replayed.className).toBe("chat-msg chat-msg-assistant");
    expect(live.className).toBe("chat-msg chat-msg-assistant chat-msg-streaming");
    expect(replayed.innerHTML).toBe(live.innerHTML);
    expect(replayed.querySelector(".chat-msg-assistant-body")?.innerHTML).toBe(renderMarkdown(raw));
  });

  it("clear 清场：消息区整段重建（卡片/节点一并清掉）", () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);
    const area = areaOf(runtime);

    area.appendUserMessage("旧消息", { source: "replay" });
    deps.messages.insertAdjacentHTML("beforeend", '<div class="chat-search-card"></div>');
    area.clear();

    expect(deps.messages.innerHTML).toBe("");
  });
});

describe("回合节点句柄：流式操作面", () => {
  it("appendToken：未 flush 的增量也进终态原文（缓冲不丢），帧渲染落进双容器", () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);
    const area = areaOf(runtime);
    const raf = holdRaf();
    const turn = area.appendAssistantMessage({ source: "live" });

    turn.appendToken("第一段\n\n第二段");
    expect(raf).toHaveBeenCalledTimes(1);
    runRafFrames(raf);
    expect(deps.messages.querySelector(".chat-stream-stable")?.innerHTML).toBe(renderMarkdown("第一段"));
    expect(deps.messages.querySelector(".chat-stream-tail")?.textContent).toContain("第二段");

    turn.appendToken("，结尾");
    const raw = turn.finish({ userPrompt: "问" });
    expect(raw).toBe("第一段\n\n第二段，结尾");
    expect(deps.messages.querySelector(".chat-msg-assistant-body")?.innerHTML).toBe(
      renderMarkdown("第一段\n\n第二段，结尾")
    );
    expect(deps.messages.querySelector(".chat-stream-stable")).toBeNull();
    expect(deps.messages.querySelector(".chat-stream-tail")).toBeNull();
  });

  it("appendThinking：同一回合收口到单一思维链状态条；token 之后的收尾 reasoning 追加新思考步骤并一并折叠", () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);
    const area = areaOf(runtime);
    const raf = holdRaf();
    const turn = area.appendAssistantMessage({ source: "live" });

    turn.appendThinking("先想");
    expect(deps.messages.querySelector(".chat-thinking-label")?.textContent).toBe("深度思考中…");
    turn.appendThinking("再想");
    expect(deps.messages.querySelectorAll(".chat-thought-chain")).toHaveLength(1);
    runRafFrames(raf);
    expect(deps.messages.querySelector(".chat-thinking-text")?.textContent).toBe("先想再想");

    turn.appendToken("正文");
    turn.appendThinking("收尾思路");
    runRafFrames(raf);
    const chain = deps.messages.querySelector(".chat-thought-chain")!;
    expect(chain.querySelectorAll(".chat-thought-step[data-step-kind='thinking']")).toHaveLength(2);
    expect(chain.classList.contains("chat-thinking-collapsible")).toBe(true);
    expect(chain.classList.contains("chat-thinking-collapsed")).toBe(true);
    expect(chain.querySelector(".chat-thinking-label-text")?.textContent).toMatch(/^已思考 \d+\.\ds$/);
    expect(chain.querySelector(".chat-thinking-duration-num")?.textContent).toMatch(/^\d+\.\d$/);

    turn.finish({ raw: "正文 [01:20]" });
    const settledChain = deps.messages.querySelector(".chat-thought-chain")!;
    expect(settledChain.querySelectorAll(".chat-thought-step[data-step-kind='thinking']")).toHaveLength(2);
    expect(settledChain.querySelector(".chat-thinking-label-text")?.textContent).toMatch(/^已思考 \d+\.\ds · 参考 1 处字幕$/);
    expect(deps.messages.querySelector(".chat-msg-assistant-body")?.textContent).toContain("正文");
  });

  it("finish：收尾前自动取消挂起帧，不留悬挂帧槽且保留累计原文", () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);
    const area = areaOf(runtime);
    const raf = holdRaf();
    const turn = area.appendAssistantMessage({ source: "live" });

    turn.appendToken("第一段\n\n");
    expect(raf).toHaveBeenCalledTimes(1);
    expect(turn.finish({})).toBe("第一段\n\n");

    const turn2 = area.appendAssistantMessage({ source: "live" });
    turn2.appendToken("第二段");
    expect(raf).toHaveBeenCalledTimes(2);
    expect(turn2.finish({})).toBe("第二段");
  });

  it("reset：清 stable/tail/思维链状态条、光标归位、累加器清零（新流不带旧流残留）", () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);
    const area = areaOf(runtime);
    const raf = holdRaf();
    const turn = area.appendAssistantMessage({ source: "live" });

    turn.appendThinking("第一代思考");
    turn.appendToken("## 第一代\n\n正文");
    turn.applySearchStatus({ type: "tool-status", status: "searching", query: "q" });
    runRafFrames(raf);
    expect(deps.messages.querySelector(".chat-stream-stable")).toBeTruthy();
    expect(deps.messages.querySelector(".chat-thought-chain")).toBeTruthy();

    turn.reset();
    expect(deps.messages.querySelector(".chat-stream-stable")).toBeNull();
    expect(deps.messages.querySelector(".chat-stream-tail")).toBeNull();
    expect(deps.messages.querySelector(".chat-thinking")).toBeNull();
    expect(deps.messages.querySelector(".chat-thought-chain")).toBeNull();
    expect(deps.messages.querySelector(".chat-msg-cursor")).toBeTruthy();

    turn.appendToken("## 第二代\n\n全新正文");
    runRafFrames(raf);
    const raw = turn.finish({});
    expect(raw).toBe("## 第二代\n\n全新正文");
    expect(deps.messages.querySelector(".chat-msg-assistant-body")?.textContent).not.toContain("第一代");
  });
});

describe("回合节点句柄：终态形态与徽标位置", () => {
  it("finish：正文容器 + 操作行按序落在节点上，markTruncated 挂在操作行之后", () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);
    const area = areaOf(runtime);
    const turn = area.appendAssistantMessage({ source: "live" });

    const raw = turn.finish({ raw: "半句", userPrompt: "问" });

    expect(raw).toBe("半句");
    const node = deps.messages.querySelector(".chat-msg-assistant")!;
    expect([...node.children].map((el) => el.className)).toEqual([
      "chat-msg-assistant-body markdown-body",
      "chat-msg-actions"
    ]);
    expect([...node.querySelectorAll(".chat-msg-action-btn")].map((button) => button.getAttribute("aria-label"))).toEqual([
      "复制回复",
      "朗读回答",
      "重新生成",
      "导出 Markdown"
    ]);

    expect(node.querySelector(".chat-msg-continue-btn")).toBeNull();
    turn.markTruncated("回答被截断（达到模型输出上限）");
    expect(deps.messages.querySelector(".chat-msg-truncated")?.textContent).toBe("回答被截断（达到模型输出上限）");
    expect(node.querySelector(".chat-msg-continue-btn")).not.toBeNull();
    expect([...node.querySelectorAll(".chat-msg-action-btn")].map((button) => button.getAttribute("aria-label"))).toEqual([
      "复制回复", "朗读回答", "重新生成", "继续生成", "导出 Markdown"
    ]);
    expect(deps.messages.querySelector(".chat-msg-truncated")?.previousElementSibling?.className).toBe("chat-msg-actions");
    expect(deps.messages.querySelector(".chat-msg-truncated")).toBe(node.lastElementChild);
  });

  it("空回答：允许重新生成，禁用朗读和导出", () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);
    const turn = areaOf(runtime).appendAssistantMessage({ source: "live" });

    turn.finish({ raw: "", historyIndex: 0 });

    expect(deps.messages.querySelector<HTMLButtonElement>(".chat-msg-regenerate-btn")?.disabled).toBe(false);
    expect(deps.messages.querySelector<HTMLButtonElement>(".chat-msg-speak-btn")?.disabled).toBe(true);
    expect(deps.messages.querySelector<HTMLButtonElement>(".chat-msg-export-btn")?.disabled).toBe(true);
  });

  it("朗读按钮把清洗正文交给语音引擎，消息区清场停止朗读", async () => {
    const deps = makeDeps();
    const speak = vi.fn();
    const stop = vi.fn();
    deps.getSpeechVolume = () => 0.35;
    deps.speechEngine = {
      getVoices: async () => [{ voiceName: "本地中文", lang: "zh-CN", remote: false }],
      speak,
      stop
    };
    const runtime = createChatRuntime(deps);
    const area = areaOf(runtime);
    area.appendAssistantMessage({ source: "live" }).finish({ raw: "[可见文字](https://example.com)" });

    const button = deps.messages.querySelector<HTMLButtonElement>(".chat-msg-speak-btn")!;
    button.click();
    await vi.waitFor(() => expect(speak).toHaveBeenCalledTimes(1));
    expect(speak.mock.calls[0][0]).toBe("可见文字");
    expect(speak.mock.calls[0][1].volume).toBe(0.35);
    expect(button.getAttribute("aria-label")).toBe("停止朗读");

    area.clear();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("会话拆除 resetStreamState 停止朗读并恢复按钮", async () => {
    const deps = makeDeps();
    const speak = vi.fn();
    const stop = vi.fn();
    deps.speechEngine = {
      getVoices: async () => [{ voiceName: "本地中文", lang: "zh-CN", remote: false }],
      speak,
      stop
    };
    const runtime = createChatRuntime(deps);
    areaOf(runtime).appendAssistantMessage({ source: "live" }).finish({ raw: "回答" });
    const button = deps.messages.querySelector<HTMLButtonElement>(".chat-msg-speak-btn")!;
    button.click();
    await vi.waitFor(() => expect(speak).toHaveBeenCalledTimes(1));

    runtime.resetStreamState();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("aria-label")).toBe("朗读回答");
  });

  it("fail：清空节点内容，只留错误占位（文案原样，不渲染正文）", () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);
    const area = areaOf(runtime);
    const turn = area.appendAssistantMessage({ source: "live" });

    turn.appendToken("半截输出");
    turn.fail("错误：网络错误");

    const node = deps.messages.querySelector(".chat-msg-assistant")!;
    expect(node.innerHTML).toBe('<div class="chat-msg-error">错误：网络错误</div>');
    expect(node.querySelector(".chat-msg-assistant-body")).toBeNull();
  });

  it("stop 有正文：正文 + 停止徽标（徽标在操作行之后），报告 body=true 与原文", () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);
    const area = areaOf(runtime);
    const turn = area.appendAssistantMessage({ source: "live" });

    turn.appendToken("部分回答");
    const outcome = turn.stop("用户手动停止", { userPrompt: "问" });

    expect(outcome).toEqual({ raw: "部分回答", body: true });
    const node = deps.messages.querySelector(".chat-msg-assistant")!;
    expect(node.querySelector(".chat-msg-assistant-body")?.innerHTML).toBe(renderMarkdown("部分回答"));
    expect(node.querySelector(".chat-msg-stopped")?.textContent).toBe("用户手动停止");
    expect(node.querySelector(".chat-msg-stopped")).toBe(node.lastElementChild);
  });

  it("stop 无正文：只留停止徽标（默认文案），报告 body=false、原文为空", () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);
    const area = areaOf(runtime);
    const turn = area.appendAssistantMessage({ source: "live" });

    const outcome = turn.stop("");

    expect(outcome).toEqual({ raw: "", body: false });
    const node = deps.messages.querySelector(".chat-msg-assistant")!;
    expect(node.innerHTML).toBe('<div class="chat-msg-stopped">已停止生成</div>');
    expect(node.querySelector(".chat-msg-assistant-body")).toBeNull();
  });
});

describe("回合节点句柄：思维链状态条（工具活动与回放）", () => {
  it("applySearchStatus：汇入本节点顶部的思维链状态条；reset 清条重放", () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);
    const area = areaOf(runtime);
    const turn = area.appendAssistantMessage({ source: "live" });

    turn.applySearchStatus({ type: "tool-status", status: "searching", query: "MoE" });
    const node = deps.messages.querySelector(".chat-msg-assistant")!;
    const chain = node.querySelector(".chat-thought-chain")!;
    expect(chain).toBeTruthy();
    expect(node.firstElementChild).toBe(chain);
    expect(chain.querySelector(".chat-thought-chain-summary")?.textContent).toBe("联网检索 · MoE…");

    turn.reset();
    expect(deps.messages.querySelector(".chat-thought-chain")).toBeNull();
    expect(deps.messages.querySelectorAll(".chat-msg-assistant")).toHaveLength(1);
  });

  it("attachSearchTimelineCard：静态检索步骤收口在本节点顶部思维链内（回放折叠态）", () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);
    const area = areaOf(runtime);
    const turn = area.appendAssistantMessage({ source: "replay" });

    turn.finish({ raw: "答 [1]。", sources: [{ title: "A", url: "https://a.com", snippet: "sa" }] });
    turn.attachSearchTimelineCard({
      assistantIndex: 1,
      queries: ["第一问"],
      resultCounts: [1],
      sources: [{ title: "A", url: "https://a.com", snippet: "sa" }]
    });

    const node = deps.messages.querySelector(".chat-msg-assistant")!;
    const chain = node.querySelector(".chat-thought-chain")!;
    expect(node.firstElementChild).toBe(chain);
    expect(chain.querySelector(".chat-thought-chain-summary")?.textContent).toBe("联网检索 1 条");
    expect(chain.querySelector(".chat-thought-step-detail")?.textContent).toBe("第一问");
    expect(node.querySelector(".chat-cite[data-cite-url='https://a.com']")).toBeTruthy();
  });
});
