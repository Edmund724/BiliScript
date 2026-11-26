import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  extractOriginFromBaseUrl,
  toPermissionMatchPattern,
  collectPermissionMatchPatterns,
  buildPermissionGrantQuery,
  parsePermissionGrantParams,
  formatPermissionRequestError,
  requestProviderOrigins,
  checkHostPermission,
  checkHostPermissionViaBackground,
  checkHostPermissionFromOffscreen,
  hasHostPermission,
  hasHostPermissionViaBackground,
  hasHostPermissionFromOffscreen,
  isStaticHostPermission,
  revokeOriginPermission,
  revokeOrphanOriginViaBackground,
  permissionRevokeErrorMessage,
  normalizeOptionalApiPermission,
  collectOptionalApiPermissions,
  checkOptionalPermissionViaBackground,
  requestOptionalPermissionViaBackground
} from "../../extension/core/host-permissions.js";

beforeEach(() => {
  resetModuleState();
});

describe("extractOriginFromBaseUrl", () => {
  it("http(s) baseUrl 提取 match pattern（含路径、尾斜杠、query 归一，补 /* 路径）", () => {
    expect(extractOriginFromBaseUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/*");
    expect(extractOriginFromBaseUrl("https://api.openai.com/v1/")).toBe("https://api.openai.com/*");
    expect(extractOriginFromBaseUrl("http://localhost:11434/v1")).toBe("http://localhost:11434/*");
    expect(extractOriginFromBaseUrl(" https://api.siliconflow.cn/v1 ")).toBe("https://api.siliconflow.cn/*");
    expect(extractOriginFromBaseUrl("https://api.example.com/v1?x=1")).toBe("https://api.example.com/*");
    expect(extractOriginFromBaseUrl("wss://api.mosi.cn/v1/realtime?model=moss-live-1.0")).toBe("wss://api.mosi.cn/*");
    expect(extractOriginFromBaseUrl("ws://localhost:8080/v1/realtime")).toBe("ws://localhost:8080/*");
  });

  it("非法/边界输入返回 null", () => {
    expect(extractOriginFromBaseUrl("")).toBeNull();
    expect(extractOriginFromBaseUrl("   ")).toBeNull();
    expect(extractOriginFromBaseUrl("not a url")).toBeNull();
    expect(extractOriginFromBaseUrl("ftp://api.example.com/v1")).toBeNull();
    expect(extractOriginFromBaseUrl("api.openai.com/v1")).toBeNull();
    expect(extractOriginFromBaseUrl("https://")).toBeNull();
    expect(extractOriginFromBaseUrl(undefined)).toBeNull();
    expect(extractOriginFromBaseUrl(null)).toBeNull();
  });
});

describe("toPermissionMatchPattern", () => {
  it("剥离端口号输出 ${protocol}//${hostname}/*（适配 Firefox 无端口权限约束）", () => {
    expect(toPermissionMatchPattern("http://localhost:11434/v1")).toBe("http://localhost/*");
    expect(toPermissionMatchPattern("http://localhost:8000/*")).toBe("http://localhost/*");
    expect(toPermissionMatchPattern("https://api.example.com:8443/v1")).toBe("https://api.example.com/*");
    expect(toPermissionMatchPattern("ws://127.0.0.1:8080/v1/realtime")).toBe("ws://127.0.0.1/*");
    expect(toPermissionMatchPattern("wss://api.mosi.cn:9000/v1/realtime")).toBe("wss://api.mosi.cn/*");
    expect(toPermissionMatchPattern("http://[::1]:11434/v1")).toBe("http://[::1]/*");
    expect(toPermissionMatchPattern(" https://api.openai.com/v1 ")).toBe("https://api.openai.com/*");
  });

  it("非法/边界输入返回 null", () => {
    expect(toPermissionMatchPattern("")).toBeNull();
    expect(toPermissionMatchPattern("   ")).toBeNull();
    expect(toPermissionMatchPattern("not a url")).toBeNull();
    expect(toPermissionMatchPattern("ftp://api.example.com/v1")).toBeNull();
    expect(toPermissionMatchPattern("https://")).toBeNull();
    expect(toPermissionMatchPattern(undefined)).toBeNull();
    expect(toPermissionMatchPattern(null)).toBeNull();
  });
});

describe("collectPermissionMatchPatterns 与授权弹窗编解码", () => {
  it("同 host 不同端口剥端口后自动去重", () => {
    expect(
      collectPermissionMatchPatterns([
        "http://localhost:11434/v1",
        "http://localhost:8000/v1",
        "https://api.openai.com:8443/v1",
        "https://api.openai.com/chat",
        "oops"
      ])
    ).toEqual(["http://localhost/*", "https://api.openai.com/*"]);
  });

  it("非数组入参按空处理", () => {
    expect(collectPermissionMatchPatterns(null)).toEqual([]);
  });

  it("buildPermissionGrantQuery / parsePermissionGrantParams 往返一致并过滤非法项", () => {
    const query = buildPermissionGrantQuery("req-42", ["http://localhost:11434/v1", "https://api.example.com/*"]);
    expect(parsePermissionGrantParams(`?${query}`)).toEqual({
      reqId: "req-42",
      origins: ["http://localhost/*", "https://api.example.com/*"]
    });
    expect(parsePermissionGrantParams("?reqId=bad&origins=not-json")).toEqual({
      reqId: "bad",
      origins: []
    });
    expect(formatPermissionRequestError(new Error("boom"))).toBe("申请域名权限失败：boom");
  });
});

describe("requestProviderOrigins（保存手势链上的批量申请）", () => {
  it("授权通过 → ok，request 收到去重后的 origin", async () => {
    const request = vi.fn(async () => true);
    const resp = await requestProviderOrigins(
      ["https://api.openai.com/v1", "https://api.siliconflow.cn/v1", "https://api.openai.com/chat"],
      request
    );
    expect(resp.ok).toBe(true);
    expect(resp.origins).toEqual(["https://api.openai.com/*", "https://api.siliconflow.cn/*"]);
    expect(request).toHaveBeenCalledWith({
      origins: ["https://api.openai.com/*", "https://api.siliconflow.cn/*"]
    });
  });

  it("多个平台只发一次 request（一次手势只够一次弹窗）", async () => {
    const request = vi.fn(async () => true);
    await requestProviderOrigins(["https://a.example.com/v1", "https://b.example.com/v1"], request);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("带端口地址转换为无端口 pattern 并去重后传给 request", async () => {
    const request = vi.fn(async () => true);
    const resp = await requestProviderOrigins(
      ["http://localhost:11434/v1", "http://localhost:8000/v1"],
      request
    );
    expect(resp).toEqual({ ok: true, origins: ["http://localhost/*"] });
    expect(request).toHaveBeenCalledWith({ origins: ["http://localhost/*"] });
  });

  it("无 origin 可申请（空列表 / 全非法）→ 不发 request 也不报错", async () => {
    const request = vi.fn(async () => true);
    expect(await requestProviderOrigins([], request)).toEqual({ ok: true, origins: [] });
    const resp = await requestProviderOrigins(["", "oops"], request);
    expect(resp.ok).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("用户拒绝 → 明确可操作错误，不静默", async () => {
    const request = vi.fn(async () => false);
    const resp = await requestProviderOrigins(["https://api.openai.com/v1"], request);
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("未授权");
    expect(resp.error).toContain("https://api.openai.com");
    expect(resp.error).toContain("操作已中止");
  });

  it("request 抛错 → { ok: false, error } 兜底", async () => {
    const request = vi.fn(async () => {
      throw new Error("permissions API unavailable");
    });
    const resp = await requestProviderOrigins(["https://x/v1"], request);
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("申请域名权限失败");
  });

  it("未注入 request 实现（非扩展环境）→ 明确失败", async () => {
    const resp = await requestProviderOrigins(["https://x/v1"], undefined);
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("不支持申请权限");
  });
});

describe("checkHostPermission / hasHostPermission（探针/模型列表的权限预检）", () => {
  it("已授权 → true / granted，contains 收到无端口 pattern", async () => {
    const contains = vi.fn(async () => true);
    expect(await checkHostPermission("https://api.openai.com/v1", contains)).toEqual({
      granted: true,
      status: "granted"
    });
    expect(await hasHostPermission("https://api.openai.com/v1", contains)).toBe(true);
    expect(contains).toHaveBeenCalledWith({ origins: ["https://api.openai.com/*"] });
    expect(await hasHostPermission("http://localhost:11434/v1", contains)).toBe(true);
    expect(contains).toHaveBeenLastCalledWith({ origins: ["http://localhost/*"] });
  });

  it("未授权 → false / denied", async () => {
    const contains = vi.fn(async () => false);
    expect(await checkHostPermission("https://api.openai.com/v1", contains)).toEqual({
      granted: false,
      status: "denied"
    });
    expect(await hasHostPermission("https://api.openai.com/v1", contains)).toBe(false);
  });

  it("URL 非法或缺失 → 显式返回 invalid-origin / false，不再静默 fail-open", async () => {
    const contains = vi.fn(async () => true);
    expect(await checkHostPermission("oops", contains)).toEqual({
      granted: false,
      status: "invalid-origin"
    });
    expect(await checkHostPermission("", undefined)).toEqual({
      granted: false,
      status: "invalid-origin"
    });
    expect(await hasHostPermission("oops", contains)).toBe(false);
    expect(await hasHostPermission(undefined, undefined)).toBe(false);
    expect(contains).not.toHaveBeenCalled();
  });

  it("origin 合法但取不到 chrome.permissions 实现或 contains 抛错 → 按已授权处理", async () => {
    expect(await hasHostPermission("https://api.openai.com/v1", undefined)).toBe(true);
    const throwing = vi.fn(async () => {
      throw new Error("no permissions API");
    });
    expect(await hasHostPermission("https://api.openai.com/v1", throwing)).toBe(true);
  });
});

describe("checkHostPermissionViaBackground / hasHostPermissionViaBackground（content 语境的权限代查）", () => {
  it("扩展页面语境（有 chrome.permissions）→ 直查，不发消息", async () => {
    const contains = vi.fn(async () => true);
    const sendMessage = vi.fn();
    vi.stubGlobal("chrome", { permissions: { contains }, runtime: { sendMessage } });

    expect(await hasHostPermissionViaBackground("https://api.openai.com/v1")).toBe(true);
    expect(contains).toHaveBeenCalledWith({ origins: ["https://api.openai.com/*"] });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("content 语境（无 chrome.permissions）→ 发 check-provider-origin 代查", async () => {
    const sendMessage = vi.fn((message: unknown, callback?: (resp: unknown) => void) => {
      callback?.({ granted: false, status: "denied" });
      return undefined;
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    expect(await checkHostPermissionViaBackground("https://api.openai.com/v1")).toEqual({
      granted: false,
      status: "denied"
    });
    expect(await hasHostPermissionViaBackground("https://api.openai.com/v1")).toBe(false);
    expect(sendMessage).toHaveBeenCalledWith(
      { type: "check-provider-origin", origin: "https://api.openai.com/*" },
      expect.any(Function)
    );
  });

  it("URL 非法或缺失 → 显式返回 invalid-origin / false，不发消息", async () => {
    const sendMessage = vi.fn();
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    expect(await checkHostPermissionViaBackground("oops")).toEqual({
      granted: false,
      status: "invalid-origin"
    });
    expect(await hasHostPermissionViaBackground("")).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();

    vi.stubGlobal("chrome", {});
    expect(await hasHostPermissionViaBackground("oops")).toBe(false);
  });

  it("已授权 → true；origin 合法但无回包 / 非扩展环境 → 按已授权处理（不阻塞既有路径）", async () => {
    const granted = vi.fn((_message: unknown, callback?: (resp: unknown) => void) => {
      callback?.({ granted: true, status: "granted" });
      return undefined;
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage: granted } });
    expect(await hasHostPermissionViaBackground("https://api.openai.com/v1")).toBe(true);

    const unanswered = vi.fn((_message: unknown, callback?: (resp: unknown) => void) => {
      callback?.(undefined);
      return undefined;
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage: unanswered } });
    expect(await hasHostPermissionViaBackground("https://api.openai.com/v1")).toBe(true);

    vi.stubGlobal("chrome", {});
    expect(await hasHostPermissionViaBackground("https://api.openai.com/v1")).toBe(true);
  });
});

describe("checkHostPermissionFromOffscreen / hasHostPermissionFromOffscreen（offscreen 语境的权限代查）", () => {
  it("SW 明确回 { granted: false } → false / denied，消息带 match pattern", async () => {
    const sendMessage = vi.fn(async () => ({ granted: false, status: "denied" }));
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    expect(await checkHostPermissionFromOffscreen("https://api.siliconflow.cn/v1")).toEqual({
      granted: false,
      status: "denied"
    });
    expect(await hasHostPermissionFromOffscreen("https://api.siliconflow.cn/v1")).toBe(false);
    expect(sendMessage).toHaveBeenCalledWith({
      type: "check-provider-origin",
      origin: "https://api.siliconflow.cn/*"
    });
  });

  it("URL 非法 → 显式返回 invalid-origin / false 且不发消息", async () => {
    const sendMessage = vi.fn(async () => ({ granted: true, status: "granted" }));
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    expect(await checkHostPermissionFromOffscreen("oops")).toEqual({
      granted: false,
      status: "invalid-origin"
    });
    expect(await hasHostPermissionFromOffscreen("")).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("已授权 → true；origin 合法但无回包 / 消息抛错 / 非扩展环境 → 按已授权处理（fail-open）", async () => {
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn(async () => ({ granted: true, status: "granted" })) } });
    expect(await hasHostPermissionFromOffscreen("https://api.openai.com/v1")).toBe(true);

    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn(async () => undefined) } });
    expect(await hasHostPermissionFromOffscreen("https://api.openai.com/v1")).toBe(true);

    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn(async () => {
          throw new Error("Could not establish connection");
        })
      }
    });
    expect(await hasHostPermissionFromOffscreen("https://api.openai.com/v1")).toBe(true);

    vi.stubGlobal("chrome", {});
    expect(await hasHostPermissionFromOffscreen("https://api.openai.com/v1")).toBe(true);
  });
});

const HOST_PERMISSION_SW_IMPORTERS: Record<string, string> = {
  "core/provider-http.ts": "SW 代发接收端（handleProviderHttpRequest）",
  "core/host-permission-handlers.ts": "SW host 权限消息族处理器（check-provider-origin / request-provider-origins）",
  "live/live-session-tracker.ts": "SW 侧 Live 会话准备（liveSessionTracker.prepareFor 双 origin 权限预检）"
};

describe("语境守卫：hasHostPermission 只准在 SW 语境界面原样调用", () => {
  const EXTENSION_ROOT = join(process.cwd(), "extension");

  function listExtensionSources(): string[] {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.(ts|js)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
          files.push(full);
        }
      }
    };
    walk(EXTENSION_ROOT);
    return files;
  }

  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  }

  function importersOfRawHasHostPermission(): string[] {
    const found: string[] = [];
    for (const file of listExtensionSources()) {
      const source = stripComments(readFileSync(file, "utf8"));
      for (const match of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']*host-permissions\.js)["']/g)) {
        if (/\b(?:hasHostPermission|checkHostPermission)\b/.test(match[1])) {
          found.push(relative(EXTENSION_ROOT, file).split(sep).join("/"));
          break;
        }
      }
    }
    return found;
  }

  it("扫描不空转：三个 SW 语境调用方确实原样 import 了它", () => {
    const found = importersOfRawHasHostPermission();
    for (const file of Object.keys(HOST_PERMISSION_SW_IMPORTERS)) {
      expect(found, `${file} 应原样 import hasHostPermission（否则本守卫在被改名后空转）`).toContain(file);
    }
  });

  it("无第四个原样 import：content / offscreen 语境要查权限得走代查入口", () => {
    const extra = importersOfRawHasHostPermission().filter((file) => !(file in HOST_PERMISSION_SW_IMPORTERS));
    expect(
      extra,
      `content / offscreen 语境不得原样 import hasHostPermission（那里它恒放行）：\n  ${extra.join("\n  ")}`
    ).toEqual([]);
  });
});

describe("revokeOriginPermission 与 revokeOrphanOriginViaBackground（孤儿权限回收）", () => {
  const deleted = { id: "a1", baseUrl: "https://api.openai.com/v1" };
  const containsGranted = vi.fn(async () => true);

  it("revokeOriginPermission：命中常驻域或权限本就不在时跳过 remove；失败返回 { origins, revoked: false }", async () => {
    const remove = vi.fn(async () => true);
    expect(isStaticHostPermission("https://api-inference.modelscope.cn/*", ["https://api-inference.modelscope.cn/*"])).toBe(true);
    expect(
      await revokeOriginPermission("https://api-inference.modelscope.cn/v1", {
        contains: containsGranted,
        remove,
        staticHostPermissions: ["https://api-inference.modelscope.cn/*"]
      })
    ).toEqual({ origins: [], revoked: false });
    expect(remove).not.toHaveBeenCalled();

    expect(
      await revokeOriginPermission("https://api.openai.com/v1", {
        contains: vi.fn(async () => false),
        remove,
        staticHostPermissions: []
      })
    ).toEqual({ origins: [], revoked: false });
    expect(remove).not.toHaveBeenCalled();

    expect(
      await revokeOriginPermission("https://api.openai.com/v1", {
        contains: containsGranted,
        remove: vi.fn(async () => false),
        staticHostPermissions: []
      })
    ).toEqual({ origins: ["https://api.openai.com/*"], revoked: false });

    expect(
      await revokeOriginPermission("https://api.openai.com/v1", {
        contains: containsGranted,
        remove: vi.fn(async () => {
          throw new Error("remove failed");
        }),
        staticHostPermissions: []
      })
    ).toEqual({ origins: ["https://api.openai.com/*"], revoked: false });
  });

  it("扩展页语境（含 chrome.permissions.remove）：按 id 剔除自身、共享同 host 端口不误删、无占用时无端口回收", async () => {
    const contains = vi.fn(async () => true);
    const remove = vi.fn(async () => true);
    vi.stubGlobal("chrome", {
      permissions: { contains, remove },
      runtime: { getManifest: () => ({ host_permissions: [] }) }
    });

    expect(await revokeOrphanOriginViaBackground(deleted, [deleted])).toEqual({
      origins: ["https://api.openai.com/*"],
      revoked: true
    });
    expect(remove).toHaveBeenCalledWith({ origins: ["https://api.openai.com/*"] });

    remove.mockClear();
    expect(
      await revokeOrphanOriginViaBackground(deleted, [{ id: "s1", baseUrl: "https://api.openai.com/chat" }])
    ).toEqual({ origins: [], revoked: false });
    expect(
      await revokeOrphanOriginViaBackground(
        { id: "ollama", baseUrl: "http://localhost:11434/v1" },
        [
          { id: "ollama", baseUrl: "http://localhost:11434/v1" },
          { id: "vllm", baseUrl: "http://localhost:8000/v1" }
        ]
      )
    ).toEqual({ origins: [], revoked: false });
    expect(await revokeOrphanOriginViaBackground({ id: "a1", baseUrl: "oops" }, [])).toEqual({
      origins: [],
      revoked: false
    });
    expect(remove).not.toHaveBeenCalled();

    expect(
      await revokeOrphanOriginViaBackground(
        { id: "ollama", baseUrl: "http://localhost:11434/v1" },
        [{ id: "ollama", baseUrl: "http://localhost:11434/v1" }]
      )
    ).toEqual({ origins: ["http://localhost/*"], revoked: true });
    expect(remove).toHaveBeenCalledWith({ origins: ["http://localhost/*"] });
  });

  it("content 语境（无 chrome.permissions）→ 常驻域零消息跳过，非静态可选域委托 background 回收", async () => {
    delete (globalThis.chrome as unknown as { permissions?: unknown }).permissions;
    const sendMessage = vi.fn((msg: unknown, cb?: (resp: unknown) => void) => {
      cb?.({ origins: ["https://custom-relay.example.com/*"], revoked: true });
      return undefined;
    });
    (globalThis.chrome.runtime as unknown as { sendMessage: typeof sendMessage }).sendMessage = sendMessage;
    (globalThis.chrome.runtime as unknown as { getManifest: () => unknown }).getManifest = () => ({
      host_permissions: ["https://api-inference.modelscope.cn/*"]
    });

    const staticResp = await revokeOrphanOriginViaBackground(
      { id: "ms", baseUrl: "https://api-inference.modelscope.cn/v1" },
      []
    );
    expect(staticResp).toEqual({ origins: [], revoked: false });
    expect(sendMessage).not.toHaveBeenCalled();

    const optionalResp = await revokeOrphanOriginViaBackground(
      { id: "c1", baseUrl: "https://custom-relay.example.com/v1" },
      []
    );
    expect(sendMessage).toHaveBeenCalledWith(
      { type: "revoke-provider-origin", origin: "https://custom-relay.example.com/*" },
      expect.any(Function)
    );
    expect(optionalResp).toEqual({ origins: ["https://custom-relay.example.com/*"], revoked: true });
  });
});

describe("permissionRevokeErrorMessage", () => {
  it("拼出浏览器中性的可操作提示（含 origin 明细）", () => {
    const msg = permissionRevokeErrorMessage(["https://api.openai.com/*"]);
    expect(msg).toContain("回收域名权限失败");
    expect(msg).toContain("https://api.openai.com/*");
    expect(msg).toContain("浏览器扩展权限设置");
    expect(msg).not.toContain("扩展详情页");
  });
});

describe("可选 API 权限（downloads）编解码与客户端代理", () => {
  it("allowlist 仅放行 downloads 并过滤非法或越权字符串", () => {
    expect(normalizeOptionalApiPermission("downloads")).toBe("downloads");
    expect(normalizeOptionalApiPermission("  downloads  ")).toBe("downloads");
    expect(normalizeOptionalApiPermission("tabs")).toBeNull();
    expect(normalizeOptionalApiPermission("")).toBeNull();
    expect(normalizeOptionalApiPermission(null)).toBeNull();
    expect(collectOptionalApiPermissions(["downloads", "tabs", "downloads", 123])).toEqual(["downloads"]);
  });

  it("buildPermissionGrantQuery / parsePermissionGrantParams 支持可选 API permissions 往返并过滤非法项", () => {
    const query = buildPermissionGrantQuery("req-dl", [], ["downloads"]);
    expect(parsePermissionGrantParams(`?${query}`)).toEqual({
      reqId: "req-dl",
      origins: [],
      permissions: ["downloads"]
    });
    expect(parsePermissionGrantParams(`?reqId=req-dl&permissions=${encodeURIComponent(JSON.stringify(["downloads", "history"]))}`)).toEqual({
      reqId: "req-dl",
      origins: [],
      permissions: ["downloads"]
    });
    expect(parsePermissionGrantParams("?reqId=req-dl&permissions=not-json")).toEqual({
      reqId: "req-dl",
      origins: []
    });
  });

  it("extension 语境直接调用 chrome.permissions，content 语境经 background 消息查询与申请 downloads", async () => {
    const contains = vi.fn(async () => true);
    const request = vi.fn(async () => true);
    (globalThis.chrome as unknown as { permissions: unknown }).permissions = { contains, request };

    expect(await checkOptionalPermissionViaBackground("downloads")).toBe(true);
    expect(contains).toHaveBeenCalledWith({ permissions: ["downloads"] });

    expect(await requestOptionalPermissionViaBackground("downloads")).toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith({ permissions: ["downloads"] });

    delete (globalThis.chrome as unknown as { permissions?: unknown }).permissions;
    const sendMessage = vi.fn((msg: { type: string }, cb?: (resp: unknown) => void) => {
      cb?.(msg.type === "check-optional-permission" ? { ok: true, granted: true } : { ok: true });
      return undefined;
    });
    (globalThis.chrome.runtime as unknown as { sendMessage: typeof sendMessage }).sendMessage = sendMessage;

    expect(await checkOptionalPermissionViaBackground("downloads")).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      { type: "check-optional-permission", permission: "downloads" },
      expect.any(Function)
    );

    expect(await requestOptionalPermissionViaBackground("downloads")).toEqual({ ok: true });
    expect(sendMessage).toHaveBeenCalledWith(
      { type: "request-optional-permission", permission: "downloads" },
      expect.any(Function)
    );
  });
});
