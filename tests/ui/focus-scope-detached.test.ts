import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDetachedRealm, type DetachedRealm } from "../helpers/detached-realm.js";
import { ASR_PROVIDER_PRESETS } from "../../extension/core/presets.js";
import * as coreState from "../../extension/core/state.js";
import * as activeHost from "../../extension/shared/active-host.js";
import { ids } from "../../extension/shared/dom-ids.js";
import * as bridgeMod from "../../extension/ui/agent-bridge-install-dialog.js";
import * as confirmMod from "../../extension/ui/confirm-dialog.js";
import * as focusScopeMod from "../../extension/ui/focus-scope.js";
import * as providerEditorMod from "../../extension/ui/provider-editor.js";
import * as settingsPanelMod from "../../extension/ui/settings-panel.js";
import * as themeBtnMod from "../../extension/ui/theme-button.js";
import { resetSettingsPanelState } from "../helpers/reset-settings-panel-state.js";

let realm: DetachedRealm | null = null;

beforeEach(() => {
  resetSettingsPanelState();
});

afterEach(() => {
  realm?.close();
  realm = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ui 核心浮层、弹窗、主题与设置面板的独立宿主迁移", () => {
  it("focusScope 与 mountPanelModalShell 支持跨 Realm 节点并在宿主切换时安全重绑或关闭", async () => {
    realm = createDetachedRealm();

    const readingView = realm.doc.createElement("div");
    readingView.id = ids.readingView;
    const sibling = realm.doc.createElement("div");
    sibling.id = "sibling-panel";
    readingView.appendChild(sibling);
    realm.doc.body.appendChild(readingView);

    activeHost.setActiveReaderHost(realm.doc, realm.win);

    const onRequestDismiss = vi.fn();
    const onForceDismiss = vi.fn();
    const shell = focusScopeMod.mountPanelModalShell({
      hostClassName: "test-modal-host",
      dialogSelector: ".test-dialog",
      html: `<div class="confirm-dialog-mask"></div><section class="test-dialog" tabindex="-1"><button type="button" class="btn-a">A</button><button type="button" class="btn-b">B</button></section>`,
      onRequestDismiss,
      onForceDismiss,
    });

    expect(shell.host.ownerDocument).toBe(realm.doc);
    expect(shell.host instanceof window.HTMLElement).toBe(false);
    expect(sibling.inert).toBe(true);

    const btnA = shell.host.querySelector<HTMLButtonElement>(".btn-a")!;
    const btnB = shell.host.querySelector<HTMLButtonElement>(".btn-b")!;
    btnB.focus();
    const tabEvent = new (realm.win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    realm.doc.dispatchEvent(tabEvent);
    expect(realm.doc.activeElement).toBe(btnA);

    const escEvent = new (realm.win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    realm.doc.dispatchEvent(escEvent);
    expect(onRequestDismiss).toHaveBeenCalledWith("escape");

    const outsideClick = new (realm.win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    realm.doc.body.dispatchEvent(outsideClick);
    expect(onRequestDismiss).toHaveBeenCalledWith("outside-click");

    activeHost.resetActiveReaderHost();
    expect(onForceDismiss).toHaveBeenCalledTimes(1);

    shell.dispose(false);
    expect(sibling.inert).toBe(false);
  });

  it("mountPanelModalShell 在同一文档模型 adoptNode 切换宿主时自动重绑监听而不误关", async () => {

    const readingView = document.createElement("div");
    readingView.id = ids.readingView;
    document.body.appendChild(readingView);

    const onRequestDismiss = vi.fn();
    const onForceDismiss = vi.fn();
    const shell = focusScopeMod.mountPanelModalShell({
      hostClassName: "adopt-modal-host",
      dialogSelector: ".adopt-dialog",
      html: `<div class="confirm-dialog-mask"></div><section class="adopt-dialog" tabindex="-1"><button type="button">OK</button></section>`,
      onRequestDismiss,
      onForceDismiss,
    });

    const detachedDoc = document.implementation.createHTMLDocument("Detached");
    const detachedWin = { closed: false } as unknown as Window;
    detachedDoc.body.appendChild(detachedDoc.adoptNode(readingView));
    activeHost.setActiveReaderHost(detachedDoc, detachedWin);

    expect(onForceDismiss).not.toHaveBeenCalled();

    detachedDoc.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(onRequestDismiss).toHaveBeenCalledWith("escape");

    shell.dispose(false);
  });

  it("confirmDialog 与 agentBridgeInstallDialog 挂载在 detached readingView 并写入 detached 剪贴板", async () => {
    realm = createDetachedRealm();

    const readingView = realm.doc.createElement("div");
    readingView.id = ids.readingView;
    realm.doc.body.appendChild(readingView);
    activeHost.setActiveReaderHost(realm.doc, realm.win);

    const pending = confirmMod.confirmDialogWithResult({ message: "确定操作？" });
    const confirmBtn = readingView.querySelector<HTMLButtonElement>(".confirm-dialog-confirm")!;
    expect(confirmBtn).not.toBeNull();
    confirmBtn.click();
    expect(await pending).toBe("confirmed");

    bridgeMod.openAgentBridgeInstallDialog("http://127.0.0.1:18492");
    const copyBtn = readingView.querySelector<HTMLButtonElement>('[data-agent-install-action="copy"]')!;
    expect(copyBtn).not.toBeNull();
    copyBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(realm.clipboardWriteText).toHaveBeenCalledTimes(1);

    const closeBtn = readingView.querySelector<HTMLButtonElement>('[data-agent-install-action="close"]')!;
    closeBtn.click();
  });

  it("refreshThemeButton 与 renderReaderSettingsPanel 解析 detached 宿主 DOM", async () => {
    realm = createDetachedRealm();

    const themeBtn = realm.doc.createElement("button");
    themeBtn.id = ids.readingThemeSelect;
    const settingsHost = realm.doc.createElement("div");
    settingsHost.id = ids.readingSettingsHost;
    const settingsPanel = realm.doc.createElement("div");
    settingsPanel.id = ids.readingSettingsPanel;
    settingsPanel.hidden = false;
    settingsPanel.appendChild(settingsHost);
    realm.doc.body.append(themeBtn, settingsPanel);

    coreState.state.reader.setTheme("dark");
    activeHost.setActiveReaderHost(realm.doc, realm.win);

    themeBtnMod.refreshThemeButton();
    expect(themeBtn.title).toContain("深色");
    expect(themeBtn.innerHTML).toContain("<svg");

    await settingsPanelMod.renderReaderSettingsPanel();
    expect(settingsHost.dataset.biliscriptSettingsRendered).toBe("1");
    expect(settingsHost.querySelector(`#${ids.readingSettingsBackBtn}`)).not.toBeNull();
  });

  it("confirmDialogWithResult 在死亡窗口 getComputedStyle 抛错时仍可安全 settle 不挂起", async () => {
    realm = createDetachedRealm();

    const readingView = realm.doc.createElement("div");
    readingView.id = ids.readingView;
    const triggerBtn = realm.doc.createElement("button");
    triggerBtn.textContent = "触发";
    readingView.appendChild(triggerBtn);
    realm.doc.body.appendChild(readingView);
    triggerBtn.focus();

    activeHost.setActiveReaderHost(realm.doc, realm.win);
    const pending = confirmMod.confirmDialogWithResult({ message: "Delete?", mountHost: readingView });

    realm.win.getComputedStyle = (() => {
      throw new Error("Dead XrayWrapper: getComputedStyle");
    }) as unknown as Window["getComputedStyle"];

    activeHost.resetActiveReaderHost();

    const result = await Promise.race([
      pending,
      new Promise<string>((resolve) => setTimeout(() => resolve("HUNG"), 50)),
    ]);
    expect(result).toBe("cancelled");
    expect(confirmMod.isConfirmDialogOpen()).toBe(false);
  });

  it("focusScope.dispose 在死亡窗口 getComputedStyle 与 focus 抛错时不向外抛异常", async () => {
    realm = createDetachedRealm();

    const triggerBtn = realm.doc.createElement("button");
    const container = realm.doc.createElement("div");
    container.tabIndex = -1;
    realm.doc.body.append(triggerBtn, container);
    triggerBtn.focus();

    const scope = focusScopeMod.createFocusScope(container, { returnFocus: triggerBtn });
    realm.win.getComputedStyle = (() => {
      throw new Error("Dead XrayWrapper: getComputedStyle");
    }) as unknown as Window["getComputedStyle"];
    triggerBtn.focus = () => {
      throw new Error("Dead XrayWrapper: focus");
    };

    expect(() => scope.dispose(true)).not.toThrow();
  });

  it("confirmDialogWithResult 在 host.isConnected 抛错时仍通过 onForceDismiss 安全 settle", async () => {
    realm = createDetachedRealm();

    const readingView = realm.doc.createElement("div");
    readingView.id = ids.readingView;
    realm.doc.body.appendChild(readingView);

    activeHost.setActiveReaderHost(realm.doc, realm.win);
    const pending = confirmMod.confirmDialogWithResult({ message: "Delete?", mountHost: readingView });
    const host = readingView.querySelector(".confirm-dialog-host")!;
    Object.defineProperty(host, "isConnected", {
      get() {
        throw new Error("Dead XrayWrapper: isConnected");
      },
      configurable: true,
    });

    activeHost.resetActiveReaderHost();

    const result = await Promise.race([
      pending,
      new Promise<string>((resolve) => setTimeout(() => resolve("HUNG"), 50)),
    ]);
    expect(result).toBe("cancelled");
    expect(confirmMod.isConfirmDialogOpen()).toBe(false);
  });

  it("openProviderEditor 在 host.isConnected 与 remove 抛错时仍关闭会话并触发 onSessionEnd", async () => {
    realm = createDetachedRealm();

    const readingView = realm.doc.createElement("div");
    readingView.id = ids.readingView;
    realm.doc.body.appendChild(readingView);

    activeHost.setActiveReaderHost(realm.doc, realm.win);
    const onSessionEnd = vi.fn();
    providerEditorMod.openProviderEditor({
      kind: "asr",
      presets: ASR_PROVIDER_PRESETS,
      mountHost: readingView,
      onSave: async () => ({ ok: true }),
      onSessionEnd,
    });
    expect(providerEditorMod.isProviderEditorOpen()).toBe(true);

    const host = readingView.querySelector<HTMLElement>(".provider-editor-host")!;
    Object.defineProperty(host, "isConnected", {
      get() {
        throw new Error("Dead XrayWrapper: isConnected");
      },
      configurable: true,
    });
    host.remove = () => {
      throw new Error("Dead XrayWrapper: remove");
    };
    realm.win.matchMedia = (() => {
      throw new Error("Dead XrayWrapper: matchMedia");
    }) as unknown as Window["matchMedia"];

    expect(() => activeHost.resetActiveReaderHost()).not.toThrow();
    expect(providerEditorMod.isProviderEditorOpen()).toBe(false);
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
  });
});
