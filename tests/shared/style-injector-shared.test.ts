// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

type StyleInjector = typeof import("../../extension/shared/style-injector.js");

const READER_PATHS = [
  "entry/styles/tokens-primitive.css",
  "entry/styles/reader.css",
  "entry/styles/reader-gate.css"
];
const PLAYER_AI_PATH = "entry/styles/player-ai.css";
const READER_CHAT_PATHS = [
  "entry/styles/github-markdown.css",
  "entry/styles/github-markdown-theme.css",
  "entry/styles/reader-chat.css"
];

let resident: StyleInjector;
let lazy: StyleInjector;

function injectedLinks(): HTMLLinkElement[] {
  return Array.from(document.querySelectorAll<HTMLLinkElement>("link[data-biliscript-style]"));
}

function hasStyleLink(path: string): boolean {
  return document.head.querySelector(`link[href$="${path}"]`) !== null;
}

beforeEach(async () => {
  resetModuleState();
  document.head.innerHTML = "";
  resident = await import("../../extension/shared/style-injector.js");
  vi.resetModules();
  lazy = await import("../../extension/shared/style-injector.js");
});

describe("style-injector 挂载记录跨实例共享", () => {
  it("两个模块实例确实不同（前提校验）", () => {
    expect(lazy).not.toBe(resident);
  });

  it("一侧挂载、另一侧认账（DOM 里只有一份同路径 <link>）", () => {
    resident.ensureReaderStyles();
    const afterFirstMount = injectedLinks().length;
    expect(afterFirstMount).toBe(3);
    for (const path of READER_PATHS) {
      expect(hasStyleLink(path), `${path} 未挂上`).toBe(true);
    }

    lazy.ensureReaderStyles();

    expect(injectedLinks().length).toBe(afterFirstMount);
  });

  it("一侧移除、另一侧认账（退出阅读模式不再残留）", () => {
    lazy.ensureReaderStyles();
    for (const path of READER_PATHS) {
      expect(hasStyleLink(path), `${path} 未挂上`).toBe(true);
    }

    resident.removeReaderStyles();

    for (const path of READER_PATHS) {
      expect(hasStyleLink(path), `${path} 仍挂在 DOM`).toBe(false);
    }
    expect(injectedLinks().length).toBe(0);
  });

  it("player-ai / 对话分区表：跨实例挂载记录一致", () => {
    resident.ensurePlayerAiStyles();
    lazy.ensurePlayerAiStyles();
    expect(hasStyleLink(PLAYER_AI_PATH)).toBe(true);
    expect(injectedLinks().length).toBe(1);

    lazy.ensureReaderChatStyles();
    resident.ensureReaderChatStyles();
    for (const path of READER_CHAT_PATHS) {
      expect(hasStyleLink(path), `${path} 未挂上`).toBe(true);
    }
    expect(injectedLinks().length).toBe(4);
  });

  it("设置表 ready promise 跨实例同一份（whenReaderSettingsStylesReady 等的是同一个）", () => {
    resident.ensureReaderSettingsStyles();
    const residentReady = resident.whenReaderSettingsStylesReady();
    const lazyReady = lazy.whenReaderSettingsStylesReady();

    expect(lazyReady).toBe(residentReady);
  });

  it("阅读表 ready 等全部 link load，而不是只等 DOM 挂载", async () => {
    const ready = resident.ensureReaderStyles();
    let settled = false;
    void ready.then(() => {
      settled = true;
    });
    const links = READER_PATHS.map((path) => document.head.querySelector(`link[href$="${path}"]`));

    for (const link of links.slice(0, 2)) {
      link?.dispatchEvent(new Event("load"));
    }
    await Promise.resolve();
    expect(settled).toBe(false);

    links[2]?.dispatchEvent(new Event("load"));
    await ready;
    expect(settled).toBe(true);
  });

  it("跨实例子窗口镜像：一侧同步并卸载，另一侧新建懒加载表可立即镜像并等待子文档 load", async () => {
    const activeHost = await import("../../extension/shared/active-host.js");
    const detachedDoc = document.implementation.createHTMLDocument("Detached");
    const detachedWin = { closed: false } as unknown as Window;

    resident.ensureReaderStyles();
    activeHost.setActiveReaderHost(detachedDoc, detachedWin);
    lazy.syncStylesToDocument(detachedDoc);

    lazy.ensureReaderSettingsStyles();
    const ready = resident.whenReaderSettingsStylesReady();
    let settled = false;
    void ready.then(() => {
      settled = true;
    });

    const settingsLinks = [
      "entry/styles/reader-settings-shell.css",
      "entry/styles/reader-settings-rows.css",
      "entry/styles/reader-settings-providers.css"
    ].map((path) => detachedDoc.head.querySelector(`link[href$="${path}"]`));

    for (const link of settingsLinks.slice(0, 2)) {
      expect(link).not.toBeNull();
      link?.dispatchEvent(new Event("load"));
    }
    await Promise.resolve();
    expect(settled).toBe(false);

    settingsLinks[2]?.dispatchEvent(new Event("load"));
    await ready;
    expect(settled).toBe(true);

    resident.clearMirroredStyles(detachedDoc);
    expect(detachedDoc.head.querySelectorAll('link[data-biliscript-style="1"]')).toHaveLength(0);
    expect(injectedLinks().length).toBe(6);
  });
});
