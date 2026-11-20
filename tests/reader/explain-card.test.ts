// 选区「解释」浮层 + 面板内解释卡片回归测试（真实模板 + 真实事件绑定）。
//
// 覆盖：
// - 选区触发：在字幕句内选中词/句 → 浮层显示并记录条目；选区清空 → 隐藏；
//   列表外（工具条）的选区不触发；
// - 定位合帧：selectionchange 只排帧不当场定位，一帧内至多一次「读→写」，
//   宽度走缓存（不回读 offsetWidth）；
// - 点「解释」：面板内弹卡片（loading → ready 文本），不切 tab、不写待解释意图；
// - 卡片「去对话追问」：写意图（含 selection）+ 三通道切到 AI 对话 tab；
// - 卡片关闭（×/遮罩）与 closeReadingView 会话收尾；
// - provider 解析失败 → error 态 + 重试按钮；
// - 浮层/卡片点击不触发点句跳转（都不在 .biliscript-reading-item 委托链内）。
//
// AI 侧（provider 解析 + 解释请求）以 vi.mock 替身解耦：请求组装与提示词口径在
// tests/ai/explain.test.ts 单测，这里只测接线与状态迁移。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

const aiMock = vi.hoisted(() => ({
  // 返回类型对齐真实 resolveActiveProvider（AiProvider，含可选 presetId）：
  // presetId 穿线用例（下方）的 mockResolvedValue 才能通过类型检查。
  resolveActiveProvider: vi.fn<() => Promise<
    { baseUrl: string; apiKey: string; model: string; presetId?: string }
  >>(),
  explainSelection: vi.fn(async (_input: Record<string, unknown>) => "这是模型给出的解释。")
}));

aiMock.resolveActiveProvider.mockImplementation(async () => ({ baseUrl: "https://api.test/v1", apiKey: "sk-test", model: "m" }));

vi.mock("../../extension/ai/active-provider.js", () => ({
  resolveActiveProvider: aiMock.resolveActiveProvider,
  NO_ACTIVE_PROVIDER_MESSAGE: "还没有配置 AI 平台，请先在插件设置中添加并启用。"
}));
vi.mock("../../extension/ai/explain.js", () => ({
  explainSelection: aiMock.explainSelection,
  buildExplainMessages: vi.fn(() => []),
  buildExplainContext: vi.fn(() => "")
}));

let state: TestState;
let clipState: (typeof import("../../extension/core/state.js"))["clipState"];
let reader: typeof import("../../extension/reader/index.js");
let ids: typeof import("../../extension/reader/state.js").ids;
let uiRenderer: typeof import("../../extension/ui/ui-renderer.js");
let explainIntent: typeof import("../../extension/reader/explain-intent.js");
let ensureReaderChatTab: typeof import("../../extension/reader/lazy-chat-tab.js").ensureReaderChatTab;
let video: HTMLVideoElement;

// fake rAF：选区定位已合帧（selectionchange 只排帧，一帧一次读→写），断言浮层
// 状态前需要手动推帧。捕获回调 + 尊重 cancelAnimationFrame（与
// tests/reader/subtitle-search.test.ts 同款）。
let rafPending: Map<number, (time: number) => void>;
let rafNextId: number;
let originalRaf: typeof window.requestAnimationFrame;
let originalCancelRaf: typeof window.cancelAnimationFrame;

function installFakeRaf() {
  rafPending = new Map();
  rafNextId = 0;
  originalRaf = window.requestAnimationFrame;
  originalCancelRaf = window.cancelAnimationFrame;
  window.requestAnimationFrame = (cb: (time: number) => void) => {
    rafNextId += 1;
    rafPending.set(rafNextId, cb);
    return rafNextId;
  };
  window.cancelAnimationFrame = (id: number) => {
    rafPending.delete(id);
  };
}

// 执行当前已登记的一帧（回调内新登记的留到下一轮）
function flushFrame() {
  const entries = [...rafPending.entries()];
  entries.forEach(([id, cb]) => {
    rafPending.delete(id);
    cb(0);
  });
}

function flushAnimationFrames(maxRounds = 30) {
  let rounds = 0;
  while (rafPending.size > 0 && rounds < maxRounds) {
    flushFrame();
    rounds += 1;
  }
  if (rafPending.size > 0) {
    throw new Error(`rAF queue did not drain after ${maxRounds} rounds`);
  }
}

async function loadModules() {
  setLocationUrl(READER_MODE_URL);
  explainIntent = await import("../../extension/reader/explain-intent.js");
  const stateModule = await import("../../extension/core/state.js");
  state = stateModule.state as TestState;
  clipState = stateModule.clipState;
  reader = await import("../../extension/reader/index.js");
  ids = (await import("../../extension/reader/state.js")).ids;
  uiRenderer = await import("../../extension/ui/ui-renderer.js");
  ensureReaderChatTab = (await import("../../extension/reader/lazy-chat-tab.js")).ensureReaderChatTab;
}

function tabBody(name: "Subtitle" | "Overview" | "Chat") {
  return document.getElementById(ids[`readingTabBody${name}`]) as HTMLElement;
}

function explainPop(): HTMLElement {
  return document.getElementById(ids.readingExplainPop) as HTMLElement;
}

