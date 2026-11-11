// extension/live/live-room-settings.ts
// 直播间按需伴看设置：仅在用户点击设置入口后装载完整设置面板，挂载到当前
// 全屏宿主的 modal dialog，不初始化视频页文摘、字幕或文本对话。

import { ids } from "../shared/dom-ids.js";
import type { LiveSettingsTarget } from "./fullscreen-live-overlay.js";

let dialogEl: HTMLDialogElement | null = null;

function getFullscreenHost(): HTMLElement | null {
  const fullscreenElement =
    document.fullscreenElement ||
    (document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement;
  return fullscreenElement instanceof HTMLElement ? fullscreenElement : null;
}

function ensureDialog(getPlayerHost: () => HTMLElement | null): HTMLDialogElement {
  if (dialogEl?.isConnected) return dialogEl;
  dialogEl?.remove();

  const dialog = document.createElement("dialog");
  dialog.className = "biliscript-live-room-settings";
  dialog.setAttribute("data-biliscript-extension-node", "live-room-settings");
  dialog.setAttribute("aria-label", "伴看平台与密钥");
  dialog.innerHTML = `
    <button type="button" class="biliscript-live-room-settings-close" aria-label="关闭伴看设置">×</button>
    <div id="${ids.readingView}" class="biliscript-live-room-settings-view">
      <section id="${ids.readingSettingsPanel}" class="biliscript-reading-settings-panel">
        <div id="${ids.readingSettingsHost}" class="biliscript-reading-settings-host"></div>
      </section>
    </div>
  `;
  dialog.querySelector<HTMLButtonElement>(".biliscript-live-room-settings-close")
    ?.addEventListener("click", () => dialog.close());
  (getFullscreenHost() || getPlayerHost() || document.body).appendChild(dialog);
  dialogEl = dialog;
  return dialog;
}

export async function openLiveRoomSettings(
  target: LiveSettingsTarget,
  getPlayerHost: () => HTMLElement | null
): Promise<void> {
  const dialog = ensureDialog(getPlayerHost);
  if (!dialog.open) dialog.showModal();
  const panel = await import("../ui/settings-panel.js");
  panel.renderReaderSettingsPanel();
  await panel.openLiveSettings(target);
}

export function closeLiveRoomSettings(): void {
  dialogEl?.close();
  dialogEl?.remove();
  dialogEl = null;
}
