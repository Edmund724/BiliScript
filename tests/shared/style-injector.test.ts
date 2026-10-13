// S3 分层：shared/style-injector.js 的挂载生命周期。
//
// 覆盖「开→关→开」注入契约：
//   - ensureReaderStyles 挂两张阅读表 link（styles/reader.css +
//     styles/reader-gate.css），路径经 chrome.runtime.getURL 解析；
//   - 幂等：重复 ensure 不重复挂（mounted Map 防重）；
//   - removeReaderStyles 摘表并清 Map；再次 ensure 重挂（link 引用全新，
//     但浏览器样式缓存保证二进宫无闪变——本测试断言 DOM 层行为）；
//   - ensurePlayerAiStyles / removePlayerAiStyles 同契约（单表）。
//
// 不校验 CSS 内容（minify/引用完整性由 build.js 的 manifest 校验覆盖）。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetModuleState } from "../setup.js";

const READER_PATHS = ["entry/styles/reader.css", "entry/styles/reader-gate.css"];
const PLAYER_AI_PATH = "entry/styles/player-ai.css";

function loadInjector() {
  return import("../../extension/shared/style-injector.js");
}

function mountedLinks(): HTMLLinkElement[] {
  return Array.from(document.querySelectorAll<HTMLLinkElement>('link[data-biliscript-style="1"]'));
}

// 挂载态即 DOM：每张表一条 link，逐路径断言（不合并成单个布尔，缺失时能报出是哪张表）。
function hasStyleLink(path: string): boolean {
  return document.head.querySelector(`link[href$="${path}"]`) !== null;
}

function expectReaderLinks(mounted: boolean): void {
  for (const path of READER_PATHS) {
    expect(hasStyleLink(path), `${path} ${mounted ? "未挂上" : "仍挂在 DOM"}`).toBe(mounted);
  }
}

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

describe("style-injector 挂载生命周期", () => {
  it("ensureReaderStyles 挂两张阅读表 link，URL 经 chrome.runtime.getURL 解析", async () => {
    const injector = await loadInjector();
    injector.ensureReaderStyles();

    const links = mountedLinks();
    expect(links).toHaveLength(2);
    const hrefs = links.map((link) => link.href);
    for (const path of READER_PATHS) {
      expect(hrefs).toContain(`chrome-extension://test/${path}`);
    }
    expectReaderLinks(true);
  });

  it("幂等：重复 ensure 不重复挂；未挂时 DOM 无对应 link", async () => {
    const injector = await loadInjector();
    expectReaderLinks(false);
    expect(hasStyleLink(PLAYER_AI_PATH)).toBe(false);

    injector.ensureReaderStyles();
    injector.ensureReaderStyles();
    expect(mountedLinks()).toHaveLength(2);

    injector.ensurePlayerAiStyles();
    injector.ensurePlayerAiStyles();
    expect(mountedLinks()).toHaveLength(3);
    expect(hasStyleLink(PLAYER_AI_PATH)).toBe(true);
  });

  it("开→关→开：remove 摘表并清 Map，再次 ensure 重挂全新 link", async () => {
    const injector = await loadInjector();

    injector.ensureReaderStyles();
    injector.ensurePlayerAiStyles();
    expect(mountedLinks()).toHaveLength(3);

    injector.removeReaderStyles();
    expect(mountedLinks()).toHaveLength(1); // 只剩 player-ai 表
    expectReaderLinks(false);

    injector.ensureReaderStyles();
    const links = mountedLinks();
    expect(links).toHaveLength(3);
    // 重挂的 link 是新节点（旧引用已摘除；样式数据由浏览器缓存，二进宫无闪变）
    expectReaderLinks(true);
  });

  it("remove 未挂过的路径是 no-op（幂等移除）", async () => {
    const injector = await loadInjector();
    injector.removeReaderStyles();
    injector.removePlayerAiStyles();
    expect(mountedLinks()).toHaveLength(0);
  });
});
