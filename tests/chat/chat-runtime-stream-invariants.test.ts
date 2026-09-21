// 流式渲染 11 条不变量的协议级回归测试（chat-runtime 经协议入口驱动）。
// 与 tests/chat/chat-runtime-stream.test.ts 互补：那边测生命周期与结构，
// 这里逐帧钉死「堆叠渲染 ≡ 全文渲染」的逐字节等价与光标/单调性契约。
//
// 覆盖映射（未被本文件覆盖的条目在现有测试中已覆盖，见文末清单）：
//   不变量 1：每帧至多一次 tail 渲染（renderMarkdown 调用计数锁定）
//   不变量 2：stable+tail 堆叠渲染逐字节等价全文渲染（多种输入逐帧断言）；
//             stable 只增不减（部分标签跨帧补全的角落除外，见
//             tests/ui/markdown-stream-invariants.test.ts 的说明）
//   不变量 4：光标每帧重建后重新接回 tail 尾部
//   不变量 5：终态整渲染与流式渲染逐字节一致（done 后整渲染重放）
//
// 已由现有测试覆盖、不重复：
//   不变量 3（剥除先于切分）的结构性部分：tests/ui/markdown-split-tail.test.ts
//     「空行切点落在未闭合围栏内」等 + 本文件逐帧等价断言（若剥除晚于切分，
//     等价断言必失败——未闭合 ``` 或 <think> 横跨切点时堆叠与全文渲染分叉）
//   不变量 6：一切 DOM 重建从文本重算（结构由 chat-runtime 闭包保证，
//     resetAssistantStream / stream-reset 测试锁定重建行为）
//   不变量 7：滚动 pinned ——「思考盒钉底契约」「自动滚动开关」测试
//   不变量 8：content-visibility 豁免 ——「chat-msg-streaming 类」测试
//   不变量 9：WeakMap 按节点隔离 ——「跨消息思考重建」「跨消息 reasoning 收尾」
//   不变量 10：分片代际校验 ——「让出期间流收口」「让出窗口内新 token 到达」
//   不变量 11：mermaid 水合时机 —— tests/ui/mermaid-render.test.ts +
//     本文件 mermaid 语料的逐帧等价（stable 重建丢水合由缓存兜底属结构行为）

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { normalizeMarkdownForSectionPaste } from "../../extension/notes/paste.js";

let createChatRuntime;
let chatSessionState;

const SLOW_NOTICE_TEXT = "模型响应较慢，可能正在思考，请稍候…";

