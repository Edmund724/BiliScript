// 票 provider-onboarding-consistency/02 的解释卡首配续跑测试：
// 配置类解释错误（无平台/缺 Key）给「去设置」直达平台编辑，保存成功回同一卡片
// 续跑一次；取消/关卡片/换选区/换视频均作废；非配置类错误保持原重试语义。
//
// 手法（对齐 explain-card.test.ts 全 DOM 骨架 + overview-setup-resume.test.ts 的
// 意图叶断言）：
//   - AI 侧（resolveActiveProvider / explainSelection）vi.mock 替身；
//   - ui/settings-panel 整个 mock 掉，捕获 openReaderAiSetup(errorClass, session)，
//     用捕获的 session 回调模拟「保存成功 / 取消编辑」两个装配方出口；
//   - 意图叶直接 import 断言快照字段与单槽语义。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";
import {
  MISSING_PROVIDER_KEY_MESSAGE,
  NO_ACTIVE_PROVIDER_MESSAGE
} from "../../extension/core/overview-setup-error.js";

const aiMock = vi.hoisted(() => ({
  resolveActiveProvider: vi.fn<() => Promise<
    { baseUrl: string; apiKey: string; model: string; presetId?: string }
  >>(),
  explainSelection: vi.fn(async (_input: Record<string, unknown>) => "这是模型给出的解释。")
}));

const setupMock = vi.hoisted(() => ({
  openReaderAiSetup: vi.fn(),
  openReaderTranscribeSettings: vi.fn()
}));

vi.mock("../../extension/ai/active-provider.js", () => ({
  resolveActiveProvider: aiMock.resolveActiveProvider
}));
vi.mock("../../extension/ai/explain.js", () => ({
  explainSelection: aiMock.explainSelection,
  buildExplainMessages: vi.fn(() => []),
  buildExplainContext: vi.fn(() => "")
}));
vi.mock("../../extension/ui/settings-panel.js", () => setupMock);

let state: TestState;
let reader: typeof import("../../extension/reader/index.js");
let ids: typeof import("../../extension/reader/state.js").ids;
let uiRenderer: typeof import("../../extension/ui/ui-renderer.js");
let resumeLeaf: typeof import("../../extension/reader/explain-setup-resume.js");

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
  resumeLeaf = await import("../../extension/reader/explain-setup-resume.js");
  const stateModule = await import("../../extension/core/state.js");
  state = stateModule.state as TestState;
  reader = await import("../../extension/reader/index.js");
  ids = (await import("../../extension/reader/state.js")).ids;
  uiRenderer = await import("../../extension/ui/ui-renderer.js");
}

function explainPop(): HTMLElement {
  return document.getElementById(ids.readingExplainPop) as HTMLElement;
}

