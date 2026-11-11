import { ids } from "../shared/dom-ids.js";
import { watchStorageKeys } from "../shared/watch-storage-keys.js";
import {
  ensureReaderSettingsStyles,
  whenReaderSettingsStylesReady
} from "../shared/style-injector.js";
import type { LiveSettingsTarget } from "./fullscreen-live-overlay.js";
import { getFullscreenHost } from "./fullscreen-host.js";
import type { LiveChatState } from "./live-chat-controller.js";
import {
  createLiveProviderSettings,
  type LiveProviderSettings
} from "../ui/live-provider-settings.js";
import { SETTINGS_PANEL_DOM_IDS } from "../ui/settings-panel-html.js";
import {
  getAiCredentialStatusText,
  type AiCredentialStatus
} from "../core/ai-credential-reference.js";

export interface LiveRoomSettingsDeps {
  getState: () => LiveChatState;
  reconnect: () => Promise<boolean>;
}

interface LiveRoomSettingsSession {
  id: number;
  dialog: HTMLDialogElement;
  view: HTMLElement;
  trigger: HTMLElement | null;
  panel: LiveProviderSettings;
  unsubscribeStorage: () => void;
}

let session: LiveRoomSettingsSession | null = null;
let nextSessionId = 0;

function setStatus(current: LiveRoomSettingsSession, message: string, isError = false): void {
  if (session !== current) return;
  const status = current.dialog.querySelector<HTMLElement>(".biliscript-live-room-settings-status");
  if (!status) return;
  status.textContent = message;
  status.dataset.error = String(isError);
}

function offerReconnect(current: LiveRoomSettingsSession, deps: LiveRoomSettingsDeps, message: string): void {
  if (session !== current) return;
  const bar = current.dialog.querySelector<HTMLElement>(".biliscript-live-room-settings-reconnect");
  const text = current.dialog.querySelector<HTMLElement>(".biliscript-live-room-settings-reconnect-text");
  const button = current.dialog.querySelector<HTMLButtonElement>(".biliscript-live-room-settings-reconnect-btn");
  if (!bar || !text || !button) return;
  text.textContent = message;
  button.textContent = deps.getState() === "connected" || deps.getState() === "connecting" ? "重新连接" : "连接";
  bar.hidden = false;
}

function syncGeminiCredential(current: LiveRoomSettingsSession, status: AiCredentialStatus | null): void {
  if (session !== current) return;
  const region = current.dialog.querySelector<HTMLElement>(".biliscript-live-room-gemini-credential");
  const reason = current.dialog.querySelector<HTMLElement>(".biliscript-live-room-gemini-credential-reason");
  if (!region || !reason) return;
  region.hidden = !status || status === "ok";
  reason.textContent = status && status !== "ok" ? getAiCredentialStatusText("gemini-live", status) : "";
}

function createDialog(getPlayerHost: () => HTMLElement | null): HTMLDialogElement {
  const dialog = document.createElement("dialog");
  const domIds = SETTINGS_PANEL_DOM_IDS;
  dialog.id = "biliscript-live-room-settings";
  dialog.className = "biliscript-live-room-settings";
  dialog.tabIndex = -1;
  dialog.setAttribute("data-biliscript-extension-node", "live-room-settings");
  dialog.setAttribute("aria-label", "伴看平台与密钥");
  dialog.innerHTML = `
    <button type="button" class="biliscript-live-room-settings-close" aria-label="关闭伴看设置">×</button>
    <div id="${ids.readingView}" class="biliscript-live-room-settings-view">
      <section id="${ids.readingSettingsPanel}" class="biliscript-reading-settings-panel">
        <div id="${ids.readingSettingsHost}" class="biliscript-reading-settings-host">
          <section class="biliscript-set-group" data-settings-section="llm">
            <div id="${domIds.liveSettingsHeader}" class="biliscript-set-header-row">
              <div class="biliscript-set-h">实时伴看平台</div>
              <button id="${domIds.addLiveProviderBtn}" class="add-property-btn" type="button">+ 添加平台</button>
            </div>
            <div id="${domIds.liveProvidersList}" class="ai-providers-list"></div>
            <p id="${domIds.liveProvidersEmpty}" class="ai-providers-empty">暂无已配置平台</p>
            <div class="biliscript-live-room-gemini-credential" hidden>
              <span class="biliscript-live-room-gemini-credential-reason"></span>
              <button type="button" class="biliscript-live-room-gemini-configure-btn">配置 Gemini Key</button>
            </div>
            <p class="biliscript-live-room-settings-status biliscript-set-hint" role="status"></p>
            <div class="biliscript-live-room-settings-reconnect" hidden>
              <span class="biliscript-live-room-settings-reconnect-text"></span>
              <button type="button" class="biliscript-live-room-settings-reconnect-btn">重新连接</button>
            </div>
          </section>
        </div>
      </section>
    </div>
  `;
  (getFullscreenHost() || getPlayerHost() || document.body).appendChild(dialog);
  return dialog;
}

