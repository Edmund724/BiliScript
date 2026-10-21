// Reader 域 seam：reader 与「reader 不能静态 import 的实现方」之间的注册式调用通道。
//
// 通道按调用方分组（每组方法名、缺失策略、注册属主见下方 READER_SEAM_METHODS）：
//
//   fetcher → reader（数据变更通知，单向扇出）：
//     订阅方经 subscribeReaderPresenter 注册回调，发布方经 notifyReaderPresenter
//     发事件。事件只带「变了什么」，渲染所需数据在通知时刻从共享 state 读取。
//     无订阅者是常态（普通页预抓取先于 reader 域装载），因此该通道不参与下方
//     单 handler 声明的缺失策略。
//   reader → fetcher（刷新请求）：
//     reader 经 requestSubtitleRefresh 请 fetcher 重抓当前 clip；fetcher 在总结链
//     装载成功路径上经 subscribeSubtitleRefresh 注册 refreshClip。链装载失败时
//     调用照旧发生，因此本槽缺失按 no-op 处理（不抛、不告警）。
//   content → reader（能力槽）：
//     settings 持久化/读取与 player-ai 快捷按钮同步的实现在常驻包，reader 域经
//     persistReaderSettingsThroughSeam / loadReaderSettingsThroughSeam /
//     requestPlayerAiSync 调用；实现在 entry/content.ts 启动时一次性注册。
//   reader → ui 壳（壳命令）、ui 壳 → reader（标签意图）：
//     reader 侧对壳的回头调改发具名命令 requestUiCommand(name, payload?)；壳在
//     装载时经 subscribeUiCommand 注册单 handler。反方向由壳的标签按钮经
//     reportTabIntent 上报意图，属主 reader/script-tab-activation 经
//     subscribeTabIntent 注册单 handler。两条边都不允许静态 import。
//   ui 壳 → 对话 tab（文档级外点关闭）：
//     ui 壳的单一文档级 click 委托经 dispatchChatTabOutsideClick 转发给对话 tab
//     在激活时注册的处理体（setChatTabOutsideClickHandler），避免第二个
//     document 监听与壳互踩。
//   reader 域内部逆边（显式端口）：
//     LAYOUT/SYNC 需要上层实现而依赖图禁止静态 import 时，经 readerPorts 的
//     显式方法回调；实现由域组装根 lifecycle 在模块求值时经 registerReaderPorts
//     单点注册。方法集只从真实调用点推导，禁止预留死槽位。
//
// 单 handler 槽的缺失语义在 READER_SEAM_METHODS 一处声明：
//   - "throw"：未注册即抛错（端口方法）；
//   - "noop"：缺席是合法时序，静默返回（字幕刷新请求）；
//   - "noop-warn"：缺席按 no-op 处理，但每槽首次命中记一次 warn——永久缺失
//     即接线 bug，同时不打断用户交互。
//
// 槽表挂 globalThis 而非模块级变量：两轮构建（scripts/build-content.js）把常驻
// 底座在懒加载区重复一份，本模块在 content-main 与 chunks/ 共享 chunk 里各是一个
// 实例。能力槽由常驻包注册、懒加载区消费，模块级槽会让注册与调用静默错开（阅读
// 面板里改主题不落盘、player-ai 同步请求无人接收）。隔离世界的 globalThis 在同一
// 扩展的全部 content 模块间唯一，两侧经它对齐到同一份槽。
//
// 双实例纪律标记：BILISCRIPT_DUAL_INSTANCE_STATEFUL——本模块含模块级可变状态（槽
// 表），允许双实例；安全依据即上文的 globalThis 槽。

import { logWarn } from "../shared/logging.js";
import type { ReaderScriptTab } from "./state.js";

// Presenter 通道的封闭事件联合（一 kind 一格）：kind 在类型层封闭，拼错的 kind
// 连编译都过不去；接收方因此按 kind 全量建表，不需要 default 静默分支。
// text 只承载状态栏文案（"subtitle-ready" 缺省时接收方取自己的默认句）。
export type ReaderPresenterEvent =
  | { kind: "reset" }
  | { kind: "rerender" }
  | { kind: "subtitle-ready"; text?: string | number | null }
  | { kind: "secondary-subtitle-ready" }
  | { kind: "status"; text: string | number | null };

