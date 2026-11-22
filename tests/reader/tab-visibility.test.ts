import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

let state: TestState;
let transitionReaderShell: typeof import("../../extension/core/state.js").transitionReaderShell;
let reader: typeof import("../../extension/reader/index.js");
let readerState: typeof import("../../extension/reader/state.js");
let activation: typeof import("../../extension/reader/script-tab-activation.js");
let ids: typeof import("../../extension/reader/state.js").ids;
let uiRenderer: typeof import("../../extension/ui/ui-renderer.js");

async function loadModules() {
  setLocationUrl(READER_MODE_URL);
  const stateMod = await import("../../extension/core/state.js");
  state = stateMod.state as TestState;
  transitionReaderShell = stateMod.transitionReaderShell;
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
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("字幕 tab body 可见性谓词（候选 06）", () => {
  it("A. 真值表：视图开着 + 当前标签为字幕 + 设置抽屉未展开 才为真", () => {
    transitionReaderShell("closed");
    readerState.setReaderActiveScriptTab("subtitle");
    state.reader.setSettingsExpanded(false);
    expect(readerState.isReadingSubtitleBodyVisible(), "视图关着").toBe(false);

    transitionReaderShell("open");
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

    await activation.activateScriptTab("overview");
    expect(readerState.isReadingSubtitleBodyVisible(), "切到概览后谓词").toBe(false);
    expect(domSaysSubtitleBodyVisible(), "切到概览后 DOM").toBe(false);

    await activation.activateScriptTab("subtitle");
    expect(readerState.isReadingSubtitleBodyVisible(), "切回字幕").toBe(true);
    expect(domSaysSubtitleBodyVisible(), "切回字幕 DOM").toBe(true);

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