function explainBtn(): HTMLButtonElement {
  return explainPop().querySelector(".biliscript-reading-explain-btn") as HTMLButtonElement;
}

function explainCard(): HTMLElement {
  return document.getElementById(ids.readingExplainCard) as HTMLElement;
}

function cardAction(action: string): HTMLElement | null {
  return explainCard().querySelector<HTMLElement>(`[data-explain-card-action="${action}"]`);
}

function subtitleItem(index: number): HTMLElement {
  return document.querySelector(`#${ids.readingSubtitleList} [data-index="${index}"]`) as HTMLElement;
}

function seedSubtitleBody() {
  state.clip.subtitleBody = [
    { from: 0, to: 10, content: "第一句话" },
    { from: 10, to: 30, content: "我们习惯将其视为传递信息的工具" }
  ];
}

// 在指定条目文本里选中一段（jsdom 不自动派发 selectionchange，手动补一发；
// 定位已合帧，补发后推一帧让浮层落到 DOM）
function selectInItem(index: number, text: string) {
  const item = subtitleItem(index);
  const textNode = item.querySelector(".biliscript-reading-text")?.firstChild as Text;
  const full = textNode.textContent || "";
  const start = Math.max(0, full.indexOf(text));
  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, start + text.length);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  flushAnimationFrames();
}

function clearSelection() {
  const selection = document.getSelection();
  selection?.removeAllRanges();
  document.dispatchEvent(new Event("selectionchange"));
  flushAnimationFrames();
}

function dispatchActionClick(action: string) {
  cardAction(action)?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-biliscript-reader-mode");
  document.body.removeAttribute("data-biliscript-reader-mode");
  aiMock.resolveActiveProvider.mockResolvedValue({ baseUrl: "https://api.test/v1", apiKey: "sk-test", model: "m" });
  aiMock.explainSelection.mockReset();
  aiMock.explainSelection.mockResolvedValue("这是模型给出的解释。");
  await loadModules();
  installFakeRaf();
  uiRenderer.ensureUiReady({ forceRecreate: true });
  mountPlayerChain();
  video = document.querySelector("video") as HTMLVideoElement;
  seedSubtitleBody();
  reader.renderReadingView();
  Element.prototype.scrollIntoView = () => {};
});