export type ReaderPresenterHandler = (event: ReaderPresenterEvent) => void;

type SubtitleRefreshHandler = () => unknown;
type SettingsPersistHandler = () => void;
type SettingsLoadHandler = () => unknown;
type PlayerAiSyncHandler = (delayMs?: number, options?: { resetRetry?: boolean }) => void;
type UiCommandHandler = (name: string, payload?: unknown) => void;
type TabIntentHandler = (tab: ReaderScriptTab) => void;
type ChatTabOutsideClickHandler = (event: MouseEvent) => void;

// 单 handler 槽的签名表：方法名 → 回调签名。新增槽在此加一行。
interface ReaderSeamHandlerMap {
  subtitleRefresh: SubtitleRefreshHandler;
  persistSettings: SettingsPersistHandler;
  loadSettings: SettingsLoadHandler;
  playerAiSync: PlayerAiSyncHandler;
  uiCommand: UiCommandHandler;
  tabIntent: TabIntentHandler;
  chatTabOutsideClick: ChatTabOutsideClickHandler;
  noteManualReaderInteraction: (...args: unknown[]) => unknown;
  syncReadingViewPlayback: (...args: unknown[]) => unknown;
  flushReadingSubtitleToIndex: (...args: unknown[]) => unknown;
}

type ReaderSeamMethod = keyof ReaderSeamHandlerMap;
type ReaderSeamHandler = ReaderSeamHandlerMap[ReaderSeamMethod];

interface ReaderSeamDeclaration {
  policy: "throw" | "noop" | "noop-warn";
  owner: string;
}

// 声明与策略的单一来源：方法名、缺失策略、注册属主。
export const READER_SEAM_METHODS = Object.freeze({
  subtitleRefresh: { policy: "noop", owner: "subtitle/fetcher" },
  persistSettings: { policy: "noop-warn", owner: "entry/content" },
  loadSettings: { policy: "noop-warn", owner: "entry/content" },
  playerAiSync: { policy: "noop-warn", owner: "entry/content" },
  uiCommand: { policy: "noop-warn", owner: "ui/ui-renderer" },
  tabIntent: { policy: "noop-warn", owner: "reader/script-tab-activation" },
  chatTabOutsideClick: { policy: "noop-warn", owner: "reader/chat-tab" },
  noteManualReaderInteraction: { policy: "throw", owner: "reader/lifecycle" },
  syncReadingViewPlayback: { policy: "throw", owner: "reader/lifecycle" },
  flushReadingSubtitleToIndex: { policy: "throw", owner: "reader/lifecycle" }
} as const satisfies Record<ReaderSeamMethod, ReaderSeamDeclaration>);

// 常驻能力组的精确覆盖方法集（entry/content.ts 一次性注册）。
const CONTENT_CAPABILITY_METHODS = ["persistSettings", "loadSettings", "playerAiSync"] as const;

// reader 端口组的精确覆盖方法集（lifecycle 单点注册）。
export const READER_PORT_METHODS = Object.freeze([
  "noteManualReaderInteraction",
  "syncReadingViewPlayback",
  "flushReadingSubtitleToIndex"
] as const);

export type ReaderPortImpls = {
  noteManualReaderInteraction: (...args: unknown[]) => unknown;
  syncReadingViewPlayback: (...args: unknown[]) => unknown;
  flushReadingSubtitleToIndex: (...args: unknown[]) => unknown;
};

export type ContentSeamCapabilities = {
  persistSettings: SettingsPersistHandler;
  loadSettings: SettingsLoadHandler;
  playerAiSync: PlayerAiSyncHandler;
};

interface ReaderBusSlots {
  readers: ReaderPresenterHandler[];
  handlers: Partial<ReaderSeamHandlerMap>;
  warnedMissing: Set<ReaderSeamMethod>;
}

