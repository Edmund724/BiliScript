// 联网搜索对话 UI 测试（spec §4，变体 B + 内联引用）：
// 经 chat-runtime 公开协议入口 handleChatPortMessage 喂 tool-status / done，
// 断言面向可观察 DOM（时间线卡 / 步骤行 / 来源 chip / [n] 内联引用 / 悬停
// 预览卡 / stream-reset 清卡 / 停止态引用）。测试基建与 chat-runtime-stream
// 同款（假 port / 同模块纪元）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { normalizeMarkdownForSectionPaste } from "../../extension/notes/paste.js";
import type { ChatPortMessage } from "../../extension/chat/chat-runtime.js";

let createChatRuntime: typeof import("../../extension/chat/chat-runtime.js").createChatRuntime;
let chatSessionState: typeof import("../../extension/chat/chat-state.js").chatSessionState;
let resetChatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").resetChatSessionStateForTests;

type ChatRuntime = ReturnType<typeof createChatRuntime>;

function makeDeps() {
  const messages = document.createElement("div");
  const input = document.createElement("textarea");
  return {
    messages,
    input,
    store: {
      persistCurrent: vi.fn(async () => {}),
      isCurrent: vi.fn((id) => id === chatSessionState.currentConversationId)
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

// 建运行时并完成一次发送（chat-runtime-stream.test 同款：sendMessage 建
// activeAssistantNode 占位与假 port；协议消息经公开入口 feed 喂入）。
async function makeRuntime(text = "这个视频里提到的 MoE 有什么新进展？") {
  const deps = makeDeps();
  deps.input.value = text;
  const runtime = createChatRuntime(deps);
  await runtime.sendTurn(deps.input.value);
  return { deps, runtime };
}

function feed(runtime: ChatRuntime, msg: ChatPortMessage) {
  runtime.handleChatPortMessage(msg);
}

// 新回合：与真实流同语义，置流式 UI 态由 sendMessage 内部负责；这里只造下一个
// assistant 占位（上一条终态时序由 endStream 完成）。测试直接调 resetStreamState
// 清流后重新走 sendMessage。
async function startNextTurn(deps: ReturnType<typeof makeDeps>, runtime: ChatRuntime, text = "") {
  runtime.resetStreamState();
  deps.input.value = text || "下一问";
  await runtime.sendTurn(deps.input.value);
}

const SOURCES = [
  { title: "DeepSeek-V3 技术报告", url: "https://arxiv.org/a", snippet: "专家并行与 FP8 训练……" },
  { title: "MoE 推理优化实践", url: "https://juejin.cn/b", snippet: "专家按热度分级驻留显存……" }
];

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
});

describe("搜索时间线卡", () => {
  it("tool-status searching：卡片插在 assistant 节点之前，头部查询词 + 步骤行「搜索中…」", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "MoE 新进展" });

    const card = deps.messages.querySelector(".chat-search-card")!;
    const assistant = deps.messages.querySelector(".chat-msg-assistant")!;
    expect(card).toBeTruthy();
    expect(card.nextElementSibling).toBe(assistant);
    expect(card.querySelector(".chat-search-card-head")).toBeTruthy();
    expect(card.querySelector(".chat-search-card-query")!.textContent).toBe("MoE 新进展");
    expect(card.querySelector(".chat-search-card-status")!.textContent).toBe("搜索中…");
    const step = card.querySelector(".chat-search-step")!;
    expect(step.classList.contains("is-running")).toBe(true);
    expect(step.querySelector(".chat-search-step-query")!.textContent).toBe("MoE 新进展");
    expect(step.querySelector(".chat-search-step-note")!.textContent).toBe("搜索中…");
  });

  it("tool-status done：步骤行补结果数、头部来源数、来源列表（序号 + 标题 + 完整 URL 属性）", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1" });
    feed(runtime, {
      type: "tool-status",
      status: "done",
      query: "q1",
      resultCount: 2,
      platform: "Tavily",
      sources: SOURCES
    });

    const card = deps.messages.querySelector(".chat-search-card")!;
    const step = card.querySelector(".chat-search-step")!;
    expect(step.classList.contains("is-running")).toBe(false);
    // 步骤行 note 现在带实际引擎（§6.5：tool-status.platform 就地接线）
    expect(step.querySelector(".chat-search-step-note")!.textContent).toBe("2 条 · Tavily");
    // 头部右端仍是「N 条来源」（卡内累计来源数），文案不含平台名与耗时
    const status = card.querySelector(".chat-search-card-status")!.textContent!;
    expect(status).toBe("2 条来源");
    const rows = card.querySelectorAll(".chat-search-source-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".chat-search-source-idx")!.textContent).toBe("1");
    expect(rows[1].querySelector(".chat-search-source-idx")!.textContent).toBe("2");
    expect(rows[0].querySelector(".chat-search-source-title")!.textContent).toBe("DeepSeek-V3 技术报告");
    // title 属性给完整 URL（标题只显示一行文本，地址不占版面）
    expect(rows[0].getAttribute("title")).toBe("https://arxiv.org/a");
    expect(rows[1].getAttribute("title")).toBe("https://juejin.cn/b");
  });

  it("二次搜索：来源编号跨搜索累计（3 号起），头部查询词与来源数随最近一次刷", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1" });
    feed(runtime, { type: "tool-status", status: "done", query: "q1", resultCount: 2, platform: "Tavily", sources: SOURCES });
    feed(runtime, { type: "tool-status", status: "searching", query: "q2" });
    feed(runtime, { type: "tool-status", status: "done", query: "q2", resultCount: 1, platform: "Tavily", sources: [{ title: "第三条", url: "https://c.example.com", snippet: "s3" }] });

    const card = deps.messages.querySelector(".chat-search-card")!;
    expect(card.querySelectorAll(".chat-search-step")).toHaveLength(2);
    const rows = card.querySelectorAll(".chat-search-source-row");
    expect(rows).toHaveLength(3);
    expect(rows[2].querySelector(".chat-search-source-idx")!.textContent).toBe("3");
    expect(rows[2].querySelector(".chat-search-source-title")!.textContent).toBe("第三条");
    expect(card.querySelector(".chat-search-card-query")!.textContent).toBe("q2");
    expect(card.querySelector(".chat-search-card-status")!.textContent).toBe("3 条来源");
  });

  it("tool-status failed：步骤行标记失败，不产生来源列表", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1" });
    feed(runtime, { type: "tool-status", status: "failed", query: "q1" });

    const card = deps.messages.querySelector(".chat-search-card")!;
    const step = card.querySelector(".chat-search-step")!;
    expect(step.classList.contains("is-failed")).toBe(true);
    expect(step.querySelector(".chat-search-step-note")!.textContent).toBe("搜索失败");
    expect(card.querySelectorAll(".chat-search-source-row")).toHaveLength(0);
    expect(card.querySelector(".chat-search-card-status")!.textContent).toBe("搜索失败");
  });

  it("来源行点击：新标签打开来源 URL", async () => {
    const { deps, runtime } = await makeRuntime();
    const opened = vi.fn();
    vi.stubGlobal("open", opened);
    feed(runtime, { type: "tool-status", status: "searching", query: "q1" });
    feed(runtime, { type: "tool-status", status: "done", query: "q1", resultCount: 1, platform: "Tavily", sources: [SOURCES[0]] });
    (deps.messages.querySelector(".chat-search-source-row") as HTMLElement).click();
    expect(opened).toHaveBeenCalledWith("https://arxiv.org/a", "_blank", "noopener");
  });

  it("来源行悬停：出预览卡（标题 + 域名 + 摘录），移出移除", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1" });
    feed(runtime, { type: "tool-status", status: "done", query: "q1", resultCount: 1, platform: "Tavily", sources: [SOURCES[0]] });

    const row = deps.messages.querySelector<HTMLElement>(".chat-search-source-row")!;
    row.dispatchEvent(new window.Event("mouseenter"));
    const preview = deps.messages.querySelector(".chat-search-preview")!;
    expect(preview).toBeTruthy();
    expect(preview.querySelector(".chat-search-preview-title")!.textContent).toBe("DeepSeek-V3 技术报告");
    expect(preview.querySelector(".chat-search-preview-host")!.textContent).toBe("arxiv.org");
    expect(preview.querySelector(".chat-search-preview-excerpt")!.textContent).toBe("专家并行与 FP8 训练……");
    row.dispatchEvent(new window.Event("mouseleave"));
    expect(deps.messages.querySelector(".chat-search-preview")).toBeNull();
  });

  it("默认折叠：头部是可点击按钮（aria-expanded=false），步骤与来源仍在 DOM 只由 CSS 隐藏", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1" });
    feed(runtime, { type: "tool-status", status: "done", query: "q1", resultCount: 2, platform: "Tavily", sources: SOURCES });

    const card = deps.messages.querySelector<HTMLElement>(".chat-search-card")!;
    const head = card.querySelector<HTMLElement>(".chat-search-card-head")!;
    // <button> 自带 Enter/Space 激活与按钮语义，无需自造键盘处理
    expect(head.tagName).toBe("BUTTON");
    expect(head.getAttribute("type")).toBe("button");
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(card.classList.contains("chat-search-card-collapsed")).toBe(true);
    // 内容不因折叠而丢弃：展开是纯类切换，不重建 DOM
    expect(card.querySelectorAll(".chat-search-step")).toHaveLength(1);
    expect(card.querySelectorAll(".chat-search-source-row")).toHaveLength(2);
  });

  it("点击头部展开／收起：折叠类与 aria-expanded 同步", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1" });
    feed(runtime, { type: "tool-status", status: "done", query: "q1", resultCount: 1, platform: "Tavily", sources: [SOURCES[0]] });

    const card = deps.messages.querySelector<HTMLElement>(".chat-search-card")!;
    const head = card.querySelector<HTMLElement>(".chat-search-card-head")!;
    head.click();
    expect(card.classList.contains("chat-search-card-collapsed")).toBe(false);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    head.click();
    expect(card.classList.contains("chat-search-card-collapsed")).toBe(true);
    expect(head.getAttribute("aria-expanded")).toBe("false");
  });

  it("用户展开后本卡记忆展开态：后续 searching／done 事件不把它折回", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1" });
    feed(runtime, { type: "tool-status", status: "done", query: "q1", resultCount: 1, platform: "Tavily", sources: [SOURCES[0]] });
    const card = deps.messages.querySelector<HTMLElement>(".chat-search-card")!;
    card.querySelector<HTMLElement>(".chat-search-card-head")!.click();
    expect(card.classList.contains("chat-search-card-collapsed")).toBe(false);

    feed(runtime, { type: "tool-status", status: "searching", query: "q2" });
    feed(runtime, { type: "tool-status", status: "done", query: "q2", resultCount: 1, platform: "Tavily", sources: [{ title: "第三条", url: "https://c.example.com", snippet: "s3" }] });

    expect(card.classList.contains("chat-search-card-collapsed")).toBe(false);
    expect(card.querySelector(".chat-search-card-head")!.getAttribute("aria-expanded")).toBe("true");
    expect(card.querySelectorAll(".chat-search-step")).toHaveLength(2);
  });

  it("新回合的新卡不继承上一张卡的展开态：默认仍折叠", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1" });
    deps.messages.querySelector<HTMLElement>(".chat-search-card-head")!.click();
    await startNextTurn(deps, runtime);
    feed(runtime, { type: "tool-status", status: "searching", query: "q2" });

    const cards = deps.messages.querySelectorAll<HTMLElement>(".chat-search-card");
    expect(cards).toHaveLength(2);
    expect(cards[1].classList.contains("chat-search-card-collapsed")).toBe(true);
  });

  it("stream-reset：时间线卡清除（整体重放含重新搜索）", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1" });
    expect(deps.messages.querySelector(".chat-search-card")).toBeTruthy();
    feed(runtime, { type: "stream-reset" });
    expect(deps.messages.querySelector(".chat-search-card")).toBeNull();
  });

  it("跨消息隔离：新回合的首条 searching 不带上一回合的步骤与来源", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1" });
    feed(runtime, { type: "tool-status", status: "done", query: "q1", resultCount: 1, platform: "Tavily", sources: [SOURCES[0]] });
    await startNextTurn(deps, runtime);
    feed(runtime, { type: "tool-status", status: "searching", query: "q2" });

    const cards = deps.messages.querySelectorAll(".chat-search-card");
    expect(cards).toHaveLength(2);
    expect(cards[1].querySelectorAll(".chat-search-step")).toHaveLength(1);
  });
});

