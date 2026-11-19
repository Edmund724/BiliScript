// core/host-permission-handlers.ts 接口测试（零整包 SW 装载，直测 HostPermissionHostAdapter 接缝）：
// 覆盖同步零 await 手势不变式、无端口归一化、Firefox 手势缺失回退（常驻放行 / 仅未授权子集弹窗 /
// 伪造来源拒绝 / 窗口关闭 / 120s 超时 / windows.create 同步抛错）、check-provider-origin 与
// revoke-provider-origin。
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHostPermissionHandlers,
  PERMISSION_GRANT_POPUP_TIMEOUT_MS,
  type HostPermissionHostAdapter
} from "../../extension/core/host-permission-handlers.js";
import { parsePermissionGrantParams } from "../../extension/core/host-permissions.js";
import type {
  CheckProviderOriginResponse,
  MessageSender,
  PermissionGrantResultResponse,
  RequestProviderOriginsResponse,
  RevokeProviderOriginResponse
} from "../../extension/shared/messaging-protocol.js";

interface HarnessOptions {
  requestImpl?: (permissions: { origins?: string[] }) => Promise<boolean>;
  omitRequest?: boolean;
  containsImpl?: (permissions: { origins?: string[] }) => Promise<boolean>;
  removeImpl?: (permissions: { origins?: string[] }) => Promise<boolean>;
  staticHostPermissions?: string[];
  createWindowImpl?: (options: Record<string, unknown>) => Promise<{ id?: number }> | { id?: number };
  timeoutMs?: number;
}

const RUNTIME_BASE = "moz-extension://ext-test-uuid/";
const RUNTIME_ID = "ext-test-id";
const CONTENT_SENDER: MessageSender = { url: "https://www.bilibili.com/video/BV1test000000" };

