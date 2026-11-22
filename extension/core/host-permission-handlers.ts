import {
  buildPermissionGrantQuery,
  checkHostPermission,
  collectPermissionMatchPatterns,
  formatPermissionRequestError,
  PERMISSION_GRANT_KEEPALIVE_PORT_NAME,
  PERMISSION_GRANT_PAGE_PATH,
  permissionDeniedErrorMessage,
  revokeOriginPermission,
  toPermissionMatchPattern
} from "./host-permissions.js";
import { consumeRuntimeLastError } from "../shared/messaging.js";
import { logWarn as defaultLogWarn } from "../shared/logging.js";
import { isMessagePortClosedError } from "./background-content-orchestration.js";
import { withOkResponse } from "./provider-handlers.js";

export { PERMISSION_GRANT_KEEPALIVE_PORT_NAME };
import type {
  BackgroundMessage,
  BackgroundMessageHandler,
  BackgroundResponseOf,
  MessageReplyDecision,
  MessageSender
} from "../shared/messaging-protocol.js";

const USER_GESTURE_PERMISSION_ERROR_RE = /user input|user gesture|may only be called from a user input handler/i;
export const PERMISSION_GRANT_POPUP_TIMEOUT_MS = 120_000;

export interface PermissionApiLike {
  request?: (permissions: { origins?: string[]; permissions?: string[] }) => Promise<boolean>;
  contains?: (permissions: { origins?: string[]; permissions?: string[] }) => Promise<boolean>;
  remove?: (permissions: { origins?: string[]; permissions?: string[] }) => Promise<boolean>;
}

export interface PermissionGrantWindowsAdapter {
  create?: (options: {
    url: string;
    type: "popup";
    width: number;
    height: number;
    focused: boolean;
  }) => Promise<{ id?: number }> | { id?: number };
  remove?: (windowId: number) => Promise<void> | void;
  onRemoved?: {
    addListener: (listener: (windowId: number) => void) => void;
    removeListener: (listener: (windowId: number) => void) => void;
  };
}

export interface HostPermissionHostAdapter {
  permissions?: PermissionApiLike;
  windows?: PermissionGrantWindowsAdapter;
  staticHostPermissions?: readonly string[];
  getRuntimeUrl: (path: string) => string;
  runtimeId?: string;
  createReqId?: () => string;
  timeoutMs?: number;
  logWarn?: (message: string, detail?: unknown) => void;
}

export interface PermissionGrantKeepalivePort {
  name?: string;
  sender?: MessageSender;
  disconnect?: () => void;
  onDisconnect?: {
    addListener: (listener: () => void) => void;
    removeListener?: (listener: () => void) => void;
  };
}

export interface HostPermissionHandlers {
  requestProviderOrigins: BackgroundMessageHandler<"request-provider-origins">;
  permissionGrantResult: BackgroundMessageHandler<"permission-grant-result">;
  checkProviderOrigin: BackgroundMessageHandler<"check-provider-origin">;
  revokeProviderOrigin: BackgroundMessageHandler<"revoke-provider-origin">;
  attachKeepalivePort: (port: PermissionGrantKeepalivePort | null | undefined) => boolean;
  getActiveKeepalivePortCount: () => number;
}

type Msg<T extends "request-provider-origins" | "permission-grant-result" | "check-provider-origin" | "revoke-provider-origin"> =
  Extract<BackgroundMessage, { type: T }>;
type Reply<T extends "request-provider-origins" | "permission-grant-result" | "check-provider-origin" | "revoke-provider-origin"> =
  (response: BackgroundResponseOf<T>) => void;

interface PendingPermissionGrant {
  windowId: number | null;
  deniedError: string;
  settle: (result: BackgroundResponseOf<"request-provider-origins">) => void;
}

function hasPermissionRequest(
  permissions: PermissionApiLike | undefined
): permissions is PermissionApiLike & { request: NonNullable<PermissionApiLike["request"]> } {
  return typeof permissions?.request === "function";
}

function isUserGesturePermissionError(error: unknown): boolean {
  const message = String((error as { message?: unknown } | null | undefined)?.message ?? error ?? "");
  return USER_GESTURE_PERMISSION_ERROR_RE.test(message);
}