afterEach(async () => {
  try {
    clearSelection();
    reader.stopReadingViewSync();
    reader.closeReadingView();
  } catch {
    // ignore
  }
  window.requestAnimationFrame = originalRaf;
  window.cancelAnimationFrame = originalCancelRaf;
  await new Promise((resolve) => setTimeout(resolve, 150));
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("选区「解释」浮层", () => {
  it("句内选中词 → 浮层显示并记录条目；选区清空 → 隐藏", () => {
    expect(explainPop().hidden).toBe(true);

    selectInItem(1, "传递信息的工具");
    expect(explainPop().hidden).toBe(false);
    expect(explainPop().dataset.itemIndex).toBe("1");

    clearSelection();
    expect(explainPop().hidden).toBe(true);
  });

  it("拖选合帧：selectionchange 不当场定位，一帧只跑一次读→写", () => {
    const widthReads = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get");
    const popHost = explainPop().parentElement as HTMLElement;
    const bodyRect = vi.spyOn(popHost, "getBoundingClientRect");

    selectInItem(1, "传递信息的工具");
    expect(explainPop().hidden).toBe(false);
    // 定位帧用宽度缓存，读几何只发生在读相位（每帧一次 bodyRect + 一次 anchor
    // rect），写相位（left/top/hidden）不再回读布局。
    expect(widthReads).toHaveBeenCalledTimes(1);
    expect(bodyRect).toHaveBeenCalledTimes(1);

    // 同一帧内的多次选区变化合并成一次定位（拖选高频路径）
    bodyRect.mockClear();
    const item = subtitleItem(1);
    const textNode = item.querySelector(".biliscript-reading-text")?.firstChild as Text;
    const selection = document.getSelection();
    [2, 4, 6].forEach((end) => {
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, end);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(bodyRect).not.toHaveBeenCalled();
    flushFrame();
    expect(bodyRect).toHaveBeenCalledTimes(1);
  });

  it("列表外的选区不触发浮层", () => {
    const input = document.getElementById(ids.readingSearchInput) as HTMLInputElement;
    input.select();
    document.dispatchEvent(new Event("selectionchange"));
    expect(explainPop().hidden).toBe(true);
  });

  it("列表滚动即隐藏浮层（定位基准失效）", () => {
    selectInItem(1, "工具");
    expect(explainPop().hidden).toBe(false);
    (document.getElementById(ids.readingSubtitleList) as HTMLElement).dispatchEvent(new Event("scroll"));
    expect(explainPop().hidden).toBe(true);
  });
});

describe("面板内解释卡片", () => {
  it("点「解释」：就地弹卡片并渲染解释，不切 tab、不写待解释意图", async () => {
    selectInItem(1, "传递信息的工具");
    explainBtn().click();

    // 卡片经 reader 动态域装载（loadReaderDomain().then），断言前等一轮落定
    await vi.waitFor(() => expect(explainCard().hidden).toBe(false));
    expect(explainCard().querySelector(".biliscript-reading-explain-card-quote")?.textContent).toBe("传递信息的工具");

    await vi.waitFor(() =>
      expect(explainCard().querySelector(".biliscript-reading-explain-card-answer")?.textContent).toContain("这是模型给出的解释。")
    );

    // 请求入参：选中片段 + 所在整句 + 起始秒 + 条目下标（上下文窗口锚点）
    const args = aiMock.explainSelection.mock.calls[0][0];
    expect(args.selection).toBe("传递信息的工具");
    expect(args.line).toBe("我们习惯将其视为传递信息的工具");
    expect(args.from).toBe(10);
    expect(args.index).toBe(1);
    expect(Array.isArray(args.body)).toBe(true);

    // 阅读不被打断：仍在字幕 tab，且没有写对话侧的待解释意图
    expect(tabBody("Subtitle").classList.contains("is-active")).toBe(true);
    expect(tabBody("Chat").classList.contains("is-active")).toBe(false);
    const probeSend = vi.fn().mockResolvedValue(true);
    const probe = explainIntent.createExplainIntentController({
      card: document.createElement("div"),
      sendPrompt: probeSend
    });
    await probe.consumeIfPending();
    expect(probeSend).not.toHaveBeenCalled();
  });

  // bilingual-subtitles/08 号票的回归锁：双语态下 `.biliscript-reading-text` 里还嵌着
  // 副行 span（`.biliscript-reading-subtext`），而「选中所在整句」只指**主行**——
  // 解释卡的引用不能把另一条轨的译文拼进来（06 执行期修的真实缺陷，`readMainLineText`）。
  it("双语开：解释请求的整句只取主行，副行译文不进引用", async () => {
    state.settings.bilingualSubtitles = true;
    clipState.applySecondarySubtitle({
      id: "sub-en",
      url: "https://sub/en.json",
      body: [{ from: 10, to: 30, content: "TRANSLATED" }]
    });
    reader.renderReadingView();
    // 条目 1 的两行都渲染出来（副行是真实译文，不是占位）
    expect(subtitleItem(1).querySelector(".biliscript-reading-subtext")?.textContent).toBe("TRANSLATED");

    selectInItem(1, "传递信息的工具");
    explainBtn().click();
    await vi.waitFor(() => expect(aiMock.explainSelection.mock.calls.length).toBeGreaterThan(0));

    const args = aiMock.explainSelection.mock.calls[0][0] as { line: string; selection: string };
    expect(args.line).toBe("我们习惯将其视为传递信息的工具");
    expect(args.line).not.toContain("TRANSLATED");
    expect(args.selection).toBe("传递信息的工具");
  });

  it("presetId 穿线：解析结果的 presetId 随 provider 原样进入解释请求（卡片层不重建 provider）", async () => {
    // 反代 baseUrl：host 推断无规则，presetId 是解释链唯一的平台识别线索
    aiMock.resolveActiveProvider.mockResolvedValue({
      baseUrl: "https://thinking-proxy.example.com/v1",
      apiKey: "sk-test",
      model: "qwen3-max",
      presetId: "qwen"
    });

    selectInItem(1, "工具");
    explainBtn().click();
    await vi.waitFor(() => expect(aiMock.explainSelection.mock.calls.length).toBeGreaterThan(0));

    const args = aiMock.explainSelection.mock.calls[0][0] as { provider: { presetId?: string; baseUrl?: string } };
    expect(args.provider.presetId).toBe("qwen");
    expect(args.provider.baseUrl).toBe("https://thinking-proxy.example.com/v1");
  });

  it("webSearchEnabled 开启（位已置位）：解释请求带联网运行时（resolve-search-provider 往返组装）", async () => {
    // 覆盖 setup 层的 chrome stub：get-settings 回开启态 + opt-in 位已置位
    //（位未置位时先出一次性说明，见下方 §6.7 用例）；resolve-search-provider
    // 回链（S4 形状；此处刻意用 apiKey:"" 的 keyless 候选——免 Key 家必须能到达
    // 解释链，第二道闸不再按 apiKey 非空判「未配置」）；其余消息回 ok
    //（sendRuntimeMessage callback 风格）。
    vi.stubGlobal("chrome", {
      runtime: {
        lastError: null,
        getURL: (path: string) => `chrome-extension://test/${path}`,
        sendMessage: (msg: { type?: string }, cb?: (r: unknown) => void) => {
          const payload =
            msg?.type === "get-settings"
              ? { ok: true, settings: { webSearchEnabled: true, searchOptInNoticeAcknowledged: true } }
              : msg?.type === "resolve-search-provider"
                ? {
                    ok: true,
                    chain: [
                      {
                        provider: { id: "p", name: "Tavily", type: "tavily", baseUrl: "https://api.tavily.com" },
                        apiKey: ""
                      }
                    ],
                    maxToolCalls: 2
                  }
                : { ok: true };
          if (typeof cb === "function") {
            cb(payload);
            return undefined;
          }
          return Promise.resolve(payload);
        }
      }
    });

    selectInItem(1, "工具");
    explainBtn().click();
    await vi.waitFor(() => expect(aiMock.explainSelection.mock.calls.length).toBeGreaterThan(0));

    const args = aiMock.explainSelection.mock.calls[0][0] as {
      webSearch?: { maxToolCalls: number; executeSearch: (q: string) => Promise<unknown> };
    };
    expect(args.webSearch).toMatchObject({ maxToolCalls: 2 });
    expect(typeof args.webSearch?.executeSearch).toBe("function");

    // 用例后恢复 setup 层 stub（下一个用例的 resetModuleState 会重装）
    vi.unstubAllGlobals();
  });

  it("toggle 关（默认设置）：解释请求不带 webSearch（无联网字段）", async () => {
    selectInItem(1, "工具");
    explainBtn().click();
    await vi.waitFor(() => expect(aiMock.explainSelection.mock.calls.length).toBeGreaterThan(0));
    const args = aiMock.explainSelection.mock.calls[0][0] as { webSearch?: unknown };
    expect(args.webSearch).toBeUndefined();
  });

  // ===== opt-in 一次性说明闸（§6.7 / §10 第 58 行）=====
  // 开关开 + 位未置位 → 解析搜索运行时**之前**先弹说明（ui/confirm-dialog，阅读
  // 视图宿主内）：同意 → 写位并继续；拒绝 → 关闭联网偏好（不传 webSearch），解释
  // 照常发起、不置授权位（重新开启才再问）。
  function stubOptInChrome(
    acknowledged: boolean,
    chain: Array<Record<string, unknown>> | null = [
      {
        provider: { id: "p", name: "Tavily", type: "tavily", baseUrl: "https://api.tavily.com" },
        apiKey: ""
      }
    ]
  ): Array<Record<string, unknown>> {
    const sent: Array<Record<string, unknown>> = [];
    vi.stubGlobal("chrome", {
      runtime: {
        lastError: null,
        getURL: (path: string) => `chrome-extension://test/${path}`,
        sendMessage: (msg: Record<string, unknown>, cb?: (r: unknown) => void) => {
          sent.push(msg);
          const payload =
            msg?.type === "get-settings"
              ? { ok: true, settings: { webSearchEnabled: true, searchOptInNoticeAcknowledged: acknowledged } }
              : msg?.type === "resolve-search-provider"
                ? (chain ? { ok: true, chain, maxToolCalls: 2 } : { ok: true })
                : { ok: true };
          if (typeof cb === "function") {
            cb(payload);
            return undefined;
          }
          return Promise.resolve(payload);
        }
      }
    });
    return sent;
  }

  it("位未置位 + 开关开：解析搜索运行时之前先弹说明；同意 → 写位并继续带联网运行时", async () => {
    const sent = stubOptInChrome(false);

    selectInItem(1, "工具");
    explainBtn().click();
    await vi.waitFor(() => expect(document.querySelector(".confirm-dialog")).not.toBeNull());
    const dialog = document.querySelector<HTMLElement>(".confirm-dialog")!;
    expect(dialog.querySelector(".confirm-dialog-title")!.textContent).toBe("允许联网搜索？");
    const message = dialog.querySelector(".confirm-dialog-message")!.textContent!;
    expect(message).toContain("联网搜索会把查询词发往内置的免 Key 服务");
    expect(message).toContain("关闭搜索开关可随时撤回");
    // 次入口（用户裁定③）：删记录停止该家接收查询
    expect(message).toContain("删除对应平台记录可停止向其发送查询");
    expect(dialog.querySelector(".confirm-dialog-cancel")!.textContent).toBe("关闭联网搜索");
    expect(dialog.querySelector(".confirm-dialog-confirm")!.textContent).toBe("允许并继续");
    // 授权前只做一次链可用性探测（付费提示用：不带查询词、不执行搜索）；
    // 搜索运行时仍在同意之后才组装
    const probesBefore = sent.filter((m) => m.type === "resolve-search-provider");
    expect(probesBefore).toHaveLength(1);
    expect(probesBefore[0]).not.toHaveProperty("query");
    expect(aiMock.explainSelection).not.toHaveBeenCalled();

    dialog.querySelector<HTMLButtonElement>(".confirm-dialog-confirm")!.click();

    await vi.waitFor(() => expect(aiMock.explainSelection.mock.calls.length).toBeGreaterThan(0));
    const args = aiMock.explainSelection.mock.calls[0][0] as { webSearch?: { maxToolCalls: number } };
    expect(args.webSearch).toMatchObject({ maxToolCalls: 2 });
    expect(sent).toContainEqual({ type: "save-settings", settings: { searchOptInNoticeAcknowledged: true } });

    vi.unstubAllGlobals();
  });

  it("位未置位 + 开关开：拒绝 → 不带 webSearch、关闭联网偏好，解释照常发起", async () => {
    const sent = stubOptInChrome(false);

    selectInItem(1, "工具");
    explainBtn().click();
    await vi.waitFor(() => expect(document.querySelector(".confirm-dialog")).not.toBeNull());
    document.querySelector<HTMLButtonElement>(".confirm-dialog-cancel")!.click();

    await vi.waitFor(() => expect(aiMock.explainSelection.mock.calls.length).toBeGreaterThan(0));
    const args = aiMock.explainSelection.mock.calls[0][0] as { webSearch?: unknown };
    expect(args.webSearch).toBeUndefined();
    // 拒绝 = 关闭联网偏好（既有开关随存储变更同步），授权位不置位（重新开启才再问）
    expect(sent).toContainEqual({ type: "save-settings", settings: { webSearchEnabled: false } });
    expect(
      sent.some((m) => m.type === "save-settings" && (m.settings as Record<string, unknown>)?.searchOptInNoticeAcknowledged)
    ).toBe(false);
    // 运行时未解析：只有授权前的付费探测，本轮不外发查询词
    expect(sent.filter((m) => m.type === "resolve-search-provider")).toHaveLength(1);

    vi.unstubAllGlobals();
  });

  it("授权中关闭阅读视图：不写偏好，也不继续发起解释生成", async () => {
    const sent = stubOptInChrome(false);

    selectInItem(1, "工具");
    explainBtn().click();
    await vi.waitFor(() => expect(document.querySelector(".confirm-dialog")).not.toBeNull());
    reader.closeReadingView();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.querySelector(".confirm-dialog")).toBeNull();
    expect(reader.isReaderExplainCardOpen()).toBe(false);
    expect(aiMock.explainSelection).not.toHaveBeenCalled();
    expect(sent.some((m) => m.type === "save-settings")).toBe(false);
    vi.unstubAllGlobals();
  });

  // 授权与平台可用性分别反馈（票 11）：位已置位（不再询问）但当前链为空时，授权不并入
  // 平台可用性文案——「未配置搜索平台」经卡片 notice 通道单独给出，解释照常完成。
  it("授权通过但搜索链为空：平台可用性在卡片 notice 单独反馈，解释照常完成", async () => {
    stubOptInChrome(true, null);

    selectInItem(1, "工具");
    explainBtn().click();

    await vi.waitFor(() => expect(aiMock.explainSelection.mock.calls.length).toBeGreaterThan(0));
    const args = aiMock.explainSelection.mock.calls[0][0] as { webSearch?: unknown };
    expect(args.webSearch).toBeUndefined();
    // ready 态（解释照常完成）同时保留平台可用性 notice
    await vi.waitFor(() =>
      expect(explainCard().querySelector(".biliscript-reading-explain-card-answer")).not.toBeNull()
    );
    expect(explainCard().querySelector(".biliscript-reading-explain-card-notice")!.textContent).toBe(
      "未配置搜索平台，本轮未联网"
    );

    vi.unstubAllGlobals();
  });

  it("卡片「去对话追问」：写意图（含 selection + explanation）+ 切到 AI 对话 tab + 聚焦输入框继续追问", async () => {
    selectInItem(1, "传递信息的工具");
    explainBtn().click();
    await vi.waitFor(() =>
      expect(explainCard().querySelector(".biliscript-reading-explain-card-answer")).not.toBeNull()
    );

    dispatchActionClick("ask-chat");

    // 卡片自身收起（切 tab 后留在字幕 tab 里会残留）
    await vi.waitFor(() => expect(explainCard().hidden).toBe(true));
    // 切对话 tab 经标签激活属主（reader/script-tab-activation 的串行队列）落地：
    // 卡片只上报意图，投影命令随后到达，DOM 三通道异步切换。
    await vi.waitFor(() => expect(tabBody("Chat").classList.contains("is-active")).toBe(true));

    const chatTab = await ensureReaderChatTab();
    await chatTab.ensureChatTabActivated();
    const quote = document.querySelector(`#${ids.readingChatIntent} .biliscript-reading-chat-intent-quote`);
    expect(quote?.textContent).toContain("传递信息的工具");
    expect(quote?.textContent).toContain("我们习惯将其视为传递信息的工具");
    expect(document.querySelector(`#${ids.readingChatIntent} .biliscript-reading-chat-intent-time`)?.textContent).toBe(
      "0:10"
    );
    expect(document.querySelector(`#${ids.readingChatIntent} .biliscript-reading-chat-intent-title`)?.textContent).toBe(
      "基于当前解释继续追问"
    );
    expect(document.activeElement).toBe(document.getElementById(ids.readingChatInput));

    const probe = explainIntent.createExplainIntentController({
      card: document.createElement("div"),
      sendPrompt: vi.fn().mockResolvedValue(true)
    });
    expect(probe.buildFollowUpPrompt("继续问")).toContain("这是模型给出的解释。");
  });

  it("× / 遮罩 / Esc 都关闭卡片", async () => {
    selectInItem(1, "工具");
    explainBtn().click();
    await vi.waitFor(() => expect(reader.isReaderExplainCardOpen()).toBe(true));

    dispatchActionClick("close");
    await vi.waitFor(() => expect(reader.isReaderExplainCardOpen()).toBe(false));
    expect(explainCard().hidden).toBe(true);

    selectInItem(1, "工具");
    explainBtn().click();
    await vi.waitFor(() => expect(reader.isReaderExplainCardOpen()).toBe(true));
    const mask = explainCard().querySelector(".biliscript-reading-explain-card-mask") as HTMLElement;
    mask.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(reader.isReaderExplainCardOpen()).toBe(false));

    selectInItem(1, "工具");
    explainBtn().click();
    await vi.waitFor(() => expect(reader.isReaderExplainCardOpen()).toBe(true));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(reader.isReaderExplainCardOpen()).toBe(false));
  });

  it("provider 解析失败 → error 态如实展示，非配置错误时重试按钮再次发起", async () => {
    aiMock.resolveActiveProvider.mockRejectedValueOnce(new Error("服务暂时不可用"));

    selectInItem(1, "工具");
    explainBtn().click();
    await vi.waitFor(() =>
      expect(explainCard().querySelector(".biliscript-reading-explain-card-state.is-error")?.textContent).toContain("服务暂时不可用")
    );
    const firstCallCount = aiMock.explainSelection.mock.calls.length;

    dispatchActionClick("retry");
    await vi.waitFor(() => expect(aiMock.explainSelection.mock.calls.length).toBe(firstCallCount + 1));
    await vi.waitFor(() =>
      expect(explainCard().querySelector(".biliscript-reading-explain-card-answer")?.textContent).toContain("这是模型给出的解释。")
    );
  });

  it("loading 态显示骨架占位并隐藏「去对话追问」；配置类错误仅渲染主按钮「去设置」", async () => {
    let resolveExplain: (text: string) => void = () => {};
    aiMock.explainSelection.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveExplain = resolve; })
    );

    selectInItem(1, "工具");
    explainBtn().click();
    await vi.waitFor(() =>
      expect(explainCard().querySelector(".biliscript-reading-explain-card-skeleton")).not.toBeNull()
    );
    expect(cardAction("ask-chat")).toBeNull();
    resolveExplain("完成解释");
    await vi.waitFor(() => expect(cardAction("ask-chat")).not.toBeNull());
    dispatchActionClick("close");

    aiMock.resolveActiveProvider.mockRejectedValueOnce(new Error("还没有配置 AI 平台，请先在插件设置中添加并启用。"));
    selectInItem(1, "工具");
    explainBtn().click();
    await vi.waitFor(() =>
      expect(explainCard().querySelector(".biliscript-reading-explain-card-state.is-error")?.textContent).toContain("还没有配置 AI 平台")
    );
    expect(explainCard().querySelector(".biliscript-reading-explain-card-actions")).not.toBeNull();
    expect(cardAction("setup")?.classList.contains("is-primary")).toBe(true);
    expect(cardAction("retry")).toBeNull();
    expect(cardAction("ask-chat")).toBeNull();
  });

  it("工具循环 notice（搜索失败/额度用尽）渲染在卡片内，不写全局状态行", async () => {
    aiMock.explainSelection.mockImplementationOnce(async (input: Record<string, unknown>) => {
      (input.onNotice as ((notice: string) => void) | undefined)?.("联网搜索额度已用尽，本次仅按字幕回答。");
      return "这是模型给出的解释。";
    });

    selectInItem(1, "工具");
    explainBtn().click();

    await vi.waitFor(() =>
      expect(explainCard().querySelector(".biliscript-reading-explain-card-answer")).not.toBeNull()
    );
    // 反馈留在卡片上下文：内容区呈现提示行
    expect(explainCard().querySelector(".biliscript-reading-explain-card-notice")?.textContent).toBe(
      "联网搜索额度已用尽，本次仅按字幕回答。"
    );
  });

  it("换选区重复打开：只留最后一张卡，过期回执不覆盖新内容", async () => {
    let resolveFirst: (text: string) => void = () => {};
    aiMock.explainSelection.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveFirst = resolve; })
    );
    aiMock.explainSelection.mockImplementationOnce(async () => "第二次的解释。");

    selectInItem(0, "第一句话");
    explainBtn().click();
    await vi.waitFor(() => expect(explainCard().querySelector(".biliscript-reading-explain-card-quote")?.textContent).toBe("第一句话"));

    selectInItem(1, "传递信息的工具");
    explainBtn().click();
    await vi.waitFor(() =>
      expect(explainCard().querySelector(".biliscript-reading-explain-card-answer")?.textContent).toContain("第二次的解释。")
    );

    // 迟到的第一次回执必须被丢弃（代际守卫）
    resolveFirst("第一次的解释。");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const answer = explainCard().querySelector(".biliscript-reading-explain-card-answer")?.textContent || "";
    expect(answer).toContain("第二次的解释。");
    expect(answer).not.toContain("第一次的解释。");
  });

  it("closeReadingView 会话收尾：卡片关闭并中止在飞请求", async () => {
    aiMock.explainSelection.mockImplementationOnce(
      (input: Record<string, unknown>) =>
        new Promise<string>((_resolve, reject) => {
          const signal = input.signal as AbortSignal | null | undefined;
          signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { aborted: true })));
        })
    );
    selectInItem(1, "工具");
    explainBtn().click();
    await vi.waitFor(() => expect(reader.isReaderExplainCardOpen()).toBe(true));

    document.documentElement.setAttribute("data-biliscript-reader-mode", "1");
    document.body.setAttribute("data-biliscript-reader-mode", "1");
    reader.closeReadingView();

    expect(reader.isReaderExplainCardOpen()).toBe(false);
    expect(explainCard().hidden).toBe(true);
  });

  it("浮层与卡片点击都不触发点句跳转（播放进度不变）", async () => {
    state.reader.readingViewOpen = true;
    reader.bindReadingViewVideo(video);
    video.play = () => Promise.resolve();
    video.currentTime = 5;

    selectInItem(1, "工具");
    explainBtn().click();
    await vi.waitFor(() => expect(explainCard().hidden).toBe(false));
    dispatchActionClick("close");

    expect(video.currentTime).toBe(5);
  });
});