describe("正文内联引用（[n] → 上标引用）", () => {
  async function finalizeWithCitations() {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1" });
    feed(runtime, { type: "tool-status", status: "done", query: "q1", resultCount: 2, platform: "Tavily", sources: SOURCES });
    feed(runtime, { type: "token", data: "进展见 [1]；调度见 [2]；编造见 [9]。" });
    feed(runtime, { type: "done" });
    return { deps, runtime };
  }

  it("done 终态：[n] 转上标引用，越界编号保留原文，无来源区块", async () => {
    const { deps } = await finalizeWithCitations();
    const body = deps.messages.querySelector(".chat-msg-assistant-body")!;
    expect(body).toBeTruthy();
    const cites = body.querySelectorAll("sup.chat-cite");
    expect(cites).toHaveLength(2);
    expect(cites[0].getAttribute("data-cite-url")).toBe("https://arxiv.org/a");
    expect(cites[1].getAttribute("data-cite-url")).toBe("https://juejin.cn/b");
    // 编造的 [9] 越界：保持纯文本
    expect(body.textContent).toContain("[9]");
    expect(body.querySelectorAll("sup.chat-cite")).toHaveLength(2);
  });

  it("引用悬停出预览卡（标题 + 域名 + 摘录），移出移除；点击新标签打开 URL", async () => {
    const { deps } = await finalizeWithCitations();
    const opened = vi.fn();
    vi.stubGlobal("open", opened);
    const cite = deps.messages.querySelector("sup.chat-cite")!;
    cite.dispatchEvent(new window.Event("mouseenter"));
    const preview = deps.messages.querySelector(".chat-search-preview")!;
    expect(preview).toBeTruthy();
    expect(preview.querySelector(".chat-search-preview-title")!.textContent).toBe("DeepSeek-V3 技术报告");
    expect(preview.querySelector(".chat-search-preview-host")!.textContent).toBe("arxiv.org");
    expect(preview.querySelector(".chat-search-preview-excerpt")!.textContent).toBe("专家并行与 FP8 训练……");
    cite.dispatchEvent(new window.Event("mouseleave"));
    expect(deps.messages.querySelector(".chat-search-preview")).toBeNull();
    (cite as HTMLElement).click();
    expect(opened).toHaveBeenCalledWith("https://arxiv.org/a", "_blank", "noopener");
  });

  it("预览摘录取 snippet 前 200 字符（spec §5）", async () => {
    const { deps, runtime } = await makeRuntime();
    const longSnippet = "长".repeat(500);
    feed(runtime, { type: "tool-status", status: "searching", query: "q1" });
    feed(runtime, {
      type: "tool-status",
      status: "done",
      query: "q1",
      resultCount: 1,
      platform: "Tavily",
      sources: [{ title: "t", url: "https://x.example.com", snippet: longSnippet }]
    });
    feed(runtime, { type: "token", data: "见 [1]。" });
    feed(runtime, { type: "done" });
    deps.messages.querySelector("sup.chat-cite")!.dispatchEvent(new window.Event("mouseenter"));
    const preview = deps.messages.querySelector(".chat-search-preview")!;
    expect(preview).toBeTruthy();
    expect(preview.querySelector(".chat-search-preview-excerpt")!.textContent).toHaveLength(200);
  });
});

