// entry/content-bootstrap.js 的加载器单测（候选4 分包）。
//
// 覆盖 bootstrap 拉起主包的四条契约：
//   - 成功加载：loadContentMain 解析出主包模块命名空间；
//   - 重复调用共享同一 promise（同一文档只发起一次模块加载）；
//   - 加载失败：promise reject，console.error 现场定位信息带主包路径与扩展
//     版本（生产上 chunk 加载失败的唯一可观测线索），且缓存清空允许重试；
//   - 防重复注入：STARTED 标志置位后再次 start 返回 null，不重复 import、
//     不覆盖哨兵；
//   - 首按钮预取（first-button-ux/04）：loadContentMain 注入 digest-button /
//     player-ai 的 <link rel="modulepreload">（只下载不执行，importModule 仍
//     只被主包路径调用）；预取失败 onerror 仅诊断并摘除 link，不阻塞主链，
//     主包失败重试时重新注入。
//
// 动态 import 无法直接 stub，生产实现的 importModule 默认参数是真实 import()；
// 测试经工厂依赖注入 fake getExtensionUrl / importModule 代替。源模块顶层的
// 自动启动由 chrome?.runtime?.getURL 守卫控制——S3 分层后 setup.ts 的通用
// chrome stub 提供 getURL（样式挂载用），守卫恒真，因此 beforeEach 里
// resetModuleState() 重置模块纪元，保证本文件的静态 import 发生在「通用 stub
// 已安装、守卫为真」之前（首次导入的模块求值顺序：setup.ts 先于本文件，
// 顶层守卫在模块求值时即触发自动启动——见 beforeEach 注释）。

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { resetModuleState } from "../setup.js";

import {
  CONTENT_MAIN_MODULE_PATH,
  PRELOAD_MODULE_PATHS,
  startContentBootstrap
} from "../../extension/entry/content-bootstrap.js";

const fakeGetExtensionUrl = (modulePath: string) => `chrome-extension://fake-id/${modulePath}`;

function cleanGlobals() {
  delete globalThis.__BOC_CONTENT_BOOTSTRAP_STARTED__;
  delete globalThis.__BOC_CONTENT_SCRIPT_LOADED__;
}

// bootstrap 注入的预取 link 是 document 级副作用，用例间必须清干净，
// 否则上个用例残留的 link 会让「注入条数」类断言互相污染。
function cleanPreloadLinks() {
  document.head
    .querySelectorAll('link[rel="modulepreload"]')
    .forEach((link) => link.remove());
}

beforeEach(() => {
  // S3 分层：setup.ts 的通用 chrome stub 现含 runtime.getURL（样式挂载用），
  // bootstrap 顶层自动启动守卫恒真——本文件静态 import 该模块时（文件加载
  // 阶段，先于任何 beforeEach）顶层启动已触发过一次。resetModuleState 重置
  // 模块纪元后，用例内的 import 才是干净求值；STARTED/哨兵在重置前已被置位
  // 也无妨（cleanGlobals 清除），且每次 beforeEach 的重置让「顶层只跑一次」
  // 的旧语义不再成立，改为：守卫真 → 每次文件加载时顶层自动启动一次（其
  // loadContentMain 的 import 失败被 bootstrap 自身 catch 并 console.error，
  // 断言不受影响），用例只测工厂注入路径。
  resetModuleState();
  cleanGlobals();
  cleanPreloadLinks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
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
    expect(globalThis.__BOC_CONTENT_BOOTSTRAP_STARTED__).toBe(true);
    // 哨兵值必须是版本字符串（background/popup 的运行时探针按版本比对）
    expect(typeof globalThis.__BOC_CONTENT_SCRIPT_LOADED__).toBe("string");
    expect(globalThis.__BOC_CONTENT_SCRIPT_LOADED__!.length).toBeGreaterThan(0);
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

    // 现场定位契约：错误输出必须包含主包路径与扩展版本，否则生产上无法
    // 区分「WAR 配置缺失」与「产物没打进 zip」。
    expect(console.error).toHaveBeenCalledTimes(1);
    const logged = (console.error as unknown as Mock).mock.calls[0].map(String).join(" ");
    expect(logged).toContain(CONTENT_MAIN_MODULE_PATH);
    expect(logged).toContain("extension v");

    // 失败后缓存清空：再次调用重新发起加载（重试语义）
    await expect(loadContentMain()).rejects.toBe(failure);
    expect(importModule).toHaveBeenCalledTimes(2);
  });

  it("防重复注入：STARTED 标志已置位时再次 start 返回 null 且不重复 import", async () => {
    const importModule = vi.fn().mockResolvedValue({});
    const first = startContentBootstrap({
      getExtensionUrl: fakeGetExtensionUrl,
      importModule
    });
    // import 经 Promise.resolve().then 异步发起，先等到它真正跑过一次
    await first!.loadContentMain();
    expect(importModule).toHaveBeenCalledTimes(1);

    const sentinelBefore = globalThis.__BOC_CONTENT_SCRIPT_LOADED__;
    const second = startContentBootstrap({
      getExtensionUrl: fakeGetExtensionUrl,
      importModule
    });
    expect(second).toBeNull();
    // 哨兵不被第二次注入覆盖，importModule 也未被新的闭包再次调用
    expect(globalThis.__BOC_CONTENT_SCRIPT_LOADED__).toBe(sentinelBefore);
    expect(importModule).toHaveBeenCalledTimes(1);
  });

  it("预取：loadContentMain 注入 digest-button / player-ai 的 modulepreload，与主包下载并行且只下载不执行", async () => {
    const mainNamespace = { default: "main" };
    const importModule = vi.fn().mockResolvedValue(mainNamespace);
    const { loadContentMain } = startContentBootstrap({
      getExtensionUrl: fakeGetExtensionUrl,
      importModule
    })!;

    await loadContentMain();

    // modulepreload 只下载不执行：importModule 仍只被主包路径调用一次，
    // 按钮 chunk 不得经 importModule 提前执行（装载时序归主包尾部 loader）。
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
    // 失败的 link 被摘除，不在 head 里堆积
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
    // 模拟预取同样失败：onerror 摘除全部预取 link
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
