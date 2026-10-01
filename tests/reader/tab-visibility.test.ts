// 字幕 tab body 可见性谓词（候选 06）：判定输入只取状态位，不反解 DOM class。
//
// 背景：sync 域 250ms tick 需要判定「字幕 tab body 是否可见」以决定是否跳过
// 高亮/滚动段（P3-1）。原实现反解 DOM class——CONTEXT「文摘面板」词条把
// 「反解 DOM class 取当前标签」列为 Avoid。本文件钉住两件事：
//   A. 谓词真值表：视图开关 × 当前标签 × 设置抽屉展开；
//   B. 投影一致锁：谓词（状态侧）与 DOM 投影（CSS 侧）在每次切换后逐一相符
//      ——状态位由标签激活属主 activateScriptTab 单点写、DOM 由它的 project-tab
//      投影命令与 renderReaderPanels 单点写，谓词改读状态位后这条「写方唯一」
//      不变量必须仍成立。
// CSS 源守卫在 tests/entry/reader-tab-body-visibility-css.test.ts。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

let state: TestState;
let reader: typeof import("../../extension/reader/index.js");
let readerState: typeof import("../../extension/reader/state.js");
let activation: typeof import("../../extension/reader/script-tab-activation.js");
let ids: typeof import("../../extension/reader/state.js").ids;
let uiRenderer: typeof import("../../extension/ui/ui-renderer.js");

async function loadModules() {
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  reader = await import("../../extension/reader/index.js");
  readerState = await import("../../extension/reader/state.js");
  activation = await import("../../extension/reader/script-tab-activation.js");
  ids = readerState.ids;
  uiRenderer = await import("../../extension/ui/ui-renderer.js");
}

function subtitleBody() {
  return document.getElementById(ids.readingTabBodySubtitle) as HTMLElement;
}

function settingsPanel() {
  return document.getElementById(ids.readingSettingsPanel) as HTMLElement;
}

// DOM 投影侧的同义判定，逐条对齐 CSS 的三条隐藏通道：body 未 is-active、
// body 带 hidden、设置抽屉展开（兄弟选择器压掉三 tab body）。
function domSaysSubtitleBodyVisible(): boolean {
  return (
    subtitleBody().classList.contains("is-active") &&
    !subtitleBody().hasAttribute("hidden") &&
    settingsPanel().hasAttribute("hidden")
  );
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-biliscript-reader-mode");
  document.body.removeAttribute("data-biliscript-reader-mode");
  await loadModules();
  uiRenderer.ensureUiReady({ forceRecreate: true });
  mountPlayerChain();
});

afterEach(async () => {
  try {
    reader.stopReadingViewSync();
    reader.closeReadingView();
  } catch {
    // ignore
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("字幕 tab body 可见性谓词（候选 06）", () => {
  it("A. 真值表：视图开着 + 当前标签为字幕 + 设置抽屉未展开 才为真", () => {
    state.reader.readingViewOpen = false;
    readerState.setReaderActiveScriptTab("subtitle");
    state.reader.setSettingsExpanded(false);
    expect(readerState.isReadingSubtitleBodyVisible(), "视图关着").toBe(false);

    state.reader.readingViewOpen = true;
    expect(readerState.isReadingSubtitleBodyVisible(), "视图开着 + 字幕 + 抽屉收起").toBe(true);

    readerState.setReaderActiveScriptTab("overview");
    expect(readerState.isReadingSubtitleBodyVisible(), "切到概览").toBe(false);
    readerState.setReaderActiveScriptTab("chat");
    expect(readerState.isReadingSubtitleBodyVisible(), "切到对话").toBe(false);

    readerState.setReaderActiveScriptTab("subtitle");
    state.reader.setSettingsExpanded(true);
    expect(readerState.isReadingSubtitleBodyVisible(), "抽屉展开压掉三 tab body").toBe(false);

    state.reader.setSettingsExpanded(false);
    expect(readerState.isReadingSubtitleBodyVisible(), "抽屉收起回落").toBe(true);
  });

  it("B. 投影一致锁：状态谓词与 DOM 三通道逐次相符", async () => {
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "大家好" }];
    document.documentElement.setAttribute("data-biliscript-reader-mode", "1");
    document.body.setAttribute("data-biliscript-reader-mode", "1");
    await reader.enterReaderMode();

    expect(readerState.isReadingSubtitleBodyVisible(), "打开默认为字幕 tab").toBe(true);
    expect(domSaysSubtitleBodyVisible(), "DOM 同口径").toBe(true);

    // 生产切换路径：属主写状态位 + 投影命令 → DOM（两侧同源）
    await activation.activateScriptTab("overview");
    expect(readerState.isReadingSubtitleBodyVisible(), "切到概览后谓词").toBe(false);
    expect(domSaysSubtitleBodyVisible(), "切到概览后 DOM").toBe(false);

    await activation.activateScriptTab("subtitle");
    expect(readerState.isReadingSubtitleBodyVisible(), "切回字幕").toBe(true);
    expect(domSaysSubtitleBodyVisible(), "切回字幕 DOM").toBe(true);

    // 抽屉通道单独生效：body 仍是 is-active（第一通道没变），可见性由抽屉压掉
    state.reader.setSettingsExpanded(true);
    reader.renderReaderPanels();
    expect(subtitleBody().classList.contains("is-active"), "抽屉展开不改 tab 通道").toBe(true);
    expect(readerState.isReadingSubtitleBodyVisible(), "抽屉展开后谓词").toBe(false);
    expect(domSaysSubtitleBodyVisible(), "抽屉展开后 DOM").toBe(false);

    state.reader.setSettingsExpanded(false);
    reader.renderReaderPanels();
    expect(readerState.isReadingSubtitleBodyVisible(), "抽屉收起后谓词").toBe(true);
    expect(domSaysSubtitleBodyVisible(), "抽屉收起后 DOM").toBe(true);
  });
});
