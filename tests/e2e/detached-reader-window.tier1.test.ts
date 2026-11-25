import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL } from "../setup.js";
import {
  assertMirroredStylesWithoutExtensionLinks,
  assertHeaderButtonOrder,
  assertStyleLinksPresent,
  assertZeroUnwrappedScrollbars,
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
  triggerPlayerAiQuickAction
} from "./helpers/detached-assertions.js";
import {
  EXPECTED_BOUNDS_KEY,
  EXPECTED_DEFAULT_MODE,
  EXPECTED_DETACH_BTN_ID,
  EXPECTED_MIN_HEIGHT,
  EXPECTED_MIN_WIDTH,
  loadActiveHostContract,
  loadDetachedBoundsContract,
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

    it("T1-F09-02: syncStylesToDocument is idempotent without creating duplicate style nodes", async () => {
      const h = await bootHarness();
      const styleInjector = await loadStyleInjectorContract();
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      const beforeCount = getMirroredStyleHrefs(childWin.document).length;
      await styleInjector.syncStylesToDocument(childWin.document);
      await styleInjector.syncStylesToDocument(childWin.document);
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
    it("T1-F26-01: Firefox detached child mirrors styles cleanly without moz-extension:// link tags", async () => {
      const h = await bootHarness({
        extensionBaseUrl: "moz-extension://firefox-test-uuid/",
        pipMode: "unsupported"
      });
      await h.openReaderInPage();
      const childWin = await h.detachReader();
      assertMirroredStylesWithoutExtensionLinks(childWin.document);
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

    it("T1-F26-04: deriveFirefoxManifest omits web_accessible_resources, sets strict_min_version >= 153.0, and strips tts/offscreen/live", async () => {
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
      expect(derived.host_permissions).not.toContain("https://live.bilibili.com/*");
      expect(derived.web_accessible_resources).toBeUndefined();
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
