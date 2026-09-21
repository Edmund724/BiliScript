// 联网搜索对话 UI 测试（spec §4，变体 B + 内联引用）：
// 经 chat-runtime 公开协议入口 handleChatPortMessage 喂 tool-status / done，
// 断言面向可观察 DOM（时间线卡 / 步骤行 / 来源 chip / [n] 内联引用 / 悬停
// 预览卡 / stream-reset 清卡 / 停止态引用）。测试基建与 chat-runtime-stream
// 同款（假 port / 同模块纪元）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { normalizeMarkdownForSectionPaste } from "../../extension/notes/paste.js";

let createChatRuntime;
let chatSessionState;

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
    connectPort: vi.fn(() => ({
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
  await runtime.sendMessage();
  return { deps, runtime };
}

function feed(runtime, msg) {
  runtime.handleChatPortMessage(msg);
}

// 新回合：与真实流同语义，置流式 UI 态由 sendMessage 内部负责；这里只造下一个
// assistant 占位（上一条终态时序由 endStream 完成）。测试直接调 resetStreamState
// 清流后重新走 sendMessage。
async function startNextTurn(deps, runtime, text) {
  runtime.resetStreamState();
  deps.input.value = text || "下一问";
  await runtime.sendMessage();
}

const SOURCES = [
  { title: "DeepSeek-V3 技术报告", url: "https://arxiv.org/a", snippet: "专家并行与 FP8 训练……" },
  { title: "MoE 推理优化实践", url: "https://juejin.cn/b", snippet: "专家按热度分级驻留显存……" }
];

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  ({ createChatRuntime } = await import("../../extension/chat/chat-runtime.js"));
  ({ chatSessionState } = await import("../../extension/chat/chat-state.js"));
  chatSessionState.chatHistory = [];
  chatSessionState.currentConversationId = "";
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("搜索时间线卡", () => {
  it("tool-status searching：卡片插在 assistant 节点之前，步骤行含查询词与「搜索中…」", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "MoE 新进展" });

    const card = deps.messages.querySelector(".chat-search-card");
    const assistant = deps.messages.querySelector(".chat-msg-assistant");
    expect(card).toBeTruthy();
    expect(card.nextElementSibling).toBe(assistant);
    expect(card.querySelector(".chat-search-card-head")).toBeTruthy();
    expect(card.querySelector(".chat-search-card-status").textContent).toBe("搜索中…");
    const step = card.querySelector(".chat-search-step");
    expect(step.classList.contains("is-running")).toBe(true);
    expect(step.querySelector(".chat-search-step-query").textContent).toBe("MoE 新进展");
    expect(step.querySelector(".chat-search-step-note").textContent).toBe("搜索中…");
  });

  it("tool-status done：步骤行补结果数、头部平台与耗时、来源 chip 行（虚线分隔）", async () => {
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

    const card = deps.messages.querySelector(".chat-search-card");
    const step = card.querySelector(".chat-search-step");
    expect(step.classList.contains("is-running")).toBe(false);
    expect(step.querySelector(".chat-search-step-note").textContent).toBe("2 条");
    expect(card.querySelector(".chat-search-card-status").textContent).toContain("Tavily · 完成（");
    const chips = card.querySelectorAll(".chat-search-chip");
    expect(chips).toHaveLength(2);
    expect(chips[0].querySelector(".chat-search-chip-idx").textContent).toBe("1");
    expect(chips[1].querySelector(".chat-search-chip-idx").textContent).toBe("2");
    expect(chips[0].querySelector("span:last-child").textContent).toBe("DeepSeek-V3 技术报告");
  });

  it("二次搜索：来源编号跨搜索累计（3 号 chip 起）", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1" });
    feed(runtime, { type: "tool-status", status: "done", query: "q1", resultCount: 2, platform: "Tavily", sources: SOURCES });
    feed(runtime, { type: "tool-status", status: "searching", query: "q2" });
    feed(runtime, { type: "tool-status", status: "done", query: "q2", resultCount: 1, platform: "Tavily", sources: [{ title: "第三条", url: "https://c.example.com", snippet: "s3" }] });

    const card = deps.messages.querySelector(".chat-search-card");
    expect(card.querySelectorAll(".chat-search-step")).toHaveLength(2);
    const chips = card.querySelectorAll(".chat-search-chip");
    expect(chips).toHaveLength(3);
    expect(chips[2].querySelector(".chat-search-chip-idx").textContent).toBe("3");
    expect(chips[2].querySelector("span:last-child").textContent).toBe("第三条");
  });

  it("tool-status failed：步骤行标记失败，不产生 chips", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1" });
    feed(runtime, { type: "tool-status", status: "failed", query: "q1" });

    const card = deps.messages.querySelector(".chat-search-card");
    const step = card.querySelector(".chat-search-step");
    expect(step.classList.contains("is-failed")).toBe(true);
    expect(step.querySelector(".chat-search-step-note").textContent).toBe("搜索失败");
    expect(card.querySelectorAll(".chat-search-chip")).toHaveLength(0);
    expect(card.querySelector(".chat-search-card-status").textContent).toBe("搜索失败");
  });

  it("chip 点击：新标签打开来源 URL", async () => {
    const { deps, runtime } = await makeRuntime();
    const opened = vi.fn();
    vi.stubGlobal("open", opened);
    feed(runtime, { type: "tool-status", status: "searching", query: "q1" });
    feed(runtime, { type: "tool-status", status: "done", query: "q1", resultCount: 1, platform: "Tavily", sources: [SOURCES[0]] });
    deps.messages.querySelector(".chat-search-chip").click();
    expect(opened).toHaveBeenCalledWith("https://arxiv.org/a", "_blank", "noopener");
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
    const body = deps.messages.querySelector(".chat-msg-assistant-body");
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
    const cite = deps.messages.querySelector("sup.chat-cite");
    cite.dispatchEvent(new window.Event("mouseenter"));
    const preview = deps.messages.querySelector(".chat-search-preview");
    expect(preview).toBeTruthy();
    expect(preview.querySelector(".chat-search-preview-title").textContent).toBe("DeepSeek-V3 技术报告");
    expect(preview.querySelector(".chat-search-preview-host").textContent).toBe("arxiv.org");
    expect(preview.querySelector(".chat-search-preview-excerpt").textContent).toBe("专家并行与 FP8 训练……");
    cite.dispatchEvent(new window.Event("mouseleave"));
    expect(deps.messages.querySelector(".chat-search-preview")).toBeNull();
    cite.click();
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
    deps.messages.querySelector("sup.chat-cite").dispatchEvent(new window.Event("mouseenter"));
    const preview = deps.messages.querySelector(".chat-search-preview");
    expect(preview).toBeTruthy();
    expect(preview.querySelector(".chat-search-preview-excerpt").textContent).toHaveLength(200);
  });
});

describe("时间线卡与流式渲染共存", () => {
  it("流式正文与思考盒照常渲染，卡片不干扰 assistant 节点内容", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1" });
    feed(runtime, { type: "reasoning", data: "思考" });
    const assistant = deps.messages.querySelector(".chat-msg-assistant");
    expect(assistant.querySelector(".chat-thinking")).toBeTruthy();
    const card = deps.messages.querySelector(".chat-search-card");
    expect(card.contains(assistant.querySelector(".chat-thinking"))).toBe(false);
  });
});
