// tests/chat/chat-message-area.test.ts
// 渲染片 seam 句柄化：两个句柄（消息区 / 回合节点）的行为锚点。
//
// 为什么单列一文件：节点装配形状与回合操作面此前由 chat-runtime 与 replay 两侧
// 手抄（选择器 + createElement + className），契约没有单一锚点。本文件把「渲染片
// 对外只给两个句柄」的契约钉在句柄行为上——协议级 DOM 产物断言仍留在
// chat-runtime-stream*.test.ts / chat-search-ui.test.ts（用户可见 DOM 逐字不变）。
//
// 失败方式清单（每条对应下方用例；先列清单写测试，后实现）：
//   1. 句柄漏操作：某个操作没接到渲染片实现（token / 思考 / 重置 / 收尾 / 徽标 /
//      时间线卡）——每个操作在消息区可观察产物上单独锚定。
//   2. DOM 形状漂移：助手节点不再是 .chat-msg.chat-msg-assistant（live 另带
//      chat-msg-streaming + 光标 span；replay 不带）——两种来源逐字锚定，光标
//      内层形态（三点脉冲的三个点）也锚定：点做成兄弟节点会被 tail 每帧的
//      innerHTML 重写当场清掉，流式期间指示直接消失。
//   3. 回放与流式装配不同形：同一原文经 replay 句柄与 live 句柄收尾后节点内部
//      不一致（回放自拼节点就会分叉）——innerHTML 逐字比对。
//   4. 三终态徽标错挂：error / stopped / truncated 的文案或位置漂移。
//   5. 代际重置失灵：resetStream 不清 stable/tail/思考盒/时间线卡，清掉光标，
//      或不清 token 累加器（新流拼接上旧流）。
//   6. 取消挂起帧丢缓冲 / 不释放帧槽：cancelPendingFrame 之后原文丢失，或新 token
//      调度不上新帧。
//   7. 来源语义漂移：replay 追加接管自动滚动；live 追加不滚底。
//   8. 消息区清场漏清（clear 不生效）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { resetModuleState } from "../setup.js";
import { normalizeMarkdownForSectionPaste } from "../../extension/notes/paste.js";
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

// 消息区句柄（渲染片对外两件之一）：测试直接经 runtime 的公开 seam 取用——与
// replay 的注入面同一条路。
function areaOf(runtime: ChatRuntime) {
  return runtime.messageArea;
}

