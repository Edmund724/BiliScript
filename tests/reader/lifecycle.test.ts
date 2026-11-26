import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mockPlayerRects, mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import { READER_READY_ATTR } from "../../extension/reader/presentation-fields.js";
import type { TestState } from "./reader-test-env.js";

let state: TestState;
let transitionReaderShell: typeof import("../../extension/core/state.js").transitionReaderShell;
let shell: typeof import("../../extension/reader/index.js");
let ids: typeof import("../../extension/reader/state.js").ids;
let impl: typeof shell;
let scriptHost: typeof import("../../extension/reader/script-host.js");

vi.mock("../../extension/reader/script-host.js", async (importActual) => {
  const actual = await importActual() as typeof import("../../extension/reader/script-host.js");
  return {
    ...actual,
    openScriptHost: vi.fn(actual.openScriptHost),
    closeScriptHost: vi.fn(actual.closeScriptHost)
  };
});

async function loadReaderModules() {
  setLocationUrl(READER_MODE_URL);
  const stateMod = await import("../../extension/core/state.js");
  state = stateMod.state as TestState;
  transitionReaderShell = stateMod.transitionReaderShell;
  shell = await import("../../extension/reader/index.js");
  ids = (await import("../../extension/reader/state.js")).ids;
  scriptHost = await import("../../extension/reader/script-host.js");
  impl = shell;
  return { state, shell, ids };
}

function syncRunning() {
  const video = document.querySelector("video");
  return Boolean((video as HTMLVideoElement | null)?.__biliscriptReadingSyncController);
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  await loadReaderModules();
  mountReaderSkeleton(ids);
  mountPlayerChain();
  mockPlayerRects();
});