describe("解释卡片焦点管理（M3 Stage 2 P0）", () => {
  it("打开移入卡片焦点，Tab/Shift+Tab 在弹窗内循环，Esc/关闭归还触发前焦点并防后台重渲抢焦点", async () => {
    state.reader.readingViewOpen = true;
    const readingView = document.getElementById(ids.readingView) as HTMLElement | null;
    if (readingView) {
      readingView.hidden = false;
      readingView.setAttribute("aria-hidden", "false");
    }
    reader.renderReadingView();

    const triggerBtn = document.createElement("button");
    triggerBtn.type = "button";
    triggerBtn.textContent = "外侧触发器";
    document.body.appendChild(triggerBtn);
    triggerBtn.focus();

    let resolveExplain: (text: string) => void = () => {};
    aiMock.explainSelection.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveExplain = resolve; })
    );

    selectInItem(1, "工具");
    explainBtn().click();
    await vi.waitFor(() => expect(reader.isReaderExplainCardOpen()).toBe(true));

    const dialog = explainCard().querySelector(".biliscript-reading-explain-card-dialog") as HTMLElement;
    expect(dialog.contains(document.activeElement)).toBe(true);

    // 焦点移到外部后，后台流/loading→ready 重渲不得抢走焦点
    const outsideInput = document.createElement("input");
    document.body.appendChild(outsideInput);
    outsideInput.focus();
    expect(document.activeElement).toBe(outsideInput);

    resolveExplain("解释已完成。");
    await vi.waitFor(() =>
      expect(explainCard().querySelector(".biliscript-reading-explain-card-answer")?.textContent).toContain("解释已完成。")
    );
    expect(document.activeElement).toBe(outsideInput);

    // Tab / Shift+Tab 圈禁在卡片内：末项 Tab 回到首项（关闭 ×），首项 Shift+Tab 回到末项（去对话追问）
    const closeBtn = explainCard().querySelector<HTMLButtonElement>(
      "button.biliscript-reading-explain-card-close"
    ) as HTMLButtonElement;
    const askBtn = cardAction("ask-chat") as HTMLButtonElement;
    askBtn.focus();
    askBtn.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(closeBtn);

    closeBtn.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(askBtn);

    // Esc 关闭并归还初始焦点
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(reader.isReaderExplainCardOpen()).toBe(false));
    expect(document.activeElement).toBe(triggerBtn);

    // 原焦点节点已不在 DOM 时，关闭回落聚焦到对应字幕项
    triggerBtn.focus();
    selectInItem(1, "工具");
    explainBtn().click();
    await vi.waitFor(() => expect(reader.isReaderExplainCardOpen()).toBe(true));
    triggerBtn.remove();
    dispatchActionClick("close");
    await vi.waitFor(() => expect(reader.isReaderExplainCardOpen()).toBe(false));
    expect(document.activeElement).toBe(subtitleItem(1));
  });
});