export async function openLiveRoomSettings(
  target: LiveSettingsTarget,
  getPlayerHost: () => HTMLElement | null,
  deps: LiveRoomSettingsDeps
): Promise<void> {
  let current = session;
  if (!current) {
    const dialog = createDialog(getPlayerHost);
    const view = dialog.querySelector<HTMLElement>(`#${ids.readingView}`);
    if (!view) {
      dialog.remove();
      return;
    }
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const id = ++nextSessionId;
    const panel = createLiveProviderSettings({
      host: view,
      getEditorMountHost: () => view,
      onStatus: (message, isError) => {
        const active = session;
        if (active?.id === id) setStatus(active, message, isError);
      },
      onGeminiCredentialStatus: (status) => {
        const active = session;
        if (active?.id === id) syncGeminiCredential(active, status);
      },
      onSaved: (kind) => {
        const active = session;
        if (!active || active.id !== id) return;
        offerReconnect(
          active,
          deps,
          kind === "ai" ? "Gemini Key 已保存，重新连接后生效" : "平台设置已保存，重新连接后生效"
        );
      }
    });
    const created: LiveRoomSettingsSession = {
      id,
      dialog,
      view,
      trigger,
      panel,
      unsubscribeStorage: () => {}
    };
    current = created;
    session = created;
    created.unsubscribeStorage = watchStorageKeys((changes, areaName) => {
      if (session !== created) return;
      if (areaName === "sync" && changes.activeLiveProviderId) {
        offerReconnect(created, deps, "伴看平台已切换，重新连接后生效；当前连接保持不变");
      }
      void created.panel.load();
    }, {
      sync: ["liveProviders", "activeLiveProviderId"],
      local: ["liveProviderKeys"]
    });
    dialog.querySelector<HTMLButtonElement>(".biliscript-live-room-settings-close")
      ?.addEventListener("click", () => closeLiveRoomSettings());
    dialog.querySelector<HTMLButtonElement>(".biliscript-live-room-gemini-configure-btn")
      ?.addEventListener("click", () => void created.panel.open("gemini-key"));
    dialog.querySelector<HTMLButtonElement>(".biliscript-live-room-settings-reconnect-btn")
      ?.addEventListener("click", async () => {
        if (session !== created) return;
        const button = dialog.querySelector<HTMLButtonElement>(".biliscript-live-room-settings-reconnect-btn");
        if (!button || button.disabled) return;
        button.disabled = true;
        setStatus(created, "正在按当前伴看平台重新连接...");
        try {
          const started = await deps.reconnect();
          if (session !== created) return;
          if (started) {
            closeLiveRoomSettings();
            return;
          }
          setStatus(created, "未能启动伴看，请检查设置后重试", true);
        } catch (error) {
          if (session === created) setStatus(created, (error as Error).message || "重新连接失败", true);
        } finally {
          if (session === created) button.disabled = false;
        }
      });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeLiveRoomSettings();
    });
    dialog.addEventListener("close", () => {
      if (session === created) closeLiveRoomSettings();
    });
    dialog.showModal();
    dialog.focus({ preventScroll: true });
  }

  ensureReaderSettingsStyles();
  await whenReaderSettingsStylesReady();
  if (session !== current) return;
  await current.panel.load();
  if (session !== current) return;
  await current.panel.open(target);
}

export function closeLiveRoomSettings(): void {
  const current = session;
  if (!current) return;
  session = null;
  nextSessionId += 1;
  current.unsubscribeStorage();
  current.panel.dispose();
  if (current.dialog.open) current.dialog.close();
  current.dialog.remove();
  if (current.trigger?.isConnected) current.trigger.focus({ preventScroll: true });
}