afterEach(() => {
  try {
    impl.stopReadingViewSync();
  } catch {
  }
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("reader 生命周期", () => {
  it("进入阅读模式：打开视图、写 data 属性、渲染字幕列表并打开 script-host", async () => {
    state.clip.title = "测试视频";
    state.clip.author = "up主";
    state.clip.chapters = [
      { title: "开场", from: 0 },
      { title: "正片", from: 30 }
    ];
    state.clip.subtitleBody = [
      { from: 0, to: 10, content: "大家好" },
      { from: 10, to: 30, content: "今天讲测试" }
    ];
    const enteredVideo = document.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(enteredVideo, "duration", { value: 120, configurable: true });

    await shell.enterReaderMode();

    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    expect(state.reader.readingViewOpen).toBe(true);
    expect(readingView.classList.contains("open")).toBe(true);
    expect(readingView.classList.contains("reader-page")).toBe(true);
    expect(readingView.getAttribute("aria-hidden")).toBe("false");
    expect(document.body.getAttribute("data-biliscript-reading-active")).toBe("1");

    document.documentElement.setAttribute("data-biliscript-reader-mode", "1");
    document.body.setAttribute("data-biliscript-reader-mode", "1");
    expect(document.documentElement.getAttribute("data-biliscript-reader-mode")).toBe("1");
    expect(document.body.getAttribute("data-biliscript-reader-mode")).toBe("1");

    const chapterButtons = readingView.querySelectorAll(".biliscript-reading-chapter") as NodeListOf<HTMLElement>;
    expect(chapterButtons.length).toBe(0);

    const subtitleItems = readingView.querySelectorAll(".biliscript-reading-item") as NodeListOf<HTMLElement>;
    expect(subtitleItems.length).toBe(2);
    expect(subtitleItems[1].dataset.seconds).toBe("10");
    expect(subtitleItems[1].textContent).toContain("今天讲测试");

    expect(state.reader.readingViewReady).toBe(true);
    expect(readingView.getAttribute(READER_READY_ATTR)).toBe("1");
    expect(readingView.getAttribute("aria-busy")).toBe("false");

    expect(scriptHost.openScriptHost).toHaveBeenCalledTimes(1);

    shell.closeReadingView();
    expect(scriptHost.closeScriptHost).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  it("页内文摘按钮打开：按钮摘除后聚焦当前标签，关闭归还到新补回的按钮", async () => {
    state.clip.bvid = "BV1test000000";
    const source = document.createElement("button");
    source.id = "biliscript-script-button";
    document.body.appendChild(source);
    source.focus();
    const activeTab = document.getElementById(ids.readingTabSubtitle) as HTMLButtonElement;
    const focusSpy = vi.spyOn(activeTab, "focus");

    const entering = shell.enterReaderMode();
    source.remove();
    await entering;

    expect(document.activeElement).toBe(activeTab);
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });

    const replacement = document.createElement("button");
    replacement.id = "biliscript-script-button";
    shell.closeReadingView();
    document.body.appendChild(replacement);
    shell.restoreReadingViewFocus();

    expect(document.activeElement).toBe(replacement);
  });

  it("有效触发来源仍在场：关闭后以防滚动方式归还；外点后不抢焦", async () => {
    state.clip.bvid = "BV1test000000";
    const source = document.createElement("button");
    document.body.appendChild(source);
    source.focus();
    const returnFocusSpy = vi.spyOn(source, "focus");

    await shell.enterReaderMode();
    shell.closeReadingView();
    shell.restoreReadingViewFocus();

    expect(document.activeElement).toBe(source);
    expect(returnFocusSpy).toHaveBeenCalledWith({ preventScroll: true });

    source.focus();
    await shell.enterReaderMode();
    shell.beginClosingReadingView();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    shell.closeReadingView();
    shell.restoreReadingViewFocus();

    expect(document.activeElement).toBe(outside);
  });

  it("beginClosingReadingView({ preserveFocusRestore: true }) 在节点提前失焦归位后仍保留返回焦点", async () => {
    state.clip.bvid = "BV1test000000";
    const source = document.createElement("button");
    document.body.appendChild(source);
    source.focus();

    await shell.enterReaderMode();
    const activeEl = document.activeElement as HTMLElement;
    activeEl.blur();
    expect(document.activeElement).toBe(document.body);

    shell.beginClosingReadingView({ preserveFocusRestore: true });
    shell.closeReadingView();
    shell.restoreReadingViewFocus();

    expect(document.activeElement).toBe(source);
  });

  it("URL 等无可靠来源：打开聚焦当前标签，无新按钮时关闭聚焦安全宿主", async () => {
    state.clip.bvid = "BV1test000000";
    expect(document.activeElement).toBe(document.body);

    await shell.enterReaderMode();

    expect(document.activeElement).toBe(document.getElementById(ids.readingTabSubtitle));
    shell.closeReadingView();
    shell.restoreReadingViewFocus();

    const root = document.getElementById(ids.root) as HTMLElement;
    expect(document.activeElement).toBe(root);
    expect(root.tabIndex).toBe(-1);
  });

  it("关闭后移动进度再重开（字幕已缓存）：进入即定位到新进度并启动同步", async () => {
    state.clip.bvid = "BV1test000000";
    const body = [];
    for (let i = 0; i < 400; i += 1) {
      body.push({ from: i * 2, to: i * 2 + 1.9, content: `字幕第${i}条` });
    }
    state.clip.subtitleBody = body;

    const video = document.querySelector("video") as HTMLVideoElement;
    video.currentTime = 0;
    await shell.enterReaderMode();
    shell.closeReadingView();

    video.currentTime = 600;

    const list = document.getElementById(ids.readingSubtitleList) as HTMLElement;
    Object.defineProperty(list, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(list, "scrollHeight", { value: 1200, configurable: true });
    const listScrollSpy = vi.fn();
    list.scrollTo = listScrollSpy;
    const elementScrollSpy = vi.fn();
    Element.prototype.scrollIntoView = elementScrollSpy;
    const windowScrollSpy = vi.fn();
    window.scrollTo = windowScrollSpy;

    await shell.enterReaderMode();

    const active = document.querySelector(".biliscript-reading-item.is-active") as HTMLElement;
    expect(active?.dataset.index).toBe("300");
    expect(state.reader.readingActiveSubtitleIndex).toBe(300);
    expect(elementScrollSpy.mock.calls.length + listScrollSpy.mock.calls.length).toBeGreaterThan(0);
    expect(windowScrollSpy).not.toHaveBeenCalled();
    expect(syncRunning()).toBe(true);

    shell.closeReadingView();
  });

  it("退出阅读模式：清空 data 属性、关闭视图、停止同步", async () => {
    state.clip.chapters = [
      { title: "开场", from: 0 },
      { title: "正片", from: 30 }
    ];
    state.clip.subtitleBody = [
      { from: 0, to: 10, content: "大家好" },
      { from: 10, to: 30, content: "今天讲测试" }
    ];

    await shell.enterReaderMode();

    const video = document.querySelector("video") as HTMLVideoElement;
    expect(syncRunning()).toBe(true);
    state.reader.setSettingsExpanded(true);
    const { confirmDialogWithResult, isConfirmDialogOpen } = await import("../../extension/ui/confirm-dialog.js");
    const pendingConfirmation = confirmDialogWithResult({ message: "等待授权" });
    expect(isConfirmDialogOpen()).toBe(true);

    shell.closeReadingView();

    await expect(pendingConfirmation).resolves.toBe("view-destroyed");
    expect(isConfirmDialogOpen()).toBe(false);
    expect(document.querySelector(".confirm-dialog-host")).toBeNull();
    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    expect(state.reader.readingViewOpen).toBe(false);
    expect(state.reader.readingSettingsExpanded).toBe(false);
    expect(document.getElementById(ids.readingSettingsPanel)?.hidden).toBe(true);
    expect(readingView.classList.contains("open")).toBe(false);
    expect(readingView.hidden).toBe(true);
    expect(readingView.inert).toBe(false);
    expect(readingView.hasAttribute("inert")).toBe(false);
    expect(readingView.getAttribute("aria-hidden")).toBe("true");
    expect(readingView.getAttribute(READER_READY_ATTR)).toBe("0");
    expect(document.body.getAttribute("data-biliscript-reading-active")).toBe(null);
    expect(document.documentElement.getAttribute("data-biliscript-reader-mode")).toBe(null);
    expect(document.documentElement.getAttribute("data-biliscript-reader-theme")).toBe(null);
    expect(document.body.getAttribute("data-biliscript-reader-theme")).toBe(null);

    expect(syncRunning()).toBe(false);
    expect(video.__biliscriptReadingSyncController).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  it("关闭过渡与收尾：beginClosing 移出焦点并保持 hidden=false，closeReadingView 后设 hidden=true 并解除 inert", async () => {
    state.clip.bvid = "BV1test000000";
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "大家好" }];
    await shell.enterReaderMode();

    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    expect(readingView.hidden).toBe(false);
    expect(readingView.hasAttribute("inert")).toBe(false);
    expect(readingView.contains(document.activeElement)).toBe(true);

    const wasOpen = shell.beginClosingReadingView();
    expect(wasOpen).toBe(true);
    expect(readingView.contains(document.activeElement)).toBe(false);
    expect(readingView.hidden).toBe(false);
    expect(readingView.inert).toBe(true);
    expect(readingView.hasAttribute("inert")).toBe(true);
    expect(readingView.getAttribute("aria-hidden")).toBe("true");

    shell.closeReadingView();
    expect(readingView.hidden).toBe(true);
    expect(readingView.inert).toBe(false);
    expect(readingView.hasAttribute("inert")).toBe(false);
  });

  it("字幕缓存属上一个视频（bvid 与当前地址不符）：进入阅读模式触发后台重抓", async () => {
    const readerBus = await import("../../extension/reader/reader-bus.js");
    const refreshSpy = vi.fn(() => Promise.resolve());
    readerBus.subscribeSubtitleRefresh(refreshSpy);
    const video = document.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { value: 120, configurable: true });

    state.clip.bvid = "BV1oldVideoA";
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "旧视频字幕" }];

    await shell.enterReaderMode();

    await vi.waitFor(() => {
      expect(refreshSpy).toHaveBeenCalled();
    });
    shell.closeReadingView();
  });

  it("字幕缓存与当前地址同 bvid：进入阅读模式不触发后台重抓", async () => {
    const readerBus = await import("../../extension/reader/reader-bus.js");
    const refreshSpy = vi.fn(() => Promise.resolve());
    readerBus.subscribeSubtitleRefresh(refreshSpy);

    state.clip.bvid = "BV1test000000";
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "当前视频字幕" }];

    await shell.enterReaderMode();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(refreshSpy).not.toHaveBeenCalled();
    shell.closeReadingView();
  });

  it("工具条相位订阅随 reader 装配绑定，无需壳侧再次触发", async () => {
    transitionReaderShell("open");
    const select = document.createElement("select");
    select.id = ids.readingSubtitleSelect;
    document.body.appendChild(select);
    shell.renderReadingView();

    const customSelect = await import("../../extension/ui/custom-select.js");
    const statusBus = await import("../../extension/shared/subtitle-status-bus.js");
    const rebuild = vi.spyOn(customSelect, "rebuildCustomSelectOptions");
    statusBus.publishSubtitleStatusPhase("asr-transcribing");

    expect(rebuild).toHaveBeenCalled();
  });

  describe("字幕就绪副作用单一收口（arch-review-batch3/01）", () => {
    it("subtitle-ready 通知：驱动全量副作用（重投影 + 播放同步 + 双语装载）", async () => {
      state.clip.bvid = "BV1test000000";
      state.clip.subtitleBody = [
        { from: 0, to: 5, content: "第一句字幕" },
        { from: 5, to: 10, content: "第二句字幕" }
      ];
      await shell.enterReaderMode();

      shell.handleReaderPresenterNotification({ kind: "subtitle-ready" });

      const items = document.querySelectorAll(".biliscript-reading-item");
      expect(items.length).toBe(2);
      expect(syncRunning()).toBe(true);

      shell.closeReadingView();
    });

    it("抓取落定对账：纯幂等重投影与条件触发，不重启双语装载", async () => {
      state.clip.bvid = "BV1test000000";
      state.clip.subtitleBody = [
        { from: 0, to: 5, content: "对账重投影字幕" }
      ];
      await shell.enterReaderMode();

      shell.onReaderSubtitleReady({
        triggerMode: "if-subtitles-present"
      });

      const items = document.querySelectorAll(".biliscript-reading-item");
      expect(items.length).toBe(1);
      expect(items[0].textContent).toContain("对账重投影字幕");

      shell.closeReadingView();
    });

    it("视图未打开时：对账路径整条跳过，subtitle-ready 通知仍执行双语副轨装载（Q1 决议）", async () => {
      const secSubtitle = await import("../../extension/reader/secondary-subtitle.js");
      const secSpy = vi.spyOn(secSubtitle, "ensureSecondarySubtitleForCurrentClip").mockReturnValue({
        kind: "skipped",
        reason: "bilingual-off"
      });
      try {
        expect(state.reader.readingViewOpen).toBe(false);

        shell.onReaderSubtitleReady({ triggerMode: "if-subtitles-present" });
        expect(secSpy).not.toHaveBeenCalled();

        shell.handleReaderPresenterNotification({ kind: "subtitle-ready" });
        expect(secSpy).toHaveBeenCalledTimes(1);
      } finally {
        secSpy.mockRestore();
      }
    });

    it("进入阅读模式：若字幕已在手（如预抓取落定），按偏好确保副轨发起装载", async () => {
      const secSubtitle = await import("../../extension/reader/secondary-subtitle.js");
      const secSpy = vi.spyOn(secSubtitle, "ensureSecondarySubtitleForCurrentClip").mockReturnValue({
        kind: "skipped",
        reason: "bilingual-off"
      });
      try {
        state.clip.bvid = "BV1test000000";
        state.clip.subtitleBody = [{ from: 0, to: 5, content: "在手字幕" }];
        await shell.enterReaderMode();
        expect(secSpy).toHaveBeenCalledTimes(1);
        shell.closeReadingView();
      } finally {
        secSpy.mockRestore();
      }
    });
  });

  describe("面板入场动效契约", () => {
    it("enterReaderMode 先写入贴栏/浮层定位再切 .open，确保入场首帧按最终几何起播", async () => {
      state.clip.bvid = "BV1test000000";
      const readingView = document.getElementById(ids.readingView) as HTMLElement;
      readingView.hidden = true;
      let wasHiddenWhenHostOpened: string | boolean = false;
      let hadOpenClassWhenHostOpened = true;
      vi.mocked(scriptHost.openScriptHost).mockImplementationOnce(() => {
        wasHiddenWhenHostOpened = readingView.hidden;
        hadOpenClassWhenHostOpened = readingView.classList.contains("open");
      });

      try {
        await shell.enterReaderMode();

        expect(wasHiddenWhenHostOpened).toBe(true);
        expect(hadOpenClassWhenHostOpened).toBe(false);
        expect(readingView.hidden).toBe(false);
        expect(readingView.classList.contains("open")).toBe(true);
      } finally {
        shell.closeReadingView();
      }
    });

    it("reader.css 与 reader-gate.css 的 @starting-style 位于对应 .open 规则之后且独立声明 allow-discrete", () => {
      const readerCss = readFileSync(join(process.cwd(), "extension/entry/styles/reader.css"), "utf8");
      const openRuleIdx = readerCss.indexOf("#biliscript-reading-view.open {");
      const startingStyleIdx = readerCss.indexOf("@starting-style {\r\n  #biliscript-reading-view.open {");
      const startingStyleIdxLf = readerCss.indexOf("@starting-style {\n  #biliscript-reading-view.open {");
      const pinnedStartingIdx = Math.max(startingStyleIdx, startingStyleIdxLf);

      expect(openRuleIdx).toBeGreaterThan(-1);
      expect(pinnedStartingIdx).toBeGreaterThan(openRuleIdx);
      expect(readerCss.slice(openRuleIdx, pinnedStartingIdx)).toContain("transition-behavior: allow-discrete;");
      expect(readerCss.slice(openRuleIdx, pinnedStartingIdx)).not.toContain("display 320ms allow-discrete");

      const gateCss = readFileSync(join(process.cwd(), "extension/entry/styles/reader-gate.css"), "utf8");
      const floatOpenIdx = gateCss.indexOf(
        'body[data-biliscript-reader-mode="1"] #biliscript-reading-view[data-biliscript-script-float="1"].open {'
      );
      const floatStartingIdx = gateCss.indexOf("@starting-style {", floatOpenIdx);

      expect(floatOpenIdx).toBeGreaterThan(-1);
      expect(floatStartingIdx).toBeGreaterThan(floatOpenIdx);
      expect(gateCss.slice(floatOpenIdx, floatStartingIdx)).toContain("transition-behavior: allow-discrete;");
      expect(gateCss.slice(floatOpenIdx, floatStartingIdx)).not.toContain("display 320ms allow-discrete");
    });
  });
});