// 拦截 rAF：注册回调但不自动执行，由用例逐帧驱动（token flush / 思考滚动合帧）。
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

    // replay：不滚底、不动自动滚动开关
    area.appendUserMessage("回放消息", { source: "replay" });
    expect(deps.messages.querySelector(".chat-msg-user")?.textContent).toBe("回放消息");
    expect(deps.messages.scrollTop).toBe(0);

    // live：强制 instant 滚底（CSS smooth 压不住）+ 接管自动滚动
    runtime.setAutoScroll(false);
    deps.messages.scrollTop = 42;
    const scrollToSpy = vi.fn();
    deps.messages.scrollTo = scrollToSpy;
    area.appendUserMessage("新消息", { source: "live" });
    expect(scrollToSpy).toHaveBeenCalledWith({ top: deps.messages.scrollHeight, behavior: "instant" });
    expect(deps.messages.querySelectorAll(".chat-msg-user")).toHaveLength(2);
  });

  it("助手节点形状只有一个主人：live 带流式豁免类 + 光标，replay 不带；live 摘除上一条豁免", () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);
    const area = areaOf(runtime);

    area.appendAssistantMessage({ source: "live" });
    const first = deps.messages.querySelector<HTMLElement>(".chat-msg-assistant")!;
    expect(first.className).toBe("chat-msg chat-msg-assistant chat-msg-streaming");
    expect(first.querySelector(".chat-msg-cursor")).toBeTruthy();
    // 光标内层 = 三点脉冲的三个点，且必须是光标的子节点（tail 每帧重写 innerHTML，
    // 兄弟节点活不过一帧）。CSS 只认这三个点，形态变了 CSS 就画不出药丸。
    expect(first.querySelectorAll(".chat-msg-cursor > i")).toHaveLength(3);

    // 上一条 live 的流式豁免在新消息上屏同一时刻摘除
    area.appendAssistantMessage({ source: "live" });
    const second = deps.messages.querySelectorAll<HTMLElement>(".chat-msg-assistant")[1];
    expect(first.classList.contains("chat-msg-streaming")).toBe(false);
    expect(second.classList.contains("chat-msg-streaming")).toBe(true);

    // replay：终态直出形态——无流式类、无光标
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

    // 外形：只差流式豁免类（内容由同一条终态渲染路径产出）
    expect(replayed.className).toBe("chat-msg chat-msg-assistant");
    expect(live.className).toBe("chat-msg chat-msg-assistant chat-msg-streaming");
    // 内部逐字同形（正文容器 + 操作行，含 class 与顺序）
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

    // 只入缓冲、未调度/未执行的新增量仍进终态
    turn.appendToken("，结尾");
    const raw = turn.finish({ userPrompt: "问" });
    expect(raw).toBe("第一段\n\n第二段，结尾");
    expect(deps.messages.querySelector(".chat-msg-assistant-body")?.innerHTML).toBe(
      renderMarkdown("第一段\n\n第二段，结尾")
    );
    // 终态重渲染整体替换流式双容器
    expect(deps.messages.querySelector(".chat-stream-stable")).toBeNull();
    expect(deps.messages.querySelector(".chat-stream-tail")).toBeNull();
  });

  it("appendThinking：同一回合累加到同一节点；token 之后的收尾 reasoning 新建节点并一并折叠", () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);
    const area = areaOf(runtime);
    const raf = holdRaf();
    const turn = area.appendAssistantMessage({ source: "live" });

    turn.appendThinking("先想");
    expect(deps.messages.querySelector(".chat-thinking-label")?.textContent).toBe("思考中…");
    turn.appendThinking("再想");
    expect(deps.messages.querySelectorAll(".chat-thinking")).toHaveLength(1);
    expect(deps.messages.querySelector(".chat-thinking-text")?.textContent).toBe("先想再想");

    // token 到达即思考收尾；其后到达的 reasoning（收尾事件）新建第二个节点
    turn.appendToken("正文");
    turn.appendThinking("收尾思路");
    runRafFrames(raf);
    const thinkings = deps.messages.querySelectorAll(".chat-thinking");
    expect(thinkings).toHaveLength(2);
    thinkings.forEach((thinking) => {
      expect(thinking.classList.contains("chat-thinking-collapsible")).toBe(true);
      expect(thinking.classList.contains("chat-thinking-collapsed")).toBe(true);
      expect(thinking.querySelector(".chat-thinking-label-text")?.textContent).toBe("思考过程");
    });

    // 终态重渲染保留折叠行
    turn.finish({ raw: "正文" });
    expect(deps.messages.querySelectorAll(".chat-thinking")).toHaveLength(2);
    expect(deps.messages.querySelector(".chat-msg-assistant-body")?.textContent).toBe("正文");
  });

  it("cancelPendingFrame：释放帧槽且不丢缓冲（新 token 可重新调度帧）", () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);
    const area = areaOf(runtime);
    const raf = holdRaf();
    const turn = area.appendAssistantMessage({ source: "live" });

    turn.appendToken("第一段\n\n");
    expect(raf).toHaveBeenCalledTimes(1);
    turn.cancelPendingFrame();

    // 帧槽已释放：新 token 重新调度帧
    turn.appendToken("第二段");
    expect(raf).toHaveBeenCalledTimes(2);
    expect(turn.finish({})).toBe("第一段\n\n第二段");
  });

  it("resetStream：清 stable/tail/思考盒/时间线卡、光标归位、累加器清零（新流不带旧流残留）", () => {
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
    expect(deps.messages.querySelector(".chat-search-card")).toBeTruthy();

    turn.resetStream();
    expect(deps.messages.querySelector(".chat-stream-stable")).toBeNull();
    expect(deps.messages.querySelector(".chat-stream-tail")).toBeNull();
    expect(deps.messages.querySelector(".chat-thinking")).toBeNull();
    expect(deps.messages.querySelector(".chat-search-card")).toBeNull();
    // 光标保留在节点末尾（下一帧 flush 重新接上）
    expect(deps.messages.querySelector(".chat-msg-cursor")).toBeTruthy();

    // 第二代流从头累积：终态原文不含第一代
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
    expect(node.querySelector(".chat-msg-copy-btn")).toBeTruthy();

    turn.markTruncated("回答被截断（达到模型输出上限）");
    expect(deps.messages.querySelector(".chat-msg-truncated")?.textContent).toBe("回答被截断（达到模型输出上限）");
    // 位置：操作行之后（与既有 done 收尾时序一致）
    expect(deps.messages.querySelector(".chat-msg-truncated")?.previousElementSibling?.className).toBe("chat-msg-actions");
    expect(deps.messages.querySelector(".chat-msg-truncated")).toBe(node.lastElementChild);
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

describe("回合节点句柄：联网搜索时间线卡", () => {
  it("applySearchStatus：卡片插在本节点之前；resetStream 清卡重放", () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);
    const area = areaOf(runtime);
    const turn = area.appendAssistantMessage({ source: "live" });

    turn.applySearchStatus({ type: "tool-status", status: "searching", query: "MoE" });
    const card = deps.messages.querySelector(".chat-search-card")!;
    const node = deps.messages.querySelector(".chat-msg-assistant")!;
    expect(card.nextElementSibling).toBe(node);
    expect(card.querySelector(".chat-search-card-status")?.textContent).toBe("搜索中…");

    turn.resetStream();
    expect(deps.messages.querySelector(".chat-search-card")).toBeNull();
    expect(deps.messages.querySelectorAll(".chat-msg-assistant")).toHaveLength(1);
  });

  it("attachSearchTimelineCard：静态时间线卡插在本节点之前（回放只表达顺序）", () => {
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

    const card = deps.messages.querySelector(".chat-search-card")!;
    const node = deps.messages.querySelector(".chat-msg-assistant")!;
    expect(card.nextElementSibling).toBe(node);
    expect(card.querySelector(".chat-search-card-status")?.textContent).toBe("1 条来源");
    expect(card.querySelector(".chat-search-step-query")?.textContent).toBe("第一问");
    // 内联引用与卡片同源
    expect(node.querySelector(".chat-cite[data-cite-url='https://a.com']")).toBeTruthy();
  });
});
