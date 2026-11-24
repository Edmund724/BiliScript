// @vitest-environment jsdom
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

  it("syncStylesToDocument 按级联顺序幂等镜像到子文档，且对 opener 为 no-op", async () => {
    const injector = await loadInjector();
    injector.ensureReaderStyles();
    injector.ensureReaderChatStyles();

    const detachedDoc = document.implementation.createHTMLDocument("Detached");
    injector.syncStylesToDocument(document);
    expect(mountedLinks()).toHaveLength(6);

    injector.syncStylesToDocument(detachedDoc);
    injector.syncStylesToDocument(detachedDoc);

    const detachedLinks = Array.from(
      detachedDoc.head.querySelectorAll<HTMLLinkElement>('link[data-biliscript-style="1"]')
    );
    expect(detachedLinks).toHaveLength(6);
    expect(detachedLinks[0].href).toContain("entry/styles/tokens-primitive.css");
    expect(detachedLinks[1].href).toContain("entry/styles/reader.css");
    expect(detachedLinks[2].href).toContain("entry/styles/reader-gate.css");
  });

  it("子窗口活跃时，懒加载样式立即镜像到子文档，removeReaderStyles 同时摘除双端阅读样式", async () => {
    const activeHost = await import("../../extension/shared/active-host.js");
    const injector = await loadInjector();
    const detachedDoc = document.implementation.createHTMLDocument("Detached");
    const detachedWin = { closed: false } as unknown as Window;

    injector.ensurePlayerAiStyles();
    injector.ensureReaderStyles();
    activeHost.setActiveReaderHost(detachedDoc, detachedWin);
    injector.syncStylesToDocument(detachedDoc);

    injector.ensureCustomSelectStyles();
    injector.ensureToggleSwitchStyles();
    injector.ensureBilingualSubtitleStyles();
    injector.ensureReaderChatStyles();

    const detachedSelect = detachedDoc.head.querySelector('link[href$="entry/styles/custom-select.css"]');
    const detachedToggle = detachedDoc.head.querySelector('link[href$="entry/styles/toggle-switch.css"]');
    const detachedBilingual = detachedDoc.head.querySelector('link[href$="entry/styles/bilingual-subtitles.css"]');
    expect(detachedSelect).not.toBeNull();
    expect(detachedToggle).not.toBeNull();
    expect(detachedBilingual).not.toBeNull();

    injector.removeReaderStyles();
    expectReaderLinks(false);
    for (const path of READER_PATHS) {
      expect(detachedDoc.head.querySelector(`link[href$="${path}"]`)).toBeNull();
    }
    expect(detachedDoc.head.querySelector(`link[href$="${PLAYER_AI_PATH}"]`)).not.toBeNull();

    injector.clearMirroredStyles(detachedDoc);
    expect(detachedDoc.head.querySelectorAll('link[data-biliscript-style="1"]')).toHaveLength(0);
    expect(hasStyleLink(PLAYER_AI_PATH)).toBe(true);
  });

  it("clearMirroredStyles 在目标文档抛出死亡对象异常时仍安全完成", async () => {
    const injector = await loadInjector();
    const deadDoc = document.implementation.createHTMLDocument("Dead");
    Object.defineProperty(deadDoc, "querySelectorAll", {
      value: () => {
        throw new TypeError("can't access dead object");
      }
    });
    expect(() => injector.clearMirroredStyles(deadDoc)).not.toThrow();
  });

  it("syncStylesToDocument 与分离态 ensure*Styles 在死亡 appendChild 或无容器文档下不抛错", async () => {
    const activeHost = await import("../../extension/shared/active-host.js");
    const injector = await loadInjector();
    const brokenDoc = document.implementation.createHTMLDocument("Broken");
    const brokenWin = { closed: false } as unknown as Window;
    const appendSpy = brokenDoc.head.appendChild.bind(brokenDoc.head);
    brokenDoc.head.appendChild = (() => {
      throw new TypeError("can't access dead object");
    }) as typeof brokenDoc.head.appendChild;

    injector.ensureReaderStyles();
    activeHost.setActiveReaderHost(brokenDoc, brokenWin);

    expect(() => injector.syncStylesToDocument(brokenDoc)).not.toThrow();
    expect(() => injector.ensurePlayerAiStyles()).not.toThrow();
    expect(() => injector.ensureReaderSettingsStyles()).not.toThrow();
    await expect(injector.whenReaderSettingsStylesReady()).resolves.toBeUndefined();
    expect(() => injector.ensureReaderChatStyles()).not.toThrow();
    expect(typeof appendSpy).toBe("function");

    const emptyDoc = document.implementation.createHTMLDocument("Empty");
    const emptyWin = { closed: false } as unknown as Window;
    emptyDoc.documentElement.remove();
    activeHost.setActiveReaderHost(emptyDoc, emptyWin);

    expect(() => injector.syncStylesToDocument(emptyDoc)).not.toThrow();
    expect(() => injector.ensurePlayerAiStyles()).not.toThrow();
    expect(() => injector.ensureReaderSettingsStyles()).not.toThrow();
    await expect(injector.whenReaderSettingsStylesReady()).resolves.toBeUndefined();
  });

  it("停靠态已加载设置表后，分离态经 syncStylesToDocument 镜像后再调 ensureReaderSettingsStyles 仍等待子文档 load", async () => {
    const activeHost = await import("../../extension/shared/active-host.js");
    const injector = await loadInjector();
    const settingsPaths = [
      "entry/styles/reader-settings-shell.css",
      "entry/styles/reader-settings-rows.css",
      "entry/styles/reader-settings-providers.css"
    ];

    injector.ensureReaderSettingsStyles();
    for (const path of settingsPaths) {
      document.head.querySelector(`link[href$="${path}"]`)?.dispatchEvent(new Event("load"));
    }
    await injector.whenReaderSettingsStylesReady();

    const detachedDoc = document.implementation.createHTMLDocument("Detached");
    const detachedWin = { closed: false } as unknown as Window;
    activeHost.setActiveReaderHost(detachedDoc, detachedWin);
    injector.syncStylesToDocument(detachedDoc);

    injector.ensureReaderSettingsStyles();
    const ready = injector.whenReaderSettingsStylesReady();
    let settled = false;
    void ready.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    const detachedLinks = settingsPaths.map((path) =>
      detachedDoc.head.querySelector(`link[href$="${path}"]`)
    );
    for (const link of detachedLinks.slice(0, 2)) {
      expect(link).not.toBeNull();
      link?.dispatchEvent(new Event("load"));
    }
    await Promise.resolve();
    expect(settled).toBe(false);

    detachedLinks[2]?.dispatchEvent(new Event("load"));
    await ready;
    expect(settled).toBe(true);
  });
});
