// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { resetModuleState } from "../setup.js";

import {
  CONTENT_MAIN_MODULE_PATH,
  PRELOAD_MODULE_PATHS,
  startContentBootstrap
} from "../../extension/entry/content-bootstrap.js";

const fakeGetExtensionUrl = (modulePath: string) => `chrome-extension://fake-id/${modulePath}`;

function cleanGlobals() {
  delete globalThis.__BILISCRIPT_CONTENT_BOOTSTRAP_STARTED__;
  delete globalThis.__BILISCRIPT_CONTENT_SCRIPT_LOADED__;
}

function cleanPreloadLinks() {
  document.head
    .querySelectorAll('link[rel="modulepreload"]')
    .forEach((link) => link.remove());
}

let savedChrome: typeof globalThis.chrome;

beforeEach(() => {
  resetModuleState();
  savedChrome = globalThis.chrome;
  cleanGlobals();
  cleanPreloadLinks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  globalThis.chrome = savedChrome;
  vi.doUnmock("../../extension/entry/content-bootstrap.js");
  vi.restoreAllMocks();
  cleanGlobals();
  cleanPreloadLinks();
});

describe("startContentBootstrap", () => {
  it("启动即置防重入标志与版本哨兵", () => {
    const bootstrap = startContentBootstrap({
      getExtensionUrl: fakeGetExtensionUrl,
      importModule: vi.fn()
    });
    expect(bootstrap).not.toBeNull();
    expect(globalThis.__BILISCRIPT_CONTENT_BOOTSTRAP_STARTED__).toBe(true);
    expect(typeof globalThis.__BILISCRIPT_CONTENT_SCRIPT_LOADED__).toBe("string");
    expect(globalThis.__BILISCRIPT_CONTENT_SCRIPT_LOADED__!.length).toBeGreaterThan(0);
  });

  it("成功加载：loadContentMain 解析出 importModule 返回的模块命名空间", async () => {
    const mainNamespace = { default: "main" };
    const importModule = vi.fn().mockResolvedValue(mainNamespace);
    const { loadContentMain } = startContentBootstrap({
      getExtensionUrl: fakeGetExtensionUrl,
      importModule
    })!;

    await expect(loadContentMain()).resolves.toBe(mainNamespace);
    expect(importModule).toHaveBeenCalledTimes(1);
    expect(importModule).toHaveBeenCalledWith(
      fakeGetExtensionUrl(CONTENT_MAIN_MODULE_PATH)
    );
  });

  it("重复调用共享同一 promise（不重复触发 import）", async () => {
    const mainNamespace = { default: "main" };
    const importModule = vi.fn().mockResolvedValue(mainNamespace);
    const { loadContentMain } = startContentBootstrap({
      getExtensionUrl: fakeGetExtensionUrl,
      importModule
    })!;

    const p1 = loadContentMain();
    const p2 = loadContentMain();
    expect(p1).toBe(p2);
    await Promise.all([p1, p2]);
    expect(importModule).toHaveBeenCalledTimes(1);
  });

  it("加载失败：reject 且 console.error 带主包路径与扩展版本；缓存清空允许重试", async () => {
    const failure = new Error("Failed to fetch dynamically imported module");
    const importModule = vi.fn().mockRejectedValue(failure);
    const { loadContentMain } = startContentBootstrap({
      getExtensionUrl: fakeGetExtensionUrl,
      importModule
    })!;

    await expect(loadContentMain()).rejects.toBe(failure);
    expect(importModule).toHaveBeenCalledTimes(1);

    expect(console.error).toHaveBeenCalledTimes(1);
    const logged = (console.error as unknown as Mock).mock.calls[0].map(String).join(" ");
    expect(logged).toContain(CONTENT_MAIN_MODULE_PATH);
    expect(logged).toContain("extension v");

    await expect(loadContentMain()).rejects.toBe(failure);
    expect(importModule).toHaveBeenCalledTimes(2);
  });

  it("防重复注入：STARTED 标志已置位时再次 start 返回 null 且不重复 import", async () => {
    const importModule = vi.fn().mockResolvedValue({});
    const first = startContentBootstrap({
      getExtensionUrl: fakeGetExtensionUrl,
      importModule
    });
    await first!.loadContentMain();
    expect(importModule).toHaveBeenCalledTimes(1);

    const sentinelBefore = globalThis.__BILISCRIPT_CONTENT_SCRIPT_LOADED__;
    const second = startContentBootstrap({
      getExtensionUrl: fakeGetExtensionUrl,
      importModule
    });
    expect(second).toBeNull();
    expect(globalThis.__BILISCRIPT_CONTENT_SCRIPT_LOADED__).toBe(sentinelBefore);
    expect(importModule).toHaveBeenCalledTimes(1);
  });

  it("预取：loadContentMain 注入 script-button / player-ai 的 modulepreload，与主包下载并行且只下载不执行", async () => {
    const mainNamespace = { default: "main" };
    const importModule = vi.fn().mockResolvedValue(mainNamespace);
    const { loadContentMain } = startContentBootstrap({
      getExtensionUrl: fakeGetExtensionUrl,
      importModule
    })!;

    await loadContentMain();

    expect(importModule).toHaveBeenCalledTimes(1);
    expect(importModule).toHaveBeenCalledWith(
      fakeGetExtensionUrl(CONTENT_MAIN_MODULE_PATH)
    );

    const links = document.head.querySelectorAll('link[rel="modulepreload"]');
    expect(links).toHaveLength(PRELOAD_MODULE_PATHS.length);
    const hrefs = [...links].map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual(
      PRELOAD_MODULE_PATHS.map((modulePath) => fakeGetExtensionUrl(modulePath))
    );
  });

  it("重复 loadContentMain 不重复注入预取 link", async () => {
    const importModule = vi.fn().mockResolvedValue({ default: "main" });
    const { loadContentMain } = startContentBootstrap({
      getExtensionUrl: fakeGetExtensionUrl,
      importModule
    })!;

    await Promise.all([loadContentMain(), loadContentMain()]);

    expect(
      document.head.querySelectorAll('link[rel="modulepreload"]')
    ).toHaveLength(PRELOAD_MODULE_PATHS.length);
  });

  it("预取失败不阻塞主链：onerror 仅诊断并摘除 link，loadContentMain 仍解析", async () => {
    const mainNamespace = { default: "main" };
    const importModule = vi.fn().mockResolvedValue(mainNamespace);
    const { loadContentMain } = startContentBootstrap({
      getExtensionUrl: fakeGetExtensionUrl,
      importModule
    })!;

    const pending = loadContentMain();
    const links = document.head.querySelectorAll('link[rel="modulepreload"]');
    links.forEach((link) => link.dispatchEvent(new Event("error")));

    await expect(pending).resolves.toBe(mainNamespace);
    expect(console.error).toHaveBeenCalledTimes(links.length);
    const logged = (console.error as unknown as Mock).mock.calls.map((call) => call.map(String).join(" "));
    PRELOAD_MODULE_PATHS.forEach((modulePath) => {
      expect(logged.some((line) => line.includes(modulePath))).toBe(true);
    });
    expect(logged[0]).toContain("extension v");
    expect(
      document.head.querySelector('link[rel="modulepreload"]')
    ).toBeNull();
  });

  it("失败可重试：主包加载失败且预取 link 已摘除后，再次触发重新注入预取", async () => {
    const failure = new Error("Failed to fetch dynamically imported module");
    const mainNamespace = { default: "main" };
    const importModule = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(mainNamespace);
    const { loadContentMain } = startContentBootstrap({
      getExtensionUrl: fakeGetExtensionUrl,
      importModule
    })!;

    await expect(loadContentMain()).rejects.toBe(failure);
    document.head
      .querySelectorAll('link[rel="modulepreload"]')
      .forEach((link) => link.dispatchEvent(new Event("error")));
    expect(
      document.head.querySelector('link[rel="modulepreload"]')
    ).toBeNull();

    await expect(loadContentMain()).resolves.toBe(mainNamespace);
    expect(
      document.head.querySelectorAll('link[rel="modulepreload"]')
    ).toHaveLength(PRELOAD_MODULE_PATHS.length);
  });
});

