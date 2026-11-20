// 统一思维链状态条（ThoughtChain）与工具活动 UI 契约测试：
// 经 chat-runtime 公开协议入口 handleChatPortMessage 喂 read_subtitles /
// capture_video_frame_at_time / web_search / reasoning / done，
// 断言面向可观察 DOM（统一思维链状态条 / 时间线步骤 / 来源列表 / [n] 内联引用 /
// 悬停预览卡 / 流式默认展开与手动折叠 / 完成自动折叠为单行摘要 / stream-reset 清空）。
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

describe("统一思维链状态条（联网检索与步骤时间线）", () => {
  it("tool-status searching：挂载在 assistant 节点顶部，流式默认展开，头部动态状态 + 步骤行「搜索中…」", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "MoE 新进展" });

    const assistant = deps.messages.querySelector(".chat-msg-assistant")!;
    const chain = assistant.querySelector<HTMLElement>(".chat-thought-chain")!;
    expect(chain).toBeTruthy();
    expect(assistant.firstElementChild).toBe(chain);
    expect(chain.classList.contains("chat-thought-chain-collapsed")).toBe(false);
    expect(chain.querySelector(".chat-thought-chain-head")!.getAttribute("aria-expanded")).toBe("true");
    expect(chain.querySelector(".chat-thought-chain-summary")!.textContent).toBe("联网检索 · MoE 新进展…");
    const step = chain.querySelector(".chat-thought-step")!;
    expect(step.classList.contains("is-running")).toBe(true);
    expect(step.querySelector(".chat-thought-step-detail")!.textContent).toBe("MoE 新进展");
    expect(step.querySelector(".chat-thought-step-meta")!.textContent).toBe("搜索中…");
  });

  it("tool-status done：步骤行补结果数与平台、头部单行摘要、来源列表（序号 + 标题 + 完整 URL 属性）", async () => {
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

    const chain = deps.messages.querySelector<HTMLElement>(".chat-thought-chain")!;
    const step = chain.querySelector(".chat-thought-step")!;
    expect(step.classList.contains("is-running")).toBe(false);
    expect(step.querySelector(".chat-thought-step-meta")!.textContent).toBe("2 条 · Tavily");
    expect(chain.querySelector(".chat-thought-chain-summary")!.textContent).toBe("联网检索 2 条");
    const rows = chain.querySelectorAll(".chat-search-source-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".chat-search-source-idx")!.textContent).toBe("1");
    expect(rows[1].querySelector(".chat-search-source-idx")!.textContent).toBe("2");
    expect(rows[0].querySelector(".chat-search-source-title")!.textContent).toBe("DeepSeek-V3 技术报告");
    expect(rows[0].getAttribute("title")).toBe("https://arxiv.org/a");
    expect(rows[1].getAttribute("title")).toBe("https://juejin.cn/b");
  });

  it("二次搜索：来源编号跨搜索累计（3 号起），步骤数与头部累计数同步更新", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1" });
    feed(runtime, { type: "tool-status", status: "done", query: "q1", resultCount: 2, platform: "Tavily", sources: SOURCES });
    feed(runtime, { type: "tool-status", status: "searching", query: "q2" });
    feed(runtime, { type: "tool-status", status: "done", query: "q2", resultCount: 1, platform: "Tavily", sources: [{ title: "第三条", url: "https://c.example.com", snippet: "s3" }] });

    const chain = deps.messages.querySelector<HTMLElement>(".chat-thought-chain")!;
    expect(chain.querySelectorAll(".chat-thought-step")).toHaveLength(2);
    const rows = chain.querySelectorAll(".chat-search-source-row");
    expect(rows).toHaveLength(3);
    expect(rows[2].querySelector(".chat-search-source-idx")!.textContent).toBe("3");
    expect(rows[2].querySelector(".chat-search-source-title")!.textContent).toBe("第三条");
    expect(chain.querySelector(".chat-thought-chain-summary")!.textContent).toBe("联网检索 3 条");
  });

  it("tool-status failed：步骤行标记失败，不产生来源列表", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1" });
    feed(runtime, { type: "tool-status", status: "failed", query: "q1" });

    const chain = deps.messages.querySelector<HTMLElement>(".chat-thought-chain")!;
    const step = chain.querySelector(".chat-thought-step")!;
    expect(step.classList.contains("is-failed")).toBe(true);
    expect(step.querySelector(".chat-thought-step-meta")!.textContent).toBe("搜索失败");
    expect(chain.querySelectorAll(".chat-search-source-row")).toHaveLength(0);
    expect(chain.querySelector(".chat-thought-chain-summary")!.textContent).toBe("搜索失败");
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

  it("流式期默认展开可随时点击收起，完成后自动折叠为单行摘要", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1" });
    feed(runtime, { type: "tool-status", status: "done", query: "q1", resultCount: 2, platform: "Tavily", sources: SOURCES });

    const chain = deps.messages.querySelector<HTMLElement>(".chat-thought-chain")!;
    const head = chain.querySelector<HTMLElement>(".chat-thought-chain-head")!;
    expect(head.tagName).toBe("BUTTON");
    expect(head.getAttribute("type")).toBe("button");
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(chain.classList.contains("chat-thought-chain-collapsed")).toBe(false);

    // 流式期间可随时手动收起，且后续事件不违背用户意愿强行展开
    head.click();
    expect(chain.classList.contains("chat-thought-chain-collapsed")).toBe(true);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    feed(runtime, { type: "tool-status", status: "searching", query: "q2" });
    expect(chain.classList.contains("chat-thought-chain-collapsed")).toBe(true);

    // 重新展开后，done 完成时自动折叠为单行摘要
    head.click();
    expect(chain.classList.contains("chat-thought-chain-collapsed")).toBe(false);
    feed(runtime, { type: "tool-status", status: "done", query: "q2", resultCount: 1, sources: [SOURCES[0]] });
    feed(runtime, { type: "token", data: "总结回答" });
    feed(runtime, { type: "done" });
    expect(chain.classList.contains("chat-thought-chain-collapsed")).toBe(true);
    expect(head.getAttribute("aria-expanded")).toBe("false");
  });

  it("新回合不继承上一回合的手动折叠态：默认回到流式展开态", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1" });
    deps.messages.querySelector<HTMLElement>(".chat-thought-chain-head")!.click();
    await startNextTurn(deps, runtime);
    feed(runtime, { type: "tool-status", status: "searching", query: "q2" });

    const chains = deps.messages.querySelectorAll<HTMLElement>(".chat-thought-chain");
    expect(chains).toHaveLength(2);
    expect(chains[0].classList.contains("chat-thought-chain-collapsed")).toBe(true);
    expect(chains[1].classList.contains("chat-thought-chain-collapsed")).toBe(false);
  });

  it("stream-reset：清空本回合思维链状态条（整体重放含重新搜索）", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1" });
    expect(deps.messages.querySelector(".chat-thought-chain")).toBeTruthy();
    feed(runtime, { type: "stream-reset" });
    expect(deps.messages.querySelector(".chat-thought-chain")).toBeNull();
  });

  it("跨消息隔离：新回合的首条 searching 不带上一回合的步骤与来源", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1" });
    feed(runtime, { type: "tool-status", status: "done", query: "q1", resultCount: 1, platform: "Tavily", sources: [SOURCES[0]] });
    await startNextTurn(deps, runtime);
    feed(runtime, { type: "tool-status", status: "searching", query: "q2" });

    const chains = deps.messages.querySelectorAll(".chat-thought-chain");
    expect(chains).toHaveLength(2);
    expect(chains[1].querySelectorAll(".chat-thought-step")).toHaveLength(1);
  });
});

