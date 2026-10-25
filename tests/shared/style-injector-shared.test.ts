// shared/style-injector 挂载记录跨实例共享回归（content 两轮构建的双实例缺陷，
// 最后一处）：
//
// scripts/build-content.js 是两轮构建——轮 A 常驻单文件（content-main.mjs）、
// 轮 B 懒加载区（chunks/），共享底座在两侧各有一份实例。挂载记录原先挂模块级
// Map，而挂载点本就分居两侧（常驻 entry/content.ts 的直达阅读 URL 路径、
// 懒加载区 reader/shell.ts 的进入事务）：各记各的会让同一路径被注入两个
// <link>，且一侧 removeReaderStyles 摘不掉另一侧那个（退出阅读模式后样式表
// 残留）。修复：挂载记录与设置表 ready promise 挂 globalThis 槽（与
// shared/messaging.ts 的页内分发槽同款先例）。
//
// 手法：vi.resetModules() 后重新 import 得到**另一个模块实例**，断言它认账
// 同一份挂载记录——正是生产里两侧实例的分工。

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

// 挂载态即 DOM（跨实例共享的记录落在同一个 document 上），逐路径断言。
function hasStyleLink(path: string): boolean {
  return document.head.querySelector(`link[href$="${path}"]`) !== null;
}

beforeEach(async () => {
  resetModuleState();
  document.head.innerHTML = "";
  resident = await import("../../extension/shared/style-injector.js");
  // 模拟轮 B 懒加载区那份实例
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
    expect(afterFirstMount).toBe(3); // tokens-primitive.css + reader.css + reader-gate.css
    for (const path of READER_PATHS) {
      expect(hasStyleLink(path), `${path} 未挂上`).toBe(true); // 跨实例共享的记录在 DOM 上可见
    }

    lazy.ensureReaderStyles();

    expect(injectedLinks().length).toBe(afterFirstMount); // 不再多挂一份
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
    lazy.ensurePlayerAiStyles(); // 两侧都 ensure，仍只有一份
    expect(hasStyleLink(PLAYER_AI_PATH)).toBe(true);
    expect(injectedLinks().length).toBe(1);

    lazy.ensureReaderChatStyles();
    resident.ensureReaderChatStyles(); // 两侧都求值，仍只有一份
    // 逐条断言三张表都在（不合并成单个布尔）
    for (const path of READER_CHAT_PATHS) {
      expect(hasStyleLink(path), `${path} 未挂上`).toBe(true);
    }
    expect(injectedLinks().length).toBe(4); // player-ai + 对话三件套
  });

  it("设置表 ready promise 跨实例同一份（whenReaderSettingsStylesReady 等的是同一个）", () => {
    resident.ensureReaderSettingsStyles();
    const residentReady = resident.whenReaderSettingsStylesReady();
    const lazyReady = lazy.whenReaderSettingsStylesReady();

    expect(lazyReady).toBe(residentReady); // 修复前懒加载区侧为 Promise.resolve() 新对象
  });
});