describe("模块导入与入口包装边界", () => {
  it("直接导入 content-bootstrap.js 不依赖 VITEST 环境变量，且无导入期副作用", async () => {
    const getUrlSpy = vi.spyOn(globalThis.chrome.runtime, "getURL");
    vi.stubEnv("VITEST", "");
    vi.resetModules();

    const mod = await import("../../extension/entry/content-bootstrap.js");

    expect(typeof mod.startContentBootstrap).toBe("function");
    expect(getUrlSpy).not.toHaveBeenCalled();
    expect(globalThis.__BILISCRIPT_CONTENT_BOOTSTRAP_STARTED__).toBeUndefined();
    expect(globalThis.__BILISCRIPT_CONTENT_SCRIPT_LOADED__).toBeUndefined();
    expect(document.head.querySelectorAll('link[rel="modulepreload"]')).toHaveLength(0);
  });

  it("导入 content-bootstrap-entry.js 在扩展运行时自动调用 startContentBootstrap().loadContentMain()", async () => {
    const loadContentMain = vi.fn().mockResolvedValue({});
    const startMock = vi.fn(() => ({ loadContentMain }));
    vi.resetModules();
    vi.doMock("../../extension/entry/content-bootstrap.js", () => ({
      startContentBootstrap: startMock
    }));

    await import("../../extension/entry/content-bootstrap-entry.js");

    expect(startMock).toHaveBeenCalledTimes(1);
    expect(loadContentMain).toHaveBeenCalledTimes(1);
  });

  it("导入 content-bootstrap-entry.js 在缺少 chrome.runtime.getURL 时不触发启动", async () => {
    const startMock = vi.fn();
    globalThis.chrome = {} as typeof globalThis.chrome;
    vi.resetModules();
    vi.doMock("../../extension/entry/content-bootstrap.js", () => ({
      startContentBootstrap: startMock
    }));

    await import("../../extension/entry/content-bootstrap-entry.js");

    expect(startMock).not.toHaveBeenCalled();
  });
});