describe("选区「解释」浮层 Stage 2 边界与过滤（P1）", () => {
  it("底边溢出上翻并钳制、隐藏后重新测量宽度、Esc 收起浮层", () => {
    const popHost = explainPop().parentElement as HTMLElement;
    let bodyRectValue = { left: 0, top: 0, width: 320, height: 200, right: 320, bottom: 200 };
    vi.spyOn(popHost, "getBoundingClientRect").mockImplementation(() => bodyRectValue as DOMRect);
    let rangeRectValue = { left: 40, top: 185, bottom: 198, right: 140, width: 100, height: 13 };
    const originalRangeRectDesc = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      writable: true,
      value: () => rangeRectValue as DOMRect
    });

    try {
      let popWidth = 56;
      const pop = explainPop();
      vi.spyOn(pop, "offsetWidth", "get").mockImplementation(() => popWidth);
      vi.spyOn(pop, "offsetHeight", "get").mockImplementation(() => 30);

      // 下方放不下且上方够高：翻到选区上方（185 - 30 - 4 = 151）
      selectInItem(1, "工具");
      expect(pop.hidden).toBe(false);
      expect(pop.style.top).toBe("151px");

      // 隐藏并变更宽度后重开：必须重新测量新宽度（left = max(8, 320 - 8 - 120) = 192），且超窄容器钳制在 [8, maxTop]
      clearSelection();
      popWidth = 120;
      bodyRectValue = { left: 0, top: 0, width: 320, height: 44, right: 320, bottom: 44 };
      rangeRectValue = { left: 300, top: 20, bottom: 32, right: 310, width: 10, height: 12 };
      selectInItem(1, "工具");
      expect(pop.hidden).toBe(false);
      expect(pop.style.left).toBe("192px");
      expect(pop.style.top).toBe("8px");

      // Esc 仅在浮层可见时收起浮层
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(pop.hidden).toBe(true);
    } finally {
      if (originalRangeRectDesc) {
        Object.defineProperty(Range.prototype, "getBoundingClientRect", originalRangeRectDesc);
      } else {
        delete (Range.prototype as unknown as Record<string, unknown>).getBoundingClientRect;
      }
    }
  });

  it("跨句选区、时间戳与非 ready 副行不弹出；ready 译文副行选中传完整双语上下文", async () => {
    state.settings.bilingualSubtitles = true;
    clipState.applySecondarySubtitle({
      id: "sub-en",
      url: "https://sub/en.json",
      body: [{ from: 10, to: 30, content: "TRANSLATED" }]
    });
    reader.renderReadingView();

    const sel = document.getSelection();
    // 1. 跨两条字幕项的选区 → 隐藏
    const t0 = subtitleItem(0).querySelector(".biliscript-reading-text")?.firstChild as Text;
    const t1 = subtitleItem(1).querySelector(".biliscript-reading-text")?.firstChild as Text;
    const crossRange = document.createRange();
    crossRange.setStart(t0, 0);
    crossRange.setEnd(t1, 2);
    sel?.removeAllRanges();
    sel?.addRange(crossRange);
    document.dispatchEvent(new Event("selectionchange"));
    flushAnimationFrames();
    expect(explainPop().hidden).toBe(true);

    // 2. 时间戳内部选区 → 隐藏
    const timeNode = subtitleItem(1).querySelector(".biliscript-reading-time")?.firstChild as Text;
    const timeRange = document.createRange();
    timeRange.setStart(timeNode, 0);
    timeRange.setEnd(timeNode, timeNode.textContent?.length || 1);
    sel?.removeAllRanges();
    sel?.addRange(timeRange);
    document.dispatchEvent(new Event("selectionchange"));
    flushAnimationFrames();
    expect(explainPop().hidden).toBe(true);

    // 3. 非 ready 副行（loading/fail）→ 隐藏
    const subEl = subtitleItem(1).querySelector(".biliscript-reading-subtext") as HTMLElement;
    const subText = subEl.firstChild as Text;
    subEl.setAttribute("data-state", "loading");
    const subLoadingRange = document.createRange();
    subLoadingRange.setStart(subText, 0);
    subLoadingRange.setEnd(subText, 4);
    sel?.removeAllRanges();
    sel?.addRange(subLoadingRange);
    document.dispatchEvent(new Event("selectionchange"));
    flushAnimationFrames();
    expect(explainPop().hidden).toBe(true);

    // 4. ready 译文副行内划词 → 弹出，点击解释传入「主句（副句）」上下文
    subEl.setAttribute("data-state", "ready");
    const subReadyRange = document.createRange();
    subReadyRange.setStart(subText, 0);
    subReadyRange.setEnd(subText, subText.textContent?.length || 10);
    sel?.removeAllRanges();
    sel?.addRange(subReadyRange);
    document.dispatchEvent(new Event("selectionchange"));
    flushAnimationFrames();
    expect(explainPop().hidden).toBe(false);

    explainBtn().click();
    await vi.waitFor(() => expect(aiMock.explainSelection.mock.calls.length).toBeGreaterThan(0));
    const args = aiMock.explainSelection.mock.calls[0][0] as { selection: string; line: string };
    expect(args.selection).toBe("TRANSLATED");
    expect(args.line).toBe("我们习惯将其视为传递信息的工具（TRANSLATED）");
  });
});

