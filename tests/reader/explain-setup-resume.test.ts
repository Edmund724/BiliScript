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
  NO_ACTIVE_MODEL_MESSAGE,
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
let setupResume: typeof import("../../extension/reader/setup-resume.js");

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
  setupResume = await import("../../extension/reader/setup-resume.js");
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
  return call as [string, { onAfterSave(): void; onSessionEnd(): void }, { providerId?: string } | undefined];
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

describe("设置协调（reader/setup-resume · explain scope）：单槽与失效语义", () => {
  it("保存有效时仅触发一次恢复；invalidateReaderSetupFlows 作废并发出 cancel", async () => {
    const onResume = vi.fn();
    const onCancel = vi.fn();
    await setupResume.beginReaderAiSetupFlow({
      scope: "explain",
      errorClass: "missing-key",
      isStillValid: () => true,
      onResume,
      onCancel
    });
    const [errorClass, session] = capturedSetupSession();
    expect(errorClass).toBe("missing-key");

    session.onAfterSave();
    session.onAfterSave();
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();

    const onResume2 = vi.fn();
    const onCancel2 = vi.fn();
    await setupResume.beginReaderAiSetupFlow({
      scope: "explain",
      errorClass: "no-provider",
      isStillValid: () => true,
      onResume: onResume2,
      onCancel: onCancel2
    });
    const [, session2] = capturedSetupSession();
    setupResume.invalidateReaderSetupFlows("explain");
    session2.onAfterSave();
    expect(onResume2).not.toHaveBeenCalled();
    expect(onCancel2).toHaveBeenCalledWith("invalid");
  });
});