export function createHostPermissionHandlers(host: HostPermissionHostAdapter): HostPermissionHandlers {
  const pendingPermissionGrants = new Map<string, PendingPermissionGrant>();
  const activeKeepalivePorts = new Set<PermissionGrantKeepalivePort>();
  let permissionGrantReqSeq = 0;
  const timeoutMs = host.timeoutMs ?? PERMISSION_GRANT_POPUP_TIMEOUT_MS;

  function nextReqId(): string {
    if (typeof host.createReqId === "function") {
      return host.createReqId();
    }
    return typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `perm-${Date.now()}-${++permissionGrantReqSeq}`;
  }

  function isPermissionGrantPageSender(sender: MessageSender): boolean {
    const runtimeId = host.runtimeId;
    if (runtimeId && sender?.id && sender.id !== runtimeId) {
      return false;
    }
    const expectedUrl = host.getRuntimeUrl(PERMISSION_GRANT_PAGE_PATH);
    const senderUrl = typeof sender?.url === "string" ? sender.url : "";
    return (
      senderUrl === expectedUrl ||
      senderUrl.startsWith(`${expectedUrl}?`) ||
      senderUrl.startsWith(`${expectedUrl}#`)
    );
  }

  function requestPermissionViaPopup(
    origins: string[],
    windowsApi: PermissionGrantWindowsAdapter
  ): Promise<BackgroundResponseOf<"request-provider-origins">> {
    if (typeof windowsApi.create !== "function") {
      return Promise.reject(new Error("当前环境不支持弹窗授权"));
    }
    const reqId = nextReqId();
    const url = host.getRuntimeUrl(`${PERMISSION_GRANT_PAGE_PATH}?${buildPermissionGrantQuery(reqId, origins)}`);
    const deniedError = permissionDeniedErrorMessage(origins);

    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onWindowRemoved: ((closedWindowId: number) => void) | undefined;

      const entry: PendingPermissionGrant = {
        windowId: null,
        deniedError,
        settle: (result) => {
          if (settled) {
            return;
          }
          settled = true;
          pendingPermissionGrants.delete(reqId);
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          if (onWindowRemoved && typeof windowsApi.onRemoved?.removeListener === "function") {
            windowsApi.onRemoved.removeListener(onWindowRemoved);
          }
          resolve(result);
        }
      };

      pendingPermissionGrants.set(reqId, entry);

      timer = setTimeout(() => {
        const winId = entry.windowId;
        entry.settle({
          ok: false,
          error: `申请域名权限失败：授权超时（${origins.join("、")}）`
        });
        if (winId !== null && typeof windowsApi.remove === "function") {
          void Promise.resolve(windowsApi.remove(winId)).catch(() => {});
        }
      }, timeoutMs);

      if (typeof windowsApi.onRemoved?.addListener === "function") {
        onWindowRemoved = (closedWindowId: number) => {
          if (entry.windowId !== null && closedWindowId === entry.windowId) {
            entry.settle({ ok: false, error: deniedError });
          }
        };
        windowsApi.onRemoved.addListener(onWindowRemoved);
      }

      try {
        if (typeof windowsApi.create !== "function") {
          entry.settle({ ok: false, error: "申请域名权限失败：当前环境不支持弹窗授权" });
          return;
        }
        void Promise.resolve(
          windowsApi.create({
            url,
            type: "popup",
            width: 460,
            height: 360,
            focused: true
          })
        ).then(
          (createdWindow) => {
            if (settled) {
              return;
            }
            const winId = createdWindow?.id;
            if (typeof winId === "number") {
              entry.windowId = winId;
            }
          },
          (createError) => {
            entry.settle({
              ok: false,
              error: formatPermissionRequestError(createError)
            });
          }
        );
      } catch (createError) {
        entry.settle({
          ok: false,
          error: formatPermissionRequestError(createError)
        });
      }
    });
  }

  async function filterMissingOrigins(origins: string[]): Promise<string[]> {
    const permissions = host.permissions;
    if (typeof permissions?.contains !== "function") {
      return origins;
    }
    const checks = await Promise.all(
      origins.map(async (origin) => {
        try {
          return (await permissions.contains!({ origins: [origin] })) ? null : origin;
        } catch {
          return origin;
        }
      })
    );
    return checks.filter((origin): origin is string => origin !== null);
  }

  async function resolvePermissionAfterGestureError(
    origins: string[],
    originalError: unknown
  ): Promise<BackgroundResponseOf<"request-provider-origins">> {
    const missingOrigins = await filterMissingOrigins(origins);
    if (missingOrigins.length === 0) {
      return { ok: true };
    }
    const windowsApi = host.windows;
    if (typeof windowsApi?.create !== "function") {
      throw originalError;
    }
    return await requestPermissionViaPopup(missingOrigins, windowsApi);
  }

  function handleRequestProviderOrigins(
    message: Msg<"request-provider-origins">,
    _sender: MessageSender,
    sendResponse: Reply<"request-provider-origins">
  ): MessageReplyDecision {
    const origins = collectPermissionMatchPatterns(message.baseUrls);
    if (origins.length === 0) {
      sendResponse({ ok: true });
      return "answered";
    }
    const permissions = host.permissions;
    if (!hasPermissionRequest(permissions)) {
      sendResponse({ ok: false, error: "当前环境不支持申请权限" });
      return "answered";
    }
    withOkResponse(
      (async () => {
        try {
          const requestTask = permissions.request({ origins });
          const granted = await requestTask;
          return granted
            ? { ok: true }
            : {
                ok: false,
                error: permissionDeniedErrorMessage(origins)
              };
        } catch (error) {
          if (!isUserGesturePermissionError(error)) {
            throw error;
          }
          return await resolvePermissionAfterGestureError(origins, error);
        }
      })(),
      sendResponse,
      formatPermissionRequestError
    );
    return "hold";
  }

  function handlePermissionGrantResult(
    message: Msg<"permission-grant-result">,
    sender: MessageSender,
    sendResponse: Reply<"permission-grant-result">
  ): void {
    if (!isPermissionGrantPageSender(sender)) {
      sendResponse({ ok: false, error: "拒绝非授权扩展页面的权限回包" });
      return;
    }
    const reqId = typeof message.reqId === "string" ? message.reqId.trim() : "";
    const entry = reqId ? pendingPermissionGrants.get(reqId) : undefined;
    if (!entry) {
      sendResponse({ ok: false, error: "授权请求不存在或已结束" });
      return;
    }
    entry.settle(
      message.ok
        ? { ok: true }
        : { ok: false, error: message.error || entry.deniedError }
    );
    sendResponse({ ok: true });
  }

  function handleCheckProviderOrigin(
    message: Msg<"check-provider-origin">,
    _sender: MessageSender,
    sendResponse: Reply<"check-provider-origin">
  ): void {
    const permissions = host.permissions;
    const contains =
      typeof permissions?.contains === "function"
        ? (query: { origins?: string[]; permissions?: string[] }) => permissions.contains!(query)
        : undefined;
    void checkHostPermission(message.origin, contains).then(sendResponse);
  }

  function handleRevokeProviderOrigin(
    message: Msg<"revoke-provider-origin">,
    _sender: MessageSender,
    sendResponse: Reply<"revoke-provider-origin">
  ): void {
    const permissions = host.permissions;
    const contains =
      typeof permissions?.contains === "function"
        ? (query: { origins?: string[]; permissions?: string[] }) => permissions.contains!(query)
        : undefined;
    const remove =
      typeof permissions?.remove === "function"
        ? (query: { origins?: string[]; permissions?: string[] }) => permissions.remove!(query)
        : undefined;
    void revokeOriginPermission(message.origin, {
      contains,
      remove,
      ...(host.staticHostPermissions !== undefined
        ? { staticHostPermissions: host.staticHostPermissions }
        : {})
    }).then(sendResponse, () => {
      const pattern = toPermissionMatchPattern(message.origin);
      sendResponse({ origins: pattern ? [pattern] : [], revoked: false });
    });
  }

  function disconnectRejectedPort(port: PermissionGrantKeepalivePort): void {
    try {
      port.disconnect?.();
    } catch (error) {
      if (!isMessagePortClosedError(error)) {
        (host.logWarn ?? defaultLogWarn)("[BILISCRIPT] rejected keepalive port disconnect failed", error);
      }
    }
  }

  function attachKeepalivePort(port: PermissionGrantKeepalivePort | null | undefined): boolean {
    if (!port || port.name !== PERMISSION_GRANT_KEEPALIVE_PORT_NAME) {
      return false;
    }
    if (port.sender && !isPermissionGrantPageSender(port.sender)) {
      disconnectRejectedPort(port);
      return true;
    }
    if (activeKeepalivePorts.has(port)) {
      return true;
    }
    activeKeepalivePorts.add(port);
    const onDisconnect = () => {
      consumeRuntimeLastError();
      activeKeepalivePorts.delete(port);
      port.onDisconnect?.removeListener?.(onDisconnect);
    };
    port.onDisconnect?.addListener?.(onDisconnect);
    return true;
  }

  return {
    requestProviderOrigins: handleRequestProviderOrigins,
    permissionGrantResult: handlePermissionGrantResult,
    checkProviderOrigin: handleCheckProviderOrigin,
    revokeProviderOrigin: handleRevokeProviderOrigin,
    attachKeepalivePort,
    getActiveKeepalivePortCount: () => activeKeepalivePorts.size
  };
}