const READER_BUS_SLOT_KEY = "__BILISCRIPT_READER_BUS__";

function readerBusSlots(): ReaderBusSlots {
  const host = globalThis as unknown as Record<string, Partial<ReaderBusSlots> | undefined>;
  let slots = host[READER_BUS_SLOT_KEY];
  if (!slots || !Array.isArray(slots.readers)) {
    slots = { readers: [], handlers: {}, warnedMissing: new Set() };
    host[READER_BUS_SLOT_KEY] = slots;
  }
  if (!slots.handlers) {
    slots.handlers = {};
  }
  if (!slots.warnedMissing) {
    slots.warnedMissing = new Set();
  }
  return slots as ReaderBusSlots;
}

// ===== Presenter 通知（单发布、多订阅，不参与缺失策略） =====

export function subscribeReaderPresenter(handler: ReaderPresenterHandler) {
  if (typeof handler !== "function") {
    return () => {};
  }
  const { readers } = readerBusSlots();
  if (readers.indexOf(handler) === -1) {
    readers.push(handler);
  }
  return function unsubscribeReaderPresenter() {
    const index = readers.indexOf(handler);
    if (index !== -1) {
      readers.splice(index, 1);
    }
  };
}

// 通知签名：单个事件对象。事件原样透传给每个 handler——fetcher 的
// "subtitle-ready" 会带状态栏文案（如"当前视频无字幕。"），"status" 带提示文本；
// 不带 text 的 kind（reset/rerender/无文案 subtitle-ready）接收方取各自默认行为。
export function notifyReaderPresenter(event: ReaderPresenterEvent) {
  for (const handler of readerBusSlots().readers.slice()) {
    try {
      handler(event);
    } catch (error) {
      logWarn("[BILISCRIPT] reader presenter handler failed", { kind: event.kind, error });
    }
  }
}

// ===== 单 handler 槽的注册与解析 =====

function setSeamHandler<M extends ReaderSeamMethod>(
  method: M,
  handler: ReaderSeamHandlerMap[M] | null
): void {
  const slots = readerBusSlots();
  if (typeof handler === "function") {
    slots.handlers[method] = handler;
  } else {
    delete slots.handlers[method];
  }
}

function assertExactCoverage(
  kind: string,
  expected: readonly ReaderSeamMethod[],
  impls: Record<string, unknown>
): void {
  const missing = expected.filter((name) => typeof impls[name] !== "function");
  if (missing.length > 0) {
    throw new Error(`[BILISCRIPT] ${kind}缺少方法：${missing.join(", ")}`);
  }
  const unknown = Object.keys(impls).filter((name) => !expected.includes(name as ReaderSeamMethod));
  if (unknown.length > 0) {
    throw new Error(`[BILISCRIPT] ${kind}含未知方法：${unknown.join(", ")}（方法集见 READER_SEAM_METHODS）`);
  }
}

function assertNotRegistered(kind: string, methods: readonly ReaderSeamMethod[]): void {
  const { handlers } = readerBusSlots();
  const already = methods.filter((name) => typeof handlers[name] === "function");
  if (already.length > 0) {
    throw new Error(`[BILISCRIPT] ${kind}重复注册：${already.join(", ")}`);
  }
}

// 常驻能力组的唯一注册入口：entry/content.ts 启动时一次性注册三个能力槽。
export function registerContentCapabilities(impls: ContentSeamCapabilities): void {
  if (!impls || typeof impls !== "object") {
    throw new Error("[BILISCRIPT] reader 能力槽注册缺少实现表。");
  }
  assertNotRegistered("reader 能力槽", CONTENT_CAPABILITY_METHODS);
  assertExactCoverage("reader 能力槽注册", CONTENT_CAPABILITY_METHODS, impls);
  for (const method of CONTENT_CAPABILITY_METHODS) {
    setSeamHandler(method, impls[method]);
  }
}