function makePort() {
  const listeners = { message: [], disconnect: [] };
  return {
    port: {
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
  const ports = [];
  return {
    messages,
    input,
    ports,
    stopBtn: null,
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
    connectPort: vi.fn(async () => {
      const session = makePort();
      ports.push(session);
      return session.port;
    })
  };
}

async function makeRuntime(text = "问题") {
  const deps = makeDeps();
  deps.input.value = text;
  const runtime = createChatRuntime(deps);
  await runtime.sendMessage();
  return { deps, runtime, session: deps.ports[0] };
}

function feed(runtime, msg) {
  runtime.handleChatPortMessage(msg);
}

function holdRaf() {
  return vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
}

function assistantNode(deps) {
  return deps.messages.querySelector(".chat-msg-assistant");
}

// 帧快照：stable/tail 的 innerHTML（tail 摘除光标后）+ 光标接回断言所需信息
function frameSnapshot(node) {
  const stableEl = node.querySelector(".chat-stream-stable");
  const tailEl = node.querySelector(".chat-stream-tail");
  const tailClone = tailEl.cloneNode(true);
  tailClone.querySelector(".chat-msg-cursor")?.remove();
  return {
    stableHTML: stableEl.innerHTML,
    tailHTML: tailClone.innerHTML,
    stableText: stableEl.textContent,
    cursorOk:
      node.querySelector(".chat-msg-cursor") !== null &&
      tailEl.lastElementChild !== null &&
      tailEl.lastElementChild.className === "chat-msg-cursor"
  };
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  ({ createChatRuntime } = await import("../../extension/chat/chat-runtime.js"));
  ({ chatSessionState } = await import("../../extension/chat/chat-state.js"));
  chatSessionState.contextData = null;
  chatSessionState.currentContextKey = "";
  chatSessionState.chatHistory = [];
  chatSessionState.currentConversationId = "";
  chatSessionState.currentConversationMeta = null;
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// 逐帧驱动 token 序列，每帧收集快照
// 注意：vi.spyOn 重复打点返回同一 mock（calls 跨运行时累积），每次驱动
// 「本次 token 新注册」的帧（list 尾部），不能用局部索引。
function runStream(runtime, deps, tokens) {
  const raf = holdRaf();
  const node = assistantNode(deps);
  const frames = [];
  let cumulative = "";
  for (const token of tokens) {
    cumulative += token;
    const before = raf.mock.calls.length;
    feed(runtime, { type: "token", data: token });
    expect(raf.mock.calls.length).toBe(before + 1);
    raf.mock.calls[raf.mock.calls.length - 1][0]();
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
    "mermaid 围栏": ["说明\n\n```mermaid\n", "graph TD;\nA-->B;\n```\n\n", "图后段"]
  };

  for (const [name, tokens] of Object.entries(CORPORA)) {
    it(`逐帧等价：${name}`, async () => {
      // 与 chat-runtime 同一模块纪元导入 markdown 模块（renderMarkdown 内部
      // 再剥 think 是幂等冗余，断言式用它对全文渲染求期望）
      const md = await import("../../extension/ui/markdown.js");
      const { deps, runtime } = await makeRuntime();
      const { frames, node } = runStream(runtime, deps, tokens);

      expect(frames.length).toBe(tokens.length);
      for (const { snapshot, cumulative } of frames) {
        const expected = md.renderMarkdown(md.stripThinkBlocks(cumulative));
        // 不变量 2：stable + tail 堆叠渲染 ≡ 全文渲染（逐字节）
        expect(snapshot.stableHTML + snapshot.tailHTML).toBe(expected);
        // 不变量 4：光标存在且接在 tail 末尾（innerHTML 重写后重新接回）
        expect(snapshot.cursorOk).toBe(true);
      }

      // 不变量 5：终态整渲染从全量文本重放，与流式渲染逐字节一致
      feed(runtime, { type: "done" });
      const full = tokens.join("");
      const finalHTML = node.querySelector(".chat-msg-assistant-body").innerHTML;
      expect(finalHTML).toBe(md.renderMarkdown(md.stripThinkBlocks(full)));
      const last = frames[frames.length - 1].snapshot;
      expect(finalHTML).toBe(last.stableHTML + last.tailHTML);
      expect(chatSessionState.chatHistory[1]).toEqual({ role: "assistant", content: full });
    });
  }

  it("stable 只增不减（无部分标签补真的语料）", async () => {
    for (const name of ["多段落+列表+围栏+结尾", "think 块未闭合再闭合", "尾随空行不抖动 stable"]) {
      const { deps, runtime } = await makeRuntime();
      const { frames } = runStream(runtime, deps, CORPORA[name]);
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
    delete window.scheduler;
  });

  it("旧帧挂起在让出点期间新 token 到达：放行后逐帧等价、内容不重复", async () => {
    const md = await import("../../extension/ui/markdown.js");
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();
    // 时钟每读一次推进 100ms（超过 50ms 预算），让出点全部命中
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 100));
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    window.scheduler = { yield: vi.fn(() => gate) };

    const tokens = ["第一段\n\n第二段", "，继续", "\n\n第三段"];
    let cumulative = "";
    // 帧 1：游标已消费、挂起在 stable 渲染前的让出点（作废路径）
    cumulative += tokens[0];
    feed(runtime, { type: "token", data: tokens[0] });
    raf.mock.calls[raf.mock.calls.length - 1][0]();
    // 帧 2 到达并执行（同样挂起在让出点）
    cumulative += tokens[1];
    feed(runtime, { type: "token", data: tokens[1] });
    raf.mock.calls[raf.mock.calls.length - 1][0]();
    release();
    await vi.waitFor(() => {
      expect(node.querySelector(".chat-stream-tail")?.textContent).toContain("第二段，继续");
    });
    // 作废帧的文本仍被合并渲染一次（不丢、不重复）
    const snapshot = frameSnapshot(node);
    expect(snapshot.stableHTML + snapshot.tailHTML).toBe(md.renderMarkdown(md.stripThinkBlocks(cumulative)));
    expect(snapshot.stableHTML + snapshot.tailHTML).not.toContain("第二段第一段");

    // 帧 3 正常推进并收尾（帧 3 在已 resolve 的让出点上仍有微任务让出，等落地）
    feed(runtime, { type: "token", data: tokens[2] });
    raf.mock.calls[raf.mock.calls.length - 1][0]();
    cumulative += tokens[2];
    await vi.waitFor(() => {
      expect(node.querySelector(".chat-stream-tail")?.textContent).toContain("第三段");
    });
    const s3 = frameSnapshot(node);
    expect(s3.stableHTML + s3.tailHTML).toBe(md.renderMarkdown(md.stripThinkBlocks(cumulative)));
    feed(runtime, { type: "done" });
    expect(node.querySelector(".chat-msg-assistant-body").innerHTML).toBe(
      md.renderMarkdown(md.stripThinkBlocks(cumulative))
    );
    expect(chatSessionState.chatHistory[1]).toEqual({ role: "assistant", content: cumulative });
  });
});

describe("不变量 1：每帧至多一次 tail 渲染（renderMarkdownStripped 调用计数）", () => {
  it("stable 未增长帧恰好 1 次（tail），stable 增长帧 2 次（stable + tail）", async () => {
    const md = await import("../../extension/ui/markdown.js");
    // flush 对剥除后的 stable/tail 调 renderMarkdownStripped（内部不再重复剥除）
    const renderSpy = vi.spyOn(md, "renderMarkdownStripped");
    const { deps, runtime } = await makeRuntime();
    const raf = holdRaf();
    const node = assistantNode(deps);

    // 帧 1：建立 stable（一次 stable 渲染 + 一次 tail 渲染）
    feed(runtime, { type: "token", data: "第一段\n\n第二段开头" });
    raf.mock.calls[raf.mock.calls.length - 1][0]();
    expect(renderSpy).toHaveBeenCalledTimes(2);

    // 帧 2：tail 增长、stable 不变 → 仅 tail 一次
    renderSpy.mockClear();
    feed(runtime, { type: "token", data: "，继续增长" });
    raf.mock.calls[raf.mock.calls.length - 1][0]();
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(node.querySelector(".chat-stream-tail").textContent).toContain("第二段开头，继续增长");

    // 帧 3：新空行边界 → stable 增长一次 + tail 一次
    renderSpy.mockClear();
    feed(runtime, { type: "token", data: "\n\n第三段" });
    raf.mock.calls[raf.mock.calls.length - 1][0]();
    expect(renderSpy).toHaveBeenCalledTimes(2);
    expect(node.querySelector(".chat-msg-cursor")).not.toBeNull();
  });
});

describe("07 票 token 合帧对拍：token-batch 分批喂入 ≡ 逐 token 喂入", () => {
  // 与 runStream 同构的批量驱动：每批数据应恰好注册 1 帧（rAF 合帧不变量对批次同样成立）
  function runBatchedStream(runtime, deps, batches) {
    const raf = holdRaf();
    const node = assistantNode(deps);
    const frames = [];
    let cumulative = "";
    for (const batch of batches) {
      cumulative += batch.join("");
      const before = raf.mock.calls.length;
      feed(runtime, { type: "token-batch", data: batch });
      expect(raf.mock.calls.length).toBe(before + 1);
      raf.mock.calls[raf.mock.calls.length - 1][0]();
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

    // 每个批边界的帧快照与逐 token 驱动的同累计文本帧逐字节一致
    for (const frame of batchedRun.frames) {
      expect(frame.snapshot).toEqual(baseFramesByCumulative.get(frame.cumulative));
    }
    // 终态一致
    feed(base.runtime, { type: "done" });
    feed(batched.runtime, { type: "done" });
    expect(batchedRun.node.textContent).toBe(baseRun.node.textContent);
    expect(batchedRun.node.querySelector(".chat-msg-assistant-body").innerHTML).toBe(
      baseRun.node.querySelector(".chat-msg-assistant-body").innerHTML
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

    expect(byBatch.deps.messages.querySelector(".chat-msg-assistant").innerHTML).toBe(
      byToken.deps.messages.querySelector(".chat-msg-assistant").innerHTML
    );
  });
});