describe("完整思维链全流程（读取字幕 → 采样关键帧 → 联网检索 → 深度思考 → 单行摘要）", () => {
  it("按时间线顺序收口四个阶段，完成后自动折叠为包含耗时与参考字幕数的单行摘要", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(2_000_000);
      const { deps, runtime } = await makeRuntime("详细解释 04:12 的原理");

      feed(runtime, { type: "tool-status", status: "searching", tool: "read_subtitles", query: "检索相关字幕", callId: "sub-1" });
      const chain = deps.messages.querySelector<HTMLElement>(".chat-thought-chain")!;
      expect(chain.querySelector(".chat-thought-chain-summary")!.textContent).toBe("读取字幕 · 检索相关字幕…");

      feed(runtime, { type: "tool-status", status: "done", tool: "read_subtitles", query: "检索相关字幕", callId: "sub-1", resultCount: 4 });
      feed(runtime, { type: "tool-status", status: "searching", tool: "capture_video_frame_at_time", query: "04:12", callId: "frame-1", targetTime: 252 });
      feed(runtime, {
        type: "tool-status",
        status: "done",
        tool: "capture_video_frame_at_time",
        query: "04:12",
        callId: "frame-1",
        targetTime: 252,
        resultCount: 1,
        expectedCount: 1,
        frames: [{ image: { mime: "image/jpeg", data: "Rk9S" }, currentTime: 252 }]
      });
      feed(runtime, { type: "tool-status", status: "searching", tool: "web_search", query: "MoE 原理", callId: "search-1" });
      feed(runtime, { type: "tool-status", status: "done", tool: "web_search", query: "MoE 原理", callId: "search-1", resultCount: 2, platform: "Tavily", sources: SOURCES });
      feed(runtime, { type: "reasoning", data: "结合字幕、画面与资料推导…" });

      nowSpy.mockReturnValue(2_004_200);
      feed(runtime, { type: "token", data: "核心推导见 [04:12]、[05:30] 与 [08:15]，参考 [1]。" });
      feed(runtime, { type: "done" });

      const steps = [...chain.querySelectorAll<HTMLElement>(".chat-thought-step")];
      expect(steps.map((s) => s.dataset.stepKind)).toEqual([
        "read_subtitles",
        "capture_video_frame_at_time",
        "web_search",
        "thinking"
      ]);
      expect(chain.classList.contains("chat-thought-chain-collapsed")).toBe(true);
      expect(chain.querySelector(".chat-thought-chain-summary")!.textContent).toBe(
        "已思考 4.2s · 采样 1 张画面 · 联网检索 2 条 · 参考 3 处字幕"
      );
      expect(deps.messages.querySelectorAll(".chat-timestamp-link")).toHaveLength(3);
    } finally {
      nowSpy.mockRestore();
    }
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

describe("统一思维链内工具与思考共存", () => {
  it("工具与思考收口在同一思维链容器内，分步骤呈现", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1" });
    feed(runtime, { type: "reasoning", data: "思考" });
    const assistant = deps.messages.querySelector(".chat-msg-assistant")!;
    const chains = assistant.querySelectorAll(".chat-thought-chain");
    expect(chains).toHaveLength(1);
    expect(chains[0].querySelector(".chat-thought-step[data-step-kind='web_search']")).toBeTruthy();
    expect(chains[0].querySelector(".chat-thought-step[data-step-kind='thinking']")).toBeTruthy();
  });
});

describe("搜索终态、播报与键盘可用性", () => {
  it("done：头部累计数与步骤本次数各自计量，独立状态区只播报一次，重复事件不重复累计", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1", callId: "call-1" });
    feed(runtime, { type: "tool-status", status: "done", query: "q1", callId: "call-1", resultCount: 2, sources: SOURCES });

    const chain = deps.messages.querySelector<HTMLElement>(".chat-thought-chain")!;
    const announcer = chain.querySelector<HTMLElement>(".chat-search-announcer")!;
    expect(chain.dataset.status).toBe("done");
    expect(chain.querySelector(".chat-thought-chain-summary")!.textContent).toBe("联网检索 2 条");
    expect(chain.querySelector(".chat-thought-step-meta")!.textContent).toBe("2 条");
    expect(announcer.getAttribute("role")).toBe("status");
    expect(announcer.getAttribute("aria-live")).toBe("polite");
    expect(announcer.textContent).toBe("搜索完成，共 2 条来源");
    expect(deps.messages.getAttribute("aria-live")).toBeNull();
    expect(deps.messages.getAttribute("role")).toBeNull();

    const observer = new MutationObserver(() => {});
    observer.observe(announcer, { childList: true, characterData: true, subtree: true });
    feed(runtime, { type: "tool-status", status: "done", query: "q1", callId: "call-1", resultCount: 2, sources: SOURCES });
    expect(observer.takeRecords()).toHaveLength(0);
    expect(chain.querySelectorAll(".chat-search-source-row")).toHaveLength(2);
    observer.disconnect();
  });

  it("cancelled：只收口对应调用并播报一次，不残留进行中样式", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1", callId: "call-1" });
    feed(runtime, { type: "tool-status", status: "cancelled", query: "q1", callId: "call-1" });

    const chain = deps.messages.querySelector<HTMLElement>(".chat-thought-chain")!;
    expect(chain.dataset.status).toBe("cancelled");
    expect(chain.querySelector(".chat-thought-chain-summary")!.textContent).toBe("已取消");
    expect(chain.querySelector(".chat-thought-step")!.classList.contains("is-cancelled")).toBe(true);
    expect(chain.querySelector(".is-running")).toBeNull();
    expect(chain.textContent).not.toContain("搜索中…");
    expect(chain.querySelector(".chat-search-announcer")!.textContent).toBe("搜索已取消");
  });

  it("callId 乱序终态不误收口其他步骤；全部结束后头部才离开搜索中", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1", callId: "call-1" });
    feed(runtime, { type: "tool-status", status: "searching", query: "q2", callId: "call-2" });
    feed(runtime, { type: "tool-status", status: "done", query: "q1", callId: "call-1", resultCount: 1, sources: [SOURCES[0]] });

    const chain = deps.messages.querySelector<HTMLElement>(".chat-thought-chain")!;
    const steps = chain.querySelectorAll<HTMLElement>(".chat-thought-step");
    expect(steps[0].querySelector(".chat-thought-step-meta")!.textContent).toBe("1 条");
    expect(steps[1].classList.contains("is-running")).toBe(true);
    expect(chain.dataset.status).toBe("searching");

    feed(runtime, { type: "tool-status", status: "cancelled", query: "q2", callId: "call-2" });
    expect(steps[1].classList.contains("is-cancelled")).toBe(true);
    expect(chain.dataset.status).toBe("cancelled");
    expect(chain.querySelectorAll(".chat-search-source-row")).toHaveLength(1);
  });

  it("failed：错误使用 alert，保留诊断通知并继续主任务", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "q1", callId: "call-1" });
    feed(runtime, { type: "tool-status", status: "failed", query: "q1", callId: "call-1" });

    const chain = deps.messages.querySelector<HTMLElement>(".chat-thought-chain")!;
    const announcer = chain.querySelector<HTMLElement>(".chat-search-announcer")!;
    expect(chain.dataset.status).toBe("failed");
    expect(announcer.getAttribute("role")).toBe("alert");
    expect(announcer.getAttribute("aria-live")).toBe("assertive");
    expect(announcer.textContent).toBe("搜索失败");
    expect(runtime.isStreaming()).toBe(true);

    feed(runtime, { type: "notice", data: "联网搜索失败：HTTP 503" });
    feed(runtime, { type: "token", data: "基于已有信息继续回答" });
    feed(runtime, { type: "done" });
    expect(deps.ui.showConversationContextNotice).toHaveBeenCalledWith("联网搜索失败：HTTP 503", 4000);
    expect(deps.messages.querySelector(".chat-msg-assistant-body")!.textContent).toContain("基于已有信息继续回答");
    expect(chain.dataset.status).toBe("failed");
  });

  it.each([
    ["finish", "cancelled", "已取消"],
    ["stop", "cancelled", "已停止"],
    ["fail", "failed", "搜索失败"],
    ["discard", "cancelled", "已取消"]
  ] as const)("%s 统一收口在途搜索，终态后迟到事件不重开", async (terminal, status, summaryText) => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);
    const turn = runtime.messageArea.appendAssistantMessage({ source: "live" });
    turn.applySearchStatus({ type: "tool-status", status: "searching", query: "q1", callId: "call-1" });

    if (terminal === "finish") turn.finish();
    else if (terminal === "stop") turn.stop("用户停止");
    else if (terminal === "fail") turn.fail("错误：网络中断");
    else turn.discard();

    const chain = deps.messages.querySelector<HTMLElement>(".chat-thought-chain")!;
    expect(chain.dataset.status).toBe(status);
    expect(chain.querySelector(".chat-thought-chain-summary")!.textContent).toBe(summaryText);
    expect(chain.querySelector(".is-running")).toBeNull();
    expect(chain.textContent).not.toContain("搜索中…");
    expect(chain.querySelector(".chat-search-announcer")!.textContent).toBe(status === "failed" ? "搜索失败" : "搜索已取消");

    turn.applySearchStatus({ type: "tool-status", status: "searching", query: "late", callId: "call-2" });
    expect(chain.querySelectorAll(".chat-thought-step")).toHaveLength(1);
    expect(chain.dataset.status).toBe(status);
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

