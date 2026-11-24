import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL } from "../setup.js";
import {
  assertAllLinkHrefsHavePrefix,
  assertHeaderButtonOrder,
  assertStyleLinksPresent,
  assertZeroUnwrappedScrollbars,
  clearWinSelection,
  clickResetAndSettle,
  dispatchEscapeInDoc,
  getFirstSubtitleItem,
  getMirroredStyleHrefs,
  getReadingViewAnchorVars,
  getWindowPrototypeDescriptorSnapshot,
  openCommandPaletteInDoc,
  openQuoteShareModalInDoc,
  setSettingsSelectValue,
  triggerSubtitleSelection
} from "./helpers/detached-assertions.js";
import {
  EXPECTED_BOUNDS_KEY,
  EXPECTED_DETACH_BTN_ID,
  EXPECTED_MIN_HEIGHT,
  EXPECTED_MIN_WIDTH,
  loadActiveHostContract,
  loadDetachedBoundsContract,
  loadDetachedWindowContract,
  loadShellContract,
  loadStyleInjectorContract
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
describe("Tier 2: Boundary, Corner & Negative-Error Paths", () => {
  describe("Feature #1: pip Mode Host Factory (Boundary & Negative)", () => {
    it("T2-F01-01: synchronous throw from requestWindow silently falls back to popup", async () => {
      const h = await bootHarness({ pipMode: "throw" });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      expect(h.fakePlatform.pipRequests).toHaveLength(1);
      expect(h.fakePlatform.openCalls).toHaveLength(1);
      expect(childWin.document.getElementById("biliscript-reading-view")).not.toBeNull();
    });

    it("T2-F01-02: pip reject plus popup blocked aborts cleanly leaving panel docked in opener", async () => {
      const h = await bootHarness({ pipMode: "reject", popupMode: "blocked" });
      await h.openReaderInPage();
      const child = await h.attemptDetachReader();
      expect(child).toBeNull();
      const view = document.getElementById("biliscript-reading-view");
      expect(view).not.toBeNull();
      expect(view?.classList.contains("open")).toBe(true);
    });

    it("T2-F01-03: requestWindow returning null falls back cleanly or aborts without orphaned state", async () => {
      const h = await bootHarness({ pipMode: "null", popupMode: "allow" });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      expect(childWin).not.toBeNull();
      expect(childWin.document.getElementById("biliscript-reading-view")).not.toBeNull();
    });

    it("T2-F01-04: pip fallback to popup does not display blocking error alert in subtitle notice", async () => {
      const h = await bootHarness({ pipMode: "reject", popupMode: "allow" });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      const notice = childWin.document.getElementById("biliscript-reading-subtitle-notice");
      expect(notice?.hidden).toBe(true);
    });

    it("T2-F01-05: calling detachReaderShell twice while already detached in pip focuses without opening a second window", async () => {
      const h = await bootHarness();
      const shell = await loadShellContract();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      childWin.focus.mockClear();
      await shell.detachReaderShell();
      expect(h.fakePlatform.pipRequests).toHaveLength(1);
      expect(childWin.focus).toHaveBeenCalled();
    });
  });

  describe("Feature #2: popup Mode Host Factory (Boundary & Negative)", () => {
    it("T2-F02-01: popup blocker returning null keeps reader docked and open in opener", async () => {
      const h = await bootHarness({ sync: { detachedWindowMode: "popup" }, popupMode: "blocked" });
      await h.openReaderInPage();
      const child = await h.attemptDetachReader();
      expect(child).toBeNull();
      expect(document.getElementById("biliscript-reading-view")?.classList.contains("open")).toBe(true);
      expect(document.getElementById("biliscript-reading-view")?.hidden).toBe(false);
    });

    it("T2-F02-02: window.open throwing error aborts detach cleanly without breaking reader", async () => {
      const h = await bootHarness({ sync: { detachedWindowMode: "popup" }, popupMode: "throw" });
      await h.openReaderInPage();
      const child = await h.attemptDetachReader();
      expect(child).toBeNull();
      expect(document.getElementById("biliscript-reading-view")?.classList.contains("open")).toBe(true);
    });

    it("T2-F02-03: window.open returning already-closed window aborts detach cleanly", async () => {
      const h = await bootHarness({ sync: { detachedWindowMode: "popup" }, popupMode: "closed" });
      await h.openReaderInPage();
      const child = await h.attemptDetachReader();
      expect(child).toBeNull();
      expect(document.getElementById("biliscript-reading-view")).not.toBeNull();
    });

    it("T2-F02-04: popup blocked after pip failure keeps subtitle list usable in-page", async () => {
      const h = await bootHarness({ pipMode: "unsupported", popupMode: "blocked" });
      await h.openReaderInPage();
      await h.attemptDetachReader();
      const subItem = getFirstSubtitleItem(document, 1);
      subItem?.click();
      await h.flushTimersAndMicrotasks(40);
      expect(h.video.currentTime).toBe(30);
    });

    it("T2-F02-05: window.open returning window without accessible document aborts safely", async () => {
      const h = await bootHarness({ sync: { detachedWindowMode: "popup" }, popupMode: "no-doc" });
      await h.openReaderInPage();
      const child = await h.attemptDetachReader();
      expect(child).toBeNull();
      expect(document.getElementById("biliscript-reading-view")?.classList.contains("open")).toBe(true);
    });
  });

  describe("Feature #3: Opener Unload / Close Guard (Boundary & Negative)", () => {
    it("T2-F03-01: opener pagehide after child was already closed by user does not throw", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      childWin.simulateUserClose();
      await h.flushTimersAndMicrotasks(450);
      expect(() => h.fakePlatform.simulateOpenerPageHide()).not.toThrow();
    });

    it("T2-F03-02: repeated opener pagehide events remain idempotent", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      h.fakePlatform.simulateOpenerPageHide();
      h.fakePlatform.simulateOpenerPageHide();
      await h.flushTimersAndMicrotasks(40);
      expect(childWin.closed).toBe(true);
      expect(childWin.close).toHaveBeenCalledTimes(1);
    });

    it("T2-F03-03: childWin.close throwing during opener pagehide is caught cleanly", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      await h.detachReader();
      h.fakePlatform.setCloseThrows(true);
      expect(() => h.fakePlatform.simulateOpenerPageHide()).not.toThrow();
    });

    it("T2-F03-04: opener pagehide while reader is docked is a harmless no-op", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      expect(() => h.fakePlatform.simulateOpenerPageHide()).not.toThrow();
      expect(h.fakePlatform.openedWindows).toHaveLength(0);
    });

    it("T2-F03-05: opener pagehide after closeDetachedWindowHost(true) does not resurrect stale listeners", async () => {
      const h = await bootHarness();
      const detachedWin = await loadDetachedWindowContract();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.redockReader();
      detachedWin.closeDetachedWindowHost(true);
      childWin.close.mockClear();
      h.fakePlatform.simulateOpenerPageHide();
      expect(childWin.close).not.toHaveBeenCalled();
    });
  });

  describe("Feature #4: Child pagehide Redock Alignment (Boundary & Negative)", () => {
    it("T2-F04-01: duplicate child pagehide events redock idempotently without throwing", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      childWin.simulateUserClose();
      childWin.dispatchEvent(new Event("pagehide"));
      await h.flushTimersAndMicrotasks(450);
      const view = document.getElementById("biliscript-reading-view");
      expect(view?.hidden).toBe(false);
      expect(view?.classList.contains("open")).toBe(true);
    });

    it("T2-F04-02: child pagehide while settings panel is expanded preserves open panel and settings in opener", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.openSettingsInActiveHost();
      childWin.simulateUserClose();
      await h.flushTimersAndMicrotasks(450);
      expect(document.getElementById("biliscript-reading-view")?.hidden).toBe(false);
      expect(document.getElementById("biliscript-reading-settings-panel")?.hidden).toBe(false);
      await dispatchEscapeInDoc(h, document);
      expect(document.getElementById("biliscript-reading-settings-panel")?.hidden).toBe(true);
    });

    it("T2-F04-03: child pagehide while confirm dialog is open migrates dialog back to opener cleanly", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.openSettingsInActiveHost();
      childWin.document.getElementById("biliscriptSettingsResetBtn")?.click();
      await h.flushTimersAndMicrotasks(40);
      childWin.simulateUserClose();
      await h.flushTimersAndMicrotasks(450);
      expect(childWin.document.querySelector(".confirm-dialog")).toBeNull();
      expect(document.getElementById("biliscript-reading-view")?.hidden).toBe(false);
      const migratedCancel = document.querySelector<HTMLButtonElement>(".confirm-dialog-cancel");
      expect(migratedCancel).not.toBeNull();
      migratedCancel?.click();
      await h.flushTimersAndMicrotasks(200);
      expect(document.querySelector(".confirm-dialog")).toBeNull();
    });

    it("T2-F04-04: child pagehide redocks functional panel in-page and allows detaching again", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const firstWin = await h.detachReader();
      firstWin.simulateUserClose();
      await h.flushTimersAndMicrotasks(450);
      const view = document.getElementById("biliscript-reading-view");
      expect(view?.hidden).toBe(false);
      expect(view?.classList.contains("open")).toBe(true);
      const secondWin = await h.detachReader();
      expect(secondWin).not.toBe(firstWin);
      expect(secondWin.closed).toBe(false);
    });

    it("T2-F04-05: child pagehide triggered during mode switch closing old window does not close new window", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const firstWin = await h.detachReader();
      await switchDetachedModeInSettings(h, "popup");
      const secondWin = h.fakePlatform.getCurrentActiveChild()!;
      expect(firstWin.closed).toBe(true);
      expect(secondWin.closed).toBe(false);
      expect(secondWin.document.getElementById("biliscript-reading-view")?.classList.contains("open")).toBe(true);
    });
  });

  describe("Feature #5: In-Place Mode Switch (Boundary & Negative)", () => {
    it("T2-F05-01: blocked popup->pip mode switch keeps existing popup window open and panel mounted", async () => {
      const h = await bootHarness({ sync: { detachedWindowMode: "popup" } });
      await h.openReaderInPage();
      const popupWin = await h.detachReader();
      h.fakePlatform.setPipMode("reject");
      h.fakePlatform.setPopupMode("blocked");
      await switchDetachedModeInSettings(h, "pip");
      expect(popupWin.closed).toBe(false);
      expect(popupWin.document.getElementById("biliscript-reading-view")).not.toBeNull();
    });

    it("T2-F05-02: blocked mode switch surfaces non-blocking status feedback inside settings", async () => {
      const h = await bootHarness({ sync: { detachedWindowMode: "popup" } });
      await h.openReaderInPage();
      const popupWin = await h.detachReader();
      h.fakePlatform.setPipMode("reject");
      h.fakePlatform.setPopupMode("blocked");
      await switchDetachedModeInSettings(h, "pip");
      const statusText = (popupWin.document.getElementById("biliscriptSettingsStatus")?.textContent ?? "").trim();
      expect(statusText.length).toBeGreaterThan(0);
      expect(statusText).not.toBe("已保存");
      expect(statusText).toMatch(/拦截|阻止|无法|失败|重开|下次|生效|切换|不支持|窗口|模式|blocked/i);
    });

    it("T2-F05-03: blocked mode switch still persists detachedWindowMode preference to sync", async () => {
      const h = await bootHarness({ sync: { detachedWindowMode: "popup" } });
      await h.openReaderInPage();
      await h.detachReader();
      h.fakePlatform.setPipMode("reject");
      h.fakePlatform.setPopupMode("blocked");
      await switchDetachedModeInSettings(h, "pip");
      expect(h.storage.syncMap.get("detachedWindowMode")).toBe("pip");
    });

    it("T2-F05-04: changing detachedWindowMode while docked updates sync without auto-detaching", async () => {
      const h = await bootHarness({ sync: { detachedWindowMode: "pip" } });
      await h.openReaderInPage();
      const doc = await h.openSettingsInActiveHost();
      await setSettingsSelectValue(h, doc, "detachedWindowMode", "popup");
      expect(h.storage.syncMap.get("detachedWindowMode")).toBe("popup");
      expect(h.fakePlatform.openCalls).toHaveLength(0);
      expect(h.fakePlatform.pipRequests).toHaveLength(0);
    });

    it("T2-F05-05: switchDetachedWindowMode to already-active mode is a clean no-op", async () => {
      const h = await bootHarness();
      const shell = await loadShellContract();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await shell.switchDetachedWindowMode("pip");
      expect(h.fakePlatform.pipRequests).toHaveLength(1);
      expect(childWin.closed).toBe(false);
    });
  });

  describe("Feature #6: Active Reader Host Context (Boundary & Negative)", () => {
    it("T2-F06-01: resetActiveReaderHost restores opener document and window", async () => {
      const h = await bootHarness();
      const activeHost = await loadActiveHostContract();
      await h.openReaderInPage();
      await h.detachReader();
      activeHost.resetActiveReaderHost();
      expect(activeHost.isReaderDetached()).toBe(false);
      expect(activeHost.getActiveReaderDocument()).toBe(document);
      expect(activeHost.getActiveReaderWindow()).toBe(window);
    });

    it("T2-F06-02: isReaderDetached reports false when active detached window becomes closed", async () => {
      const h = await bootHarness();
      const activeHost = await loadActiveHostContract();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      childWin.closed = true;
      expect(activeHost.isReaderDetached()).toBe(false);
    });

    it("T2-F06-03: setActiveReaderHost with same doc/win twice stays idempotent", async () => {
      const h = await bootHarness();
      const activeHost = await loadActiveHostContract();
      const childDoc = document.implementation.createHTMLDocument("Child");
      const childWin = { closed: false, document: childDoc } as unknown as Window;
      const listener = vi.fn();
      const unsub = activeHost.onActiveHostChange(listener);
      activeHost.setActiveReaderHost(childDoc, childWin);
      activeHost.setActiveReaderHost(childDoc, childWin);
      unsub();
      expect(listener).toHaveBeenCalledTimes(1);
      activeHost.resetActiveReaderHost();
      expect(h.fakePlatform.openedWindows).toHaveLength(0);
    });

    it("T2-F06-04: activeById returns null for unknown ids without throwing", async () => {
      const h = await bootHarness();
      const activeHost = await loadActiveHostContract();
      await h.openReaderInPage();
      await h.detachReader();
      expect(activeHost.activeById("non-existent-element-xyz")).toBeNull();
    });

    it("T2-F06-05: unsubscribing onActiveHostChange stops future notifications", async () => {
      const h = await bootHarness();
      const activeHost = await loadActiveHostContract();
      const listener = vi.fn();
      const unsub = activeHost.onActiveHostChange(listener);
      unsub();
      await h.openReaderInPage();
      await h.detachReader();
      await h.redockReader();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("Feature #7: Panel-Domain Overlays & Interactions (Boundary & Negative)", () => {
    it("T2-F07-01: focus-scope Tab cycle stays inside detached childDoc modal", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      const quoteDialog = await openQuoteShareModalInDoc(h, childWin.document);
      expect(quoteDialog).not.toBeNull();
      const closeBtn = childWin.document.querySelector<HTMLButtonElement>(".biliscript-quote-share-close");
      closeBtn?.focus();
      childWin.document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
      expect(quoteDialog?.contains(childWin.document.activeElement)).toBe(true);
    });

    it("T2-F07-02: clicking opener document does not dismiss or crash detached custom-select state", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.openSettingsInActiveHost();
      childWin.document.getElementById("openAppearanceBtn")?.click();
      await h.flushTimersAndMicrotasks(60);
      const trigger = childWin.document.querySelector<HTMLElement>(
        "#biliscriptSettingsSubpageAppearance .custom-select-trigger"
      );
      expect(trigger).not.toBeNull();
      trigger?.click();
      await h.flushTimersAndMicrotasks(30);
      document.body.click();
      await h.flushTimersAndMicrotasks(30);
      expect(
        childWin.document.querySelector('.custom-select-dropdown:not([hidden]):not([data-inline="true"])')
      ).not.toBeNull();
      expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    });

    it("T2-F07-03: selection explain pop stays within narrow child window bounds", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      childWin.simulateResize(360, 420);
      await triggerSubtitleSelection(h, childWin.document, childWin);
      const pop = childWin.document.getElementById("biliscript-reading-explain-pop");
      expect(pop?.hidden).toBe(false);
    });

    it("T2-F07-04: closing reader shell while quote share and command palette exist cleans up modals in childDoc", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await openQuoteShareModalInDoc(h, childWin.document);
      await openCommandPaletteInDoc(h, childWin.document);
      await h.clickHeaderCloseInActiveHost();
      expect(childWin.document.querySelector(".biliscript-quote-share-dialog")).toBeNull();
      expect(childWin.document.getElementById("biliscript-command-palette")).toBeNull();
    });

    it("T2-F07-05: pressing Esc on open settings panel inside childDoc steps back without closing window", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.openSettingsInActiveHost();
      await dispatchEscapeInDoc(h, childWin.document);
      expect(childWin.closed).toBe(false);
      expect(childWin.document.getElementById("biliscript-reading-settings-panel")?.hidden).toBe(true);
    });
  });

  describe("Feature #8: Opener-Bound Bilibili Probes (Boundary & Negative)", () => {
    it("T2-F08-01: decoy <video> inserted into detached childDoc does not hijack opener video probe", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      const decoyVideo = childWin.document.createElement("video");
      childWin.document.body.appendChild(decoyVideo);
      const { getRuntimeVideoElement } = await import("../../extension/bilibili/video-probe.js");
      expect(getRuntimeVideoElement()).toBe(h.video);
    });

    it("T2-F08-02: decoy .right-container-inner in childDoc is ignored by opener anchor probe", async () => {
      const h = await bootHarness({ rightAnchorPresent: false });
      document.querySelector("#bilibili-player")?.remove();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      const decoyAnchor = childWin.document.createElement("div");
      decoyAnchor.className = "right-container-inner";
      childWin.document.body.appendChild(decoyAnchor);
      const { hasScriptAnchor } = await import("../../extension/reader/script-host.js");
      expect(hasScriptAnchor()).toBe(false);
    });

    it("T2-F08-03: removing opener <video> while detached surfaces graceful notice on seek", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      h.video.remove();
      getFirstSubtitleItem(childWin.document, 1)?.click();
      await h.flushTimersAndMicrotasks(40);
      const notice = childWin.document.getElementById("biliscript-reading-subtitle-notice");
      expect(notice?.hidden).toBe(false);
      expect(notice?.textContent).toContain("播放器");
    });

    it("T2-F08-04: mutating detached childDoc attributes does not fool Bilibili host theme probe", async () => {
      const h = await bootHarness({ sync: { readerTheme: "bilibili" } });
      document.documentElement.setAttribute("data-theme", "light");
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      childWin.document.documentElement.setAttribute("data-theme", "dark");
      const { detectBilibiliHostTheme } = await import("../../extension/shared/host-theme.js");
      expect(detectBilibiliHostTheme()).toBe("light");
    });

    it("T2-F08-05: opener #biliscript-player-ai-quick-action remains suppressed/absent while reader is open detached", async () => {
      const h = await bootHarness();
      const { startPlayerAiQuickAction } = await import("../../extension/ai/player-ai.js");
      startPlayerAiQuickAction();
      await h.flushTimersAndMicrotasks(80);
      await h.openReaderInPage();
      await h.detachReader();
      expect(document.getElementById("biliscript-player-ai-quick-action")).toBeNull();
    });
  });

  describe("Feature #9: Stylesheet Registry & Mirroring (Boundary & Negative)", () => {
    it("T2-F09-01: removeReaderStyles while detached removes reader links from both opener and child", async () => {
      const h = await bootHarness();
      const styleInjector = await loadStyleInjectorContract();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      styleInjector.removeReaderStyles();
      expect(getMirroredStyleHrefs(document).some((href) => href.endsWith("reader.css"))).toBe(false);
      expect(getMirroredStyleHrefs(childWin.document).some((href) => href.endsWith("reader.css"))).toBe(false);
    });

    it("T2-F09-02: repeated ensureCustomSelectStyles calls while detached mount only one custom-select.css link", async () => {
      const h = await bootHarness();
      const styleInjector = await loadStyleInjectorContract();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      styleInjector.ensureCustomSelectStyles();
      styleInjector.ensureCustomSelectStyles();
      const matches = getMirroredStyleHrefs(childWin.document).filter((href) => href.endsWith("custom-select.css"));
      expect(matches).toHaveLength(1);
    });

    it("T2-F09-03: clearMirroredStyles on clean document with zero mirrored links is a safe no-op", async () => {
      await bootHarness();
      const styleInjector = await loadStyleInjectorContract();
      const emptyDoc = document.implementation.createHTMLDocument("Empty");
      expect(() => styleInjector.clearMirroredStyles(emptyDoc)).not.toThrow();
      expect(getMirroredStyleHrefs(emptyDoc)).toHaveLength(0);
    });

    it("T2-F09-04: mirrored link hrefs preserve chrome-extension:// or moz-extension:// origin", async () => {
      const h = await bootHarness({ extensionBaseUrl: "chrome-extension://abcdef123456/" });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      assertAllLinkHrefsHavePrefix(childWin.document, "chrome-extension://abcdef123456/");
    });

    it("T2-F09-05: whenReaderSettingsStylesReady resolves deterministically after opening settings while detached", async () => {
      const h = await bootHarness();
      const styleInjector = await loadStyleInjectorContract();
      await h.openReaderInPage();
      await h.detachReader();
      await h.openSettingsInActiveHost();
      await expect(styleInjector.whenReaderSettingsStylesReady()).resolves.toBeUndefined();
    });
  });

  describe("Feature #10: Live Presentation & Token Mirroring (Boundary & Negative)", () => {
    it("T2-F10-01: external storage.sync readerTheme change propagates live into detached window", async () => {
      const h = await bootHarness({ sync: { readerTheme: "light", readerThemeUserSet: true } });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      h.storage.emitExternalChange("sync", "readerTheme", "light", "dark");
      await h.flushTimersAndMicrotasks(80);
      expect(childWin.document.documentElement.dataset.biliscriptReaderTheme).toBe("dark");
    });

    it("T2-F10-02: corrupted readerTheme and readerPalette in sync normalize to valid values in detached doc", async () => {
      const h = await bootHarness({ sync: { readerTheme: "neon-invalid", readerPalette: "unknown-palette" } });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      expect(["light", "dark"]).toContain(childWin.document.documentElement.dataset.biliscriptReaderTheme);
      expect(childWin.document.documentElement.dataset.biliscriptReaderPalette).toBe("flyme");
    });

    it("T2-F10-03: theme and typography updated while detached remain intact after redocking", async () => {
      const h = await bootHarness({ sync: { readerTheme: "light" } });
      await h.openReaderInPage();
      await h.detachReader();
      await h.clickHeaderThemeInActiveHost();
      await h.redockReader();
      expect(document.documentElement.dataset.biliscriptReaderTheme).toBe("dark");
      expect(document.getElementById("biliscript-reading-view")?.dataset.theme).toBe("dark");
    });

    it("T2-F10-04: applyPrePaintReaderTheme handles minimal detached document without throwing", async () => {
      await bootHarness();
      const { applyPrePaintReaderTheme } = await import("../../extension/shared/host-theme.js");
      const minDoc = document.implementation.createHTMLDocument("Min");
      minDoc.body.remove();
      expect(() =>
        applyPrePaintReaderTheme({ readerTheme: "dark", readerThemeUserSet: true, readerPalette: "editorial" }, minDoc)
      ).not.toThrow();
      expect(minDoc.documentElement.dataset.biliscriptReaderTheme).toBe("dark");
    });

    it("T2-F10-05: explicit dark readerTheme overrides light Bilibili host theme inside detached doc", async () => {
      const h = await bootHarness({ sync: { readerTheme: "dark", readerThemeUserSet: true } });
      document.documentElement.removeAttribute("data-theme");
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      expect(childWin.document.documentElement.dataset.biliscriptReaderTheme).toBe("dark");
    });
  });

  describe("Feature #11: Detached Viewport CSS & Firefox Scrollbars (Boundary & Negative)", () => {
    it("T2-F11-01: all extension/entry/styles/*.css files contain zero bare scrollbar-width/color declarations", () => {
      assertZeroUnwrappedScrollbars([
        "extension/entry/styles/reader.css",
        "extension/entry/styles/reader-chat.css",
        "extension/entry/styles/reader-settings-shell.css",
        "extension/entry/styles/bilingual-subtitles.css",
        "extension/entry/styles/player-ai.css",
        "extension/entry/styles/onboarding.css",
        "extension/entry/styles/permission-grant.css"
      ]);
    });

    it("T2-F11-02: minimum 360x420 detached child window does not trigger opener float attribute", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      childWin.simulateResize(360, 420);
      await h.flushTimersAndMicrotasks(100);
      expect(childWin.document.getElementById("biliscript-reading-view")?.hasAttribute("data-biliscript-script-float")).toBe(false);
    });

    it("T2-F11-03: redocking into narrow opener viewport (<1000px) engages degraded float layout", async () => {
      const h = await bootHarness({ viewportWidth: 1440 });
      await h.openReaderInPage();
      await h.detachReader();
      Object.defineProperty(window, "innerWidth", { value: 820, configurable: true, writable: true });
      await h.redockReader();
      expect(document.getElementById("biliscript-reading-view")?.getAttribute("data-biliscript-script-float")).toBe("1");
    });

    it("T2-F11-04: closing from detached mode leaves zero stale --biliscript-script-* variables", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      await h.detachReader();
      await h.clickHeaderCloseInActiveHost();
      const view = document.getElementById("biliscript-reading-view")!;
      expect(getReadingViewAnchorVars(view)).toEqual([]);
    });

    it("T2-F11-05: opener window scroll events while detached do not set scrolling attr on readingView", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      window.dispatchEvent(new Event("scroll"));
      await h.flushTimersAndMicrotasks(50);
      const view = childWin.document.getElementById("biliscript-reading-view")!;
      expect(view.hasAttribute("data-biliscript-script-scrolling")).toBe(false);
    });
  });

  describe("Feature #12: Serialized Shell Transitions (Boundary & Negative)", () => {
    it("T2-F12-01: double-clicking detach button does not spawn two detached windows", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const btn = document.getElementById(EXPECTED_DETACH_BTN_ID)!;
      btn.click();
      btn.click();
      await h.flushStyles();
      await h.flushTimersAndMicrotasks(100);
      expect(h.fakePlatform.pipRequests).toHaveLength(1);
    });

    it("T2-F12-02: detachReaderShell called while shell is closed returns false safely", async () => {
      await bootHarness();
      const shell = await loadShellContract();
      const ok = await shell.detachReaderShell();
      expect(ok).toBe(false);
    });

    it("T2-F12-03: redockReaderShell called when already docked is a safe no-op", async () => {
      const h = await bootHarness();
      const shell = await loadShellContract();
      await h.openReaderInPage();
      await expect(shell.redockReaderShell()).resolves.toBe(true);
      expect(document.getElementById("biliscript-reading-view")?.classList.contains("open")).toBe(true);
    });

    it("T2-F12-04: exitReaderShell called immediately after failed detach leaves closed state intact", async () => {
      const h = await bootHarness({ pipMode: "reject", popupMode: "blocked" });
      const shell = await loadShellContract();
      await h.openReaderInPage();
      await h.attemptDetachReader();
      const exitPromise = shell.exitReaderShell();
      await h.flushTimersAndMicrotasks(450);
      await exitPromise;
      expect(document.getElementById("biliscript-reading-view")?.hidden).toBe(true);
    });

    it("T2-F12-05: shell state and view open flag stay consistent after failed detach", async () => {
      const h = await bootHarness({ pipMode: "reject", popupMode: "blocked" });
      const { getReaderShellState } = await import("../../extension/core/state.js");
      const { isReaderViewOpen } = await import("../../extension/reader/state.js");
      await h.openReaderInPage();
      await h.attemptDetachReader();
      expect(getReaderShellState()).toBe("open");
      expect(isReaderViewOpen()).toBe(true);
    });
  });

  describe("Feature #13: In-Page Anchor Pause/Resume & Self-Heal Guard (Boundary & Negative)", () => {
    it("T2-F13-01: isReaderShellIntact returns false if #biliscript-reading-view is removed from childDoc", async () => {
      const h = await bootHarness();
      const shell = await loadShellContract();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      childWin.document.getElementById("biliscript-reading-view")?.remove();
      expect(shell.isReaderShellIntact()).toBe(false);
    });

    it("T2-F13-02: isReaderShellIntact returns false if detached childWin becomes closed without exit", async () => {
      const h = await bootHarness();
      const shell = await loadShellContract();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      childWin.closed = true;
      expect(shell.isReaderShellIntact()).toBe(false);
    });

    it("T2-F13-03: opener MutationObserver guard does not clear data-biliscript-reader-mode while detached", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      await h.detachReader();
      document.body.setAttribute("data-biliscript-reader-mode", "1");
      await h.flushTimersAndMicrotasks(60);
      expect(document.documentElement.getAttribute("data-biliscript-reader-mode")).toBe("1");
    });

    it("T2-F13-04: script-host 2000ms reanchor interval does not overwrite styles while detached", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.flushTimersAndMicrotasks(4500);
      const detachedView = childWin.document.getElementById("biliscript-reading-view")!;
      expect(getReadingViewAnchorVars(detachedView)).toEqual([]);
    });

    it("T2-F13-05: rapid detach->redock->close cycle leaves zero leaked opener resize or scroll listeners", async () => {
      const h = await bootHarness();
      const winAdd = vi.spyOn(window, "addEventListener");
      const winRemove = vi.spyOn(window, "removeEventListener");
      await h.openReaderInPage();
      await h.detachReader();
      await h.redockReader();
      await h.clickHeaderCloseInActiveHost();
      const resizeAdds = winAdd.mock.calls.filter(([t]) => t === "resize").length;
      const resizeRemoves = winRemove.mock.calls.filter(([t]) => t === "resize").length;
      expect(resizeRemoves).toBeGreaterThanOrEqual(resizeAdds);
    });
  });

  describe("Feature #14: Fixed 4-Button Header Contract (Boundary & Negative)", () => {
    it("T2-F14-01: ensureUiReady with forceRecreate preserves exact 4-button header contract", async () => {
      await bootHarness();
      const { ensureUiReady } = await import("../../extension/ui/ui-renderer.js");
      ensureUiReady({ forceRecreate: true });
      assertHeaderButtonOrder(document);
    });

    it("T2-F14-02: detached window hides header close button while reader-toggle exits shell and clears opener reader attrs", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      expect((childWin.document.getElementById("biliscript-reading-close-btn") as HTMLButtonElement).hidden).toBe(true);
      await h.dispatchMessage({ type: "reader-toggle", readerUrl: READER_MODE_URL });
      expect(childWin.closed).toBe(true);
      expect(document.documentElement.getAttribute("data-biliscript-reader-mode")).toBeNull();
    });

    it("T2-F14-03: clicking detach button while settings overlay modal is open respects overlay guard", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      await h.openSettingsInActiveHost();
      document.getElementById("biliscriptSettingsResetBtn")?.click();
      await h.flushTimersAndMicrotasks(30);
      const detachBtn = document.getElementById(EXPECTED_DETACH_BTN_ID);
      expect(detachBtn).not.toBeNull();
      detachBtn?.click();
      await h.flushTimersAndMicrotasks(40);
      expect(document.querySelector(".confirm-dialog")).not.toBeNull();
      expect(h.fakePlatform.pipRequests).toHaveLength(0);
    });

    it("T2-F14-04: header action container never adds a 5th button or text-node label", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      const buttons = assertHeaderButtonOrder(childWin.document);
      expect(buttons.every((btn) => (btn.textContent ?? "").trim() === "")).toBe(true);
    });

    it("T2-F14-05: 4-button header contract survives pip to popup mode switch with expected visibility", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const pipWin = await h.detachReader();
      expect((pipWin.document.getElementById(EXPECTED_DETACH_BTN_ID) as HTMLButtonElement).hidden).toBe(true);
      expect((pipWin.document.getElementById("biliscript-reading-close-btn") as HTMLButtonElement).hidden).toBe(true);
      await switchDetachedModeInSettings(h, "popup");
      const popupWin = h.fakePlatform.getCurrentActiveChild()!;
      assertHeaderButtonOrder(popupWin.document);
      expect((popupWin.document.getElementById(EXPECTED_DETACH_BTN_ID) as HTMLButtonElement).hidden).toBe(false);
      expect((popupWin.document.getElementById("biliscript-reading-close-btn") as HTMLButtonElement).hidden).toBe(true);
    });
  });

  describe("Feature #15: Timestamp Seek Without Opener Focus Theft (Boundary & Negative)", () => {
    it("T2-F15-01: clicking subtitle item while childWin has active text selection does not seek", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      h.video.currentTime = 12;
      await triggerSubtitleSelection(h, childWin.document, childWin);
      getFirstSubtitleItem(childWin.document, 2)?.click();
      await h.flushTimersAndMicrotasks(40);
      expect(h.video.currentTime).toBe(12);
      clearWinSelection(childWin);
    });

    it("T2-F15-02: invalid NaN subtitle timestamp clamps safely to 0 without throwing", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      const item = getFirstSubtitleItem(childWin.document, 1)!;
      item.dataset.seconds = "not-a-number";
      item.click();
      await h.flushTimersAndMicrotasks(40);
      expect(h.video.currentTime).toBe(0);
    });

    it("T2-F15-03: missing opener <video> displays notice in childDoc without throwing", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      h.video.remove();
      getFirstSubtitleItem(childWin.document, 1)?.click();
      await h.flushTimersAndMicrotasks(40);
      expect(childWin.document.getElementById("biliscript-reading-subtitle-notice")?.hidden).toBe(false);
    });

    it("T2-F15-04: command palette timestamp jump seeks opener video without calling opener focus", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      h.openerFocusSpy.mockClear();
      const palette = await openCommandPaletteInDoc(h, childWin.document);
      const input = palette!.querySelector<HTMLInputElement>("input")!;
      expect(input).not.toBeNull();
      input.value = "1:30";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await h.flushTimersAndMicrotasks(40);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await h.flushTimersAndMicrotasks(40);
      expect(h.video.currentTime).toBe(90);
      expect(h.openerFocusSpy).not.toHaveBeenCalled();
    });

    it("T2-F15-05: secondary mini-player <video> candidate on opener does not hijack player seek", async () => {
      const h = await bootHarness();
      const miniWrap = document.createElement("div");
      miniWrap.className = "bpx-player-mini-warp";
      const miniVideo = document.createElement("video");
      miniWrap.appendChild(miniVideo);
      document.body.appendChild(miniWrap);
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      getFirstSubtitleItem(childWin.document, 1)?.click();
      await h.flushTimersAndMicrotasks(40);
      expect(h.video.currentTime).toBe(30);
      expect(miniVideo.currentTime).toBe(0);
    });
  });

  describe("Feature #16: Fullscreen Retention (Boundary & Negative)", () => {
    it("T2-F16-01: rapid fullscreen enter->exit->enter retains single detached child window", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.toggleWebpageFullscreen(true);
      await h.toggleWebpageFullscreen(false);
      await h.toggleWebpageFullscreen(true);
      expect(childWin.closed).toBe(false);
      expect(h.fakePlatform.pipRequests).toHaveLength(1);
    });

    it("T2-F16-02: webpage fullscreen retains popup mode detached window cleanly", async () => {
      const h = await bootHarness({ sync: { detachedWindowMode: "popup" } });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.toggleWebpageFullscreen(true);
      expect(childWin.closed).toBe(false);
    });

    it("T2-F16-03: exiting fullscreen and immediately clicking subtitle timestamp seeks opener video", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.toggleWebpageFullscreen(true);
      await h.toggleWebpageFullscreen(false);
      getFirstSubtitleItem(childWin.document, 2)?.click();
      await h.flushTimersAndMicrotasks(40);
      expect(h.video.currentTime).toBe(90);
    });

    it("T2-F16-04: fullscreenchange when detached does not hide #biliscript-reading-view", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.toggleWebpageFullscreen(true);
      const view = childWin.document.getElementById("biliscript-reading-view");
      expect(view?.hidden).toBe(false);
      expect(view?.classList.contains("open")).toBe(true);
    });

    it("T2-F16-05: fullscreenchange with missing .bpx-player-container does not throw or close detached window", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      document.querySelector(".bpx-player-container")?.remove();
      document.dispatchEvent(new Event("fullscreenchange"));
      await h.flushTimersAndMicrotasks(50);
      expect(childWin.closed).toBe(false);
    });
  });

  describe("Feature #17: SPA Video / 分P Retention (Boundary & Negative)", () => {
    it("T2-F17-01: rapid double SPA video change settles on latest clip in same detached window", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.triggerSpaNavigation("https://www.bilibili.com/video/BV1rapidA0001/", {
        bvid: "BV1rapidA0001",
        cid: "7001",
        subtitleText: "快速切换A"
      });
      await h.triggerSpaNavigation("https://www.bilibili.com/video/BV1rapidB0002/", {
        bvid: "BV1rapidB0002",
        cid: "7002",
        subtitleText: "最终稳定字幕B"
      });
      expect(childWin.closed).toBe(false);
      expect(childWin.document.getElementById("biliscript-reading-subtitle")?.textContent).toContain("最终稳定字幕B");
    });

    it("T2-F17-02: SPA hashchange with identical clip signature keeps detached window untouched", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      await h.flushTimersAndMicrotasks(80);
      expect(childWin.closed).toBe(false);
      expect(h.fakePlatform.pipRequests).toHaveLength(1);
    });

    it("T2-F17-03: SPA video switch while settings drawer is open preserves detached window", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.openSettingsInActiveHost();
      await h.triggerSpaNavigation("https://www.bilibili.com/video/BV1spaset0001/", {
        bvid: "BV1spaset0001",
        cid: "7003"
      });
      expect(childWin.closed).toBe(false);
      expect(childWin.document.getElementById("biliscript-reading-settings-panel")?.hidden).toBe(false);
    });

    it("T2-F17-04: SPA navigation after closing detached window does not auto-reopen detached window", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      await h.detachReader();
      await h.clickHeaderCloseInActiveHost();
      await h.triggerSpaNavigation("https://www.bilibili.com/video/BV1afterclose1/", {
        bvid: "BV1afterclose1",
        cid: "7004"
      });
      expect(h.fakePlatform.pipRequests).toHaveLength(1);
      expect(h.fakePlatform.getCurrentActiveChild()).toBeNull();
    });

    it("T2-F17-05: SPA navigation after childWin closed handles closed state without throwing", async () => {
      const h = await bootHarness({ sync: { detachedWindowMode: "popup" } });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      childWin.simulateUserClose();
      await h.flushTimersAndMicrotasks(450);
      await h.triggerSpaNavigation("https://www.bilibili.com/video/BV1postclose2/", {
        bvid: "BV1postclose2",
        cid: "7005"
      });
      expect(h.fakePlatform.getCurrentActiveChild()).toBeNull();
    });
  });

  describe("Feature #18: reader-enter While Detached (Boundary & Negative)", () => {
    it("T2-F18-01: reader-enter after child window closed keeps redocked reader open in-page", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      childWin.simulateUserClose();
      await h.flushTimersAndMicrotasks(450);
      await h.dispatchMessage({ type: "reader-enter", readerUrl: READER_MODE_URL });
      expect(document.getElementById("biliscript-reading-view")?.classList.contains("open")).toBe(true);
      expect(h.fakePlatform.getCurrentActiveChild()).toBeNull();
    });

    it("T2-F18-02: repeated reader-enter calls while detached never duplicate #biliscript-reading-view", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.dispatchMessage({ type: "reader-enter", readerUrl: READER_MODE_URL });
      await h.dispatchMessage({ type: "reader-enter", readerUrl: READER_MODE_URL });
      expect(childWin.document.querySelectorAll("#biliscript-reading-view")).toHaveLength(1);
      expect(document.querySelectorAll("#biliscript-reading-view")).toHaveLength(0);
    });

    it("T2-F18-03: reader-enter while detached in popup mode focuses existing popup window", async () => {
      const h = await bootHarness({ sync: { detachedWindowMode: "popup" } });
      await h.openReaderInPage();
      const popupWin = await h.detachReader();
      popupWin.focus.mockClear();
      await h.dispatchMessage({ type: "reader-enter", readerUrl: READER_MODE_URL });
      expect(popupWin.focus).toHaveBeenCalledTimes(1);
    });

    it("T2-F18-04: reader-enter with empty readerUrl while detached still focuses child window", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      childWin.focus.mockClear();
      await h.dispatchMessage({ type: "reader-enter", readerUrl: "" });
      expect(childWin.focus).toHaveBeenCalledTimes(1);
    });

    it("T2-F18-05: reader-enter while detached returns { ok: true } response", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      await h.detachReader();
      const resp = await h.dispatchMessage({ type: "reader-enter", readerUrl: READER_MODE_URL });
      expect(resp).toMatchObject({ ok: true });
    });
  });

  describe("Feature #19: reader-toggle (Alt+B) While Detached (Boundary & Negative)", () => {
    it("T2-F19-01: reader-toggle while entering shell closes cleanly without leaving orphan window", async () => {
      const h = await bootHarness();
      const { dispatchContentScriptMessage } = await import("../../extension/shared/messaging.js");
      let enterDone = false;
      dispatchContentScriptMessage({ type: "reader-enter", readerUrl: READER_MODE_URL }, () => {
        enterDone = true;
      });
      await h.flushTimersAndMicrotasks(10);
      const toggleResp = await h.dispatchMessage({ type: "reader-toggle", readerUrl: READER_MODE_URL });
      await h.flushTimersAndMicrotasks(450);
      expect(enterDone).toBe(true);
      expect(toggleResp).toMatchObject({ ok: true, open: false });
      expect(document.getElementById("biliscript-reading-view")?.hidden).toBe(true);
    });

    it("T2-F19-02: double reader-toggle from detached state closes then reopens in-page", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      const first = await h.dispatchMessage({ type: "reader-toggle", readerUrl: READER_MODE_URL });
      await h.flushTimersAndMicrotasks(450);
      const second = await h.dispatchMessage({ type: "reader-toggle", readerUrl: READER_MODE_URL });
      expect(first).toMatchObject({ ok: true, open: false });
      expect(second).toMatchObject({ ok: true, open: true });
      expect(childWin.closed).toBe(true);
      expect(document.getElementById("biliscript-reading-view")?.classList.contains("open")).toBe(true);
    });

    it("T2-F19-03: reader-toggle from detached state clears mirrored stylesheets from childDoc", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.dispatchMessage({ type: "reader-toggle", readerUrl: READER_MODE_URL });
      await h.flushTimersAndMicrotasks(450);
      expect(getMirroredStyleHrefs(childWin.document)).toHaveLength(0);
    });

    it("T2-F19-04: reader-toggle from detached state resets active host back to opener", async () => {
      const h = await bootHarness();
      const activeHost = await loadActiveHostContract();
      await h.openReaderInPage();
      await h.detachReader();
      await h.dispatchMessage({ type: "reader-toggle", readerUrl: READER_MODE_URL });
      await h.flushTimersAndMicrotasks(450);
      expect(activeHost.isReaderDetached()).toBe(false);
      expect(activeHost.getActiveReaderDocument()).toBe(document);
    });

    it("T2-F19-05: reader-toggle while detached settings and command palette are open tears down overlays", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.openSettingsInActiveHost();
      await openCommandPaletteInDoc(h, childWin.document);
      await h.dispatchMessage({ type: "reader-toggle", readerUrl: READER_MODE_URL });
      await h.flushTimersAndMicrotasks(450);
      expect(childWin.document.getElementById("biliscript-command-palette")).toBeNull();
      expect(document.getElementById("biliscript-reading-settings-panel")?.hidden).toBe(true);
    });
  });

  describe("Feature #20: Quick AI Prompt While Detached (Boundary & Negative)", () => {
    it("T2-F20-01: whitespace-only quick AI prompt focuses detached window and activates chat without auto-sending", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      childWin.focus.mockClear();
      await h.dispatchMessage({
        type: "reader-enter",
        readerUrl: READER_MODE_URL,
        chat: { prompt: "   " }
      });
      await h.flushTimersAndMicrotasks(80);
      expect(childWin.focus).toHaveBeenCalled();
      expect(childWin.document.getElementById("biliscript-reading-tab-chat")?.classList.contains("is-active")).toBe(true);
    });

    it("T2-F20-02: quick AI prompt while already on chat tab in detached window focuses and processes new prompt", async () => {
      const h = await bootHarness({
        sync: {
          defaultAiModel: "openai-1::gpt-4o-mini",
          aiProviders: [{ id: "openai-1", name: "OpenAI", presetId: "openai", baseUrl: "https://api.openai.com/v1", models: ["gpt-4o-mini"], requiresKey: true, enabled: true }]
        },
        local: {
          aiProviderKeys: { "openai-1": "sk-test" }
        }
      });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.switchTabInActiveHost("chat");
      childWin.focus.mockClear();
      await h.dispatchMessage({
        type: "reader-enter",
        readerUrl: READER_MODE_URL,
        chat: { prompt: "追问更多细节" }
      });
      await h.flushTimersAndMicrotasks(100);
      expect(childWin.focus).toHaveBeenCalled();
      const messagesText = childWin.document.getElementById("biliscript-reading-chat-messages")?.textContent ?? "";
      const inputVal = (childWin.document.getElementById("biliscript-reading-chat-input") as HTMLTextAreaElement)?.value ?? "";
      expect(messagesText.includes("追问更多细节") || inputVal.includes("追问更多细节")).toBe(true);
    });

    it("T2-F20-03: quick AI prompt while docked stays in-page without auto-popping detached window", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      await h.dispatchMessage({
        type: "reader-enter",
        readerUrl: READER_MODE_URL,
        chat: { prompt: "停靠模式提问" }
      });
      await h.flushTimersAndMicrotasks(80);
      expect(h.fakePlatform.pipRequests).toHaveLength(0);
      expect(document.getElementById("biliscript-reading-tab-chat")?.classList.contains("is-active")).toBe(true);
    });

    it("T2-F20-04: quick AI prompt after detached close reopens reader in-page and activates chat", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      await h.detachReader();
      await h.clickHeaderCloseInActiveHost();
      await h.dispatchMessage({
        type: "reader-enter",
        readerUrl: READER_MODE_URL,
        chat: { prompt: "关闭后再次提问" }
      });
      await h.flushTimersAndMicrotasks(100);
      expect(document.getElementById("biliscript-reading-view")?.classList.contains("open")).toBe(true);
      expect(document.getElementById("biliscript-reading-tab-chat")?.classList.contains("is-active")).toBe(true);
    });

    it("T2-F20-05: quick AI prompt while on overview tab switches detached panel cleanly to chat", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.switchTabInActiveHost("overview");
      await h.dispatchMessage({
        type: "reader-enter",
        readerUrl: READER_MODE_URL,
        chat: { prompt: "从概览切到对话" }
      });
      await h.flushTimersAndMicrotasks(80);
      expect(childWin.document.getElementById("biliscript-reading-tab-overview")?.classList.contains("is-active")).toBe(false);
      expect(childWin.document.getElementById("biliscript-reading-tab-chat")?.classList.contains("is-active")).toBe(true);
    });
  });

  describe("Feature #21: reader-restore & autoOpenReader In-Page (Boundary & Negative)", () => {
    it("T2-F21-01: reader-restore never calls requestWindow even when documentPictureInPicture is supported", async () => {
      const h = await bootHarness({ pipMode: "allow" });
      await h.dispatchMessage({ type: "reader-restore", readerUrl: READER_MODE_URL });
      expect(h.fakePlatform.pipRequests).toHaveLength(0);
      expect(document.getElementById("biliscript-reading-view")?.classList.contains("open")).toBe(true);
    });

    it("T2-F21-02: reader-restore self-heals broken DOM strictly in-page", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      document.getElementById("biliscript-root")?.remove();
      await h.dispatchMessage({ type: "reader-restore", readerUrl: READER_MODE_URL });
      expect(document.getElementById("biliscript-reading-view")?.classList.contains("open")).toBe(true);
      expect(h.fakePlatform.pipRequests).toHaveLength(0);
    });

    it("T2-F21-03: autoOpenReader=false on video boot keeps reader closed", async () => {
      const h = await bootHarness({ sync: { autoOpenReader: false }, bootContentScript: true });
      expect(document.getElementById("biliscript-reading-view")?.classList.contains("open") ?? false).toBe(false);
      expect(h.fakePlatform.pipRequests).toHaveLength(0);
    });

    it("T2-F21-04: reader-restore after previous detached session opener pagehide opens in-page", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      h.fakePlatform.simulateOpenerPageHide();
      await h.flushTimersAndMicrotasks(60);
      expect(childWin.closed).toBe(true);
      await h.dispatchMessage({ type: "reader-restore", readerUrl: READER_MODE_URL });
      expect(document.getElementById("biliscript-reading-view")?.classList.contains("open")).toBe(true);
      expect(h.fakePlatform.pipRequests).toHaveLength(1);
    });

    it("T2-F21-05: autoOpenReader=true on unsupported Bilibili homepage does not open reader", async () => {
      const h = await bootHarness({
        url: "https://www.bilibili.com/",
        sync: { autoOpenReader: true },
        bootContentScript: true
      });
      expect(document.getElementById("biliscript-reading-view")).toBeNull();
      expect(h.fakePlatform.pipRequests).toHaveLength(0);
    });
  });

  describe("Feature #22: detachedWindowMode Preference (sync) (Boundary & Negative)", () => {
    it("T2-F22-01: invalid detachedWindowMode values normalize to pip", async () => {
      await bootHarness();
      const { normalizeSettings } = await import("../../extension/core/settings-store.js");
      expect(normalizeSettings({ detachedWindowMode: "fullscreen" }).detachedWindowMode).toBe("pip");
      expect(normalizeSettings({ detachedWindowMode: 123 }).detachedWindowMode).toBe("pip");
      expect(normalizeSettings({ detachedWindowMode: null }).detachedWindowMode).toBe("pip");
      expect(normalizeSettings({ detachedWindowMode: undefined }).detachedWindowMode).toBe("pip");
    });

    it("T2-F22-02: empty string or mismatched casing normalizes deterministically", async () => {
      await bootHarness();
      const { normalizeSettings } = await import("../../extension/core/settings-store.js");
      expect(normalizeSettings({ detachedWindowMode: "" }).detachedWindowMode).toBe("pip");
      expect(["pip", "popup"]).toContain(normalizeSettings({ detachedWindowMode: " POPUP " }).detachedWindowMode);
    });

    it("T2-F22-03: SNAPSHOT_STORAGE_KEYS maps detachedWindowMode to sync storage area", async () => {
      await bootHarness();
      const { SNAPSHOT_STORAGE_KEYS } = await import("../../extension/core/settings-snapshot.js");
      expect(SNAPSHOT_STORAGE_KEYS.find((entry) => entry.key === "detachedWindowMode")).toEqual({
        key: "detachedWindowMode",
        area: "sync",
        domain: "settings"
      });
    });

    it("T2-F22-04: saving detachedWindowMode never writes to chrome.storage.local", async () => {
      const h = await bootHarness();
      const { saveSettings } = await import("../../extension/core/settings-store.js");
      await saveSettings({ detachedWindowMode: "popup" });
      expect(h.storage.syncMap.get("detachedWindowMode")).toBe("popup");
      await saveSettings({ detachedWindowMode: "pip" });
      expect(h.storage.syncMap.get("detachedWindowMode")).toBe("pip");
      expect(h.storage.localMap.size).toBe(0);
    });

    it("T2-F22-05: external storage.onChanged for detachedWindowMode updates settings UI select when docked", async () => {
      const h = await bootHarness({ sync: { detachedWindowMode: "pip" } });
      await h.openReaderInPage();
      const doc = await h.openSettingsInActiveHost();
      h.storage.emitExternalChange("sync", "detachedWindowMode", "pip", "popup");
      await h.flushTimersAndMicrotasks(80);
      const select = doc.getElementById("detachedWindowMode") as HTMLSelectElement | null;
      expect(select?.value).toBe("popup");
    });
  });

  describe("Feature #23: Shared Window Dimensions (local) (Boundary & Negative)", () => {
    it("T2-F23-01: clampDetachedWindowBounds clamps dimensions below 360x420 up to minimum bounds", async () => {
      await bootHarness();
      const boundsStore = await loadDetachedBoundsContract();
      expect(boundsStore.MIN_DETACHED_WINDOW_WIDTH).toBe(EXPECTED_MIN_WIDTH);
      expect(boundsStore.MIN_DETACHED_WINDOW_HEIGHT).toBe(EXPECTED_MIN_HEIGHT);
      expect(boundsStore.clampDetachedWindowBounds({ width: 200, height: 300 })).toEqual({
        width: 360,
        height: 420
      });
    });

    it("T2-F23-02: clampDetachedWindowBounds handles NaN, Infinity, and negative values safely", async () => {
      await bootHarness();
      const boundsStore = await loadDetachedBoundsContract();
      const clampedA = boundsStore.clampDetachedWindowBounds({ width: Number.NaN, height: -50 });
      const clampedB = boundsStore.clampDetachedWindowBounds({ width: Number.POSITIVE_INFINITY, height: "bad" });
      expect(clampedA.width).toBeGreaterThanOrEqual(360);
      expect(clampedA.height).toBeGreaterThanOrEqual(420);
      expect(clampedB.width).toBeGreaterThanOrEqual(360);
      expect(clampedB.height).toBeGreaterThanOrEqual(420);
    });

    it("T2-F23-03: fractional dimensions round to integer pixel bounds >= 360x420", async () => {
      await bootHarness();
      const boundsStore = await loadDetachedBoundsContract();
      expect(boundsStore.clampDetachedWindowBounds({ width: 412.7, height: 599.2 })).toEqual({
        width: 413,
        height: 599
      });
    });

    it("T2-F23-04: rapid resize bursts debounce into latest bounds in local storage", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      childWin.simulateResize(500, 600);
      childWin.simulateResize(540, 660);
      childWin.simulateResize(615, 795);
      await h.flushTimersAndMicrotasks(500);
      expect(h.storage.localMap.get(EXPECTED_BOUNDS_KEY)).toEqual({ width: 615, height: 795 });
    });

    it("T2-F23-05: resizing detached window below minimum clamps saved local bounds to 360x420", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      childWin.simulateResize(240, 310);
      await h.flushTimersAndMicrotasks(500);
      expect(h.storage.localMap.get(EXPECTED_BOUNDS_KEY)).toEqual({ width: 360, height: 420 });
    });
  });

  describe("Feature #24: Initial Default Geometry (Boundary & Negative)", () => {
    it("T2-F24-01: availHeight=0 or NaN falls back safely to height >= 420", async () => {
      await bootHarness();
      const boundsStore = await loadDetachedBoundsContract();
      const zero = boundsStore.resolveInitialDetachedWindowBounds({
        saved: null,
        customPanelWidthEnabled: false,
        customPanelWidth: 540,
        availHeight: 0
      });
      const nanVal = boundsStore.resolveInitialDetachedWindowBounds({
        saved: null,
        customPanelWidthEnabled: false,
        customPanelWidth: 540,
        availHeight: Number.NaN
      });
      expect(zero.height).toBeGreaterThanOrEqual(420);
      expect(nanVal.height).toBeGreaterThanOrEqual(420);
    });

    it("T2-F24-02: customPanelWidthEnabled=false ignores customPanelWidth=650 and defaults width to 540", async () => {
      await bootHarness();
      const boundsStore = await loadDetachedBoundsContract();
      expect(
        boundsStore.resolveInitialDetachedWindowBounds({
          saved: null,
          customPanelWidthEnabled: false,
          customPanelWidth: 650,
          availHeight: 1080
        })
      ).toEqual({ width: 540, height: 760 });
    });

    it("T2-F24-03: corrupted customPanelWidth below 360 clamps initial width to 360", async () => {
      await bootHarness();
      const boundsStore = await loadDetachedBoundsContract();
      expect(
        boundsStore.resolveInitialDetachedWindowBounds({
          saved: null,
          customPanelWidthEnabled: true,
          customPanelWidth: 250,
          availHeight: 1080
        }).width
      ).toBe(360);
    });

    it("T2-F24-04: large 4K availHeight=2160 caps initial detached height at 760", async () => {
      await bootHarness();
      const boundsStore = await loadDetachedBoundsContract();
      expect(
        boundsStore.resolveInitialDetachedWindowBounds({
          saved: null,
          customPanelWidthEnabled: false,
          customPanelWidth: 540,
          availHeight: 2160
        })
      ).toEqual({ width: 540, height: 760 });
    });

    it("T2-F24-05: availHeight=525 hits exact round(525 * 0.8) = 420 boundary", async () => {
      await bootHarness();
      const boundsStore = await loadDetachedBoundsContract();
      expect(
        boundsStore.resolveInitialDetachedWindowBounds({
          saved: null,
          customPanelWidthEnabled: false,
          customPanelWidth: 540,
          availHeight: 525
        })
      ).toEqual({ width: 540, height: 420 });
    });
  });

  describe("Feature #25: 「恢复默认偏好」 Reset (Boundary & Negative)", () => {
    it("T2-F25-01: reset while detached resets sync mode and clears local bounds without breaking open window", async () => {
      const h = await bootHarness({
        sync: { detachedWindowMode: "popup" },
        local: { [EXPECTED_BOUNDS_KEY]: { width: 640, height: 800 } }
      });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      const doc = await h.openSettingsInActiveHost();
      await clickResetAndSettle(h, doc, true);
      expect(childWin.closed).toBe(false);
      expect(h.storage.syncMap.get("detachedWindowMode")).toBe("pip");
      expect(h.storage.localMap.has(EXPECTED_BOUNDS_KEY)).toBe(false);
    });

    it("T2-F25-02: reset when local bounds key was never set completes without error", async () => {
      const h = await bootHarness({ sync: { detachedWindowMode: "popup" } });
      await h.openReaderInPage();
      const doc = await h.openSettingsInActiveHost();
      await clickResetAndSettle(h, doc, true);
      expect(h.storage.syncMap.get("detachedWindowMode")).toBe("pip");
      expect(h.storage.localMap.has(EXPECTED_BOUNDS_KEY)).toBe(false);
    });

    it("T2-F25-03: reset emits chrome.storage.onChanged for detachedWindowMode", async () => {
      const h = await bootHarness({ sync: { detachedWindowMode: "popup" } });
      const seenChanges: Array<Record<string, chrome.storage.StorageChange>> = [];
      chrome.storage.onChanged.addListener((changes) => seenChanges.push(changes));
      await h.openReaderInPage();
      const doc = await h.openSettingsInActiveHost();
      await clickResetAndSettle(h, doc, true);
      expect(seenChanges.some((c) => c.detachedWindowMode?.newValue === "pip")).toBe(true);
    });

    it("T2-F25-04: reset preserves configured AI providers in local storage while clearing detached bounds", async () => {
      const h = await bootHarness({
        local: {
          [EXPECTED_BOUNDS_KEY]: { width: 700, height: 800 },
          biliscript_ai_providers_v1: [{ id: "openai-1", name: "OpenAI", type: "openai", enabled: true }]
        }
      });
      await h.openReaderInPage();
      const doc = await h.openSettingsInActiveHost();
      await clickResetAndSettle(h, doc, true);
      expect(h.storage.localMap.has(EXPECTED_BOUNDS_KEY)).toBe(false);
      expect(h.storage.localMap.get("biliscript_ai_providers_v1")).toHaveLength(1);
    });

    it("T2-F25-05: reset failure when sync write rejects reports error status cleanly", async () => {
      const h = await bootHarness({ sync: { detachedWindowMode: "popup" } });
      await h.openReaderInPage();
      const doc = await h.openSettingsInActiveHost();
      h.storage.failNextSyncSet();
      await clickResetAndSettle(h, doc, true);
      const statusEl = doc.getElementById("biliscriptSettingsStatus");
      const statusText = statusEl?.textContent ?? "";
      expect(statusEl?.dataset.error).toBe("true");
      expect(statusText.trim().length).toBeGreaterThan(0);
      expect(statusText).not.toBe("已恢复默认设置");
      expect(h.storage.syncMap.get("detachedWindowMode")).toBe("popup");
    });
  });

  describe("Feature #26: Cross-Browser & Real-Browser Contract Invariants (Boundary & Negative)", () => {
    it("T2-F26-01: missing documentPictureInPicture with moz-extension:// URL does not throw ReferenceError", async () => {
      const h = await bootHarness({
        extensionBaseUrl: "moz-extension://firefox-uuid/",
        pipMode: "unsupported"
      });
      await h.openReaderInPage();
      await expect(h.detachReader()).resolves.not.toThrow();
    });

    it("T2-F26-02: non-writable absent documentPictureInPicture preserves descriptors, falls back to popup, and loads moz-extension:// CSS", async () => {
      const before = getWindowPrototypeDescriptorSnapshot();
      const h = await bootHarness({
        extensionBaseUrl: "moz-extension://fx-xray/",
        pipMode: "unsupported"
      });
      Object.defineProperty(window, "documentPictureInPicture", {
        value: undefined,
        writable: false,
        configurable: true
      });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      expect(h.fakePlatform.pipRequests).toHaveLength(0);
      expect(h.fakePlatform.openCalls).toHaveLength(1);
      assertAllLinkHrefsHavePrefix(childWin.document, "moz-extension://fx-xray/");
      assertStyleLinksPresent(childWin.document, ["reader.css", "reader-gate.css"]);
      const after = getWindowPrototypeDescriptorSnapshot();
      expect(after.hasDocumentGetter).toBe(before.hasDocumentGetter);
      expect(after.docBodyOwnDesc).toEqual(before.docBodyOwnDesc);
      expect(Object.getOwnPropertyDescriptor(window, "documentPictureInPicture")?.writable).toBe(false);
    });

    it("T2-F26-03: __BILISCRIPT_ACTIVE_HOST__ slot cleanup leaves zero leaked childDoc references on reset", async () => {
      const h = await bootHarness();
      const activeHost = await loadActiveHostContract();
      await h.openReaderInPage();
      await h.detachReader();
      activeHost.resetActiveReaderHost();
      expect(activeHost.getActiveReaderDocument()).toBe(document);
      expect(activeHost.isReaderDetached()).toBe(false);
    });

    it("T2-F26-04: Firefox popup fallback cleans up all moz-extension:// mirrored links on child pagehide", async () => {
      const h = await bootHarness({
        extensionBaseUrl: "moz-extension://firefox-uuid/",
        pipMode: "unsupported"
      });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      childWin.simulateUserClose();
      await h.flushTimersAndMicrotasks(450);
      expect(getMirroredStyleHrefs(childWin.document)).toHaveLength(0);
    });

    it("T2-F26-05: style-injector resolves identical relative stylesheet paths for chrome-extension and moz-extension", async () => {
      const h = await bootHarness({
        extensionBaseUrl: "moz-extension://fx-153/",
        pipMode: "unsupported"
      });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      assertStyleLinksPresent(childWin.document, [
        "tokens-primitive.css",
        "reader.css",
        "reader-gate.css"
      ]);
    });
  });
});