// reader 端口组的唯一注册入口：域组装根 lifecycle 在模块求值时单点注册。
// 注册表必须精确覆盖方法集：缺方法抛错（防实现缺失静默化），多出未知键也
// 抛错（防拼写漂移悄悄绕过显式方法集）。
export function registerReaderPorts(impls: ReaderPortImpls): void {
  if (!impls || typeof impls !== "object") {
    throw new Error("[BILISCRIPT] reader 端口注册缺少实现表。");
  }
  assertNotRegistered("reader 端口", READER_PORT_METHODS);
  assertExactCoverage("reader 端口注册", READER_PORT_METHODS, impls);
  for (const method of READER_PORT_METHODS) {
    setSeamHandler(method, impls[method]);
  }
}

// 解析单 handler 槽：按声明策略抛错或按 no-op 返回 null（noop-warn 每槽首次告警）。
function resolveSeamHandler<M extends ReaderSeamMethod>(
  method: M
): ReaderSeamHandlerMap[M] | null {
  const slots = readerBusSlots();
  const handler = slots.handlers[method] as ReaderSeamHandlerMap[M] | undefined;
  if (typeof handler === "function") {
    return handler;
  }
  const { policy, owner } = READER_SEAM_METHODS[method];
  if (policy === "throw") {
    throw new Error(`[BILISCRIPT] reader seam 方法 ${method} 未注册（应由 ${owner} 注册）。`);
  }
  if (policy === "noop-warn" && !slots.warnedMissing.has(method)) {
    slots.warnedMissing.add(method);
    logWarn(`[BILISCRIPT] reader seam 方法 ${method} 未注册（${owner} 尚未注册），按 no-op 处理`);
  }
  return null;
}

function requireSeamHandler<M extends ReaderSeamMethod>(
  method: M
): NonNullable<ReaderSeamHandlerMap[M]> {
  const handler = resolveSeamHandler(method);
  if (!handler) {
    throw new Error(`[BILISCRIPT] reader seam 方法 ${method} 未注册（应由 ${READER_SEAM_METHODS[method].owner} 注册）。`);
  }
  return handler;
}

// ===== 字幕刷新（reader → fetcher） =====

// fetcher 在总结链装载成功路径上注册 refreshClip。首个注册者生效：先到者占据
// 该槽，后来的注册不覆盖（链重复装载时的 refreshClip 同一函数，幂等），返回
// 摘除函数；摘除只清同名 handler。
export function subscribeSubtitleRefresh(handler: SubtitleRefreshHandler) {
  if (typeof handler !== "function") {
    return () => {};
  }
  const slots = readerBusSlots();
  if (typeof slots.handlers.subtitleRefresh !== "function") {
    slots.handlers.subtitleRefresh = handler;
  }
  return function unsubscribeSubtitleRefresh() {
    if (readerBusSlots().handlers.subtitleRefresh === handler) {
      delete readerBusSlots().handlers.subtitleRefresh;
    }
  };
}

// Asks the subtitle fetcher to re-fetch the current clip. Resolves with the
// handler's return value (a Promise), or with undefined when no handler is
// registered yet — must never throw.
export function requestSubtitleRefresh(): Promise<unknown> {
  const handler = resolveSeamHandler("subtitleRefresh");
  if (!handler) {
    return Promise.resolve(undefined);
  }
  try {
    return Promise.resolve(handler());
  } catch (error) {
    logWarn("[BILISCRIPT] subtitle refresh handler failed", { error });
    return Promise.resolve(undefined);
  }
}

// ===== 常驻能力槽（content → reader） =====

export function persistReaderSettingsThroughSeam() {
  const handler = resolveSeamHandler("persistSettings");
  if (!handler) {
    return;
  }
  try {
    handler();
  } catch (error) {
    logWarn("[BILISCRIPT] reader settings persist handler failed", { error });
  }
}

export function loadReaderSettingsThroughSeam() {
  const handler = resolveSeamHandler("loadSettings");
  if (!handler) {
    return Promise.resolve(null);
  }
  try {
    return Promise.resolve(handler());
  } catch (error) {
    logWarn("[BILISCRIPT] reader settings load handler failed", { error });
    return Promise.resolve(null);
  }
}

