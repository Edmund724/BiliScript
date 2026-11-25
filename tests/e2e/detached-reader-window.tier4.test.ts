import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { READER_MODE_URL } from "../setup.js";
import {
  assertMirroredStylesWithoutExtensionLinks,
  assertStyleLinksPresent,
  assertZeroUnwrappedScrollbars,
  clearWinSelection,
  clickResetAndSettle,
  dispatchEscapeInDoc,
  getFirstSubtitleItem,
  getMirroredStyleHrefs,
  openCommandPaletteInDoc,
  openExplainCardFromSelection,
  openQuoteShareModalInDoc,
  setSettingsRangeValue,
  triggerPlayerAiQuickAction
} from "./helpers/detached-assertions.js";
import {
  EXPECTED_BOUNDS_KEY,
  EXPECTED_DETACH_BTN_ID,
  loadActiveHostContract,
  loadShellContract
} from "./helpers/detached-contracts.js";
import {
  bootBilibiliVideoPage,
  switchDetachedModeInSettings,
  warmDetachedE2eRuntime,
  type BootOptions,
  type DetachedE2EHarness
} from "./helpers/detached-e2e-harness.js";

let activeHarness: DetachedE2EHarness | null = null;

beforeAll(async () => {
  await warmDetachedE2eRuntime();
}, 30000);

async function bootHarness(options: BootOptions = {}): Promise<DetachedE2EHarness> {
  const harness = await bootBilibiliVideoPage(options);
  activeHarness = harness;
  return harness;
}