describe("Stage 2 同步与生命周期联动闭环（P0/P1）", () => {
  it("点击折叠字幕选区不触发跳播；卡片开启时不自动滚动列表", async () => {
    state.reader.readingViewOpen = true;
    reader.bindReadingViewVideo(video);
    video.play = () => Promise.resolve();
    video.currentTime = 5;

    selectInItem(1, "工具");
    const list = document.getElementById(ids.readingSubtitleList) as HTMLElement;
    list.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    clearSelection();
    subtitleItem(1).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(video.currentTime).toBe(5);

    // 无选区普通点击则正常跳播
    list.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    subtitleItem(1).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(video.currentTime).toBe(10));

    // 打开解释卡后同步 tick 不触发列表自动滚动
    selectInItem(1, "工具");
    explainBtn().click();
    await vi.waitFor(() => expect(reader.isReaderExplainCardOpen()).toBe(true));

    const windowScrollToSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    video.currentTime = 2;
    reader.syncReadingViewPlayback();
    expect(windowScrollToSpy).not.toHaveBeenCalled();
  });

  it("换片 / 分 P reset 时关闭解释卡并清理待解释与首配续跑流程", async () => {
    const lifecycle = await import("../../extension/reader/lifecycle.js");
    const setupResume = await import("../../extension/reader/setup-resume.js");
    const onResume = vi.fn();
    const onCancel = vi.fn();

    selectInItem(1, "工具");
    explainBtn().click();
    await vi.waitFor(() => expect(reader.isReaderExplainCardOpen()).toBe(true));

    explainIntent.setPendingExplainIntent({ from: 10, content: "句", createdAt: 1 });
    const flowPromise = setupResume.beginReaderAiSetupFlow({
      scope: "explain",
      errorClass: "no-provider",
      isStillValid: () => true,
      onResume,
      onCancel
    });

    lifecycle.handleReaderPresenterNotification({ kind: "reset" });
    await flowPromise;

    expect(reader.isReaderExplainCardOpen()).toBe(false);
    expect(explainCard().hidden).toBe(true);
    const probeSend = vi.fn().mockResolvedValue(true);
    const probe = explainIntent.createExplainIntentController({
      card: document.createElement("div"),
      sendPrompt: probeSend
    });
    await probe.consumeIfPending();
    expect(probeSend).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledWith("invalid");
    expect(onResume).not.toHaveBeenCalled();
  });
});