describe("历史视频帧工具可见闭环", () => {
  const TOOL = "capture_video_frame_at_time" as const;
  const FRAMES = [10, 12, 14].map((currentTime, index) => ({
    image: { mime: "image/jpeg", data: ["Rk9S", "Q0VO", "QUZU"][index] },
    currentTime
  }));

  function searching(callId = "frame-1") {
    return { type: "tool-status", status: "searching", tool: TOOL, query: "0:12", callId, targetTime: 12 } satisfies ChatPortMessage;
  }

  it("进行中显示目标时间；成功显示数量、实际帧时间并可打开画面", async () => {
    const { deps, runtime } = await makeRuntime("看看 12 秒附近");
    feed(runtime, searching());
    const chain = deps.messages.querySelector<HTMLElement>(".chat-thought-chain")!;
    expect(chain.querySelector(".chat-thought-chain-summary")!.textContent).toBe("采样关键帧 · 00:12 附近…");
    expect(chain.querySelector(".chat-thought-step-detail")!.textContent).toBe("00:12 附近");
    expect(chain.querySelector(".is-running")).not.toBeNull();

    feed(runtime, {
      type: "tool-status",
      status: "done",
      tool: TOOL,
      query: "0:12",
      callId: "frame-1",
      targetTime: 12,
      resultCount: 3,
      expectedCount: 3,
      frames: FRAMES
    });
    expect(chain.dataset.status).toBe("done");
    expect(chain.querySelector(".chat-thought-chain-summary")!.textContent).toBe("采样 3 张画面");
    expect(chain.querySelector(".chat-thought-step-meta")!.textContent).toBe("3 张");
    expect([...chain.querySelectorAll(".chat-video-frame-time")].map((el) => el.textContent)).toEqual(["00:10", "00:12", "00:14"]);
    expect(chain.querySelector(".chat-search-announcer")!.textContent).toBe("已获取 3 张画面");

    const firstFrame = chain.querySelector<HTMLButtonElement>(".chat-video-frame-item .chat-image-open")!;
    expect(firstFrame.getAttribute("aria-label")).toBe("查看 00:10 的实际画面");
    firstFrame.click();
    expect(document.querySelector<HTMLImageElement>(".chat-image-viewer-image")?.src).toBe("data:image/jpeg;base64,Rk9S");
  });

  it("部分成功明确缺失数量，只展示实际取到的帧", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, searching());
    feed(runtime, {
      type: "tool-status",
      status: "done",
      tool: TOOL,
      query: "0:12",
      callId: "frame-1",
      targetTime: 12,
      resultCount: 2,
      expectedCount: 3,
      frames: [FRAMES[0], FRAMES[2]]
    });

    const chain = deps.messages.querySelector<HTMLElement>(".chat-thought-chain")!;
    expect(chain.querySelector(".chat-thought-step-meta")!.textContent).toBe("2 张，缺失 1 张");
    expect(chain.querySelector(".chat-search-announcer")!.textContent).toBe("已获取 2 张画面，缺失 1 张");
    expect([...chain.querySelectorAll(".chat-video-frame-time")].map((el) => el.textContent)).toEqual(["00:10", "00:14"]);
  });

  it("全部失败显示文字降级，后续文字回答与终态思维链共存", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, searching());
    feed(runtime, { type: "tool-status", status: "failed", tool: TOOL, query: "0:12", callId: "frame-1", targetTime: 12 });
    feed(runtime, { type: "token", data: "依据字幕继续回答" });
    feed(runtime, { type: "done" });

    const chain = deps.messages.querySelector<HTMLElement>(".chat-thought-chain")!;
    expect(chain.dataset.status).toBe("failed");
    expect(chain.querySelector(".chat-thought-step-meta")!.textContent).toBe("未取到画面，已按文字继续");
    expect(chain.querySelector(".chat-search-announcer")!.textContent).toBe("未取到画面，已按文字继续");
    expect(chain.querySelector(".chat-search-announcer")!.getAttribute("role")).toBe("alert");
    expect(deps.messages.querySelector(".chat-msg-assistant-body")!.textContent).toContain("依据字幕继续回答");
  });

  it.each(["finish", "stop", "fail", "discard"] as const)("%s 统一收口并锁定旧回合，迟到回包不更新", async (terminal) => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);
    const turn = runtime.messageArea.appendAssistantMessage({ source: "live" });
    turn.applySearchStatus(searching());

    if (terminal === "finish") turn.finish();
    else if (terminal === "stop") turn.stop("用户停止");
    else if (terminal === "fail") turn.fail("错误：端口断开");
    else turn.discard();
    const chain = deps.messages.querySelector<HTMLElement>(".chat-thought-chain")!;
    const expectedStatus = terminal === "fail" ? "failed" : "cancelled";
    const expectedSummary = terminal === "fail" ? "未取到画面" : terminal === "stop" ? "已停止" : "已取消";
    expect(chain.dataset.status).toBe(expectedStatus);
    expect(chain.querySelector(".chat-thought-chain-summary")!.textContent).toBe(expectedSummary);
    expect(chain.querySelector(".is-running")).toBeNull();

    turn.applySearchStatus({
      type: "tool-status",
      status: "done",
      tool: TOOL,
      query: "0:12",
      callId: "frame-1",
      targetTime: 12,
      resultCount: 3,
      expectedCount: 3,
      frames: FRAMES
    });
    expect(chain.dataset.status).toBe(expectedStatus);
    expect(chain.querySelectorAll(".chat-video-frame-item")).toHaveLength(0);
    expect(chain.querySelector(".chat-thought-chain-summary")!.textContent).toBe(expectedSummary);
  });

  it("关闭会话或换片的 reset 显示已取消，迟到事件不重开旧回合", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, searching());
    runtime.resetStreamState();

    const chain = deps.messages.querySelector<HTMLElement>(".chat-thought-chain")!;
    expect(chain.dataset.status).toBe("cancelled");
    expect(chain.querySelector(".chat-thought-chain-summary")!.textContent).toBe("已取消");
    feed(runtime, { type: "tool-status", status: "done", tool: TOOL, query: "0:12", callId: "frame-1", targetTime: 12, frames: FRAMES });
    expect(chain.querySelectorAll(".chat-video-frame-item")).toHaveLength(0);
    expect(chain.dataset.status).toBe("cancelled");
  });

  it("同思维链内搜索与多次截帧按调用隔离计数和实际帧列表", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", tool: "web_search", query: "背景资料", callId: "search-1" });
    feed(runtime, { type: "tool-status", status: "done", tool: "web_search", query: "背景资料", callId: "search-1", resultCount: 1, sources: [SOURCES[0]] });
    feed(runtime, searching("frame-1"));
    feed(runtime, { type: "tool-status", status: "done", tool: TOOL, query: "0:12", callId: "frame-1", targetTime: 12, resultCount: 1, expectedCount: 3, frames: [FRAMES[0]] });
    feed(runtime, { type: "tool-status", status: "searching", tool: TOOL, query: "0:30", callId: "frame-2", targetTime: 30 });
    feed(runtime, { type: "tool-status", status: "done", tool: TOOL, query: "0:30", callId: "frame-2", targetTime: 30, resultCount: 2, expectedCount: 3, frames: [FRAMES[1], FRAMES[2]] });

    const chain = deps.messages.querySelector<HTMLElement>(".chat-thought-chain")!;
    const steps = chain.querySelectorAll<HTMLElement>(".chat-thought-step");
    expect(steps).toHaveLength(3);
    expect(steps[0].querySelector(".chat-thought-step-meta")!.textContent).toBe("1 条");
    expect(steps[0].querySelector(".chat-video-frame-results")).toBeNull();
    expect(steps[1].querySelector(".chat-thought-step-meta")!.textContent).toBe("1 张，缺失 2 张");
    expect([...steps[1].querySelectorAll(".chat-video-frame-time")].map((el) => el.textContent)).toEqual(["00:10"]);
    expect(steps[2].querySelector(".chat-thought-step-meta")!.textContent).toBe("2 张，缺失 1 张");
    expect([...steps[2].querySelectorAll(".chat-video-frame-time")].map((el) => el.textContent)).toEqual(["00:12", "00:14"]);
    expect(chain.querySelector(".chat-thought-chain-summary")!.textContent).toBe("采样 3 张画面 · 联网检索 1 条");
    expect(chain.querySelector(".chat-search-announcer")!.textContent).toBe("已获取 2 张画面，缺失 1 张");
  });
});
