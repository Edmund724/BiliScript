import type { Settings } from "../core/defaults.js";
import {
  formatPermissionRequestError,
  parsePermissionGrantParams,
  PERMISSION_GRANT_KEEPALIVE_PORT_NAME,
  PERMISSION_GRANT_PAGE_PATH,
  permissionDeniedErrorMessage,
  type PermissionGrantParams
} from "../core/host-permissions.js";
import { normalizeReaderPalette } from "../core/validators.js";
import {
  resolveEffectiveTheme,
  resolveReaderThemeMode,
  writeThemeSnapshot
} from "../shared/host-theme.js";
import { consumeRuntimeLastError, sendRuntimeMessage } from "../shared/messaging.js";

export { parsePermissionGrantParams, PERMISSION_GRANT_KEEPALIVE_PORT_NAME, type PermissionGrantParams };

export const PERMISSION_GRANT_WAITING_BUTTON_TEXT = "等待浏览器确认…";
export const PERMISSION_GRANT_WAITING_STATUS_TEXT = "请在浏览器弹出的权限提示中点击允许…";

function applyAppearance(settings: Partial<Settings>, doc: Document = document): void {
  const root = doc.documentElement;
  root.setAttribute("data-biliscript-onboarding", "1");
  const mode = resolveReaderThemeMode(settings);
  const theme = resolveEffectiveTheme(mode, doc);
  const palette = normalizeReaderPalette(settings.readerPalette);
  root.setAttribute("data-theme", theme);
  root.setAttribute("data-palette", palette);
  writeThemeSnapshot({ mode, palette, resolved: theme });
}

async function readStoredAppearance(): Promise<Partial<Settings>> {
  const syncStorage = globalThis.chrome?.storage?.sync;
  if (typeof syncStorage?.get === "function") {
    try {
      const stored = await syncStorage.get(["readerTheme", "readerThemeUserSet", "readerPalette"]);
      if (stored && typeof stored === "object") {
        return stored as Partial<Settings>;
      }
    } catch {
      // Fall back to default appearance when storage is unavailable.
    }
  }
  return {};
}

export function syncPermissionGrantAppearance(doc: Document = document): void {
  let latestSettings: Partial<Settings> = {};
  applyAppearance(latestSettings, doc);

  const media = typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
  media?.addEventListener?.("change", () => {
    const mode = resolveReaderThemeMode(latestSettings);
    if (mode === "bilibili" || mode === "system") {
      applyAppearance(latestSettings, doc);
    }
  });

  void readStoredAppearance().then((stored) => {
    latestSettings = stored;
    applyAppearance(latestSettings, doc);
  });
}

function openPermissionGrantKeepalivePort(): { disconnect: () => void } | null {
  const connect = globalThis.chrome?.runtime?.connect;
  if (typeof connect !== "function") {
    return null;
  }
  let port: chrome.runtime.Port;
  try {
    port = connect.call(globalThis.chrome.runtime, { name: PERMISSION_GRANT_KEEPALIVE_PORT_NAME });
  } catch {
    return null;
  }
  if (!port || typeof port.disconnect !== "function") {
    return null;
  }
  let disconnected = false;
  const onDisconnect = () => {
    consumeRuntimeLastError();
    disconnected = true;
    port.onDisconnect?.removeListener?.(onDisconnect);
  };
  port.onDisconnect?.addListener?.(onDisconnect);
  return {
    disconnect() {
      if (disconnected) {
        return;
      }
      disconnected = true;
      port.onDisconnect?.removeListener?.(onDisconnect);
      try {
        port.disconnect();
      } catch {
        // Ignore errors when the port is already disconnected.
      }
    }
  };
}

export function initPermissionGrantPage(search = globalThis.location?.search ?? ""): void {
  syncPermissionGrantAppearance(document);

  const originsList = document.getElementById("permissionGrantOrigins");
  const allowBtn = document.getElementById("permissionGrantAllowBtn") as HTMLButtonElement | null;
  const cancelBtn = document.getElementById("permissionGrantCancelBtn") as HTMLButtonElement | null;
  const statusEl = document.getElementById("permissionGrantStatus");
  if (!originsList || !allowBtn || !cancelBtn) {
    return;
  }

  const { reqId, origins } = parsePermissionGrantParams(search);
  originsList.textContent = "";
  for (const origin of origins) {
    const item = document.createElement("li");
    item.textContent = origin;
    originsList.appendChild(item);
  }

  allowBtn.disabled = !reqId || origins.length === 0;
  cancelBtn.disabled = false;

  // Keep the Firefox Event Page awake for the full popup window lifetime so pendingPermissionGrants
  // stays resident across the 120s authorization window.
  const keepalivePort = reqId ? openPermissionGrantKeepalivePort() : null;
  const releaseKeepalive = (): void => {
    keepalivePort?.disconnect();
  };
  if (keepalivePort && typeof window !== "undefined") {
    window.addEventListener("pagehide", releaseKeepalive, { once: true });
    window.addEventListener("beforeunload", releaseKeepalive, { once: true });
  }

  let settled = false;

  const replyAndClose = async (ok: boolean, error?: string): Promise<void> => {
    if (reqId) {
      try {
        await sendRuntimeMessage({ type: "permission-grant-result", reqId, ok, error });
      } catch {
        // Ignore send errors when background has timed out or closed.
      }
    }
    releaseKeepalive();
    window.close();
  };

  allowBtn.addEventListener("click", () => {
    if (settled || !reqId || origins.length === 0) {
      return;
    }
    settled = true;
    allowBtn.disabled = true;
    cancelBtn.disabled = true;
    allowBtn.textContent = PERMISSION_GRANT_WAITING_BUTTON_TEXT;
    if (statusEl) {
      statusEl.textContent = PERMISSION_GRANT_WAITING_STATUS_TEXT;
      statusEl.hidden = false;
    }

    if (typeof globalThis.chrome?.permissions?.request !== "function") {
      void replyAndClose(false, "当前环境不支持申请权限");
      return;
    }

    // Must call chrome.permissions.request synchronously inside the click handler
    // so Firefox / Chrome preserves the extension page user gesture.
    let requestTask: Promise<boolean>;
    try {
      requestTask = globalThis.chrome.permissions.request({ origins });
    } catch (error) {
      void replyAndClose(false, formatPermissionRequestError(error));
      return;
    }

    void Promise.resolve(requestTask).then(
      (granted) =>
        replyAndClose(Boolean(granted), granted ? undefined : permissionDeniedErrorMessage(origins)),
      (error) => replyAndClose(false, formatPermissionRequestError(error))
    );
  });

  cancelBtn.addEventListener("click", () => {
    if (settled) {
      return;
    }
    settled = true;
    allowBtn.disabled = true;
    cancelBtn.disabled = true;
    const error = origins.length > 0 ? permissionDeniedErrorMessage(origins) : "已取消域名权限申请";
    void replyAndClose(false, error);
  });
}

if (
  typeof document !== "undefined" &&
  typeof location !== "undefined" &&
  location.pathname.endsWith(`/${PERMISSION_GRANT_PAGE_PATH}`)
) {
  initPermissionGrantPage();
}