describe("error 态：配置类错误仅给「去设置」，非配置类只给「重试」", () => {
  it("无平台错误：只保留主按钮「去设置」，不显示无效的「重试」和「去对话追问」", async () => {
    await openCardInError("工具", new Error(NO_ACTIVE_PROVIDER_MESSAGE));
    const setup = cardAction("setup");
    expect(setup).not.toBeNull();
    expect(setup?.textContent).toContain("去设置");
    expect(setup?.classList.contains("is-primary")).toBe(true);
    expect(cardAction("retry")).toBeNull();
    expect(cardAction("ask-chat")).toBeNull();
  });

  it("缺 Key 错误：仅给「去设置」", async () => {
    await openCardInError("工具", new Error(MISSING_PROVIDER_KEY_MESSAGE));
    expect(cardAction("setup")).not.toBeNull();
    expect(cardAction("retry")).toBeNull();
    expect(cardAction("ask-chat")).toBeNull();
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

describe("「去设置」：直接进入平台编辑并携带一次性恢复回调", () => {
  it("点击去设置：直达 openReaderAiSetup 并附带 onAfterSave / onSessionEnd", async () => {
    await openCardInError("传递信息的工具", new Error(NO_ACTIVE_PROVIDER_MESSAGE));
    dispatchActionClick("setup");

    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    const [errorClass, session] = capturedSetupSession();
    expect(errorClass).toBe("no-provider");
    expect(typeof session.onAfterSave).toBe("function");
    expect(typeof session.onSessionEnd).toBe("function");
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
  it("onSessionEnd 作废续跑 → 不续跑；卡片 error 与「去设置」原样保留", async () => {
    await openCardInError("传递信息的工具", new Error(NO_ACTIVE_PROVIDER_MESSAGE));
    dispatchActionClick("setup");
    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    const [, session] = capturedSetupSession();

    // 取消编辑：会话结束回调作废续跑（保存回调不会随取消触发，这里兜底连发也不续跑）
    session.onSessionEnd();
    session.onAfterSave();
    await Promise.resolve();
    await Promise.resolve();
    expect(aiMock.explainSelection).not.toHaveBeenCalled();

    // 原错误与再次进入设置的入口保留
    expect(explainCard().querySelector(".biliscript-reading-explain-card-state.is-error")?.textContent).toContain(
      NO_ACTIVE_PROVIDER_MESSAGE
    );
    expect(cardAction("setup")).not.toBeNull();
  });
});

describe("续跑失效：关卡片 / 换选区 / 换视频后旧会话不续跑", () => {
  it("关闭卡片后保存成功：不续跑", async () => {
    await openCardInError("工具", new Error(MISSING_PROVIDER_KEY_MESSAGE));
    dispatchActionClick("setup");
    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    const [, session] = capturedSetupSession();

    dispatchActionClick("close");
    await vi.waitFor(() => expect(reader.isReaderExplainCardOpen()).toBe(false));

    session.onAfterSave();
    await Promise.resolve();
    await Promise.resolve();
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

describe("缺模型引导、防连点代次保护与保存后焦点不盗抢", () => {
  it("resolveEditableAiProviderId 优先命中 defaultModel 启用平台，否则回落首个启用平台", async () => {
    const { callbackStyleSendMessage } = await import("../helpers/chrome-runtime-host.js");
    (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = callbackStyleSendMessage({
      "ai-providers-list": () => ({
        ok: true,
        providers: [
          { id: "p-disabled", enabled: false, models: [] },
          { id: "p1", enabled: true, models: [] },
          { id: "p2", enabled: true, models: [] }
        ]
      }),
      "get-settings": () => ({ ok: true, settings: { defaultModel: "p2" } })
    });
    const { resolveEditableAiProviderId } = await vi.importActual<
      typeof import("../../extension/ui/settings-panel.js")
    >("../../extension/ui/settings-panel.js");
    await expect(resolveEditableAiProviderId()).resolves.toBe("p2");
  });

  it("缺模型错误：渲染「去设置」，直接透传 no-model（不改写为 missing-key）", async () => {
    await openCardInError("工具", new Error(NO_ACTIVE_MODEL_MESSAGE));
    expect(cardAction("setup")).not.toBeNull();
    dispatchActionClick("setup");

    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    const [errorClass, session, target] = capturedSetupSession();
    expect(errorClass).toBe("no-model");
    expect(target).toBeUndefined();

    session.onAfterSave();
    await vi.waitFor(() => expect(aiMock.explainSelection).toHaveBeenCalledTimes(1));
  });

  it("快速双击去设置只打开一次 & 旧会话 onSessionEnd 不误清最新流程", async () => {
    let resolveFirst!: () => void;
    setupMock.openReaderAiSetup.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        })
    );
    await openCardInError("工具", new Error(NO_ACTIVE_PROVIDER_MESSAGE));
    dispatchActionClick("setup");
    dispatchActionClick("setup");
    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    const [, session1] = capturedSetupSession();
    resolveFirst();
    await Promise.resolve();
    await Promise.resolve();

    dispatchActionClick("setup");
    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(2));
    const [, session2] = capturedSetupSession();

    session1.onSessionEnd();
    session2.onAfterSave();
    await vi.waitFor(() => expect(aiMock.explainSelection).toHaveBeenCalledTimes(1));
  });

  it("保存续跑后关闭设置抽屉：焦点留在解释卡对话框，不被抢回字幕 Tab 按钮", async () => {
    await openCardInError("传递信息的工具", new Error(MISSING_PROVIDER_KEY_MESSAGE));
    const { openReaderSettingsMode } = await import("../../extension/reader/settings-mode.js");
    // 原触发按钮在设置期间被卡片重建卸载（模拟 returnTarget.isConnected === false）
    dispatchActionClick("setup");
    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    const [, session] = capturedSetupSession();
    openReaderSettingsMode();
    expect(state.reader.readingSettingsExpanded).toBe(true);

    let resolveResume: (text: string) => void = () => {};
    aiMock.explainSelection.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveResume = resolve; })
    );
    session.onAfterSave();

    await vi.waitFor(() => expect(aiMock.explainSelection).toHaveBeenCalledTimes(1));
    expect(state.reader.readingSettingsExpanded).toBe(false);
    const dialog = explainCard().querySelector<HTMLElement>(".biliscript-reading-explain-card-dialog");
    expect(dialog).not.toBeNull();
    expect(document.activeElement).toBe(dialog);
    resolveResume("已恢复。");
  });
});