function createHarness(options: HarnessOptions = {}) {
  const windowRemovedListeners = new Set<(windowId: number) => void>();

  const requestMock = vi.fn(options.requestImpl ?? (async () => true));
  const containsMock = vi.fn(options.containsImpl ?? (async () => false));
  const removeMock = vi.fn(options.removeImpl ?? (async () => true));
  const createWindowMock = vi.fn(options.createWindowImpl ?? (async () => ({ id: 42 })));
  const removeWindowMock = vi.fn(async () => {});
  const addRemovedListener = vi.fn((fn: (windowId: number) => void) => {
    windowRemovedListeners.add(fn);
  });
  const removeRemovedListener = vi.fn((fn: (windowId: number) => void) => {
    windowRemovedListeners.delete(fn);
  });

  const adapter: HostPermissionHostAdapter = {
    permissions: {
      ...(options.omitRequest ? {} : { request: requestMock }),
      contains: containsMock,
      remove: removeMock
    },
    windows: {
      create: createWindowMock,
      remove: removeWindowMock,
      onRemoved: {
        addListener: addRemovedListener,
        removeListener: removeRemovedListener
      }
    },
    staticHostPermissions: options.staticHostPermissions ?? [],
    getRuntimeUrl: (path: string) => `${RUNTIME_BASE}${path}`,
    runtimeId: RUNTIME_ID,
    timeoutMs: options.timeoutMs
  };

  const handlers = createHostPermissionHandlers(adapter);

  const requestOrigins = (baseUrls?: unknown): Promise<RequestProviderOriginsResponse> =>
    new Promise((resolve) => {
      handlers.requestProviderOrigins({ type: "request-provider-origins", baseUrls }, CONTENT_SENDER, resolve);
    });

  const grantResult = (
    payload: { reqId: string; ok: boolean; error?: string },
    sender: MessageSender
  ): PermissionGrantResultResponse => {
    let response: PermissionGrantResultResponse | undefined;
    handlers.permissionGrantResult(
      { type: "permission-grant-result", ...payload },
      sender,
      (resp) => {
        response = resp;
      }
    );
    return response!;
  };

  const checkOrigin = (origin?: unknown): Promise<CheckProviderOriginResponse> =>
    new Promise((resolve) => {
      handlers.checkProviderOrigin({ type: "check-provider-origin", origin }, CONTENT_SENDER, resolve);
    });

  const revokeOrigin = (origin?: unknown): Promise<RevokeProviderOriginResponse> =>
    new Promise((resolve) => {
      handlers.revokeProviderOrigin({ type: "revoke-provider-origin", origin }, CONTENT_SENDER, resolve);
    });

  return {
    handlers,
    requestOrigins,
    grantResult,
    checkOrigin,
    revokeOrigin,
    requestMock,
    containsMock,
    removeMock,
    createWindowMock,
    removeWindowMock,
    addRemovedListener,
    removeRemovedListener,
    windowRemovedListeners
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("request-provider-origins：同步手势链与 Firefox 授权回退", () => {
  it("同步手势不变式：在返回 hold 前同步直调 permissions.request（零先行 await）并传入去重无端口 pattern", async () => {
    const h = createHarness({ requestImpl: async () => true });

    let response: RequestProviderOriginsResponse | undefined;
    const decision = h.handlers.requestProviderOrigins(
      {
        type: "request-provider-origins",
        baseUrls: ["http://localhost:11434/v1", "http://localhost:8000/v1"]
      },
      CONTENT_SENDER,
      (resp) => {
        response = resp;
      }
    );

    expect(decision).toBe("hold");
    // 关键手势断言：未让出任何微任务，permissions.request 已同步触发
    expect(h.requestMock).toHaveBeenCalledTimes(1);
    expect(h.requestMock).toHaveBeenCalledWith({ origins: ["http://localhost/*"] });
    expect(h.createWindowMock).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(response).toEqual({ ok: true }));
  });

  it("空列表与缺失 permissions.request 均同步即答（decision = answered）", () => {
    const emptyHarness = createHarness();
    let emptyResp: RequestProviderOriginsResponse | undefined;
    expect(
      emptyHarness.handlers.requestProviderOrigins(
        { type: "request-provider-origins", baseUrls: ["", "invalid"] },
        CONTENT_SENDER,
        (resp) => {
          emptyResp = resp;
        }
      )
    ).toBe("answered");
    expect(emptyResp).toEqual({ ok: true });
    expect(emptyHarness.requestMock).not.toHaveBeenCalled();

    const unsupportedHarness = createHarness({ omitRequest: true });
    let unsupportedResp: RequestProviderOriginsResponse | undefined;
    expect(
      unsupportedHarness.handlers.requestProviderOrigins(
        { type: "request-provider-origins", baseUrls: ["https://api.example.com/v1"] },
        CONTENT_SENDER,
        (resp) => {
          unsupportedResp = resp;
        }
      )
    ).toBe("answered");
    expect(unsupportedResp).toEqual({ ok: false, error: "当前环境不支持申请权限" });
  });

  it("用户拒绝返回可操作错误；非手势异常原样失败且不查 contains / 不弹窗", async () => {
    const denied = createHarness({ requestImpl: async () => false });
    const deniedResp = await denied.requestOrigins(["https://custom.example.com/v1"]);
    expect(deniedResp.ok).toBe(false);
    expect(deniedResp.error).toContain("未授权 https://custom.example.com/*");

    const failed = createHarness({
      requestImpl: async () => {
        throw new Error("permissions API unavailable");
      }
    });
    const failedResp = await failed.requestOrigins(["https://custom-relay.example.com/v1"]);
    expect(failedResp).toEqual({
      ok: false,
      error: "申请域名权限失败：permissions API unavailable"
    });
    expect(failed.containsMock).not.toHaveBeenCalled();
    expect(failed.createWindowMock).not.toHaveBeenCalled();
  });

  it("Firefox 手势报错且命中已授权常驻域 → 静默放行，不弹窗", async () => {
    const h = createHarness({
      requestImpl: async () => {
        throw new Error("permissions.request may only be called from a user input handler");
      },
      containsImpl: async () => true
    });

    expect(await h.requestOrigins(["https://api.openai.com/v1"])).toEqual({ ok: true });
    expect(h.containsMock).toHaveBeenCalledWith({ origins: ["https://api.openai.com/*"] });
    expect(h.createWindowMock).not.toHaveBeenCalled();
  });

  it("Firefox 手势报错且混合已授权与未授权域名 → 仅对未授权子集弹窗，拒绝伪造回包，合法回包结算并清理监听", async () => {
    const h = createHarness({
      requestImpl: async () => {
        throw new Error("Missing user gesture");
      },
      containsImpl: async ({ origins }) => origins?.[0] === "https://api.openai.com/*",
      createWindowImpl: async () => ({ id: 88 })
    });

    const pending = h.requestOrigins(["https://api.openai.com/v1", "http://localhost:11434/v1"]);
    await vi.waitFor(() => expect(h.createWindowMock).toHaveBeenCalledTimes(1));

    const createArgs = h.createWindowMock.mock.calls[0][0] as {
      url: string;
      type: string;
      width: number;
      height: number;
      focused: boolean;
    };
    expect(createArgs).toMatchObject({ type: "popup", width: 460, height: 360, focused: true });
    expect(createArgs.url).toContain(`${RUNTIME_BASE}entry/permission-grant.html?`);

    const parsed = parsePermissionGrantParams(new URL(createArgs.url).search);
    expect(parsed.reqId).not.toBe("");
    expect(parsed.origins).toEqual(["http://localhost/*"]);

    // 伪造来源（非扩展授权页 / 非本扩展 id）均被拒且不影响挂起请求
    expect(
      h.grantResult({ reqId: parsed.reqId, ok: true }, { url: CONTENT_SENDER.url, id: RUNTIME_ID })
    ).toEqual({ ok: false, error: "拒绝非授权扩展页面的权限回包" });
    expect(
      h.grantResult({ reqId: parsed.reqId, ok: true }, { url: createArgs.url, id: "foreign-ext-id" })
    ).toEqual({ ok: false, error: "拒绝非授权扩展页面的权限回包" });

    // 来自授权页本身的合法回包完成授权并释放监听
    expect(
      h.grantResult(
        { reqId: parsed.reqId, ok: true },
        { url: createArgs.url, id: RUNTIME_ID, tab: { id: 101, url: createArgs.url } }
      )
    ).toEqual({ ok: true });
    expect(await pending).toEqual({ ok: true });
    expect(h.removeRemovedListener).toHaveBeenCalledTimes(1);
    expect(h.windowRemovedListeners.size).toBe(0);

    // 已结算的 reqId 再次回包提示不存在
    expect(
      h.grantResult({ reqId: parsed.reqId, ok: true }, { url: createArgs.url, id: RUNTIME_ID })
    ).toEqual({ ok: false, error: "授权请求不存在或已结束" });
  });

  it("弹窗被用户直接关闭（windows.onRemoved）→ 按拒绝结算并清理监听", async () => {
    const h = createHarness({
      requestImpl: async () => {
        throw new Error("permissions.request may only be called from a user input handler");
      },
      containsImpl: async () => false,
      createWindowImpl: async () => ({ id: 99 })
    });

    const pending = h.requestOrigins(["http://localhost:11434/v1"]);
    await vi.waitFor(() => expect(h.createWindowMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(h.addRemovedListener).toHaveBeenCalledTimes(1));

    const [onRemoved] = [...h.windowRemovedListeners];
    onRemoved(99);

    const response = await pending;
    expect(response.ok).toBe(false);
    expect(response.error).toContain("未授权 http://localhost/*");
    expect(h.removeRemovedListener).toHaveBeenCalledTimes(1);
    expect(h.windowRemovedListeners.size).toBe(0);
  });

  it("弹窗 120s 未响应 → 超时失败回包并关闭弹窗与清理监听", async () => {
    vi.useFakeTimers();
    const h = createHarness({
      requestImpl: async () => {
        throw new Error("permissions.request may only be called from a user input handler");
      },
      containsImpl: async () => false,
      createWindowImpl: async () => ({ id: 77 })
    });

    const pending = h.requestOrigins(["https://relay.example.com/v1"]);
    await vi.waitFor(() => expect(h.createWindowMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(PERMISSION_GRANT_POPUP_TIMEOUT_MS);

    const response = await pending;
    expect(response.ok).toBe(false);
    expect(response.error).toContain("授权超时");
    expect(h.removeWindowMock).toHaveBeenCalledWith(77);
    expect(h.removeRemovedListener).toHaveBeenCalledTimes(1);
    expect(h.windowRemovedListeners.size).toBe(0);
  });

  it("windows.create 同步抛错 → 立即失败回包并清理监听", async () => {
    const h = createHarness({
      requestImpl: async () => {
        throw new Error("permissions.request may only be called from a user input handler");
      },
      containsImpl: async () => false,
      createWindowImpl: () => {
        throw new Error("popup blocked");
      }
    });

    expect(await h.requestOrigins(["https://relay.example.com/v1"])).toEqual({
      ok: false,
      error: "申请域名权限失败：popup blocked"
    });
    expect(h.removeRemovedListener).toHaveBeenCalledTimes(1);
    expect(h.windowRemovedListeners.size).toBe(0);
  });
});

describe("check-provider-origin 与 revoke-provider-origin", () => {
  it("check-provider-origin：已授权/未授权/带端口归一/缺失非法 fail-open", async () => {
    const granted = createHarness({ containsImpl: async () => true });
    expect(await granted.checkOrigin("https://api.openai.com/*")).toEqual({ granted: true });
    expect(granted.containsMock).toHaveBeenCalledWith({ origins: ["https://api.openai.com/*"] });

    expect(await granted.checkOrigin("http://localhost:11434/*")).toEqual({ granted: true });
    expect(granted.containsMock).toHaveBeenLastCalledWith({ origins: ["http://localhost/*"] });

    const denied = createHarness({ containsImpl: async () => false });
    expect(await denied.checkOrigin("https://api.openai.com/*")).toEqual({ granted: false });

    const failOpen = createHarness({ containsImpl: async () => false });
    expect(await failOpen.checkOrigin(undefined)).toEqual({ granted: true });
    expect(await failOpen.checkOrigin("oops")).toEqual({ granted: true });
    expect(failOpen.containsMock).not.toHaveBeenCalled();
  });

  it("revoke-provider-origin：跳过静态常驻域，非静态可选域经无端口 pattern 回收", async () => {
    const h = createHarness({
      containsImpl: async () => true,
      removeImpl: async () => true,
      staticHostPermissions: ["https://api-inference.modelscope.cn/*"]
    });

    expect(await h.revokeOrigin("https://api-inference.modelscope.cn/*")).toEqual({
      origins: [],
      revoked: false
    });
    expect(h.removeMock).not.toHaveBeenCalled();

    expect(await h.revokeOrigin("http://localhost:11434/v1")).toEqual({
      origins: ["http://localhost/*"],
      revoked: true
    });
    expect(h.containsMock).toHaveBeenCalledWith({ origins: ["http://localhost/*"] });
    expect(h.removeMock).toHaveBeenCalledWith({ origins: ["http://localhost/*"] });
  });
});
