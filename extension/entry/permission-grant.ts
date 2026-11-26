import type { Settings } from "../core/defaults.js";
import {
  formatOptionalPermissionRequestError,
  formatPermissionRequestError,
  optionalPermissionDeniedErrorMessage,
  parsePermissionGrantParams,
  PERMISSION_GRANT_KEEPALIVE_PORT_NAME,
  PERMISSION_GRANT_PAGE_PATH,
  permissionDeniedErrorMessage,
  type OptionalApiPermission,
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
      }
    }
  };
}

const OPTIONAL_PERMISSION_LABELS: Record<OptionalApiPermission, string> = {
  downloads: "下载管理（downloads）：将视频笔记保存到系统下载目录的子文件夹"
};

function describeOptionalPermission(permission: OptionalApiPermission): string {
  return OPTIONAL_PERMISSION_LABELS[permission] || permission;
}

export function initPermissionGrantPage(search = globalThis.location?.search ?? ""): void {
  syncPermissionGrantAppearance(document);

  const titleEl = document.getElementById("permissionGrantTitle");
  const reasonEl = document.querySelector(".grant-reason");
  const originsList = document.getElementById("permissionGrantOrigins");
  const allowBtn = document.getElementById("permissionGrantAllowBtn") as HTMLButtonElement | null;
  const cancelBtn = document.getElementById("permissionGrantCancelBtn") as HTMLButtonElement | null;
  const statusEl = document.getElementById("permissionGrantStatus");
  if (!originsList || !allowBtn || !cancelBtn) {
    return;
  }

  const { reqId, origins, permissions = [] } = parsePermissionGrantParams(search);
  const hasOrigins = origins.length > 0;
  const hasPermissions = permissions.length > 0;
  const isOptionalApiOnly = !hasOrigins && hasPermissions;

  if (isOptionalApiOnly) {
    document.title = "BiliScript｜扩展权限授权";
    if (titleEl) {
      titleEl.textContent = "允许授予以下扩展权限";
    }
    if (reasonEl) {
      reasonEl.textContent = "受浏览器安全限制，该可选权限需在扩展窗口内触发授权。点击「允许授权」后，请在浏览器弹出的提示中确认。";
    }
    allowBtn.textContent = "允许授权";
  }

  originsList.textContent = "";
  for (const origin of origins) {
    const item = document.createElement("li");
    item.textContent = origin;
    originsList.appendChild(item);
  }
  for (const permission of permissions) {
    const item = document.createElement("li");
    item.textContent = describeOptionalPermission(permission);
    originsList.appendChild(item);
  }

  allowBtn.disabled = !reqId || (!hasOrigins && !hasPermissions);
  cancelBtn.disabled = false;

  const keepalivePort = reqId ? openPermissionGrantKeepalivePort() : null;
  const releaseKeepalive = (): void => {
    keepalivePort?.disconnect();
  };
  if (keepalivePort && typeof window !== "undefined") {
    window.addEventListener("pagehide", releaseKeepalive, { once: true });
    window.addEventListener("beforeunload", releaseKeepalive, { once: true });
  }

  let settled = false;

  const resolveDeniedError = (): string => {
    if (hasOrigins) {
      return permissionDeniedErrorMessage(origins);
    }
    if (hasPermissions) {
      return optionalPermissionDeniedErrorMessage(permissions);
    }
    return "已取消权限申请";
  };

  const formatError = (error: unknown): string =>
    isOptionalApiOnly ? formatOptionalPermissionRequestError(error) : formatPermissionRequestError(error);

  const replyAndClose = async (ok: boolean, error?: string): Promise<void> => {
    if (reqId) {
      try {
        await sendRuntimeMessage({ type: "permission-grant-result", reqId, ok, error });
      } catch {
      }
    }
    releaseKeepalive();
    window.close();
  };

  allowBtn.addEventListener("click", () => {
    if (settled || !reqId || (!hasOrigins && !hasPermissions)) {
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

    const requestPayload: { origins?: string[]; permissions?: string[] } = {};
    if (hasOrigins) {
      requestPayload.origins = origins;
    }
    if (hasPermissions) {
      requestPayload.permissions = permissions;
    }

    let requestTask: Promise<boolean>;
    try {
      requestTask = globalThis.chrome.permissions.request(requestPayload);
    } catch (error) {
      void replyAndClose(false, formatError(error));
      return;
    }

    void Promise.resolve(requestTask).then(
      (granted) =>
        replyAndClose(Boolean(granted), granted ? undefined : resolveDeniedError()),
      (error) => replyAndClose(false, formatError(error))
    );
  });

  cancelBtn.addEventListener("click", () => {
    if (settled) {
      return;
    }
    settled = true;
    allowBtn.disabled = true;
    cancelBtn.disabled = true;
    const error = hasOrigins || hasPermissions ? resolveDeniedError() : "已取消域名权限申请";
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