afterEach(async () => {
  await activeHarness?.cleanup();
  activeHarness = null;
});
describe("Tier 4: Real-World Application Scenarios", () => {
  it("T4-01: binge-watching across multiple clips and parts in detached pip", async () => {
    const h = await bootHarness();
    const activeHost = await loadActiveHostContract();
    await h.openReaderInPage();
    const childWin = await h.detachReader();
    await h.triggerSpaNavigation("https://www.bilibili.com/video/BV1test000000/?p=2", {
      bvid: "BV1test000000",
      cid: "2002",
      subtitleText: "第二P精彩内容"
    });
    await h.triggerSpaNavigation("https://www.bilibili.com/video/BV1bingeNext03/", {
      bvid: "BV1bingeNext03",
      cid: "3003",
      subtitleText: "推荐连播新视频"
    });
    expect(childWin.closed).toBe(false);
    expect(activeHost.isReaderDetached()).toBe(true);
    expect(childWin.document.getElementById("biliscript-reading-subtitle")?.textContent).toContain("推荐连播新视频");
    expect(h.fakePlatform.pipRequests).toHaveLength(1);
  });

  it("T4-02: active study note-taking (explain card + quote share + timestamp seek without opener focus theft)", async () => {
    const h = await bootHarness();
    await h.openReaderInPage();
    const childWin = await h.detachReader();
    const card = await openExplainCardFromSelection(h, childWin.document, childWin);
    expect(card?.hidden).toBe(false);
    await dispatchEscapeInDoc(h, childWin.document);
    const quoteDialog = await openQuoteShareModalInDoc(h, childWin.document);
    expect(quoteDialog).not.toBeNull();
    await dispatchEscapeInDoc(h, childWin.document);
    clearWinSelection(childWin);
    h.openerFocusSpy.mockClear();
    childWin.focus.mockClear();
    getFirstSubtitleItem(childWin.document, 2)?.click();
    await h.flushTimersAndMicrotasks(40);
    expect(h.video.currentTime).toBe(90);
    expect(h.openerFocusSpy).not.toHaveBeenCalled();
    expect(childWin.focus).toHaveBeenCalled();
  });

  it("T4-03: multi-device sync vs laptop 720p / monitor 1440p local resize + full preference reset", async () => {
    const hLaptop = await bootHarness({ availHeight: 720, sync: { detachedWindowMode: "pip" } });
    await hLaptop.openReaderInPage();
    const laptopWin = await hLaptop.detachReader();
    expect(hLaptop.fakePlatform.pipRequests[0]).toMatchObject({ width: 540, height: 576 });
    laptopWin.simulateResize(480, 620);
    await hLaptop.flushTimersAndMicrotasks(500);
    expect(hLaptop.storage.localMap.get(EXPECTED_BOUNDS_KEY)).toEqual({ width: 480, height: 620 });
    await hLaptop.cleanup();
    const hDesktop = await bootHarness({ availHeight: 1440, sync: { detachedWindowMode: "popup" } });
    await hDesktop.openReaderInPage();
    await hDesktop.detachReader();
    expect(hDesktop.fakePlatform.openCalls[0].features).toContain("width=540");
    expect(hDesktop.fakePlatform.openCalls[0].features).toContain("height=760");
    const doc = await hDesktop.openSettingsInActiveHost();
    await clickResetAndSettle(hDesktop, doc, true);
    expect(hDesktop.storage.syncMap.get("detachedWindowMode")).toBe("pip");
    expect(hDesktop.storage.localMap.has(EXPECTED_BOUNDS_KEY)).toBe(false);
  });

  it("T4-04: Firefox-like environment without PiP falls back to popup, mirrors moz-extension CSS, and redocks on OS close", async () => {
    const h = await bootHarness({
      extensionBaseUrl: "moz-extension://fx-profile-153/",
      pipMode: "unsupported"
    });
    await h.openReaderInPage();
    const childWin = await h.detachReader();
    assertMirroredStylesWithoutExtensionLinks(childWin.document);
    assertZeroUnwrappedScrollbars(["extension/entry/styles/reader.css"]);
    childWin.simulateUserClose();
    await h.flushTimersAndMicrotasks(450);
    expect(getMirroredStyleHrefs(childWin.document)).toHaveLength(0);
    const view = document.getElementById("biliscript-reading-view");
    expect(view?.hidden).toBe(false);
    expect(view?.classList.contains("open")).toBe(true);
    expect((document.getElementById(EXPECTED_DETACH_BTN_ID) as HTMLButtonElement).hidden).toBe(false);
    expect((document.getElementById("biliscript-reading-close-btn") as HTMLButtonElement).hidden).toBe(false);
  });

  it("T4-05: live AI chat session across detach -> lazy CSS mirror -> theme/typography tweak -> redock preserving draft", async () => {
    const h = await bootHarness({ sync: { readerTheme: "light" } });
    await h.openReaderInPage();
    await h.switchTabInActiveHost("chat");
    (document.getElementById("biliscript-reading-chat-input") as HTMLTextAreaElement).value = "连续会话草稿内容";
    const childWin = await h.detachReader();
    assertStyleLinksPresent(childWin.document, ["reader-chat.css", "github-markdown.css"]);
    await h.clickHeaderThemeInActiveHost();
    await h.openSettingsInActiveHost();
    childWin.document.getElementById("openAppearanceBtn")?.click();
    await h.flushTimersAndMicrotasks(60);
    await setSettingsRangeValue(h, childWin.document, "chatLineHeight", 160);
    await h.redockReader();
    expect(document.documentElement.dataset.biliscriptReaderTheme).toBe("dark");
    expect((document.getElementById("biliscript-reading-chat-input") as HTMLTextAreaElement).value).toBe("连续会话草稿内容");
    expect(
      document.getElementById("biliscript-reading-view")?.style.getPropertyValue("--biliscript-chat-line-height")
    ).toBe("1.6");
  });

  it("T4-06: live mode switching pip -> popup allowed, then popup -> pip blocked notice -> reopen applies pip", async () => {
    const h = await bootHarness({ pipMode: "allow", popupMode: "allow" });
    await h.openReaderInPage();
    const pipWin = await h.detachReader();
    await switchDetachedModeInSettings(h, "popup");
    const popupWin = h.fakePlatform.getCurrentActiveChild()!;
    expect(pipWin.closed).toBe(true);
    expect(popupWin).not.toBe(pipWin);
    h.fakePlatform.setPipMode("reject");
    h.fakePlatform.setPopupMode("blocked");
    await switchDetachedModeInSettings(h, "pip");
    expect(popupWin.closed).toBe(false);
    expect(h.storage.syncMap.get("detachedWindowMode")).toBe("pip");
    await h.clickHeaderCloseInActiveHost();
    h.fakePlatform.setPipMode("allow");
    h.fakePlatform.setPopupMode("allow");
    await h.openReaderInPage();
    const reopenedPip = await h.detachReader();
    expect(reopenedPip).not.toBe(popupWin);
    expect(h.fakePlatform.pipRequests).toHaveLength(3);
  });

  it("T4-07: webpage fullscreen plus Quick AI prompt routing from player control bar", async () => {
    const h = await bootHarness();
    await h.openReaderInPage();
    const childWin = await h.detachReader();
    await h.toggleWebpageFullscreen(true);
    childWin.focus.mockClear();
    await triggerPlayerAiQuickAction(h, "全屏状态下的视频总结");
    expect(childWin.closed).toBe(false);
    expect(childWin.focus).toHaveBeenCalled();
    expect(childWin.document.getElementById("biliscript-reading-tab-chat")?.classList.contains("is-active")).toBe(true);
  });

  it("T4-08: keyboard-centric control (reader-enter focus, Ctrl+K palette, Esc, Alt+B close, reopen in-page)", async () => {
    const h = await bootHarness();
    await h.openReaderInPage();
    const childWin = await h.detachReader();
    childWin.focus.mockClear();
    await h.dispatchMessage({ type: "reader-enter", readerUrl: READER_MODE_URL });
    expect(childWin.focus).toHaveBeenCalled();
    const palette = await openCommandPaletteInDoc(h, childWin.document);
    expect(palette).not.toBeNull();
    await dispatchEscapeInDoc(h, childWin.document);
    const closedPalette = childWin.document.getElementById("biliscript-command-palette") as HTMLDialogElement | null;
    expect(Boolean(closedPalette?.open || closedPalette?.hasAttribute("open"))).toBe(false);
    await h.dispatchMessage({ type: "reader-toggle", readerUrl: READER_MODE_URL });
    await h.flushTimersAndMicrotasks(450);
    expect(childWin.closed).toBe(true);
    await h.dispatchMessage({ type: "reader-toggle", readerUrl: READER_MODE_URL });
    expect(document.getElementById("biliscript-reading-view")?.classList.contains("open")).toBe(true);
  });

  it("T4-09: popup-blocker resilience and narrow-viewport redock into degraded float layout", async () => {
    const h = await bootHarness({
      sync: { detachedWindowMode: "popup" },
      popupMode: "blocked",
      viewportWidth: 900
    });
    await h.openReaderInPage();
    const blocked = await h.attemptDetachReader();
    expect(blocked).toBeNull();
    expect(document.getElementById("biliscript-reading-view")?.getAttribute("data-biliscript-script-float")).toBe("1");
    h.fakePlatform.setPopupMode("allow");
    const popupWin = await h.detachReader();
    expect(popupWin.document.getElementById("biliscript-reading-view")?.hasAttribute("data-biliscript-script-float")).toBe(false);
    await h.redockReader();
    expect(document.getElementById("biliscript-reading-view")?.getAttribute("data-biliscript-script-float")).toBe("1");
  });

  it("T4-10: tab-close pagehide cleanup plus reload reader-restore strictly in-page", async () => {
    const h1 = await bootHarness();
    await h1.openReaderInPage();
    const childWin = await h1.detachReader();
    h1.fakePlatform.simulateOpenerPageHide();
    await h1.flushTimersAndMicrotasks(40);
    expect(childWin.closed).toBe(true);
    await h1.cleanup();
    const h2 = await bootHarness({ url: READER_MODE_URL, bootContentScript: true });
    expect(document.getElementById("biliscript-reading-view")?.classList.contains("open")).toBe(true);
    expect(h2.fakePlatform.pipRequests).toHaveLength(0);
    expect(h2.fakePlatform.openCalls).toHaveLength(0);
  });

  it("T4-11: external Bilibili host theme reactivity and presentation sync across detached window", async () => {
    const h = await bootHarness({ sync: { readerTheme: "bilibili", readerPalette: "flyme" } });
    await h.openReaderInPage();
    const childWin = await h.detachReader();
    expect(childWin.document.documentElement.dataset.biliscriptReaderTheme).toBe("light");
    document.documentElement.setAttribute("data-theme", "dark");
    await h.flushTimersAndMicrotasks(80);
    expect(childWin.document.documentElement.dataset.biliscriptReaderTheme).toBe("dark");
    document.documentElement.removeAttribute("data-theme");
    await h.flushTimersAndMicrotasks(80);
    expect(childWin.document.documentElement.dataset.biliscriptReaderTheme).toBe("light");
  });

  it("T4-12: sequential overlay storm in detached window (settings -> custom select -> confirm dialog -> dismiss)", async () => {
    const h = await bootHarness();
    await h.openReaderInPage();
    const childWin = await h.detachReader();
    await h.openSettingsInActiveHost();
    childWin.document.getElementById("openAppearanceBtn")?.click();
    await h.flushTimersAndMicrotasks(60);
    childWin.document.querySelector<HTMLElement>("#biliscriptSettingsSubpageAppearance .custom-select-trigger")?.click();
    await h.flushTimersAndMicrotasks(30);
    childWin.document.body.click();
    await h.flushTimersAndMicrotasks(30);
    const backBtn = childWin.document.getElementById("biliscript-reading-settings-back-btn");
    expect(backBtn).not.toBeNull();
    backBtn?.click();
    await h.flushTimersAndMicrotasks(60);
    await clickResetAndSettle(h, childWin.document, false);
    await dispatchEscapeInDoc(h, childWin.document);
    expect(childWin.closed).toBe(false);
    expect(childWin.document.getElementById("biliscript-reading-settings-panel")?.hidden).toBe(true);
  });

  it("T4-13: rapid detach/redock/SPA/close/reopen transaction serialization preserving single shell root", async () => {
    const h = await bootHarness();
    const shell = await loadShellContract();
    await h.openReaderInPage();
    const rootNode = document.getElementById("biliscript-reading-view");
    const p1 = shell.detachReaderShell();
    const p2 = shell.redockReaderShell();
    const p3 = shell.detachReaderShell();
    await h.flushStyles();
    await h.flushTimersAndMicrotasks(120);
    await Promise.all([p1, p2, p3]);
    await h.triggerSpaNavigation("https://www.bilibili.com/video/BV1stress9999/", {
      bvid: "BV1stress9999",
      cid: "9999",
      subtitleText: "压测切换完成"
    });
    await shell.exitReaderShell();
    await h.flushTimersAndMicrotasks(450);
    expect(h.fakePlatform.getCurrentActiveChild()).toBeNull();
    expect(document.getElementById("biliscript-reading-view")).toBe(rootNode);
    await h.openReaderInPage();
    expect(document.getElementById("biliscript-reading-view")).toBe(rootNode);
    expect(rootNode?.classList.contains("open")).toBe(true);
  });
});
