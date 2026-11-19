import { collectPermissionMatchPatterns, permissionDeniedErrorMessage } from "../core/host-permissions.js";
import { sendRuntimeMessage } from "../shared/messaging.js";

export interface PermissionGrantParams {
  reqId: string;
  origins: string[];
}

export function parsePermissionGrantParams(search: string): PermissionGrantParams {
  const params = new URLSearchParams(search);
  const reqId = (params.get("reqId") || "").trim();
  const rawOrigins = params.get("origins");
  if (!rawOrigins) {
    return { reqId, origins: [] };
  }
  try {
    const parsed: unknown = JSON.parse(rawOrigins);
    return { reqId, origins: collectPermissionMatchPatterns(parsed) };
  } catch {
    return { reqId, origins: [] };
  }
}

export function initPermissionGrantPage(search = globalThis.location?.search ?? ""): void {
  const originsList = document.getElementById("permissionGrantOrigins");
  const allowBtn = document.getElementById("permissionGrantAllowBtn") as HTMLButtonElement | null;
  const cancelBtn = document.getElementById("permissionGrantCancelBtn") as HTMLButtonElement | null;
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

  let settled = false;

  const replyAndClose = async (ok: boolean, error?: string): Promise<void> => {
    if (reqId) {
      try {
        await sendRuntimeMessage({ type: "permission-grant-result", reqId, ok, error });
      } catch {
        // Ignore send errors when background has timed out or closed.
      }
    }
    window.close();
  };

  allowBtn.addEventListener("click", () => {
    if (settled || !reqId || origins.length === 0) {
      return;
    }
    settled = true;
    allowBtn.disabled = true;
    cancelBtn.disabled = true;

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
      void replyAndClose(false, `申请域名权限失败：${(error as Error | undefined)?.message || error}`);
      return;
    }

    void Promise.resolve(requestTask).then(
      (granted) =>
        replyAndClose(Boolean(granted), granted ? undefined : permissionDeniedErrorMessage(origins)),
      (error) =>
        replyAndClose(false, `申请域名权限失败：${(error as Error | undefined)?.message || error}`)
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
  location.pathname.endsWith("/permission-grant.html")
) {
  initPermissionGrantPage();
}