function explainBtn(): HTMLButtonElement {
  return explainPop().querySelector("button") as HTMLButtonElement;
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

function dispatchActionClick(action: string) {
  cardAction(action)?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

// 打开卡片并等到 error 态（provider 解析按调用方指定失败）。
async function openCardInError(selection: string, error: Error): Promise<HTMLElement> {
  aiMock.resolveActiveProvider.mockRejectedValueOnce(error);
  selectInItem(1, selection);
  explainBtn().click();
  await vi.waitFor(() =>
    expect(explainCard().querySelector(".biliscript-reading-explain-card-state.is-error")).not.toBeNull()
  );
  return explainCard();
}

function capturedSetupSession() {
  const call = setupMock.openReaderAiSetup.mock.calls.at(-1);
  expect(call, "openReaderAiSetup 应已被调用").toBeTruthy();
  return call as [string, { onAfterSave(): void; onSessionEnd(): void }];
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-biliscript-reader-mode");
  document.body.removeAttribute("data-biliscript-reader-mode");
  aiMock.resolveActiveProvider.mockReset();
  aiMock.resolveActiveProvider.mockResolvedValue({ baseUrl: "https://api.test/v1", apiKey: "sk-test", model: "m" });
  aiMock.explainSelection.mockReset();
  aiMock.explainSelection.mockResolvedValue("这是模型给出的解释。");
  setupMock.openReaderAiSetup.mockReset();
  setupMock.openReaderTranscribeSettings.mockReset();
  await loadModules();
  installFakeRaf();
  uiRenderer.ensureUiReady({ forceRecreate: true });
  mountPlayerChain();
  state.clip.bvid = "BV1explain000";
  state.clip.cid = "2000";
  seedSubtitleBody();
  reader.renderReadingView();
  Element.prototype.scrollIntoView = () => {};
});

afterEach(async () => {
  try {
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

describe("意图叶子（reader/explain-setup-resume）：单槽语义", () => {
  it("set → peek 副本 → consume 取走清空 → clear 作废", async () => {
    const intent = {
      selection: "传递信息的工具",
      line: "我们习惯将其视为传递信息的工具",
      from: 10,
      index: 1,
      runId: 3,
      bvid: "BV1explain000",
      cid: "2000",
      createdAt: 1000,
      errorClass: "missing-key" as const
    };
    resumeLeaf.setExplainSetupResumeIntent(intent);
    const peeked = resumeLeaf.peekExplainSetupResumeIntent();
    expect(peeked).toEqual(intent);
    // 外部改写副本不影响内部状态
    (peeked as { selection: string }).selection = "被篡改";
    expect(resumeLeaf.peekExplainSetupResumeIntent()?.selection).toBe("传递信息的工具");

    expect(resumeLeaf.consumeExplainSetupResumeIntent()).toEqual(intent);
    expect(resumeLeaf.consumeExplainSetupResumeIntent()).toBeNull();
    expect(resumeLeaf.peekExplainSetupResumeIntent()).toBeNull();

    resumeLeaf.setExplainSetupResumeIntent({ ...intent, errorClass: "no-provider" });
    resumeLeaf.clearExplainSetupResumeIntent();
    expect(resumeLeaf.consumeExplainSetupResumeIntent()).toBeNull();
  });
});

describe("error 态：配置类错误给「去设置」，非配置类只给「重试」", () => {
  it("无平台错误：去设置 + 重试并存", async () => {
    await openCardInError("工具", new Error(NO_ACTIVE_PROVIDER_MESSAGE));
    const setup = cardAction("setup");
    expect(setup).not.toBeNull();
    expect(setup?.textContent).toContain("去设置");
    expect(cardAction("retry")).not.toBeNull();
  });

  it("缺 Key 错误：给去设置", async () => {
    await openCardInError("工具", new Error(MISSING_PROVIDER_KEY_MESSAGE));
    expect(cardAction("setup")).not.toBeNull();
  });

  it("非配置类错误（网络/额度/限流文案）：不伪装成配置问题，只有重试", async () => {
    await openCardInError("工具", new Error("网络请求失败，请检查网络后重试"));
    expect(cardAction("setup")).toBeNull();
    expect(cardAction("retry")).not.toBeNull();

    aiMock.resolveActiveProvider.mockRejectedValueOnce(new Error("请求限流，请稍后再试"));
    dispatchActionClick("retry");
    // 重试走原语义：仍是 error 态 + 重试，不冒出去设置
    await vi.waitFor(() =>
      expect(explainCard().querySelector(".biliscript-reading-explain-card-state.is-error")?.textContent).toContain("请求限流")
    );
    expect(cardAction("setup")).toBeNull();
    expect(cardAction("retry")).not.toBeNull();
  });
});

describe("「去设置」：记录意图并直达平台编辑", () => {
  it("点击去设置：意图快照（选区/整句/时刻/下标/代际号/视频身份/类目）+ 直达分派", async () => {
    await openCardInError("传递信息的工具", new Error(NO_ACTIVE_PROVIDER_MESSAGE));
    dispatchActionClick("setup");

    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    const [errorClass, session] = capturedSetupSession();
    expect(errorClass).toBe("no-provider");
    expect(typeof session.onAfterSave).toBe("function");
    expect(typeof session.onSessionEnd).toBe("function");

    const intent = resumeLeaf.peekExplainSetupResumeIntent();
    expect(intent).toMatchObject({
      selection: "传递信息的工具",
      line: "我们习惯将其视为传递信息的工具",
      from: 10,
      index: 1,
      bvid: "BV1explain000",
      cid: "2000",
      errorClass: "no-provider"
    });
    expect(typeof intent?.runId).toBe("number");
  });

  it("配置期间 Esc 归逐层退出：设置开着不抢关卡片，设置关了恢复卡片 Esc", async () => {
    selectInItem(1, "工具");
    explainBtn().click();
    await vi.waitFor(() => expect(reader.isReaderExplainCardOpen()).toBe(true));

    // 设置抽屉展开（编辑器/抽屉叠在卡片上）：Esc 不归卡片消化
    state.reader.setSettingsExpanded(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(reader.isReaderExplainCardOpen()).toBe(true);

    state.reader.setSettingsExpanded(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(reader.isReaderExplainCardOpen()).toBe(false));
  });
});

describe("保存成功：回到同一解释卡并续跑一次", () => {
  it("onAfterSave → 卡片 loading 可见 → 同一选区出结果；一次性消费", async () => {
    // 首个请求在 provider 解析期即失败（未到 explainSelection），续跑是首次解释调用
    await openCardInError("传递信息的工具", new Error(MISSING_PROVIDER_KEY_MESSAGE));
    dispatchActionClick("setup");
    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    const [, session] = capturedSetupSession();

    // 保存成功后 provider 解析恢复默认成功；续跑请求先挂起，断言生成状态可见
    let resolveResume: (text: string) => void = () => {};
    aiMock.explainSelection.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveResume = resolve; })
    );
    session.onAfterSave();

    await vi.waitFor(() => expect(aiMock.explainSelection).toHaveBeenCalledTimes(1));
    // 用户能看到生成状态：同一卡片进入 loading 态
    await vi.waitFor(() =>
      expect(explainCard().querySelector(".biliscript-reading-explain-card-state")?.textContent).toContain("正在解释")
    );
    expect(explainCard().querySelector(".biliscript-reading-explain-card-quote")?.textContent).toBe("传递信息的工具");

    // 续跑请求入参 = 原选区/整句/时刻/下标（同一解释任务）
    const args = aiMock.explainSelection.mock.calls[0][0];
    expect(args.selection).toBe("传递信息的工具");
    expect(args.line).toBe("我们习惯将其视为传递信息的工具");
    expect(args.from).toBe(10);
    expect(args.index).toBe(1);

    resolveResume("配置后续跑的解释。");
    await vi.waitFor(() =>
      expect(explainCard().querySelector(".biliscript-reading-explain-card-answer")?.textContent).toContain("配置后续跑的解释。")
    );

    // 一次性：重复 onAfterSave（重复保存）不再发起第二轮
    session.onAfterSave();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(aiMock.explainSelection).toHaveBeenCalledTimes(1);
  });
});

describe("取消配置：保留原错误与再次进入设置的入口", () => {
  it("onSessionEnd 清意图 → 不续跑；卡片 error 与「去设置」原样保留", async () => {
    await openCardInError("传递信息的工具", new Error(NO_ACTIVE_PROVIDER_MESSAGE));
    dispatchActionClick("setup");
    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    const [, session] = capturedSetupSession();
    expect(resumeLeaf.peekExplainSetupResumeIntent()).not.toBeNull();

    // 取消编辑：会话结束回调清意图（保存回调不会随取消触发，这里兜底连发也不续跑）
    session.onSessionEnd();
    expect(resumeLeaf.peekExplainSetupResumeIntent()).toBeNull();
    session.onAfterSave();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(aiMock.explainSelection).not.toHaveBeenCalled();

    // 原错误与再次进入设置的入口保留
    expect(explainCard().querySelector(".biliscript-reading-explain-card-state.is-error")?.textContent).toContain(
      NO_ACTIVE_PROVIDER_MESSAGE
    );
    expect(cardAction("setup")).not.toBeNull();
  });
});

describe("续跑意图失效：关卡片 / 换选区 / 换视频后旧意图不续跑", () => {
  it("关闭卡片后保存成功：不续跑", async () => {
    await openCardInError("工具", new Error(MISSING_PROVIDER_KEY_MESSAGE));
    dispatchActionClick("setup");
    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    const [, session] = capturedSetupSession();

    dispatchActionClick("close");
    await vi.waitFor(() => expect(reader.isReaderExplainCardOpen()).toBe(false));
    expect(resumeLeaf.peekExplainSetupResumeIntent()).toBeNull();

    session.onAfterSave();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(aiMock.explainSelection).not.toHaveBeenCalled();
  });

  it("换选区新开卡后保存成功：旧意图作废，新卡在飞请求不被旧回执/旧意图覆盖", async () => {
    await openCardInError("传递信息的工具", new Error(MISSING_PROVIDER_KEY_MESSAGE));
    dispatchActionClick("setup");
    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    const [, session] = capturedSetupSession();

    // 关闭旧卡、换新选区开新卡（新请求挂起）
    dispatchActionClick("close");
    await vi.waitFor(() => expect(reader.isReaderExplainCardOpen()).toBe(false));
    let resolveNew: (text: string) => void = () => {};
    aiMock.explainSelection.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveNew = resolve; })
    );
    selectInItem(0, "第一句话");
    explainBtn().click();
    await vi.waitFor(() => expect(aiMock.explainSelection).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(explainCard().querySelector(".biliscript-reading-explain-card-quote")?.textContent).toBe("第一句话")
    );

    // 旧卡的保存成功回执此时到达：意图已随关卡片作废，不得覆盖新卡
    session.onAfterSave();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(aiMock.explainSelection).toHaveBeenCalledTimes(1);

    resolveNew("新选区的解释。");
    await vi.waitFor(() =>
      expect(explainCard().querySelector(".biliscript-reading-explain-card-answer")?.textContent).toContain("新选区的解释。")
    );
  });

  it("换视频后保存成功：视频身份不一致，不续跑", async () => {
    await openCardInError("工具", new Error(NO_ACTIVE_PROVIDER_MESSAGE));
    dispatchActionClick("setup");
    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    const [, session] = capturedSetupSession();

    state.clip.bvid = "BV1other00000";
    session.onAfterSave();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(aiMock.explainSelection).not.toHaveBeenCalled();
    // 卡片仍在（开着），错误原样
    expect(reader.isReaderExplainCardOpen()).toBe(true);
    expect(cardAction("setup")).not.toBeNull();
  });
});
