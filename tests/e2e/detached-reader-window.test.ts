import { readFileSync } from "node:fs";
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
  getFirstOverviewChapter,
  getFirstSubtitleItem,
  getMirroredStyleHrefs,
  getReadingViewAnchorVars,
  getWindowPrototypeDescriptorSnapshot,
  openCommandPaletteInDoc,
  openExplainCardFromSelection,
  openQuoteShareModalInDoc,
  setSettingsCheckboxValue,
  setSettingsRangeValue,
  setSettingsSelectValue,
  triggerPlayerAiQuickAction,
  triggerSubtitleSelection
} from "./helpers/detached-assertions.js";
import {
  EXPECTED_BOUNDS_KEY,
  EXPECTED_DEFAULT_MODE,
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
  type BootOptions,
  type DetachedE2EHarness
} from "./helpers/detached-e2e-harness.js";

let activeHarness: DetachedE2EHarness | null = null;

beforeAll(async () => {
  await Promise.all([
    import("../../extension/reader/shell.js"),
    import("../../extension/ui/ui-renderer.js"),
    import("../../extension/reader/lifecycle.js"),
    import("../../extension/ui/settings-panel.js"),
    import("../../extension/core/settings-snapshot.js")
  ]);
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

describe("Tier 1: Category-Partition Equivalence Coverage", () => {
  describe("Feature #1: pip Mode Host Factory", () => {
    it("T1-F01-01: default pip detach requests Document PiP with disallowReturnToOpener=false", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      await h.detachReader();
      expect(h.fakePlatform.pipRequests).toHaveLength(1);
      expect(h.fakePlatform.pipRequests[0]).toMatchObject({
        disallowReturnToOpener: false
      });
      expect(h.fakePlatform.pipRequests[0].width).toBeGreaterThanOrEqual(EXPECTED_MIN_WIDTH);
      expect(h.fakePlatform.pipRequests[0].height).toBeGreaterThanOrEqual(EXPECTED_MIN_HEIGHT);
      expect(h.fakePlatform.openCalls).toHaveLength(0);
    });

    it("T1-F01-02: pip detach transfers single #biliscript-reading-view root to child document", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const openerRoot = document.getElementById("biliscript-reading-view");
      const childWin = await h.detachReader();
      const childRoot = childWin.document.getElementById("biliscript-reading-view");
      expect(openerRoot).not.toBeNull();
      expect(childRoot).toBe(openerRoot);
      expect(childRoot?.ownerDocument).toBe(childWin.document);
      expect(document.getElementById("biliscript-reading-view")).toBeNull();
    });

    it("T1-F01-03: unsupported documentPictureInPicture silently falls back to popup window.open", async () => {
      const h = await bootHarness({ pipMode: "unsupported" });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      expect(h.fakePlatform.pipRequests).toHaveLength(0);
      expect(h.fakePlatform.openCalls).toHaveLength(1);
      expect(h.fakePlatform.openCalls[0].url).toBe("about:blank");
      expect(h.fakePlatform.openCalls[0].features).toContain("popup");
      expect(childWin.document.getElementById("biliscript-reading-view")).not.toBeNull();
    });

    it("T1-F01-04: rejected requestWindow silently falls back to popup window.open", async () => {
      const h = await bootHarness({ pipMode: "reject" });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      expect(h.fakePlatform.pipRequests).toHaveLength(1);
      expect(h.fakePlatform.openCalls).toHaveLength(1);
      expect(childWin.document.getElementById("biliscript-reading-view")).not.toBeNull();
    });

    it("T1-F01-05: pip detach focuses the newly opened child window", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      expect(childWin.focus).toHaveBeenCalled();
      expect(h.fakePlatform.getLastFocusedWindow()).toBe(childWin);
    });
  });

  describe("Feature #2: popup Mode Host Factory", () => {
    it("T1-F02-01: popup mode calls window.open with about:blank and popup features", async () => {
      const h = await bootHarness({ sync: { detachedWindowMode: "popup" } });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      expect(h.fakePlatform.openCalls).toHaveLength(1);
      expect(h.fakePlatform.openCalls[0].url).toBe("about:blank");
      expect(h.fakePlatform.openCalls[0].features).toContain("popup=yes");
      expect(h.fakePlatform.openCalls[0].features).toContain("resizable=yes");
      expect(childWin.document.getElementById("biliscript-reading-view")).not.toBeNull();
    });

    it("T1-F02-02: popup mode bypasses documentPictureInPicture.requestWindow", async () => {
      const h = await bootHarness({ sync: { detachedWindowMode: "popup" } });
      await h.openReaderInPage();
      await h.detachReader();
      expect(h.fakePlatform.pipRequests).toHaveLength(0);
    });

    it("T1-F02-03: popup detach moves #biliscript-reading-view into popup document body", async () => {
      const h = await bootHarness({ sync: { detachedWindowMode: "popup" } });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      expect(childWin.document.body.contains(childWin.document.getElementById("biliscript-reading-view"))).toBe(true);
      expect(document.getElementById("biliscript-reading-view")).toBeNull();
    });

    it("T1-F02-04: popup detach calls focus on the opened popup window", async () => {
      const h = await bootHarness({ sync: { detachedWindowMode: "popup" } });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      expect(childWin.focus).toHaveBeenCalled();
    });

    it("T1-F02-05: popup window redocks panel cleanly back to opener document", async () => {
      const h = await bootHarness({ sync: { detachedWindowMode: "popup" } });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.redockReader();
      expect(childWin.closed).toBe(true);
      expect(document.getElementById("biliscript-reading-view")).not.toBeNull();
      expect(childWin.document.getElementById("biliscript-reading-view")).toBeNull();
    });
  });

  describe("Feature #3: Opener Unload / Close Guard", () => {
    it("T1-F03-01: opener pagehide closes active detached pip window", async () => {
      const h = await bootHarness({ pipMode: "allow" });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      h.fakePlatform.simulateOpenerPageHide();
      await h.flushTimersAndMicrotasks(40);
      expect(childWin.closed).toBe(true);
      expect(childWin.close).toHaveBeenCalled();
    });

    it("T1-F03-02: opener pagehide closes active detached popup window", async () => {
      const h = await bootHarness({ sync: { detachedWindowMode: "popup" } });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      h.fakePlatform.simulateOpenerPageHide();
      await h.flushTimersAndMicrotasks(40);
      expect(childWin.closed).toBe(true);
      expect(childWin.close).toHaveBeenCalled();
    });

    it("T1-F03-03: opener pagehide resets active host context back to opener", async () => {
      const h = await bootHarness();
      const activeHost = await loadActiveHostContract();
      await h.openReaderInPage();
      await h.detachReader();
      expect(activeHost.isReaderDetached()).toBe(true);
      h.fakePlatform.simulateOpenerPageHide();
      await h.flushTimersAndMicrotasks(40);
      expect(activeHost.isReaderDetached()).toBe(false);
      expect(activeHost.getActiveReaderDocument()).toBe(document);
    });

    it("T1-F03-04: after redocking, opener pagehide does not call close again on old child", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.redockReader();
      childWin.close.mockClear();
      h.fakePlatform.simulateOpenerPageHide();
      await h.flushTimersAndMicrotasks(40);
      expect(childWin.close).not.toHaveBeenCalled();
    });

    it("T1-F03-05: opener pagehide after mode switch closes the new active window", async () => {
      const h = await bootHarness({ pipMode: "allow", popupMode: "allow" });
      await h.openReaderInPage();
      const firstWin = await h.detachReader();
      await switchDetachedModeInSettings(h, "popup");
      const secondWin = h.fakePlatform.getCurrentActiveChild();
      expect(secondWin).not.toBe(firstWin);
      h.fakePlatform.simulateOpenerPageHide();
      await h.flushTimersAndMicrotasks(40);
      expect(secondWin?.closed).toBe(true);
    });
  });

  describe("Feature #4: Child pagehide Redock Alignment", () => {
    it("T1-F04-01: user closing pip window redocks reader in-page and preserves opener reader attrs", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      childWin.simulateUserClose();
      await h.flushTimersAndMicrotasks(450);
      expect(document.documentElement.getAttribute("data-biliscript-reader-mode")).toBe("1");
      expect(document.body.getAttribute("data-biliscript-reader-mode")).toBe("1");
      expect(document.body.getAttribute("data-biliscript-reading-active")).toBe("1");
    });

    it("T1-F04-02: user closing popup window redocks reader in-page", async () => {
      const h = await bootHarness({ sync: { detachedWindowMode: "popup" } });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      childWin.simulateUserClose();
      await h.flushTimersAndMicrotasks(450);
      expect(document.documentElement.getAttribute("data-biliscript-reader-mode")).toBe("1");
      expect(document.body.getAttribute("data-biliscript-reading-active")).toBe("1");
      expect(document.getElementById("biliscript-reading-view")?.hidden).toBe(false);
    });

    it("T1-F04-03: child pagehide restores open #biliscript-reading-view root inside opener body", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const originalView = document.getElementById("biliscript-reading-view");
      const childWin = await h.detachReader();
      childWin.simulateUserClose();
      await h.flushTimersAndMicrotasks(450);
      const restoredView = document.getElementById("biliscript-reading-view");
      expect(restoredView).toBe(originalView);
      expect(restoredView?.hidden).toBe(false);
      expect(restoredView?.classList.contains("open")).toBe(true);
    });

    it("T1-F04-04: child pagehide clears mirrored styles, resets active host to opener, and restores header buttons", async () => {
      const h = await bootHarness();
      const activeHost = await loadActiveHostContract();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      childWin.simulateUserClose();
      await h.flushTimersAndMicrotasks(450);
      expect(getMirroredStyleHrefs(childWin.document)).toHaveLength(0);
      expect(activeHost.isReaderDetached()).toBe(false);
      expect(activeHost.getActiveReaderDocument()).toBe(document);
      expect((document.getElementById(EXPECTED_DETACH_BTN_ID) as HTMLButtonElement).hidden).toBe(false);
      expect((document.getElementById("biliscript-reading-close-btn") as HTMLButtonElement).hidden).toBe(false);
    });

    it("T1-F04-05: intentional redock closes child window without exiting reader shell", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.redockReader();
      expect(childWin.closed).toBe(true);
      const view = document.getElementById("biliscript-reading-view");
      expect(view?.hidden).toBe(false);
      expect(view?.classList.contains("open")).toBe(true);
      expect(document.documentElement.getAttribute("data-biliscript-reader-mode")).toBe("1");
    });
  });

  describe("Feature #5: In-Place Mode Switch", () => {
    it("T1-F05-01: switching pip to popup in detached settings migrates panel into new popup window", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const pipWin = await h.detachReader();
      await switchDetachedModeInSettings(h, "popup");
      const popupWin = h.fakePlatform.getCurrentActiveChild();
      expect(popupWin).not.toBeNull();
      expect(popupWin).not.toBe(pipWin);
      expect(h.fakePlatform.openCalls).toHaveLength(1);
      expect(popupWin?.document.getElementById("biliscript-reading-view")).not.toBeNull();
    });

    it("T1-F05-02: switching popup to pip in detached settings migrates panel into new pip window", async () => {
      const h = await bootHarness({ sync: { detachedWindowMode: "popup" } });
      await h.openReaderInPage();
      const popupWin = await h.detachReader();
      await switchDetachedModeInSettings(h, "pip");
      const pipWin = h.fakePlatform.getCurrentActiveChild();
      expect(pipWin).not.toBeNull();
      expect(pipWin).not.toBe(popupWin);
      expect(h.fakePlatform.pipRequests).toHaveLength(1);
      expect(pipWin?.document.getElementById("biliscript-reading-view")).not.toBeNull();
    });

    it("T1-F05-03: successful mode switch closes previous window after new window opens", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const firstWin = await h.detachReader();
      await switchDetachedModeInSettings(h, "popup");
      expect(firstWin.closed).toBe(true);
      expect(firstWin.close).toHaveBeenCalled();
    });

    it("T1-F05-04: active tab and chat draft survive in-place mode switch", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const firstWin = await h.detachReader();
      await h.switchTabInActiveHost("chat");
      const draftInput = firstWin.document.getElementById("biliscript-reading-chat-input") as HTMLTextAreaElement;
      draftInput.value = "跨模式保留草稿";
      await switchDetachedModeInSettings(h, "popup");
      const secondWin = h.fakePlatform.getCurrentActiveChild()!;
      const migratedInput = secondWin.document.getElementById("biliscript-reading-chat-input") as HTMLTextAreaElement;
      expect(migratedInput.value).toBe("跨模式保留草稿");
      expect(secondWin.document.getElementById("biliscript-reading-tab-chat")?.classList.contains("is-active")).toBe(true);
    });

    it("T1-F05-05: mirrored stylesheets and theme datasets survive in-place mode switch", async () => {
      const h = await bootHarness({ sync: { readerTheme: "dark", readerThemeUserSet: true, readerPalette: "editorial" } });
      await h.openReaderInPage();
      await h.detachReader();
      await switchDetachedModeInSettings(h, "popup");
      const popupWin = h.fakePlatform.getCurrentActiveChild()!;
      assertStyleLinksPresent(popupWin.document, ["reader.css", "reader-settings-shell.css"]);
      expect(popupWin.document.documentElement.dataset.biliscriptReaderTheme).toBe("dark");
      expect(popupWin.document.documentElement.dataset.biliscriptReaderPalette).toBe("editorial");
    });
  });

  describe("Feature #6: Active Reader Host Context", () => {
    it("T1-F06-01: defaults to opener document and window when docked", async () => {
      await bootHarness();
      const activeHost = await loadActiveHostContract();
      expect(activeHost.isReaderDetached()).toBe(false);
      expect(activeHost.getOpenerDocument()).toBe(document);
      expect(activeHost.getOpenerWindow()).toBe(window);
      expect(activeHost.getActiveReaderDocument()).toBe(document);
      expect(activeHost.getActiveReaderWindow()).toBe(window);
    });

    it("T1-F06-02: updates active document and window to detached child on detach", async () => {
      const h = await bootHarness();
      const activeHost = await loadActiveHostContract();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      expect(activeHost.isReaderDetached()).toBe(true);
      expect(activeHost.getActiveReaderDocument()).toBe(childWin.document);
      expect(activeHost.getActiveReaderWindow()).toBe(childWin as unknown as Window);
    });

    it("T1-F06-03: opener getters continue returning main page document and window while detached", async () => {
      const h = await bootHarness();
      const activeHost = await loadActiveHostContract();
      await h.openReaderInPage();
      await h.detachReader();
      expect(activeHost.getOpenerDocument()).toBe(document);
      expect(activeHost.getOpenerWindow()).toBe(window);
    });

    it("T1-F06-04: activeById queries active reader document rather than opener when detached", async () => {
      const h = await bootHarness();
      const activeHost = await loadActiveHostContract();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      const view = activeHost.activeById("biliscript-reading-view");
      expect(view).not.toBeNull();
      expect(view?.ownerDocument).toBe(childWin.document);
    });

    it("T1-F06-05: onActiveHostChange notifies subscribers on detach and redock", async () => {
      const h = await bootHarness();
      const activeHost = await loadActiveHostContract();
      const events: Array<{ detached: boolean; doc: Document }> = [];
      const unsub = activeHost.onActiveHostChange((ctx) => {
        events.push({ detached: ctx.detached, doc: ctx.doc });
      });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.redockReader();
      unsub();
      expect(events).toEqual([
        { detached: true, doc: childWin.document },
        { detached: false, doc: document }
      ]);
    });
  });

  describe("Feature #7: Panel-Domain Overlays & Interactions", () => {
    it("T1-F07-01: settings drawer opens and navigates subpages inside detached child document", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.openSettingsInActiveHost();
      const settingsPanel = childWin.document.getElementById("biliscript-reading-settings-panel");
      expect(settingsPanel?.hidden).toBe(false);
      childWin.document.getElementById("openAppearanceBtn")?.click();
      await h.flushTimersAndMicrotasks(80);
      expect(childWin.document.getElementById("biliscriptSettingsSubpageAppearance")?.hidden).toBe(false);
    });

    it("T1-F07-02: custom-select opens and dismisses via outside click inside detached child document", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.openSettingsInActiveHost();
      childWin.document.getElementById("openAppearanceBtn")?.click();
      await h.flushTimersAndMicrotasks(80);
      const trigger = childWin.document.querySelector<HTMLElement>(
        "#biliscriptSettingsSubpageAppearance .custom-select-trigger"
      );
      expect(trigger).not.toBeNull();
      trigger?.click();
      await h.flushTimersAndMicrotasks(40);
      expect(
        childWin.document.querySelector('.custom-select-dropdown:not([hidden]):not([data-inline="true"])')
      ).not.toBeNull();
      expect(trigger?.getAttribute("aria-expanded")).toBe("true");
      childWin.document.body.click();
      await h.flushTimersAndMicrotasks(40);
      expect(
        childWin.document.querySelector('.custom-select-dropdown:not([hidden]):not([data-inline="true"])')
      ).toBeNull();
      expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    });

    it("T1-F07-03: confirmDialog mounts inside detached child document and resolves confirm", async () => {
      const h = await bootHarness({ sync: { detachedWindowMode: "popup" } });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.openSettingsInActiveHost();
      childWin.document.getElementById("biliscriptSettingsResetBtn")?.click();
      await h.flushTimersAndMicrotasks(40);
      const dialog = childWin.document.querySelector(".confirm-dialog");
      expect(dialog).not.toBeNull();
      expect(document.querySelector(".confirm-dialog")).toBeNull();
      childWin.document.querySelector<HTMLButtonElement>(".confirm-dialog-confirm")?.click();
      await h.flushTimersAndMicrotasks(100);
      expect(childWin.document.querySelector(".confirm-dialog")).toBeNull();
    });

    it("T1-F07-04: Ctrl+K opens command palette inside detached child document", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      const palette = await openCommandPaletteInDoc(h, childWin.document);
      expect(palette).not.toBeNull();
      expect(palette?.ownerDocument).toBe(childWin.document);
      expect(document.getElementById("biliscript-command-palette")).toBeNull();
    });

    it("T1-F07-05: selection explain card and quote share modal mount and close on Esc inside childDoc", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      const explainCard = await openExplainCardFromSelection(h, childWin.document, childWin);
      expect(explainCard?.hidden).toBe(false);
      expect(explainCard?.ownerDocument).toBe(childWin.document);
      await dispatchEscapeInDoc(h, childWin.document);
      expect(explainCard?.hidden).toBe(true);
      const quoteDialog = await openQuoteShareModalInDoc(h, childWin.document);
      expect(quoteDialog?.ownerDocument).toBe(childWin.document);
      await dispatchEscapeInDoc(h, childWin.document);
      expect(childWin.document.querySelector(".biliscript-quote-share-dialog")).toBeNull();
    });
  });

  describe("Feature #8: Opener-Bound Bilibili Probes", () => {
    it("T1-F08-01: runtime video lookup resolves opener <video> while detached", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      await h.detachReader();
      const { getRuntimeVideoElement } = await import("../../extension/bilibili/video-probe.js");
      expect(getRuntimeVideoElement()).toBe(h.video);
    });

    it("T1-F08-02: script right-column anchor probe stays bound to opener document", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      await h.detachReader();
      const { hasScriptAnchor } = await import("../../extension/reader/script-host.js");
      expect(hasScriptAnchor()).toBe(true);
    });

    it("T1-F08-03: fullscreen state probe reads opener player container while detached", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      await h.detachReader();
      const { isPlayerFullscreen } = await import("../../extension/bilibili/fullscreen.js");
      expect(isPlayerFullscreen()).toBe(false);
      await h.toggleWebpageFullscreen(true);
      expect(isPlayerFullscreen()).toBe(true);
    });

    it("T1-F08-04: Bilibili host theme detection reads opener attributes while detached", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      await h.detachReader();
      document.documentElement.setAttribute("data-theme", "dark");
      const { detectBilibiliHostTheme } = await import("../../extension/shared/host-theme.js");
      expect(detectBilibiliHostTheme()).toBe("dark");
    });

    it("T1-F08-05: player AI quick action button mounts in opener control bar", async () => {
      const h = await bootHarness();
      const { startPlayerAiQuickAction } = await import("../../extension/ai/player-ai.js");
      startPlayerAiQuickAction();
      await h.flushTimersAndMicrotasks(80);
      const btn = document.getElementById("biliscript-player-ai-quick-action");
      expect(btn).not.toBeNull();
      expect(btn?.ownerDocument).toBe(document);
    });
  });

  describe("Feature #9: Stylesheet Registry & Mirroring", () => {
    it("T1-F09-01: detaching mirrors all active reader stylesheets into child document head", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      assertStyleLinksPresent(childWin.document, [
        "tokens-primitive.css",
        "reader.css",
        "reader-gate.css"
      ]);
    });

    it("T1-F09-02: syncStylesToDocument is idempotent without creating duplicate link nodes", async () => {
      const h = await bootHarness();
      const styleInjector = await loadStyleInjectorContract();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      const beforeCount = getMirroredStyleHrefs(childWin.document).length;
      styleInjector.syncStylesToDocument(childWin.document);
      styleInjector.syncStylesToDocument(childWin.document);
      expect(getMirroredStyleHrefs(childWin.document)).toHaveLength(beforeCount);
    });

    it("T1-F09-03: opening settings while detached immediately mirrors reader-settings CSS to childDoc", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.openSettingsInActiveHost();
      assertStyleLinksPresent(childWin.document, [
        "reader-settings-shell.css",
        "reader-settings-rows.css",
        "reader-settings-providers.css"
      ]);
    });

    it("T1-F09-04: activating chat tab while detached immediately mirrors reader-chat CSS to childDoc", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.switchTabInActiveHost("chat");
      assertStyleLinksPresent(childWin.document, [
        "github-markdown.css",
        "github-markdown-theme.css",
        "reader-chat.css"
      ]);
    });

    it("T1-F09-05: redocking calls clearMirroredStyles leaving childDoc head empty of extension styles", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      expect(getMirroredStyleHrefs(childWin.document).length).toBeGreaterThan(0);
      await h.redockReader();
      expect(getMirroredStyleHrefs(childWin.document)).toHaveLength(0);
    });
  });

  describe("Feature #10: Live Presentation & Token Mirroring", () => {
    it("T1-F10-01: clicking header theme toggle while detached updates childDoc and readingView datasets", async () => {
      const h = await bootHarness({ sync: { readerTheme: "light" } });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.clickHeaderThemeInActiveHost();
      const view = childWin.document.getElementById("biliscript-reading-view");
      expect(view?.dataset.theme).toBe("dark");
      expect(childWin.document.documentElement.dataset.biliscriptReaderTheme).toBe("dark");
    });

    it("T1-F10-02: switching readerPalette in detached settings updates childDoc palette dataset", async () => {
      const h = await bootHarness({ sync: { readerPalette: "flyme" } });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.openSettingsInActiveHost();
      childWin.document.getElementById("openAppearanceBtn")?.click();
      await h.flushTimersAndMicrotasks(60);
      await setSettingsSelectValue(h, childWin.document, "readerPalette", "editorial");
      expect(childWin.document.documentElement.dataset.biliscriptReaderPalette).toBe("editorial");
      expect(childWin.document.getElementById("biliscript-reading-view")?.dataset.palette).toBe("editorial");
    });

    it("T1-F10-03: typography sliders in detached settings update CSS custom properties on readingView", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.openSettingsInActiveHost();
      childWin.document.getElementById("openAppearanceBtn")?.click();
      await h.flushTimersAndMicrotasks(60);
      await setSettingsRangeValue(h, childWin.document, "readerFontSizeScale", 120);
      const view = childWin.document.getElementById("biliscript-reading-view")!;
      expect(view.style.getPropertyValue("--biliscript-reader-font-scale")).toBe("1.2");
    });

    it("T1-F10-04: chatInputGlow and reduceTransparency toggles update readingView attributes in childDoc", async () => {
      const h = await bootHarness({ sync: { chatInputGlow: true, reduceTransparency: false } });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.openSettingsInActiveHost();
      childWin.document.getElementById("openAppearanceBtn")?.click();
      await h.flushTimersAndMicrotasks(60);
      await setSettingsCheckboxValue(h, childWin.document, "chatInputGlow", false);
      await setSettingsCheckboxValue(h, childWin.document, "reduceTransparency", true);
      const view = childWin.document.getElementById("biliscript-reading-view")!;
      expect(view.dataset.chatInputGlow).toBe("0");
      expect(view.dataset.biliscriptReduceTransparency).toBe("1");
    });

    it("T1-F10-05: opener Bilibili host theme mutation updates detached window when mode is bilibili", async () => {
      const h = await bootHarness({ sync: { readerTheme: "bilibili" } });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      document.documentElement.setAttribute("data-theme", "dark");
      await h.flushTimersAndMicrotasks(80);
      expect(childWin.document.documentElement.dataset.biliscriptReaderTheme).toBe("dark");
    });
  });

  describe("Feature #11: Detached Viewport CSS & Firefox Scrollbars", () => {
    it("T1-F11-01: detaching clears fixed anchor CSS variables and float attr on readingView", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const dockedView = document.getElementById("biliscript-reading-view")!;
      expect(getReadingViewAnchorVars(dockedView).length).toBeGreaterThan(0);
      const childWin = await h.detachReader();
      const detachedView = childWin.document.getElementById("biliscript-reading-view")!;
      expect(getReadingViewAnchorVars(detachedView)).toEqual([]);
      expect(detachedView.hasAttribute("data-biliscript-script-float")).toBe(false);
    });

    it("T1-F11-02: detached readingView positions cleanly inside child viewport without anchor coords or float attr", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      const detachedView = childWin.document.getElementById("biliscript-reading-view")!;
      expect(detachedView.ownerDocument).toBe(childWin.document);
      expect(detachedView.parentElement).toBe(childWin.document.body);
      expect(detachedView.style.getPropertyValue("--biliscript-script-left")).toBe("");
      expect(detachedView.style.getPropertyValue("--biliscript-script-top")).toBe("");
      expect(detachedView.hasAttribute("data-biliscript-script-float")).toBe(false);
      expect(detachedView.classList.contains("open")).toBe(true);
      assertStyleLinksPresent(childWin.document, ["reader.css", "reader-gate.css"]);
      const cssRulesText =
        readFileSync("extension/entry/styles/reader.css", "utf8") +
        readFileSync("extension/entry/styles/reader-gate.css", "utf8");
      expect(cssRulesText).toMatch(/detached/i);
    });

    it("T1-F11-03: reader stylesheets wrap scrollbar-width and scrollbar-color in @supports (-moz-appearance: none)", () => {
      assertZeroUnwrappedScrollbars([
        "extension/entry/styles/reader.css",
        "extension/entry/styles/reader-chat.css",
        "extension/entry/styles/reader-settings-shell.css",
        "extension/entry/styles/bilingual-subtitles.css"
      ]);
    });

    it("T1-F11-04: detached child document root receives data-biliscript-reader-mode=1", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      expect(childWin.document.documentElement.getAttribute("data-biliscript-reader-mode")).toBe("1");
    });

    it("T1-F11-05: redocking restores script-host anchor coordinates on opener", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      await h.detachReader();
      await h.redockReader();
      const redockedView = document.getElementById("biliscript-reading-view")!;
      expect(getReadingViewAnchorVars(redockedView).length).toBeGreaterThan(0);
    });
  });

  describe("Feature #12: Serialized Shell Transitions", () => {
    it("T1-F12-01: single #biliscript-reading-view DOM node identity preserved across enter->detach->redock->close", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const rootNode = document.getElementById("biliscript-reading-view");
      const childWin = await h.detachReader();
      expect(childWin.document.getElementById("biliscript-reading-view")).toBe(rootNode);
      await h.redockReader();
      expect(document.getElementById("biliscript-reading-view")).toBe(rootNode);
      await h.clickHeaderCloseInActiveHost();
      expect(document.getElementById("biliscript-reading-view")).toBe(rootNode);
    });

    it("T1-F12-02: active overview tab is preserved across detach and redock", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      await h.switchTabInActiveHost("overview");
      const childWin = await h.detachReader();
      expect(childWin.document.getElementById("biliscript-reading-tab-overview")?.classList.contains("is-active")).toBe(true);
      await h.redockReader();
      expect(document.getElementById("biliscript-reading-tab-overview")?.classList.contains("is-active")).toBe(true);
    });

    it("T1-F12-03: chat input draft survives detach and redock", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      await h.switchTabInActiveHost("chat");
      const input = document.getElementById("biliscript-reading-chat-input") as HTMLTextAreaElement;
      input.value = "未发送的提问草稿";
      const childWin = await h.detachReader();
      expect((childWin.document.getElementById("biliscript-reading-chat-input") as HTMLTextAreaElement).value).toBe("未发送的提问草稿");
      await h.redockReader();
      expect((document.getElementById("biliscript-reading-chat-input") as HTMLTextAreaElement).value).toBe("未发送的提问草稿");
    });

    it("T1-F12-04: concurrent detach and redock calls serialize cleanly on shellTransactionQueue", async () => {
      const h = await bootHarness();
      const shell = await loadShellContract();
      await h.openReaderInPage();
      const detachPromise = shell.detachReaderShell();
      const redockPromise = shell.redockReaderShell();
      await h.flushStyles();
      await h.flushTimersAndMicrotasks(80);
      await Promise.all([detachPromise, redockPromise]);
      expect(document.getElementById("biliscript-reading-view")?.classList.contains("open")).toBe(true);
      expect(h.fakePlatform.getCurrentActiveChild()).toBeNull();
    });

    it("T1-F12-05: concurrent detach and exitReaderShell resolves cleanly in closed state", async () => {
      const h = await bootHarness();
      const shell = await loadShellContract();
      await h.openReaderInPage();
      const detachPromise = shell.detachReaderShell();
      const exitPromise = shell.exitReaderShell();
      await h.flushStyles();
      await h.flushTimersAndMicrotasks(450);
      await Promise.all([detachPromise, exitPromise]);
      expect(h.fakePlatform.getCurrentActiveChild()).toBeNull();
      expect(document.getElementById("biliscript-reading-view")?.hidden).toBe(true);
    });
  });

  describe("Feature #13: In-Page Anchor Pause/Resume & Self-Heal Guard", () => {
    it("T1-F13-01: isReaderShellIntact returns true when open reading view is hosted in detached childDoc", async () => {
      const h = await bootHarness();
      const shell = await loadShellContract();
      await h.openReaderInPage();
      await h.detachReader();
      expect(shell.isReaderShellIntact()).toBe(true);
    });

    it("T1-F13-02: opener resize and scroll events do not write anchor CSS vars while detached", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      window.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("scroll"));
      await h.flushTimersAndMicrotasks(250);
      const detachedView = childWin.document.getElementById("biliscript-reading-view")!;
      expect(getReadingViewAnchorVars(detachedView)).toEqual([]);
    });

    it("T1-F13-03: script-button self-heal interval sees detached shell intact and skips restore/reinject", async () => {
      const h = await bootHarness();
      const { injectScriptButton } = await import("../../extension/ui/script-button.js");
      injectScriptButton();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      const viewBefore = childWin.document.getElementById("biliscript-reading-view");
      await h.flushTimersAndMicrotasks(7000);
      expect(h.fakePlatform.getCurrentActiveChild()).toBe(childWin);
      expect(childWin.closed).toBe(false);
      expect(childWin.document.getElementById("biliscript-reading-view")).toBe(viewBefore);
      expect(document.querySelectorAll("#biliscript-script-button")).toHaveLength(1);
    });

    it("T1-F13-04: redocking resumes script-host anchoring and restores anchor vars", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      await h.detachReader();
      await h.redockReader();
      window.dispatchEvent(new Event("resize"));
      await h.flushTimersAndMicrotasks(60);
      const view = document.getElementById("biliscript-reading-view")!;
      expect(getReadingViewAnchorVars(view).length).toBeGreaterThan(0);
    });

    it("T1-F13-05: closing from detached mode restores #biliscript-script-button on opener", async () => {
      const h = await bootHarness();
      const { injectScriptButton } = await import("../../extension/ui/script-button.js");
      injectScriptButton();
      await h.openReaderInPage();
      await h.detachReader();
      await h.clickHeaderCloseInActiveHost();
      await h.flushTimersAndMicrotasks(1500);
      expect(document.getElementById("biliscript-script-button")).not.toBeNull();
    });
  });

  describe("Feature #14: Fixed 4-Button Header Contract", () => {
    it("T1-F14-01: header action bar renders exactly 4 borderless icon buttons in fixed order", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      assertHeaderButtonOrder(document);
    });

    it("T1-F14-02: when docked, detach button shows pop-out label and aria-label", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const btn = document.getElementById(EXPECTED_DETACH_BTN_ID);
      expect(btn).not.toBeNull();
      const label = `${btn?.getAttribute("aria-label") ?? ""} ${btn?.getAttribute("title") ?? ""}`;
      expect(label).toContain("弹出");
    });

    it("T1-F14-03: when detached in pip, detach and close buttons are hidden; popup keeps detach visible and hides close", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const pipWin = await h.detachReader();
      assertHeaderButtonOrder(pipWin.document);
      const pipDetach = pipWin.document.getElementById(EXPECTED_DETACH_BTN_ID) as HTMLButtonElement;
      const pipClose = pipWin.document.getElementById("biliscript-reading-close-btn") as HTMLButtonElement;
      const label = `${pipDetach.getAttribute("aria-label") ?? ""} ${pipDetach.title ?? ""}`;
      expect(label).toContain("归位");
      expect(pipDetach.hidden).toBe(true);
      expect(pipClose.hidden).toBe(true);
      expect((pipWin.document.getElementById("biliscript-reading-theme-select") as HTMLButtonElement).hidden).toBe(false);
      expect((pipWin.document.getElementById("biliscript-reading-settings-btn") as HTMLButtonElement).hidden).toBe(false);

      await switchDetachedModeInSettings(h, "popup");
      const popupWin = h.fakePlatform.getCurrentActiveChild()!;
      assertHeaderButtonOrder(popupWin.document);
      expect((popupWin.document.getElementById(EXPECTED_DETACH_BTN_ID) as HTMLButtonElement).hidden).toBe(false);
      expect((popupWin.document.getElementById("biliscript-reading-close-btn") as HTMLButtonElement).hidden).toBe(true);
    });

    it("T1-F14-04: pip external close redocks and restores visible controls; popup header redock button toggles back", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const pipWin = await h.detachReader();
      pipWin.simulateUserClose();
      await h.flushTimersAndMicrotasks(80);
      expect(pipWin.closed).toBe(true);
      expect((document.getElementById(EXPECTED_DETACH_BTN_ID) as HTMLButtonElement).hidden).toBe(false);
      expect((document.getElementById("biliscript-reading-close-btn") as HTMLButtonElement).hidden).toBe(false);

      await switchDetachedModeInSettings(h, "popup");
      const popupWin = await h.detachReader();
      const popupDetach = popupWin.document.getElementById(EXPECTED_DETACH_BTN_ID) as HTMLButtonElement;
      expect(popupDetach.hidden).toBe(false);
      popupDetach.click();
      await h.flushStyles();
      await h.flushTimersAndMicrotasks(80);
      expect(popupWin.closed).toBe(true);
      expect((document.getElementById(EXPECTED_DETACH_BTN_ID) as HTMLButtonElement).hidden).toBe(false);
      expect((document.getElementById("biliscript-reading-close-btn") as HTMLButtonElement).hidden).toBe(false);
    });

    it("T1-F14-05: theme and settings remain interactive inside pip window, and external redock restores in-page close button", async () => {
      const h = await bootHarness({ sync: { readerTheme: "light" } });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      expect((childWin.document.getElementById("biliscript-reading-close-btn") as HTMLButtonElement).hidden).toBe(true);
      await h.clickHeaderThemeInActiveHost();
      expect(childWin.document.documentElement.dataset.biliscriptReaderTheme).toBe("dark");
      await h.openSettingsInActiveHost();
      expect(childWin.document.getElementById("biliscript-reading-settings-panel")?.hidden).toBe(false);
      childWin.simulateUserClose();
      await h.flushTimersAndMicrotasks(80);
      expect(childWin.closed).toBe(true);
      expect(document.getElementById("biliscript-reading-view")?.hidden).toBe(false);
      expect((document.getElementById("biliscript-reading-close-btn") as HTMLButtonElement).hidden).toBe(false);
      await h.clickHeaderCloseInActiveHost();
      expect(document.getElementById("biliscript-reading-view")?.hidden).toBe(true);
    });
  });

  describe("Feature #15: Timestamp Seek Without Opener Focus Theft", () => {
    it("T1-F15-01: clicking subtitle timestamp in detached window seeks opener <video>", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      const item = getFirstSubtitleItem(childWin.document, 1);
      expect(item).not.toBeNull();
      item?.click();
      await h.flushTimersAndMicrotasks(40);
      expect(h.video.currentTime).toBe(30);
    });

    it("T1-F15-02: clicking subtitle timestamp while opener <video> is paused calls video.play()", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      getFirstSubtitleItem(childWin.document, 2)?.click();
      await h.flushTimersAndMicrotasks(40);
      expect(h.video.currentTime).toBe(90);
      expect(h.videoPlaySpy).toHaveBeenCalled();
    });

    it("T1-F15-03: clicking overview chapter timestamp in detached window seeks opener <video>", async () => {
      const h = await bootHarness({
        sync: {
          defaultAiModel: "openai-1::gpt-4o-mini",
          aiProviders: [{ id: "openai-1", name: "OpenAI", presetId: "openai", baseUrl: "https://api.openai.com/v1", models: ["gpt-4o-mini"], requiresKey: true, enabled: true }]
        },
        local: {
          aiProviderKeys: { "openai-1": "sk-test" }
        }
      });
      const { state } = await import("../../extension/core/state.js");
      const { buildClipOverviewIdentity, saveAnalysisFinal } = await import("../../extension/ai/l1-chapter-index.js");
      const identity = buildClipOverviewIdentity(state.clip);
      await saveAnalysisFinal(identity.finalKey, {
        summary: "测试全片概览简介",
        chapters: [
          { from: 0, to: 30, title: "开篇简介", summary: "开篇" },
          { from: 90, to: 180, title: "核心原理", summary: "核心" }
        ],
        quotes: []
      });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.switchTabInActiveHost("overview");
      await h.flushTimersAndMicrotasks(60);
      const chapter = getFirstOverviewChapter(childWin.document, 1);
      expect(chapter).not.toBeNull();
      chapter?.click();
      await h.flushTimersAndMicrotasks(40);
      expect(h.video.currentTime).toBe(90);
    });

    it("T1-F15-04: timestamp seek while detached does not call opener window.focus()", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      h.openerFocusSpy.mockClear();
      getFirstSubtitleItem(childWin.document, 1)?.click();
      await h.flushTimersAndMicrotasks(40);
      expect(h.openerFocusSpy).not.toHaveBeenCalled();
    });

    it("T1-F15-05: timestamp seek retains/restores focus on detached child window", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      childWin.focus.mockClear();
      getFirstSubtitleItem(childWin.document, 1)?.click();
      await h.flushTimersAndMicrotasks(40);
      expect(childWin.focus).toHaveBeenCalled();
      expect(h.fakePlatform.getLastFocusedWindow()).toBe(childWin);
    });
  });

  describe("Feature #16: Fullscreen Retention", () => {
    it("T1-F16-01: entering Bilibili webpage fullscreen keeps detached pip window open", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.toggleWebpageFullscreen(true);
      expect(childWin.closed).toBe(false);
      expect(childWin.document.getElementById("biliscript-reading-view")?.classList.contains("open")).toBe(true);
    });

    it("T1-F16-02: exiting webpage fullscreen keeps detached window open", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.toggleWebpageFullscreen(true);
      await h.toggleWebpageFullscreen(false);
      expect(childWin.closed).toBe(false);
    });

    it("T1-F16-03: browser fullscreenElement change keeps detached popup window open", async () => {
      const h = await bootHarness({ sync: { detachedWindowMode: "popup" } });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      const player = document.getElementById("bilibili-player");
      Object.defineProperty(document, "fullscreenElement", { value: player, configurable: true });
      document.dispatchEvent(new Event("fullscreenchange"));
      await h.flushTimersAndMicrotasks(50);
      expect(childWin.closed).toBe(false);
      Object.defineProperty(document, "fullscreenElement", { value: null, configurable: true });
      document.dispatchEvent(new Event("fullscreenchange"));
      await h.flushTimersAndMicrotasks(50);
      expect(childWin.closed).toBe(false);
    });

    it("T1-F16-04: fullscreen transitions do not trigger exitReaderShell or redockReaderShell", async () => {
      const h = await bootHarness();
      const activeHost = await loadActiveHostContract();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.toggleWebpageFullscreen(true);
      expect(activeHost.isReaderDetached()).toBe(true);
      expect(document.getElementById("biliscript-reading-view")).toBeNull();
      expect(childWin.document.getElementById("biliscript-reading-view")).not.toBeNull();
    });

    it("T1-F16-05: opener <video> seek binding continues working after fullscreen toggle", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.toggleWebpageFullscreen(true);
      await h.toggleWebpageFullscreen(false);
      getFirstSubtitleItem(childWin.document, 1)?.click();
      await h.flushTimersAndMicrotasks(40);
      expect(h.video.currentTime).toBe(30);
    });
  });

  describe("Feature #17: SPA Video / 分P Retention", () => {
    it("T1-F17-01: SPA navigation to new bvid keeps detached pip window open", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.triggerSpaNavigation("https://www.bilibili.com/video/BV1nextvideo99/", {
        bvid: "BV1nextvideo99",
        cid: "2002",
        title: "下一集视频",
        subtitleText: "新视频第一句字幕"
      });
      expect(childWin.closed).toBe(false);
      expect(h.fakePlatform.pipRequests).toHaveLength(1);
    });

    it("T1-F17-02: SPA navigation to part ?p=2 keeps detached popup window open", async () => {
      const h = await bootHarness({ sync: { detachedWindowMode: "popup" } });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.triggerSpaNavigation("https://www.bilibili.com/video/BV1test000000/?p=2", {
        bvid: "BV1test000000",
        cid: "1002",
        title: "P2 分集标题",
        subtitleText: "分P第二集字幕"
      });
      expect(childWin.closed).toBe(false);
      expect(h.fakePlatform.openCalls).toHaveLength(1);
    });

    it("T1-F17-03: SPA video switch refreshes clip content inside detached child document", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.triggerSpaNavigation("https://www.bilibili.com/video/BV1refresh88/", {
        bvid: "BV1refresh88",
        cid: "3003",
        title: "刷新后标题",
        subtitleText: "刷新后的字幕内容"
      });
      expect(childWin.document.getElementById("biliscript-reading-subtitle")?.textContent).toContain("刷新后的字幕内容");
    });

    it("T1-F17-04: SPA navigation to unsupported Bilibili homepage exits shell and closes detached window", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.triggerSpaNavigation("https://www.bilibili.com/");
      await h.flushTimersAndMicrotasks(450);
      expect(childWin.closed).toBe(true);
      expect(document.getElementById("biliscript-reading-view")?.hidden).toBe(true);
    });

    it("T1-F17-05: active host remains detached across supported SPA video navigation", async () => {
      const h = await bootHarness();
      const activeHost = await loadActiveHostContract();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.triggerSpaNavigation("https://www.bilibili.com/video/BV1keephost77/", {
        bvid: "BV1keephost77",
        cid: "4004"
      });
      expect(activeHost.isReaderDetached()).toBe(true);
      expect(activeHost.getActiveReaderDocument()).toBe(childWin.document);
    });
  });

  describe("Feature #18: reader-enter While Detached", () => {
    it("T1-F18-01: reader-enter while detached focuses existing detached window", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      childWin.focus.mockClear();
      await h.dispatchMessage({ type: "reader-enter", readerUrl: READER_MODE_URL });
      expect(childWin.focus).toHaveBeenCalledTimes(1);
    });

    it("T1-F18-02: reader-enter while detached does not call requestWindow or window.open again", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      await h.detachReader();
      await h.dispatchMessage({ type: "reader-enter", readerUrl: READER_MODE_URL });
      expect(h.fakePlatform.pipRequests).toHaveLength(1);
      expect(h.fakePlatform.openCalls).toHaveLength(0);
    });

    it("T1-F18-03: reader-enter while detached keeps #biliscript-reading-view inside childDoc", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.dispatchMessage({ type: "reader-enter", readerUrl: READER_MODE_URL });
      expect(childWin.document.getElementById("biliscript-reading-view")).not.toBeNull();
      expect(document.getElementById("biliscript-reading-view")).toBeNull();
    });

    it("T1-F18-04: reader-enter while detached focuses existing window without closing open settings drawer", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.openSettingsInActiveHost();
      childWin.focus.mockClear();
      await h.dispatchMessage({ type: "reader-enter", readerUrl: READER_MODE_URL });
      await h.flushTimersAndMicrotasks(40);
      expect(childWin.focus).toHaveBeenCalledTimes(1);
      expect(childWin.document.getElementById("biliscript-reading-settings-panel")?.hidden).toBe(false);
      expect(h.fakePlatform.pipRequests).toHaveLength(1);
    });

    it("T1-F18-05: reader-enter from closed state opens strictly in-page without auto-pop", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      expect(document.getElementById("biliscript-reading-view")?.classList.contains("open")).toBe(true);
      expect(h.fakePlatform.pipRequests).toHaveLength(0);
      expect(h.fakePlatform.openCalls).toHaveLength(0);
    });
  });

  describe("Feature #19: reader-toggle (Alt+B) While Detached", () => {
    it("T1-F19-01: reader-toggle while detached in pip closes window and exits reader shell", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.dispatchMessage({ type: "reader-toggle", readerUrl: READER_MODE_URL });
      await h.flushTimersAndMicrotasks(450);
      expect(childWin.closed).toBe(true);
      expect(document.getElementById("biliscript-reading-view")?.hidden).toBe(true);
    });

    it("T1-F19-02: reader-toggle while detached in popup closes popup window and exits shell", async () => {
      const h = await bootHarness({ sync: { detachedWindowMode: "popup" } });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.dispatchMessage({ type: "reader-toggle", readerUrl: READER_MODE_URL });
      await h.flushTimersAndMicrotasks(450);
      expect(childWin.closed).toBe(true);
      expect(document.documentElement.getAttribute("data-biliscript-reader-mode")).toBeNull();
    });

    it("T1-F19-03: reader-toggle returns { ok: true, open: false } when closing detached window", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      await h.detachReader();
      const resp = await h.dispatchMessage({ type: "reader-toggle", readerUrl: READER_MODE_URL });
      await h.flushTimersAndMicrotasks(450);
      expect(resp).toMatchObject({ ok: true, open: false });
    });

    it("T1-F19-04: subsequent reader-toggle reopens reader in-page returning { ok: true, open: true }", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      await h.detachReader();
      await h.dispatchMessage({ type: "reader-toggle", readerUrl: READER_MODE_URL });
      await h.flushTimersAndMicrotasks(450);
      const reopenResp = await h.dispatchMessage({ type: "reader-toggle", readerUrl: READER_MODE_URL });
      expect(reopenResp).toMatchObject({ ok: true, open: true });
      expect(document.getElementById("biliscript-reading-view")?.classList.contains("open")).toBe(true);
      expect(h.fakePlatform.pipRequests).toHaveLength(1);
    });

    it("T1-F19-05: reader-toggle preserves hidden #biliscript-reading-view root in opener body", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const root = document.getElementById("biliscript-reading-view");
      await h.detachReader();
      await h.dispatchMessage({ type: "reader-toggle", readerUrl: READER_MODE_URL });
      await h.flushTimersAndMicrotasks(450);
      expect(document.getElementById("biliscript-reading-view")).toBe(root);
      expect(root?.hidden).toBe(true);
    });
  });

  describe("Feature #20: Quick AI Prompt While Detached", () => {
    it("T1-F20-01: reader-enter with chat prompt while detached focuses child window", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      childWin.focus.mockClear();
      await h.dispatchMessage({
        type: "reader-enter",
        readerUrl: READER_MODE_URL,
        chat: { prompt: "总结这个视频的核心观点" }
      });
      await h.flushTimersAndMicrotasks(80);
      expect(childWin.focus).toHaveBeenCalled();
    });

    it("T1-F20-02: quick AI prompt while detached switches active tab to chat in childDoc", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      await h.dispatchMessage({
        type: "reader-enter",
        readerUrl: READER_MODE_URL,
        chat: { prompt: "提炼三个重点" }
      });
      await h.flushTimersAndMicrotasks(80);
      expect(childWin.document.getElementById("biliscript-reading-tab-chat")?.classList.contains("is-active")).toBe(true);
      expect(childWin.document.getElementById("biliscript-reading-tabbody-chat")?.hidden).toBe(false);
    });

    it("T1-F20-03: quick AI prompt executes and records prompt in detached chat session", async () => {
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
      await h.dispatchMessage({
        type: "reader-enter",
        readerUrl: READER_MODE_URL,
        chat: { prompt: "解释第二章节" }
      });
      await h.flushTimersAndMicrotasks(120);
      const messagesText = childWin.document.getElementById("biliscript-reading-chat-messages")?.textContent ?? "";
      const inputVal = (childWin.document.getElementById("biliscript-reading-chat-input") as HTMLTextAreaElement)?.value ?? "";
      expect(messagesText.includes("解释第二章节") || inputVal.includes("解释第二章节")).toBe(true);
    });

    it("T1-F20-04: quick AI prompt while detached does not open a second detached window", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      await h.detachReader();
      await h.dispatchMessage({
        type: "reader-enter",
        readerUrl: READER_MODE_URL,
        chat: { prompt: "列出关键词" }
      });
      await h.flushTimersAndMicrotasks(80);
      expect(h.fakePlatform.pipRequests).toHaveLength(1);
      expect(h.fakePlatform.openCalls).toHaveLength(0);
    });

    it("T1-F20-05: player-ai-quick-action runtime message routes to detached chat tab", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      childWin.focus.mockClear();
      await triggerPlayerAiQuickAction(h, "来自播放器快捷按钮的提问");
      expect(childWin.focus).toHaveBeenCalled();
      expect(childWin.document.getElementById("biliscript-reading-tab-chat")?.classList.contains("is-active")).toBe(true);
    });
  });

  describe("Feature #21: reader-restore & autoOpenReader In-Page", () => {
    it("T1-F21-01: reader-restore opens strictly in-page without invoking PiP or popup", async () => {
      const h = await bootHarness();
      const activeHost = await loadActiveHostContract();
      await h.dispatchMessage({ type: "reader-restore", readerUrl: READER_MODE_URL });
      expect(document.getElementById("biliscript-reading-view")?.classList.contains("open")).toBe(true);
      expect(activeHost.isReaderDetached()).toBe(false);
      expect(h.fakePlatform.pipRequests).toHaveLength(0);
      expect(h.fakePlatform.openCalls).toHaveLength(0);
    });

    it("T1-F21-02: autoOpenReader=true on content script boot opens strictly in-page", async () => {
      const h = await bootHarness({
        sync: { autoOpenReader: true, detachedWindowMode: "pip" },
        bootContentScript: true
      });
      expect(document.getElementById("biliscript-reading-view")?.classList.contains("open")).toBe(true);
      expect(h.fakePlatform.pipRequests).toHaveLength(0);
      expect(h.fakePlatform.openCalls).toHaveLength(0);
    });

    it("T1-F21-03: ?biliscript_reader=1 URL on boot restores strictly in-page", async () => {
      const h = await bootHarness({
        url: READER_MODE_URL,
        bootContentScript: true
      });
      expect(document.getElementById("biliscript-reading-view")?.classList.contains("open")).toBe(true);
      expect(h.fakePlatform.pipRequests).toHaveLength(0);
      expect(h.fakePlatform.openCalls).toHaveLength(0);
    });

    it("T1-F21-04: autoOpenReader=true on SPA video navigation opens in-page without auto-pop", async () => {
      const h = await bootHarness({ sync: { autoOpenReader: true } });
      await h.triggerSpaNavigation("https://www.bilibili.com/video/BV1autoopen02/", {
        bvid: "BV1autoopen02",
        cid: "5005"
      });
      expect(document.getElementById("biliscript-reading-view")?.classList.contains("open")).toBe(true);
      expect(h.fakePlatform.pipRequests).toHaveLength(0);
      expect(h.fakePlatform.openCalls).toHaveLength(0);
    });

    it("T1-F21-05: even when detachedWindowMode is popup, reader-restore stays in-page", async () => {
      const h = await bootHarness({ sync: { detachedWindowMode: "popup" } });
      await h.dispatchMessage({ type: "reader-restore", readerUrl: READER_MODE_URL });
      expect(document.getElementById("biliscript-reading-view")?.classList.contains("open")).toBe(true);
      expect(h.fakePlatform.openCalls).toHaveLength(0);
    });
  });

  describe("Feature #22: detachedWindowMode Preference (sync)", () => {
    it("T1-F22-01: DEFAULT_SETTINGS.detachedWindowMode defaults to pip", async () => {
      await bootHarness();
      const { DEFAULT_SETTINGS } = await import("../../extension/core/defaults.js");
      expect(DEFAULT_SETTINGS.detachedWindowMode).toBe(EXPECTED_DEFAULT_MODE);
    });

    it("T1-F22-02: getMergedSettings reads popup from sync and normalizes defaults", async () => {
      await bootHarness({ sync: { detachedWindowMode: "popup" } });
      const { getMergedSettings } = await import("../../extension/core/settings-store.js");
      const merged = await getMergedSettings();
      expect(merged.detachedWindowMode).toBe("popup");
    });

    it("T1-F22-03: saveSettings persists detachedWindowMode to sync only and not local", async () => {
      const h = await bootHarness();
      const { saveSettings } = await import("../../extension/core/settings-store.js");
      await saveSettings({ detachedWindowMode: "popup" });
      expect(h.storage.syncMap.get("detachedWindowMode")).toBe("popup");
      expect(h.storage.localMap.has("detachedWindowMode")).toBe(false);
    });

    it("T1-F22-04: detachedWindowMode is registered in SETTINGS_NORMALIZER_KEYS and not duplicated in passthrough", async () => {
      await bootHarness();
      const { SETTINGS_NORMALIZER_KEYS, SETTINGS_PASSTHROUGH_KEYS } = await import(
        "../../extension/core/settings-store.js"
      );
      expect(SETTINGS_NORMALIZER_KEYS).toContain("detachedWindowMode");
      expect(SETTINGS_PASSTHROUGH_KEYS).not.toContain("detachedWindowMode");
    });

    it("T1-F22-05: settings UI hydrates detachedWindowMode select from sync storage", async () => {
      const h = await bootHarness({ sync: { detachedWindowMode: "popup" } });
      await h.openReaderInPage();
      const doc = await h.openSettingsInActiveHost();
      const select = doc.getElementById("detachedWindowMode") as HTMLSelectElement | null;
      expect(select?.value).toBe("popup");
    });
  });

  describe("Feature #23: Shared Window Dimensions (local)", () => {
    it("T1-F23-01: saveDetachedWindowBounds persists dimensions to chrome.storage.local only", async () => {
      const h = await bootHarness();
      const boundsStore = await loadDetachedBoundsContract();
      await boundsStore.saveDetachedWindowBounds({ width: 610, height: 790 });
      expect(boundsStore.DETACHED_WINDOW_BOUNDS_KEY).toBe(EXPECTED_BOUNDS_KEY);
      expect(h.storage.localMap.get(EXPECTED_BOUNDS_KEY)).toEqual({ width: 610, height: 790 });
      expect(h.storage.syncMap.has(EXPECTED_BOUNDS_KEY)).toBe(false);
    });

    it("T1-F23-02: loadDetachedWindowBounds reads and clamps saved local dimensions", async () => {
      await bootHarness({ local: { [EXPECTED_BOUNDS_KEY]: { width: 580, height: 740 } } });
      const boundsStore = await loadDetachedBoundsContract();
      const loaded = await boundsStore.loadDetachedWindowBounds();
      expect(loaded).toEqual({ width: 580, height: 740 });
    });

    it("T1-F23-03: detached window resize debounces and persists bounds to local storage", async () => {
      const h = await bootHarness();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      childWin.simulateResize(640, 820);
      await h.flushTimersAndMicrotasks(500);
      expect(h.storage.localMap.get(EXPECTED_BOUNDS_KEY)).toEqual({ width: 640, height: 820 });
      expect(h.storage.syncMap.has(EXPECTED_BOUNDS_KEY)).toBe(false);
    });

    it("T1-F23-04: subsequent detach reuses saved local dimensions across sessions", async () => {
      const h = await bootHarness({ local: { [EXPECTED_BOUNDS_KEY]: { width: 660, height: 810 } } });
      await h.openReaderInPage();
      await h.detachReader();
      expect(h.fakePlatform.pipRequests[0]).toMatchObject({ width: 660, height: 810 });
    });

    it("T1-F23-05: pip and popup modes share the same local bounds key", async () => {
      const h = await bootHarness({ pipMode: "allow", popupMode: "allow" });
      await h.openReaderInPage();
      const pipWin = await h.detachReader();
      pipWin.simulateResize(625, 785);
      await h.flushTimersAndMicrotasks(500);
      await h.redockReader();
      await setSettingsSelectValue(h, await h.openSettingsInActiveHost(), "detachedWindowMode", "popup");
      await h.detachReader();
      expect(h.fakePlatform.openCalls[0].features).toContain("width=625");
      expect(h.fakePlatform.openCalls[0].features).toContain("height=785");
    });
  });

  describe("Feature #24: Initial Default Geometry", () => {
    it("T1-F24-01: defaults to 540x760 when custom width disabled and availHeight is 1080", async () => {
      await bootHarness({ availHeight: 1080 });
      const boundsStore = await loadDetachedBoundsContract();
      expect(
        boundsStore.resolveInitialDetachedWindowBounds({
          saved: null,
          customPanelWidthEnabled: false,
          customPanelWidth: 620,
          availHeight: 1080
        })
      ).toEqual({ width: 540, height: 760 });
    });

    it("T1-F24-02: uses enabled customPanelWidth when resolving initial detached width", async () => {
      await bootHarness({ availHeight: 1080 });
      const boundsStore = await loadDetachedBoundsContract();
      expect(
        boundsStore.resolveInitialDetachedWindowBounds({
          saved: null,
          customPanelWidthEnabled: true,
          customPanelWidth: 620,
          availHeight: 1080
        })
      ).toEqual({ width: 620, height: 760 });
    });

    it("T1-F24-03: laptop availHeight=720 computes height = round(720 * 0.8) = 576", async () => {
      await bootHarness({ availHeight: 720 });
      const boundsStore = await loadDetachedBoundsContract();
      expect(
        boundsStore.resolveInitialDetachedWindowBounds({
          saved: null,
          customPanelWidthEnabled: false,
          customPanelWidth: 540,
          availHeight: 720
        })
      ).toEqual({ width: 540, height: 576 });
    });

    it("T1-F24-04: small availHeight=480 clamps height up to minimum 420", async () => {
      await bootHarness({ availHeight: 480 });
      const boundsStore = await loadDetachedBoundsContract();
      expect(
        boundsStore.resolveInitialDetachedWindowBounds({
          saved: null,
          customPanelWidthEnabled: false,
          customPanelWidth: 540,
          availHeight: 480
        })
      ).toEqual({ width: 540, height: 420 });
    });

    it("T1-F24-05: saved local bounds override computed default geometry", async () => {
      await bootHarness({ availHeight: 720 });
      const boundsStore = await loadDetachedBoundsContract();
      expect(
        boundsStore.resolveInitialDetachedWindowBounds({
          saved: { width: 480, height: 690 },
          customPanelWidthEnabled: true,
          customPanelWidth: 640,
          availHeight: 720
        })
      ).toEqual({ width: 480, height: 690 });
    });
  });

  describe("Feature #25: 「恢复默认偏好」 Reset", () => {
    it("T1-F25-01: confirm reset restores detachedWindowMode to pip in chrome.storage.sync", async () => {
      const h = await bootHarness({ sync: { detachedWindowMode: "popup" } });
      await h.openReaderInPage();
      const doc = await h.openSettingsInActiveHost();
      await clickResetAndSettle(h, doc, true);
      expect(h.storage.syncMap.get("detachedWindowMode")).toBe("pip");
    });

    it("T1-F25-02: confirm reset removes saved bounds from chrome.storage.local", async () => {
      const h = await bootHarness({ local: { [EXPECTED_BOUNDS_KEY]: { width: 700, height: 840 } } });
      await h.openReaderInPage();
      const doc = await h.openSettingsInActiveHost();
      await clickResetAndSettle(h, doc, true);
      expect(h.storage.localMap.has(EXPECTED_BOUNDS_KEY)).toBe(false);
    });

    it("T1-F25-03: confirm reset updates detachedWindowMode UI select back to pip", async () => {
      const h = await bootHarness({ sync: { detachedWindowMode: "popup" } });
      await h.openReaderInPage();
      const doc = await h.openSettingsInActiveHost();
      await clickResetAndSettle(h, doc, true);
      const select = doc.getElementById("detachedWindowMode") as HTMLSelectElement | null;
      expect(select?.value).toBe("pip");
    });

    it("T1-F25-04: next detach after reset recalculates initial default geometry", async () => {
      const h = await bootHarness({
        availHeight: 720,
        sync: { detachedWindowMode: "popup" },
        local: { [EXPECTED_BOUNDS_KEY]: { width: 690, height: 850 } }
      });
      await h.openReaderInPage();
      const doc = await h.openSettingsInActiveHost();
      await clickResetAndSettle(h, doc, true);
      await h.detachReader();
      expect(h.fakePlatform.pipRequests[0]).toMatchObject({ width: 540, height: 576 });
    });

    it("T1-F25-05: cancelling reset dialog leaves detachedWindowMode and local bounds untouched", async () => {
      const h = await bootHarness({
        sync: { detachedWindowMode: "popup" },
        local: { [EXPECTED_BOUNDS_KEY]: { width: 650, height: 790 } }
      });
      await h.openReaderInPage();
      const doc = await h.openSettingsInActiveHost();
      await clickResetAndSettle(h, doc, false);
      expect(h.storage.syncMap.get("detachedWindowMode")).toBe("popup");
      expect(h.storage.localMap.get(EXPECTED_BOUNDS_KEY)).toEqual({ width: 650, height: 790 });
    });
  });

  describe("Feature #26: Cross-Browser & Real-Browser Contract Invariants", () => {
    it("T1-F26-01: moz-extension:// style URLs mirror cleanly into detached child head", async () => {
      const h = await bootHarness({
        extensionBaseUrl: "moz-extension://firefox-test-uuid/",
        pipMode: "unsupported"
      });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      assertAllLinkHrefsHavePrefix(childWin.document, "moz-extension://firefox-test-uuid/");
    });

    it("T1-F26-02: Firefox-like environment without documentPictureInPicture completes full detach->redock->close lifecycle", async () => {
      const h = await bootHarness({
        extensionBaseUrl: "moz-extension://firefox-test-uuid/",
        pipMode: "unsupported"
      });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      expect(h.fakePlatform.openCalls).toHaveLength(1);
      await h.redockReader();
      expect(childWin.closed).toBe(true);
      await h.clickHeaderCloseInActiveHost();
      expect(document.getElementById("biliscript-reading-view")?.hidden).toBe(true);
    });

    it("T1-F26-03: __BILISCRIPT_ACTIVE_HOST__ shared slot survives dual-instance module reload while detached", async () => {
      const h = await bootHarness();
      const hostA = await loadActiveHostContract();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      expect(hostA.isReaderDetached()).toBe(true);
      vi.resetModules();
      const hostB = await loadActiveHostContract();
      expect(hostB.isReaderDetached()).toBe(true);
      expect(hostB.getActiveReaderDocument()).toBe(childWin.document);
    });

    it("T1-F26-04: deriveFirefoxManifest exposes entry/styles/* for bilibili, sets strict_min_version >= 153.0, and strips tts/offscreen", async () => {
      const { deriveFirefoxManifest } = await import("../../scripts/firefox-manifest.js");
      const { ASR_PROVIDER_PRESETS, PRESETS } = await import("../../extension/core/presets.js");
      const chromiumManifest = JSON.parse(readFileSync("extension/manifest.json", "utf8")) as {
        permissions: string[];
        host_permissions: string[];
        background: { service_worker?: string; type?: string };
        content_scripts: Array<{ matches: string[] }>;
        web_accessible_resources: Array<{ resources: string[]; matches: string[] }>;
      };
      const derived = deriveFirefoxManifest(chromiumManifest, {
        presets: PRESETS,
        asrPresets: ASR_PROVIDER_PRESETS
      });
      expect(Number.parseFloat(derived.browser_specific_settings.gecko.strict_min_version)).toBeGreaterThanOrEqual(153);
      expect(derived.permissions).not.toContain("tts");
      expect(derived.permissions).not.toContain("offscreen");
      const resources = derived.web_accessible_resources.flatMap((entry: { resources: string[] }) => entry.resources);
      const matches = derived.web_accessible_resources.flatMap((entry: { matches: string[] }) => entry.matches);
      expect(resources).toContain("entry/styles/*");
      expect(matches).toContain("https://www.bilibili.com/*");
      expect(matches).not.toContain("https://live.bilibili.com/*");
    });

    it("T1-F26-05: cross-document transfer keeps opener Window/Document descriptors intact for XrayWrapper safety", async () => {
      const before = getWindowPrototypeDescriptorSnapshot();
      const h = await bootHarness({ pipMode: "unsupported" });
      await h.openReaderInPage();
      await h.detachReader();
      const after = getWindowPrototypeDescriptorSnapshot();
      expect(after.hasDocumentGetter).toBe(before.hasDocumentGetter);
      expect(after.docBodyOwnDesc).toEqual(before.docBodyOwnDesc);
    });
  });
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
    assertAllLinkHrefsHavePrefix(childWin.document, "moz-extension://fx-profile-153/");
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
