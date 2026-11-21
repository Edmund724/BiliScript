import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetModuleState } from "../setup.js";

const READER_PATHS = [
  "entry/styles/tokens-primitive.css",
  "entry/styles/reader.css",
  "entry/styles/reader-gate.css"
];
const PLAYER_AI_PATH = "entry/styles/player-ai.css";

function loadInjector() {
  return import("../../extension/shared/style-injector.js");
}

function mountedLinks(): HTMLLinkElement[] {
  return Array.from(document.querySelectorAll<HTMLLinkElement>('link[data-biliscript-style="1"]'));
}

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
  it("ensureReaderStyles 挂阅读表 link（含 tokens-primitive.css 置顶），URL 经 chrome.runtime.getURL 解析", async () => {
    const injector = await loadInjector();
    injector.ensureReaderStyles();

    const links = mountedLinks();
    expect(links).toHaveLength(3);
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
    expect(mountedLinks()).toHaveLength(3);

    injector.ensurePlayerAiStyles();
    injector.ensurePlayerAiStyles();
    expect(mountedLinks()).toHaveLength(4);
    expect(hasStyleLink(PLAYER_AI_PATH)).toBe(true);
  });

  it("开→关→开：remove 摘表并清 Map，再次 ensure 重挂全新 link", async () => {
    const injector = await loadInjector();

    injector.ensureReaderStyles();
    injector.ensurePlayerAiStyles();
    expect(mountedLinks()).toHaveLength(4);

    injector.removeReaderStyles();
    expect(mountedLinks()).toHaveLength(1);
    expectReaderLinks(false);

    injector.ensureReaderStyles();
    const links = mountedLinks();
    expect(links).toHaveLength(4);
    expectReaderLinks(true);
  });

  it("remove 未挂过的路径是 no-op（幂等移除）", async () => {
    const injector = await loadInjector();
    injector.removeReaderStyles();
    injector.removePlayerAiStyles();
    expect(mountedLinks()).toHaveLength(0);
  });
});