describe("时间线卡与流式渲染共存", () => {
  it("流式正文与思考盒照常渲染，卡片不干扰 assistant 节点内容", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1" });
    feed(runtime, { type: "reasoning", data: "思考" });
    const assistant = deps.messages.querySelector(".chat-msg-assistant")!;
    expect(assistant.querySelector(".chat-thinking")).toBeTruthy();
    const card = deps.messages.querySelector(".chat-search-card")!;
    expect(card.contains(assistant.querySelector(".chat-thinking"))).toBe(false);
  });
});


describe("搜索终态、播报与键盘可用性", () => {
  it("done：头部累计数与步骤本次数各自计量，独立状态区只播报一次，重复事件不重复累计", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1", callId: "call-1" });
    feed(runtime, { type: "tool-status", status: "done", query: "q1", callId: "call-1", resultCount: 2, sources: SOURCES });

    const card = deps.messages.querySelector<HTMLElement>(".chat-search-card")!;
    const announcer = card.querySelector<HTMLElement>(".chat-search-announcer")!;
    expect(card.dataset.status).toBe("done");
    expect(card.querySelector(".chat-search-card-status")!.textContent).toBe("2 条来源");
    expect(card.querySelector(".chat-search-step-note")!.textContent).toBe("2 条");
    expect(announcer.getAttribute("role")).toBe("status");
    expect(announcer.getAttribute("aria-live")).toBe("polite");
    expect(announcer.textContent).toBe("搜索完成，共 2 条来源");
    expect(deps.messages.getAttribute("aria-live")).toBeNull();
    expect(deps.messages.getAttribute("role")).toBeNull();

    const observer = new MutationObserver(() => {});
    observer.observe(announcer, { childList: true, characterData: true, subtree: true });
    feed(runtime, { type: "tool-status", status: "done", query: "q1", callId: "call-1", resultCount: 2, sources: SOURCES });
    expect(observer.takeRecords()).toHaveLength(0);
    expect(card.querySelectorAll(".chat-search-source-row")).toHaveLength(2);
    observer.disconnect();
  });

  it("cancelled：只收口对应调用并播报一次，不残留进行中样式", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1", callId: "call-1" });
    feed(runtime, { type: "tool-status", status: "cancelled", query: "q1", callId: "call-1" });

    const card = deps.messages.querySelector<HTMLElement>(".chat-search-card")!;
    expect(card.dataset.status).toBe("cancelled");
    expect(card.querySelector(".chat-search-card-status")!.textContent).toBe("已取消");
    expect(card.querySelector(".chat-search-step")!.classList.contains("is-cancelled")).toBe(true);
    expect(card.querySelector(".is-running")).toBeNull();
    expect(card.textContent).not.toContain("搜索中…");
    expect(card.querySelector(".chat-search-announcer")!.textContent).toBe("搜索已取消");
  });

  it("callId 乱序终态不误收口其他步骤；全部结束后头部才离开搜索中", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1", callId: "call-1" });
    feed(runtime, { type: "tool-status", status: "searching", query: "q2", callId: "call-2" });
    feed(runtime, { type: "tool-status", status: "done", query: "q1", callId: "call-1", resultCount: 1, sources: [SOURCES[0]] });

    const card = deps.messages.querySelector<HTMLElement>(".chat-search-card")!;
    const steps = card.querySelectorAll<HTMLElement>(".chat-search-step");
    expect(steps[0].querySelector(".chat-search-step-note")!.textContent).toBe("1 条");
    expect(steps[1].classList.contains("is-running")).toBe(true);
    expect(card.dataset.status).toBe("searching");

    feed(runtime, { type: "tool-status", status: "cancelled", query: "q2", callId: "call-2" });
    expect(steps[1].classList.contains("is-cancelled")).toBe(true);
    expect(card.dataset.status).toBe("cancelled");
    expect(card.querySelectorAll(".chat-search-source-row")).toHaveLength(1);
  });

  it("failed：错误使用 alert，保留诊断通知并继续主任务", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1", callId: "call-1" });
    feed(runtime, { type: "tool-status", status: "failed", query: "q1", callId: "call-1" });

    const card = deps.messages.querySelector<HTMLElement>(".chat-search-card")!;
    const announcer = card.querySelector<HTMLElement>(".chat-search-announcer")!;
    expect(card.dataset.status).toBe("failed");
    expect(announcer.getAttribute("role")).toBe("alert");
    expect(announcer.getAttribute("aria-live")).toBe("assertive");
    expect(announcer.textContent).toBe("搜索失败");
    expect(runtime.isStreaming()).toBe(true);

    feed(runtime, { type: "notice", data: "联网搜索失败：HTTP 503" });
    feed(runtime, { type: "token", data: "基于已有信息继续回答" });
    feed(runtime, { type: "done" });
    expect(deps.ui.showConversationContextNotice).toHaveBeenCalledWith("联网搜索失败：HTTP 503", 4000);
    expect(deps.messages.querySelector(".chat-msg-assistant-body")!.textContent).toContain("基于已有信息继续回答");
    expect(card.dataset.status).toBe("failed");
  });

  it.each([
    ["finish", "cancelled", "已取消"],
    ["stop", "cancelled", "已取消"],
    ["fail", "failed", "搜索失败"],
    ["discard", "cancelled", "已取消"]
  ] as const)("%s 统一收口在途搜索，终态后迟到事件不重开", async (terminal, status, text) => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);
    const turn = runtime.messageArea.appendAssistantMessage({ source: "live" });
    turn.applySearchStatus({ type: "tool-status", status: "searching", query: "q1", callId: "call-1" });

    if (terminal === "finish") turn.finish();
    else if (terminal === "stop") turn.stop("用户停止");
    else if (terminal === "fail") turn.fail("错误：网络中断");
    else turn.discard();

    const card = deps.messages.querySelector<HTMLElement>(".chat-search-card")!;
    expect(card.dataset.status).toBe(status);
    expect(card.querySelector(".chat-search-card-status")!.textContent).toBe(text);
    expect(card.querySelector(".is-running")).toBeNull();
    expect(card.textContent).not.toContain("搜索中…");
    expect(card.querySelector(".chat-search-announcer")!.textContent).toBe(status === "failed" ? "搜索失败" : "搜索已取消");

    turn.applySearchStatus({ type: "tool-status", status: "searching", query: "late", callId: "call-2" });
    expect(card.querySelectorAll(".chat-search-step")).toHaveLength(1);
    expect(card.dataset.status).toBe(status);
  });

  it("来源行聚焦出预览，Esc 与 blur 收起；按钮保留原生键盘激活", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1", callId: "call-1" });
    feed(runtime, { type: "tool-status", status: "done", query: "q1", callId: "call-1", resultCount: 1, sources: [SOURCES[0]] });
    const row = deps.messages.querySelector<HTMLButtonElement>(".chat-search-source-row")!;

    expect(row.tagName).toBe("BUTTON");
    row.dispatchEvent(new FocusEvent("focus"));
    expect(deps.messages.querySelector(".chat-search-preview")).not.toBeNull();
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(deps.messages.querySelector(".chat-search-preview")).toBeNull();
    row.dispatchEvent(new FocusEvent("focus"));
    row.dispatchEvent(new FocusEvent("blur"));
    expect(deps.messages.querySelector(".chat-search-preview")).toBeNull();
  });

  it("正文引用可聚焦，Enter/Space 打开来源，Esc 与 blur 管理预览", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1", callId: "call-1" });
    feed(runtime, { type: "tool-status", status: "done", query: "q1", callId: "call-1", resultCount: 2, sources: SOURCES });
    feed(runtime, { type: "token", data: "进展见 [1]；调度见 [2]。" });
    feed(runtime, { type: "done" });
    const opened = vi.fn();
    vi.stubGlobal("open", opened);
    const cite = deps.messages.querySelector<HTMLElement>("sup.chat-cite")!;

    expect(cite.tabIndex).toBe(0);
    expect(cite.getAttribute("role")).toBe("button");
    cite.dispatchEvent(new FocusEvent("focus"));
    expect(deps.messages.querySelector(".chat-search-preview")).not.toBeNull();
    cite.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    cite.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(opened).toHaveBeenCalledTimes(2);
    expect(opened).toHaveBeenCalledWith("https://arxiv.org/a", "_blank", "noopener");
    cite.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(deps.messages.querySelector(".chat-search-preview")).toBeNull();
    cite.dispatchEvent(new FocusEvent("focus"));
    cite.dispatchEvent(new FocusEvent("blur"));
    expect(deps.messages.querySelector(".chat-search-preview")).toBeNull();
  });

  it("已滚动消息区中的预览计入 scrollTop，底部不足时翻到锚点上方且不被裁切", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1", callId: "call-1" });
    feed(runtime, { type: "tool-status", status: "done", query: "q1", callId: "call-1", resultCount: 1, sources: [SOURCES[0]] });
    const row = deps.messages.querySelector<HTMLElement>(".chat-search-source-row")!;
    let anchorTop = 200;
    deps.messages.scrollTop = 500;
    Object.defineProperty(deps.messages, "clientHeight", { configurable: true, value: 300 });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === deps.messages) return new DOMRect(0, 100, 400, 300);
      if (this === row) return new DOMRect(20, anchorTop, 300, 20);
      if (this.hasAttribute("data-chat-search-preview")) return new DOMRect(0, 0, 320, 100);
      return new DOMRect();
    });

    row.dispatchEvent(new FocusEvent("focus"));
    const preview = deps.messages.querySelector<HTMLElement>(".chat-search-preview")!;
    expect(preview.style.top).toBe("626px");
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    anchorTop = 350;
    row.dispatchEvent(new FocusEvent("focus"));
    const flipped = deps.messages.querySelector<HTMLElement>(".chat-search-preview")!;
    expect(flipped.style.top).toBe("644px");
  });
});
