import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL } from "../setup.js";
import {
  assertHeaderButtonOrder,
  assertStyleLinksPresent,
  assertZeroUnwrappedScrollbars,
  clearWinSelection,
  clickResetAndSettle,
  dispatchEscapeInDoc,
  getFirstSubtitleItem,
  getReadingViewAnchorVars,
  openExplainCardFromSelection,
  openQuoteShareModalInDoc,
  setSettingsCheckboxValue,
  setSettingsRangeValue,
  setSettingsSelectValue,
  triggerPlayerAiQuickAction
} from "./helpers/detached-assertions.js";
import {
  EXPECTED_BOUNDS_KEY,
  EXPECTED_DETACH_BTN_ID,
  loadActiveHostContract
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
describe("Tier 3: Pairwise Feature Interactions", () => {
  it("T3-01: F1 x F6 - pip pop-out updates active host to childDoc/childWin while keeping opener probes", async () => {
    const h = await bootHarness();
    const activeHost = await loadActiveHostContract();
    await h.openReaderInPage();
    const childWin = await h.detachReader();
    expect(activeHost.isReaderDetached()).toBe(true);
    expect(activeHost.getActiveReaderDocument()).toBe(childWin.document);
    expect(activeHost.getOpenerDocument()).toBe(document);
    const { getRuntimeVideoElement } = await import("../../extension/bilibili/video-probe.js");
    expect(getRuntimeVideoElement()).toBe(h.video);
  });

  it("T3-02: F1 x F2 - pip runtime failure silently falls back to popup with shared bounds and single shell root", async () => {
    const h = await bootHarness({
      pipMode: "reject",
      local: { [EXPECTED_BOUNDS_KEY]: { width: 612, height: 788 } }
    });
    await h.openReaderInPage();
    const rootNode = document.getElementById("biliscript-reading-view");
    const childWin = await h.detachReader();
    expect(h.fakePlatform.pipRequests).toHaveLength(1);
    expect(h.fakePlatform.openCalls[0].features).toContain("width=612");
    expect(h.fakePlatform.openCalls[0].features).toContain("height=788");
    expect(childWin.document.getElementById("biliscript-reading-view")).toBe(rootNode);
  });

  it("T3-03: F2 x F5 - starting in popup and switching mode in settings migrates panel into pip cleanly", async () => {
    const h = await bootHarness({ sync: { detachedWindowMode: "popup" } });
    await h.openReaderInPage();
    const popupWin = await h.detachReader();
    await switchDetachedModeInSettings(h, "pip");
    const pipWin = h.fakePlatform.getCurrentActiveChild()!;
    expect(popupWin.closed).toBe(true);
    expect(pipWin).not.toBe(popupWin);
    expect(h.fakePlatform.pipRequests).toHaveLength(1);
    expect(pipWin.document.getElementById("biliscript-reading-view")?.classList.contains("open")).toBe(true);
  });

  it("T3-04: F3 x F4 - child pagehide redocks without firing opener guard; opener pagehide closes active child", async () => {
    const h = await bootHarness();
    await h.openReaderInPage();
    const firstChild = await h.detachReader();
    firstChild.simulateUserClose();
    await h.flushTimersAndMicrotasks(450);
    expect(document.getElementById("biliscript-reading-view")?.hidden).toBe(false);
    expect(document.getElementById("biliscript-reading-view")?.classList.contains("open")).toBe(true);
    const secondChild = await h.detachReader();
    h.fakePlatform.simulateOpenerPageHide();
    await h.flushTimersAndMicrotasks(40);
    expect(secondChild.closed).toBe(true);
  });

  it("T3-05: F4 x F12 x F14 - popup header redock vs pip external redock vs reader-toggle exit serialization", async () => {
    const h = await bootHarness({ sync: { detachedWindowMode: "popup" } });
    await h.openReaderInPage();
    const winA = await h.detachReader();
    winA.document.getElementById(EXPECTED_DETACH_BTN_ID)?.click();
    await h.flushStyles();
    await h.flushTimersAndMicrotasks(60);
    expect(winA.closed).toBe(true);
    expect(document.getElementById("biliscript-reading-view")?.classList.contains("open")).toBe(true);
    await switchDetachedModeInSettings(h, "pip");
    const winB = await h.detachReader();
    winB.simulateUserClose();
    await h.flushTimersAndMicrotasks(80);
    expect(winB.closed).toBe(true);
    expect(document.getElementById("biliscript-reading-view")?.hidden).toBe(false);
    const winC = await h.detachReader();
    await h.dispatchMessage({ type: "reader-toggle", readerUrl: READER_MODE_URL });
    await h.flushTimersAndMicrotasks(450);
    expect(winC.closed).toBe(true);
    expect(document.getElementById("biliscript-reading-view")?.hidden).toBe(true);
  });

  it("T3-06: F5 x F22 - blocked mode switch keeps window intact, shows notice, persists detachedWindowMode to sync", async () => {
    const h = await bootHarness({ sync: { detachedWindowMode: "popup" } });
    await h.openReaderInPage();
    const popupWin = await h.detachReader();
    h.fakePlatform.setPipMode("reject");
    h.fakePlatform.setPopupMode("blocked");
    await switchDetachedModeInSettings(h, "pip");
    expect(popupWin.closed).toBe(false);
    expect(h.storage.syncMap.get("detachedWindowMode")).toBe("pip");
    const statusText = (popupWin.document.getElementById("biliscriptSettingsStatus")?.textContent ?? "").trim();
    expect(statusText.length).toBeGreaterThan(0);
    expect(statusText).not.toBe("已保存");
    expect(statusText).toMatch(/拦截|阻止|无法|失败|重开|下次|生效|切换|不支持|窗口|模式|blocked/i);
  });

  it("T3-07: F6 x F7 - active host routes settings drawer, explain card, quote share modal, and focus trap inside childDoc", async () => {
    const h = await bootHarness();
    await h.openReaderInPage();
    const childWin = await h.detachReader();
    await h.openSettingsInActiveHost();
    expect(childWin.document.getElementById("biliscript-reading-settings-panel")?.hidden).toBe(false);
    await dispatchEscapeInDoc(h, childWin.document);
    const card = await openExplainCardFromSelection(h, childWin.document, childWin);
    expect(card?.ownerDocument).toBe(childWin.document);
    await dispatchEscapeInDoc(h, childWin.document);
    const quoteDialog = await openQuoteShareModalInDoc(h, childWin.document);
    expect(quoteDialog?.ownerDocument).toBe(childWin.document);
  });

  it("T3-08: F6 x F8 - while detached, video and Bilibili right-column anchors remain bound to opener document", async () => {
    const h = await bootHarness();
    const activeHost = await loadActiveHostContract();
    await h.openReaderInPage();
    const childWin = await h.detachReader();
    expect(activeHost.getActiveReaderDocument()).toBe(childWin.document);
    const { getRuntimeVideoElement } = await import("../../extension/bilibili/video-probe.js");
    const { hasScriptAnchor } = await import("../../extension/reader/script-host.js");
    expect(getRuntimeVideoElement()).toBe(h.video);
    expect(hasScriptAnchor()).toBe(true);
  });

  it("T3-09: F7 x F9 - opening AI chat tab and quote share while detached mirrors lazy CSS immediately", async () => {
    const h = await bootHarness();
    await h.openReaderInPage();
    const childWin = await h.detachReader();
    await h.switchTabInActiveHost("chat");
    assertStyleLinksPresent(childWin.document, ["reader-chat.css", "github-markdown.css"]);
    const dialog = await openQuoteShareModalInDoc(h, childWin.document);
    expect(dialog).not.toBeNull();
  });

  it("T3-10: F7 x F15 - selection explain card open alongside subtitle click seeks opener video without losing child focus", async () => {
    const h = await bootHarness();
    await h.openReaderInPage();
    const childWin = await h.detachReader();
    await openExplainCardFromSelection(h, childWin.document, childWin);
    clearWinSelection(childWin);
    h.openerFocusSpy.mockClear();
    childWin.focus.mockClear();
    getFirstSubtitleItem(childWin.document, 2)?.click();
    await h.flushTimersAndMicrotasks(40);
    expect(h.video.currentTime).toBe(90);
    expect(h.openerFocusSpy).not.toHaveBeenCalled();
    expect(childWin.focus).toHaveBeenCalled();
  });

  it("T3-11: F8 x F15 - multiple video candidates on opener resolve runtime player video on detached seek", async () => {
    const h = await bootHarness();
    const feedCard = document.createElement("div");
    feedCard.className = "bili-video-card";
    const decoyVideo = document.createElement("video");
    feedCard.appendChild(decoyVideo);
    document.body.appendChild(feedCard);
    await h.openReaderInPage();
    const childWin = await h.detachReader();
    getFirstSubtitleItem(childWin.document, 1)?.click();
    await h.flushTimersAndMicrotasks(40);
    expect(h.video.currentTime).toBe(30);
    expect(decoyVideo.currentTime).toBe(0);
  });

  it("T3-12: F9 x F10 - initial/lazy mirrored stylesheets combine with live theme/palette/typography updates", async () => {
    const h = await bootHarness({ sync: { readerTheme: "light", readerPalette: "flyme" } });
    await h.openReaderInPage();
    const childWin = await h.detachReader();
    await h.openSettingsInActiveHost();
    childWin.document.getElementById("openAppearanceBtn")?.click();
    await h.flushTimersAndMicrotasks(60);
    await setSettingsSelectValue(h, childWin.document, "readerTheme", "dark");
    await setSettingsSelectValue(h, childWin.document, "readerPalette", "editorial");
    await setSettingsRangeValue(h, childWin.document, "readerFontSizeScale", 115);
    assertStyleLinksPresent(childWin.document, ["reader.css", "reader-settings-shell.css"]);
    expect(childWin.document.documentElement.dataset.biliscriptReaderTheme).toBe("dark");
    expect(childWin.document.documentElement.dataset.biliscriptReaderPalette).toBe("editorial");
    expect(childWin.document.getElementById("biliscript-reading-view")?.style.getPropertyValue("--biliscript-reader-font-scale")).toBe("1.15");
  });

  it("T3-13: F10 x F11 - live theme toggle + reduced transparency updates detached viewport tokens with zero bare scrollbars", async () => {
    const h = await bootHarness({ sync: { readerTheme: "light", reduceTransparency: false } });
    await h.openReaderInPage();
    const childWin = await h.detachReader();
    await h.clickHeaderThemeInActiveHost();
    await h.openSettingsInActiveHost();
    childWin.document.getElementById("openAppearanceBtn")?.click();
    await h.flushTimersAndMicrotasks(60);
    await setSettingsCheckboxValue(h, childWin.document, "reduceTransparency", true);
    const view = childWin.document.getElementById("biliscript-reading-view")!;
    expect(view.dataset.theme).toBe("dark");
    expect(childWin.document.documentElement.dataset.biliscriptReaderTheme).toBe("dark");
    expect(view.dataset.biliscriptReduceTransparency).toBe("1");
    assertZeroUnwrappedScrollbars(["extension/entry/styles/reader.css"]);
  });

  it("T3-14: F12 x F13 - detach -> redock -> detach sequence pauses and resumes script-host anchoring without false restore", async () => {
    const h = await bootHarness();
    const { injectScriptButton } = await import("../../extension/ui/script-button.js");
    injectScriptButton();
    await h.openReaderInPage();
    const firstWin = await h.detachReader();
    expect(getReadingViewAnchorVars(firstWin.document.getElementById("biliscript-reading-view")!)).toEqual([]);
    await h.redockReader();
    expect(getReadingViewAnchorVars(document.getElementById("biliscript-reading-view")!).length).toBeGreaterThan(0);
    expect(document.getElementById("biliscript-script-button")).toBeNull();
    const secondWin = await h.detachReader();
    expect(getReadingViewAnchorVars(secondWin.document.getElementById("biliscript-reading-view")!)).toEqual([]);
    await h.flushTimersAndMicrotasks(5000);
    expect(secondWin.closed).toBe(false);
    expect(document.querySelectorAll("#biliscript-script-button")).toHaveLength(1);
  });

  it("T3-15: F13 x F14 - header visibility swaps cleanly across docked, pip, external redock, and popup", async () => {
    const h = await bootHarness();
    await h.openReaderInPage();
    assertHeaderButtonOrder(document);
    expect(document.getElementById(EXPECTED_DETACH_BTN_ID)?.getAttribute("aria-label")).toContain("弹出");
    expect((document.getElementById(EXPECTED_DETACH_BTN_ID) as HTMLButtonElement).hidden).toBe(false);
    expect((document.getElementById("biliscript-reading-close-btn") as HTMLButtonElement).hidden).toBe(false);
    const pipWin = await h.detachReader();
    assertHeaderButtonOrder(pipWin.document);
    expect(pipWin.document.getElementById(EXPECTED_DETACH_BTN_ID)?.getAttribute("aria-label")).toContain("归位");
    expect((pipWin.document.getElementById(EXPECTED_DETACH_BTN_ID) as HTMLButtonElement).hidden).toBe(true);
    expect((pipWin.document.getElementById("biliscript-reading-close-btn") as HTMLButtonElement).hidden).toBe(true);
    pipWin.simulateUserClose();
    await h.flushTimersAndMicrotasks(80);
    assertHeaderButtonOrder(document);
    expect(document.getElementById(EXPECTED_DETACH_BTN_ID)?.getAttribute("aria-label")).toContain("弹出");
    expect((document.getElementById(EXPECTED_DETACH_BTN_ID) as HTMLButtonElement).hidden).toBe(false);
    expect((document.getElementById("biliscript-reading-close-btn") as HTMLButtonElement).hidden).toBe(false);
    await switchDetachedModeInSettings(h, "popup");
    const popupWin = await h.detachReader();
    assertHeaderButtonOrder(popupWin.document);
    expect(popupWin.document.getElementById(EXPECTED_DETACH_BTN_ID)?.getAttribute("aria-label")).toContain("归位");
    expect((popupWin.document.getElementById(EXPECTED_DETACH_BTN_ID) as HTMLButtonElement).hidden).toBe(false);
    expect((popupWin.document.getElementById("biliscript-reading-close-btn") as HTMLButtonElement).hidden).toBe(true);
  });

  it("T3-16: F16 x F17 - entering webpage fullscreen while detached then SPA switching to p=2 retains window & refreshes clip", async () => {
    const h = await bootHarness();
    await h.openReaderInPage();
    const childWin = await h.detachReader();
    await h.toggleWebpageFullscreen(true);
    await h.triggerSpaNavigation("https://www.bilibili.com/video/BV1test000000/?p=2", {
      bvid: "BV1test000000",
      cid: "2222",
      subtitleText: "全屏分P新字幕"
    });
    expect(childWin.closed).toBe(false);
    expect(childWin.document.getElementById("biliscript-reading-subtitle")?.textContent).toContain("全屏分P新字幕");
  });

  it("T3-17: F16 x F19 - entering fullscreen while detached then pressing Alt+B closes detached window & exits shell", async () => {
    const h = await bootHarness();
    await h.openReaderInPage();
    const childWin = await h.detachReader();
    await h.toggleWebpageFullscreen(true);
    await h.dispatchMessage({ type: "reader-toggle", readerUrl: READER_MODE_URL });
    await h.flushTimersAndMicrotasks(450);
    expect(childWin.closed).toBe(true);
    expect(document.getElementById("biliscript-reading-view")?.hidden).toBe(true);
  });

  it("T3-18: F1 x F17 x F20 - detached pip survives SPA navigation and accepts quick AI prompt targeting new clip", async () => {
    const h = await bootHarness();
    await h.openReaderInPage();
    const childWin = await h.detachReader();
    await h.triggerSpaNavigation("https://www.bilibili.com/video/BV1newclip88/", {
      bvid: "BV1newclip88",
      cid: "8888",
      subtitleText: "新片段内容"
    });
    await h.dispatchMessage({
      type: "reader-enter",
      readerUrl: READER_MODE_URL,
      chat: { prompt: "总结新片段" }
    });
    await h.flushTimersAndMicrotasks(100);
    expect(childWin.closed).toBe(false);
    expect(h.fakePlatform.pipRequests).toHaveLength(1);
    expect(childWin.document.getElementById("biliscript-reading-tab-chat")?.classList.contains("is-active")).toBe(true);
  });

  it("T3-19: F18 x F19 - reader-enter focuses detached window, then reader-toggle closes it and preserves hidden root", async () => {
    const h = await bootHarness();
    await h.openReaderInPage();
    const rootNode = document.getElementById("biliscript-reading-view");
    const childWin = await h.detachReader();
    childWin.focus.mockClear();
    await h.dispatchMessage({ type: "reader-enter", readerUrl: READER_MODE_URL });
    expect(childWin.focus).toHaveBeenCalledTimes(1);
    await h.dispatchMessage({ type: "reader-toggle", readerUrl: READER_MODE_URL });
    await h.flushTimersAndMicrotasks(450);
    expect(childWin.closed).toBe(true);
    expect(document.getElementById("biliscript-reading-view")).toBe(rootNode);
    expect(rootNode?.hidden).toBe(true);
  });

  it("T3-20: F18 x F20 - quick AI prompt focuses detached window, switches from subtitle to chat, and submits prompt", async () => {
    const h = await bootHarness();
    await h.openReaderInPage();
    const childWin = await h.detachReader();
    childWin.focus.mockClear();
    await triggerPlayerAiQuickAction(h, "快速提问测试");
    expect(childWin.focus).toHaveBeenCalled();
    expect(childWin.document.getElementById("biliscript-reading-tab-subtitle")?.classList.contains("is-active")).toBe(false);
    expect(childWin.document.getElementById("biliscript-reading-tab-chat")?.classList.contains("is-active")).toBe(true);
  });

  it("T3-21: F3 x F21 - opener reload closes old detached window and autoOpenReader restores strictly in-page", async () => {
    const h1 = await bootHarness();
    await h1.openReaderInPage();
    const oldWin = await h1.detachReader();
    h1.fakePlatform.simulateOpenerPageHide();
    await h1.flushTimersAndMicrotasks(40);
    expect(oldWin.closed).toBe(true);
    await h1.cleanup();
    const h2 = await bootHarness({ sync: { autoOpenReader: true }, bootContentScript: true });
    expect(document.getElementById("biliscript-reading-view")?.classList.contains("open")).toBe(true);
    expect(h2.fakePlatform.pipRequests).toHaveLength(0);
  });

  it("T3-22: F21 x F24 - autoOpenReader opens in-page first, then pop-out uses computed default geometry", async () => {
    const h = await bootHarness({
      availHeight: 720,
      sync: { autoOpenReader: true, customPanelWidthEnabled: true, customPanelWidth: 600 },
      bootContentScript: true
    });
    expect(document.getElementById("biliscript-reading-view")?.classList.contains("open")).toBe(true);
    await h.detachReader();
    expect(h.fakePlatform.pipRequests[0]).toMatchObject({ width: 600, height: 576 });
  });

  it("T3-23: F22 x F23 - mode toggle updates sync only while child resize debounces bounds to local only", async () => {
    const h = await bootHarness();
    await h.openReaderInPage();
    const childWin = await h.detachReader();
    childWin.simulateResize(630, 800);
    await h.flushTimersAndMicrotasks(500);
    await switchDetachedModeInSettings(h, "popup");
    expect(h.storage.syncMap.get("detachedWindowMode")).toBe("popup");
    expect(h.storage.syncMap.has(EXPECTED_BOUNDS_KEY)).toBe(false);
    expect(h.storage.localMap.get(EXPECTED_BOUNDS_KEY)).toEqual({ width: 630, height: 800 });
    expect(h.storage.localMap.has("detachedWindowMode")).toBe(false);
  });

  it("T3-24: F23 x F24 x F25 - resize saves local bounds -> reset clears local bounds -> next pop-out uses computed defaults", async () => {
    const h = await bootHarness({ availHeight: 720 });
    await h.openReaderInPage();
    const firstWin = await h.detachReader();
    firstWin.simulateResize(680, 840);
    await h.flushTimersAndMicrotasks(500);
    expect(h.storage.localMap.get(EXPECTED_BOUNDS_KEY)).toEqual({ width: 680, height: 840 });
    const doc = await h.openSettingsInActiveHost();
    await clickResetAndSettle(h, doc, true);
    await h.redockReader();
    await h.detachReader();
    expect(h.fakePlatform.pipRequests[1]).toMatchObject({ width: 540, height: 576 });
  });

  it("T3-25: F2 x F25 x F26 - reset in Firefox-like popup fallback restores detachedWindowMode=pip and clears local bounds", async () => {
    const h = await bootHarness({
      extensionBaseUrl: "moz-extension://fx-reset/",
      pipMode: "unsupported",
      sync: { detachedWindowMode: "popup" },
      local: { [EXPECTED_BOUNDS_KEY]: { width: 620, height: 790 } }
    });
    await h.openReaderInPage();
    const childWin = await h.detachReader();
    const doc = await h.openSettingsInActiveHost();
    await clickResetAndSettle(h, doc, true);
    expect(childWin.closed).toBe(false);
    expect(h.storage.syncMap.get("detachedWindowMode")).toBe("pip");
    expect(h.storage.localMap.has(EXPECTED_BOUNDS_KEY)).toBe(false);
  });

  it("T3-26: F11 x F26 - detached CSS uses @supports (-moz-appearance: none) and shared slot survives chunk reload", async () => {
    assertZeroUnwrappedScrollbars([
      "extension/entry/styles/reader.css",
      "extension/entry/styles/reader-chat.css",
      "extension/entry/styles/reader-settings-shell.css"
    ]);
    const h = await bootHarness();
    const hostA = await loadActiveHostContract();
    await h.openReaderInPage();
    const childWin = await h.detachReader();
    vi.resetModules();
    const hostB = await loadActiveHostContract();
    expect(hostA.isReaderDetached()).toBe(true);
    expect(hostB.isReaderDetached()).toBe(true);
    expect(hostB.getActiveReaderDocument()).toBe(childWin.document);
  });
});