export function requestPlayerAiSync(delayMs?: number, options?: { resetRetry?: boolean }) {
  const handler = resolveSeamHandler("playerAiSync");
  if (!handler) {
    return;
  }
  try {
    handler(delayMs, options);
  } catch (error) {
    logWarn("[BILISCRIPT] player-ai sync handler failed", { error });
  }
}

// ===== 壳命令 / 标签意图（reader ↔ ui 壳） =====

// Registers the ui-renderer callback that executes shell commands (tab 投影,
// settings drawer). 单 handler 槽：后注册覆盖先注册。
export function subscribeUiCommand(handler: UiCommandHandler) {
  setSeamHandler("uiCommand", typeof handler === "function" ? handler : null);
}

// 壳命令纯转发（fire-and-forget）：壳未装载（无 handler）或命令名未识别时按
// 声明策略处理——reader 域发命令早于壳装载是合法时序。handler 内异常只记日志
// 不上抛。
export function requestUiCommand(name: string, payload?: unknown) {
  const handler = resolveSeamHandler("uiCommand");
  if (!handler) {
    return;
  }
  try {
    handler(name, payload);
  } catch (error) {
    logWarn("[BILISCRIPT] ui command handler failed", { name, error });
  }
}

// 反向槽（ui → reader）：ui 壳的 tab 点击经 reportTabIntent 上报标签意图，属主
// reader/script-tab-activation 在模块装载时注册单 handler。槽缺席（壳点击早于
// reader 域装载）按声明策略处理；DOM 反馈由属主的投影命令完成。
export function subscribeTabIntent(handler: TabIntentHandler) {
  setSeamHandler("tabIntent", typeof handler === "function" ? handler : null);
}

export function reportTabIntent(tab: ReaderScriptTab) {
  const handler = resolveSeamHandler("tabIntent");
  if (!handler) {
    return;
  }
  try {
    handler(tab);
  } catch (error) {
    logWarn("[BILISCRIPT] tab intent handler failed", { tab, error });
  }
}

// ===== 文档级外点关闭转发（ui 壳 → 对话 tab） =====

// 注册/替换对话 tab 的文档级外点关闭处理体（传 null 摘除）。同一时刻最多一个
// 注册者（后注册覆盖先注册）；无注册者时转发按声明策略 no-op。
export function setChatTabOutsideClickHandler(handler: ChatTabOutsideClickHandler | null): void {
  setSeamHandler("chatTabOutsideClick", typeof handler === "function" ? handler : null);
}

// ui-renderer 的单一文档级 click 委托调用：转发给对话 tab 的外点处理体。
export function dispatchChatTabOutsideClick(event: MouseEvent): void {
  const handler = resolveSeamHandler("chatTabOutsideClick");
  if (!handler) {
    return;
  }
  try {
    handler(event);
  } catch (error) {
    logWarn("[BILISCRIPT] chat tab outside-click handler failed", { error });
  }
}

// ===== reader 域内部逆边（显式端口） =====

// 显式方法集：逐个列出、不做动态名字分发。LAYOUT/SYNC 域只经本对象回调
// reader 上层域，方法签名与被替换的旧槽逐一对应。
export const readerPorts = {
  // LAYOUT(video-bind) → SYNC：阅读视图 scroll/wheel 的手动交互通知。
  noteManualReaderInteraction(...args: unknown[]) {
    return requireSeamHandler("noteManualReaderInteraction")(...args);
  },
  // LAYOUT(video-bind) → SYNC：视频 seeked/loadedmetadata 事件驱动同步
  //（播放稳态由 sync 250ms tick 单路驱动，不监听 timeupdate）。
  syncReadingViewPlayback(...args: unknown[]) {
    return requireSeamHandler("syncReadingViewPlayback")(...args);
  },
  // SYNC → LIFECYCLE：跳转/跟随目标未上屏时的同步补渲染（分批渲染任务的
  // 实现属主是 lifecycle，经此端口供给 sync）。
  flushReadingSubtitleToIndex(...args: unknown[]) {
    return requireSeamHandler("flushReadingSubtitleToIndex")(...args);
  }
};
