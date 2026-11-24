// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeMarkdownForSectionPaste } from "../../extension/notes/paste.js";
import type { ChatPort, ChatPortMessage } from "../../extension/chat/chat-runtime.js";

vi.mock("../../extension/ui/lazy-mermaid.js", () => ({
  hydrateMermaid: vi.fn()
}));

import { createChatRuntime as rawCreateChatRuntime } from "../../extension/chat/chat-runtime.js";
import { chatSessionState, resetChatSessionStateForTests } from "../../extension/chat/chat-state.js";
import * as md from "../../extension/ui/markdown.js";

const createChatRuntime: typeof rawCreateChatRuntime = ((deps) => {
  const runtime = rawCreateChatRuntime(deps);
  if ("ports" in deps && Array.isArray((deps as { ports?: unknown }).ports)) {
    runtimePorts.set(runtime, (deps as unknown as { ports: PortSession[] }).ports);
  }
  return runtime;
}) as typeof rawCreateChatRuntime;

interface FakePort {
  name: string;
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (fn: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
}

interface PortSession {
  port: FakePort;
  listeners: {
    message: Array<(message: unknown) => void>;
    disconnect: Array<() => void>;
  };
}

type ChatRuntime = ReturnType<typeof import("../../extension/chat/chat-runtime.js").createChatRuntime>;
type RuntimeDeps = ReturnType<typeof makeDeps>;
const runtimePorts = new WeakMap<ChatRuntime, PortSession[]>();

type SchedulerWindow = { scheduler?: { yield: () => Promise<void> } };

const SLOW_NOTICE_TEXT = "模型响应较慢，可能正在思考，请稍候…";

function makePort(): PortSession {
  const listeners: PortSession["listeners"] = { message: [], disconnect: [] };
  return {
    port: {
      name: "offscreen-chat",
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
      postMessage: vi.fn(),
      disconnect: vi.fn()
    },
    listeners
  };
}

function makeDeps() {
  const messages = document.createElement("div");
  const input = document.createElement("textarea");
  const ports: PortSession[] = [];
  return {
    messages,
    input,
    ports,
    store: {
      persistCurrent: vi.fn(async () => {}),
      isCurrent: vi.fn((id: string) => id === chatSessionState.currentConversationId)
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
    getSelectedModel: () => "test-model",
    getTimestampNavDeps: () => ({}),
    normalizeMarkdownForSectionPaste,
    connectPort: vi.fn(async () => {
      const session = makePort();
      ports.push(session);
      return session.port as unknown as ChatPort;
    })
  };
}

async function makeRuntime(text = "问题") {
  const deps = makeDeps();
  deps.input.value = text;
  const runtime = createChatRuntime(deps);
  await runtime.sendTurn(deps.input.value);
  return { deps, runtime, session: deps.ports[0] };
}

function feed(runtime: ChatRuntime, msg: ChatPortMessage | null | undefined) {
  const session = runtimePorts.get(runtime)?.at(-1);
  if (!session) {
    throw new Error("no fake ChatPort connected for runtime");
  }
  for (const listener of [...session.listeners.message]) {
    listener(msg);
  }
}

function holdRaf() {
  return vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
}

function assistantNode(deps: RuntimeDeps): HTMLElement {
  return deps.messages.querySelector(".chat-msg-assistant") as HTMLElement;
}

function withoutTableLayout(element: Element): HTMLElement {
  const clone = element.cloneNode(true) as HTMLElement;
  for (const label of Array.from(clone.querySelectorAll(".biliscript-md-table-cell-label"))) {
    label.remove();
  }
  for (const shell of Array.from(clone.querySelectorAll(".biliscript-md-table"))) {
    const table = shell.querySelector("table");
    if (table) {
      shell.replaceWith(table);
    }
  }
  for (const codeShell of Array.from(clone.querySelectorAll(".biliscript-md-code"))) {
    const pre = codeShell.querySelector("pre");
    if (pre) {
      codeShell.replaceWith(pre);
    }
  }
  return clone;
}

function frameSnapshot(node: Element) {
  const stableEl = node.querySelector(".chat-stream-stable")!;
  const tailEl = node.querySelector(".chat-stream-tail")!;
  const stableClone = withoutTableLayout(stableEl);
  const tailClone = withoutTableLayout(tailEl);
  tailClone.querySelector(".chat-msg-cursor")?.remove();
  return {
    stableHTML: stableClone.innerHTML,
    tailHTML: tailClone.innerHTML,
    stableText: stableEl.textContent,
    cursorOk:
      node.querySelector(".chat-msg-cursor") !== null &&
      tailEl.lastElementChild !== null &&
      tailEl.lastElementChild.className === "chat-msg-cursor"
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  resetChatSessionStateForTests();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function runStream(runtime: ChatRuntime, deps: RuntimeDeps, tokens: string[]) {
  const raf = holdRaf();
  const node = assistantNode(deps);
  const frames = [];
  let cumulative = "";
  for (const token of tokens) {
    cumulative += token;
    const before = raf.mock.calls.length;
    feed(runtime, { type: "token", data: token });
    expect(raf.mock.calls.length).toBe(before + 1);
    raf.mock.calls[raf.mock.calls.length - 1][0](0);
    frames.push({ snapshot: frameSnapshot(node), cumulative });
  }
  return { frames, node, raf };
}

describe("不变量 2/4：逐帧堆叠渲染逐字节等价全文渲染，光标每帧接回", () => {
  const CORPORA = {
    "多段落+列表+围栏+结尾": [
      "# 标题\n\n",
      "第一段**加粗**",
      "\n\n- 项目一\n",
      "- 项目二\n\n",
      "```js\nconst a = 1;\n```\n\n",
      "结尾段落"
    ],
    "think 块流中闭合": ["<think>思考过程</think>\n\n", "正文第一段", "\n\n第二段"],
    "think 块未闭合再闭合": ["<think>未闭合", "思考继续</think>\n\n正文", "\n\n再一段"],
    "杂散闭合标签跨帧补全": ["a </thin", "k> \n\n", "下一段"],
    "围栏内含空行跨帧": ["前文\n\n```js\n\n", "代码行一\n\n", "代码行二\n```\n\n后文"],
    "尾随空行不抖动 stable": ["第一段\n\n第二段\n\n", "\n", "\n\n第三段"],
    "全文无空行退化全 tail": ["只有一", "个段落", "没有空行", "，继续挤"],
    "mermaid 围栏": ["说明\n\n```mermaid\n", "graph TD;\nA-->B;\n```\n\n", "图后段"],
    "跨行强调": [
      "前文段落\n\n",
      "这是一个**跨行",
      "\n强调的加粗**文本\n\n",
      "结尾段落"
    ],
    "长表格": [
      "表格前言\n\n",
      "| 列A | 列B |\n| --- | --- |\n",
      "| 1 | 2 |\n",
      "| 3 | 4 |\n\n",
      "表后段落"
    ],
    "公式": [
      "公式前段\n\n",
      "$$\nE = mc^2\n$$\n\n",
      "行内公式 $a^2 + b^2 = c^2$ 说明\n\n",
      "结尾段落"
    ],
    "联网搜索回答": [
      "根据搜索结果如下：\n\n",
      "1. **核心要点**：第一条信息\n",
      "2. **扩展信息**：第二条说明详情\n\n",
      "> 引用来源：官方文档\n\n",
      "总结陈词。"
    ]
  };

  for (const [name, tokens] of Object.entries(CORPORA)) {
    it(`逐帧等价：${name}`, async () => {
      const { deps, runtime } = await makeRuntime();
      const { frames, node } = runStream(runtime, deps, tokens);

      expect(frames.length).toBe(tokens.length);
      for (const { snapshot, cumulative } of frames) {
        const expected = md.renderMarkdown(md.stripThinkBlocks(cumulative), { streaming: true });
        expect(snapshot.stableHTML + snapshot.tailHTML).toBe(expected);
        expect(snapshot.cursorOk).toBe(true);
      }

      feed(runtime, { type: "done" });
      const full = tokens.join("");
      const finalHTML = withoutTableLayout(node.querySelector(".chat-msg-assistant-body")!).innerHTML;
      expect(finalHTML).toBe(md.renderMarkdown(md.stripThinkBlocks(full)));
      const last = frames[frames.length - 1].snapshot;
      expect(finalHTML).toBe(last.stableHTML + last.tailHTML);
      expect(chatSessionState.chatHistory[1]).toEqual({ role: "assistant", content: full });
    });
  }

  it("stable 只增不减（无部分标签补真的语料）", async () => {
    for (const name of ["多段落+列表+围栏+结尾", "think 块未闭合再闭合", "尾随空行不抖动 stable"]) {
      const { deps, runtime } = await makeRuntime();
      const { frames } = runStream(runtime, deps, CORPORA[name as keyof typeof CORPORA]);
      let prevStable = "";
      for (const { snapshot } of frames) {
        expect(snapshot.stableText.startsWith(prevStable)).toBe(true);
        prevStable = snapshot.stableText;
      }
    }
  });
});

describe("不变量 10 增量侧：让出点作废帧后流继续，游标不重复消费", () => {
  afterEach(() => {
    delete (window as unknown as SchedulerWindow).scheduler;
  });

  it("旧帧挂起在让出点期间新 token 到达：放行后逐帧等价、内容不重复", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 100));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    (window as unknown as SchedulerWindow).scheduler = { yield: vi.fn(() => gate) };

    const tokens = ["第一段\n\n第二段", "，继续", "\n\n第三段"];
    let cumulative = "";
    cumulative += tokens[0];
    feed(runtime, { type: "token", data: tokens[0] });
    raf.mock.calls[raf.mock.calls.length - 1][0](0);
    cumulative += tokens[1];
    feed(runtime, { type: "token", data: tokens[1] });
    raf.mock.calls[raf.mock.calls.length - 1][0](0);
    release();
    await vi.waitFor(() => {
      expect(node.querySelector(".chat-stream-tail")?.textContent).toContain("第二段，继续");
    });
    const snapshot = frameSnapshot(node);
    expect(snapshot.stableHTML + snapshot.tailHTML).toBe(md.renderMarkdown(md.stripThinkBlocks(cumulative)));
    expect(snapshot.stableHTML + snapshot.tailHTML).not.toContain("第二段第一段");

    feed(runtime, { type: "token", data: tokens[2] });
    raf.mock.calls[raf.mock.calls.length - 1][0](0);
    cumulative += tokens[2];
    await vi.waitFor(() => {
      expect(node.querySelector(".chat-stream-tail")?.textContent).toContain("第三段");
    });
    const s3 = frameSnapshot(node);
    expect(s3.stableHTML + s3.tailHTML).toBe(md.renderMarkdown(md.stripThinkBlocks(cumulative)));
    feed(runtime, { type: "done" });
    expect(node.querySelector(".chat-msg-assistant-body")!.innerHTML).toBe(
      md.renderMarkdown(md.stripThinkBlocks(cumulative))
    );
    expect(chatSessionState.chatHistory[1]).toEqual({ role: "assistant", content: cumulative });
  });
});

describe("不变量 1：每帧至多一次 tail 渲染（renderMarkdownStripped 调用计数）", () => {
  it("stable 未增长帧恰好 1 次（tail），stable 增长帧 2 次（stable + tail）", async () => {
    const renderSpy = vi.spyOn(md, "renderMarkdownStripped");
    const { deps, runtime } = await makeRuntime();
    const raf = holdRaf();
    const node = assistantNode(deps);

    feed(runtime, { type: "token", data: "第一段\n\n第二段开头" });
    raf.mock.calls[raf.mock.calls.length - 1][0](0);
    expect(renderSpy).toHaveBeenCalledTimes(2);

    renderSpy.mockClear();
    feed(runtime, { type: "token", data: "，继续增长" });
    raf.mock.calls[raf.mock.calls.length - 1][0](0);
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(node.querySelector(".chat-stream-tail")!.textContent).toContain("第二段开头，继续增长");

    renderSpy.mockClear();
    feed(runtime, { type: "token", data: "\n\n第三段" });
    raf.mock.calls[raf.mock.calls.length - 1][0](0);
    expect(renderSpy).toHaveBeenCalledTimes(2);
    expect(node.querySelector(".chat-msg-cursor")).not.toBeNull();
  });
});

describe("07 票 token 合帧对拍：token-batch 分批喂入 ≡ 逐 token 喂入", () => {
  function runBatchedStream(runtime: ChatRuntime, deps: RuntimeDeps, batches: string[][]) {
    const raf = holdRaf();
    const node = assistantNode(deps);
    const frames = [];
    let cumulative = "";
    for (const batch of batches) {
      cumulative += batch.join("");
      const before = raf.mock.calls.length;
      feed(runtime, { type: "token-batch", data: batch });
      expect(raf.mock.calls.length).toBe(before + 1);
      raf.mock.calls[raf.mock.calls.length - 1][0](0);
      frames.push({ snapshot: frameSnapshot(node), cumulative });
    }
    return { frames, node, raf };
  }

  const CORPUS = [
    "# 标题\n\n",
    "第一段**加粗**",
    "\n\n- 项目一\n",
    "- 项目二\n\n",
    "```js\nconst a = 1;\n```\n\n",
    "结尾段落"
  ];

  it("不均匀分批（含单 token 批）与逐 token 逐帧等价、终态一致", async () => {
    const base = await makeRuntime("基线");
    const baseRun = runStream(base.runtime, base.deps, CORPUS);
    const baseFramesByCumulative = new Map(baseRun.frames.map((f) => [f.cumulative, f.snapshot]));

    const batches = [
      [CORPUS[0]],
      [CORPUS[1], CORPUS[2]],
      [CORPUS[3], CORPUS[4], CORPUS[5]]
    ];
    const batched = await makeRuntime("合帧");
    const batchedRun = runBatchedStream(batched.runtime, batched.deps, batches);

    for (const frame of batchedRun.frames) {
      expect(frame.snapshot).toEqual(baseFramesByCumulative.get(frame.cumulative));
    }
    feed(base.runtime, { type: "done" });
    feed(batched.runtime, { type: "done" });
    expect(batchedRun.node.textContent).toBe(baseRun.node.textContent);
    expect(batchedRun.node.querySelector(".chat-msg-assistant-body")!.innerHTML).toBe(
      baseRun.node.querySelector(".chat-msg-assistant-body")!.innerHTML
    );
  });

  it("token-batch 与 token 的分派副作用一致：收尾 reasoning 同样新建思考节点", async () => {
    const byToken = await makeRuntime("逐token");
    for (const t of ["正文", "继续"]) {
      feed(byToken.runtime, { type: "token", data: t });
    }
    feed(byToken.runtime, { type: "reasoning", data: "事后思路" });

    const byBatch = await makeRuntime("合帧");
    feed(byBatch.runtime, { type: "token-batch", data: ["正文", "继续"] });
    feed(byBatch.runtime, { type: "reasoning", data: "事后思路" });

    expect(byBatch.deps.messages.querySelector(".chat-msg-assistant")!.innerHTML).toBe(
      byToken.deps.messages.querySelector(".chat-msg-assistant")!.innerHTML
    );
  });
});

describe("工单 07：稳定提交游标增量维护，已提交节点保持身份与水合隔离", () => {
  it("多段落流式追加：已提交的段落 DOM 节点在后续帧保持 === 引用，不被销毁替换", async () => {
    const { deps, runtime } = await makeRuntime();
    const raf = holdRaf();
    const node = assistantNode(deps);

    feed(runtime, { type: "token", data: "段落一\n\n段落二开头" });
    raf.mock.calls[raf.mock.calls.length - 1][0](0);
    const stableEl = node.querySelector(".chat-stream-stable")!;
    const p1 = stableEl.querySelector("p");
    expect(p1).not.toBeNull();
    expect(p1!.textContent).toBe("段落一");

    feed(runtime, { type: "token", data: "继续增长" });
    raf.mock.calls[raf.mock.calls.length - 1][0](0);
    expect(stableEl.querySelector("p")).toBe(p1);

    feed(runtime, { type: "token", data: "\n\n段落三" });
    raf.mock.calls[raf.mock.calls.length - 1][0](0);
    const paras = stableEl.querySelectorAll("p");
    expect(paras.length).toBe(2);
    expect(paras[0]).toBe(p1);
    expect(paras[1].textContent).toContain("段落二开头继续增长");
  });

  it("表格与列表增量提交：已提交表格保持 <table> 身份追加行，列表保持 <ul> 身份追加项", async () => {
    const { deps, runtime } = await makeRuntime();
    const raf = holdRaf();
    const node = assistantNode(deps);

    feed(runtime, { type: "token", data: "| A | B |\n| --- | --- |\n| 1 | 2 |\n\n后文" });
    raf.mock.calls[raf.mock.calls.length - 1][0](0);
    const stableEl = node.querySelector(".chat-stream-stable")!;
    const tableEl = stableEl.querySelector("table");
    expect(tableEl).not.toBeNull();
    const initialRows = tableEl!.querySelectorAll("tbody tr");
    expect(initialRows.length).toBe(1);

    feed(runtime, { type: "token", data: "\n\n- 列表一\n- 列表二\n\n结尾" });
    raf.mock.calls[raf.mock.calls.length - 1][0](0);
    expect(stableEl.querySelector("table")).toBe(tableEl);
    const ulEl = stableEl.querySelector("ul");
    expect(ulEl).not.toBeNull();
    expect(ulEl!.querySelectorAll("li").length).toBe(2);
  });

  it("Mermaid 与数学公式水合隔离：新块进入 stable 时，旧已水合节点不被销毁", async () => {
    const { deps, runtime } = await makeRuntime();
    const raf = holdRaf();
    const node = assistantNode(deps);

    feed(runtime, {
      type: "token",
      data: "$$\nE=mc^2\n$$\n\n```mermaid\ngraph TD;\nA-->B;\n```\n\n新段落开头"
    });
    raf.mock.calls[raf.mock.calls.length - 1][0](0);
    const stableEl = node.querySelector(".chat-stream-stable")!;
    const mathEl = stableEl.querySelector("[data-biliscript-math]");
    const mermaidEl = stableEl.querySelector("[data-biliscript-mermaid]");
    expect(mathEl).not.toBeNull();
    expect(mermaidEl).not.toBeNull();

    mermaidEl!.setAttribute("data-test-rendered", "true");
    mathEl!.setAttribute("data-test-rendered", "true");

    feed(runtime, { type: "token", data: "\n\n后续段落落定\n\n更后文本" });
    raf.mock.calls[raf.mock.calls.length - 1][0](0);

    expect(stableEl.querySelector("[data-biliscript-mermaid]")).toBe(mermaidEl);
    expect(mermaidEl!.getAttribute("data-test-rendered")).toBe("true");
    expect(stableEl.querySelector("[data-biliscript-math]")).toBe(mathEl);
    expect(mathEl!.getAttribute("data-test-rendered")).toBe("true");
  });

  it("性能证据：稳定区解析量随新增内容增长，不随每次提交时的完整前缀重复增长", async () => {
    const renderSpy = vi.spyOn(md, "renderMarkdownStripped");
    const { deps, runtime } = await makeRuntime();
    const raf = holdRaf();

    feed(runtime, { type: "token", data: "段落一内容较为简短\n\n段落二开头" });
    raf.mock.calls[raf.mock.calls.length - 1][0](0);

    const firstCallText = renderSpy.mock.calls[0][0];
    expect(firstCallText).toContain("段落一内容较为简短");

    renderSpy.mockClear();

    feed(runtime, { type: "token", data: "，继续补齐第二段\n\n段落三" });
    raf.mock.calls[raf.mock.calls.length - 1][0](0);

    const stableCallText = renderSpy.mock.calls[0][0];
    expect(stableCallText).toContain("第二段");
    expect(stableCallText).not.toContain("段落一内容较为简短");
  });
});

