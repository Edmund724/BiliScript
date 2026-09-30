// 文摘面板「当前标签」的持久化叶子（2026-10 用户决议：刷新/新视频/手动进入都
// 恢复上次所在标签，不再跳回字幕 tab）。
//
// 为什么落 chrome.storage.local 而不是 settings 域：标签位置是设备本地 UI 偏好
//（与 shared/selected-provider 的「对话 tab 选中模型」同类），没有设置面板入口、
// 无需跨设备同步、也不该占用 chrome.storage.sync 的写入配额。settings 域
//（readerTheme 等）的归一化步骤表/白名单因此零改动。
//
// 边界：本模块是叶子——只与 chrome.storage.local 交互，静态依赖仅 shared/logging
// 与 reader/state 的纯类型（type-only，构建后消失，不构成对 state 的运行时边）。
// 读失败/值非法一律回落 "subtitle"（默认标签），写失败静默：持久化是体验
// 增强，任何时候都不得阻断进入阅读模式或切换标签。存储不可用（非扩展上下文、
// 测试桩缺失）同样按缺失处理。
//
// 双实例纪律：本模块无常驻可变状态（无模块级变量），不需要
// BILISCRIPT_DUAL_INSTANCE_STATEFUL 标记。

import { logWarn } from "../shared/logging.js";
import type { ReaderScriptTab } from "./state.js";

// 存储键：读（loadReaderScriptTab）与写（saveReaderScriptTab）同源，禁止在
// 调用方手抄字符串。
export const READER_ACTIVE_TAB_KEY = "readerActiveScriptTab";

const READER_SCRIPT_TABS: readonly ReaderScriptTab[] = ["subtitle", "overview", "chat"];

export function isReaderScriptTab(value: unknown): value is ReaderScriptTab {
  return READER_SCRIPT_TABS.indexOf(value as ReaderScriptTab) !== -1;
}

// 脏值归一的唯一收口：三个合法标签原样，其余（缺失/未知字符串/非字符串）回落
// 默认「字幕」。调用方按「永远拿到合法标签」使用，不再各自兜底。
export function normalizeReaderScriptTab(value: unknown): ReaderScriptTab {
  return isReaderScriptTab(value) ? value : "subtitle";
}

function storageLocal(): chrome.storage.StorageArea | undefined {
  try {
    return globalThis.chrome?.storage?.local;
  } catch {
    // 非扩展上下文下访问 chrome 可能抛（属性 getter 缺失等）：按不可用处理
    return undefined;
  }
}

// 读取上次所在标签。任何失败（存储不可用/读取拒绝/值非法）都回落 "subtitle"，
// 绝不向调用方抛——进入阅读模式的链上多一个 await 不得新增失败面。
export async function loadReaderScriptTab(): Promise<ReaderScriptTab> {
  const area = storageLocal();
  if (!area) {
    return "subtitle";
  }
  try {
    const stored = (await area.get(READER_ACTIVE_TAB_KEY)) as Record<string, unknown> | undefined;
    return normalizeReaderScriptTab(stored?.[READER_ACTIVE_TAB_KEY]);
  } catch (error) {
    logWarn("[BILISCRIPT] reader active tab load failed", error);
    return "subtitle";
  }
}

// 写入当前标签（fire-and-forget）：同步抛错与异步拒绝都只记日志——切 tab 的
// 交互不被存储拖慢，也不因写失败回滚。
export function saveReaderScriptTab(tab: ReaderScriptTab): void {
  const area = storageLocal();
  if (!area) {
    return;
  }
  try {
    void Promise.resolve(area.set({ [READER_ACTIVE_TAB_KEY]: tab })).catch((error) => {
      logWarn("[BILISCRIPT] reader active tab save failed", error);
    });
  } catch (error) {
    logWarn("[BILISCRIPT] reader active tab save failed", error);
  }
}
