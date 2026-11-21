// BILISCRIPT_DUAL_INSTANCE_STATEFUL
import { logWarn } from "../shared/logging.js";
import type { ReaderScriptTab } from "./state.js";

export type ReaderPresenterEvent =
  | { kind: "reset" }
  | { kind: "rerender" }
  | { kind: "subtitle-ready" }
  | { kind: "secondary-subtitle-ready" }
  | { kind: "notice"; text: string | number | null };

export type ReaderPresenterHandler = (event: ReaderPresenterEvent) => void;

type SubtitleRefreshHandler = (options?: { forceRefresh?: boolean }) => unknown;
type SettingsPersistHandler = () => void;
type UiCommandHandler = (name: string, payload?: unknown) => void;
type TabIntentHandler = (tab: ReaderScriptTab) => void;
type ChatTabOutsideClickHandler = (event: MouseEvent) => void;
type SessionStopHandler = (reason?: "takeover") => void;

interface ReaderSeamHandlerMap {
  subtitleRefresh: SubtitleRefreshHandler;
  persistSettings: SettingsPersistHandler;
  uiCommand: UiCommandHandler;
  tabIntent: TabIntentHandler;
  chatTabOutsideClick: ChatTabOutsideClickHandler;
  liveCompanionStop: SessionStopHandler;
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

export const READER_SEAM_METHODS = Object.freeze({
  subtitleRefresh: { policy: "noop", owner: "subtitle/fetcher" },
  persistSettings: { policy: "noop-warn", owner: "entry/content" },
  uiCommand: { policy: "noop-warn", owner: "ui/ui-renderer" },
  tabIntent: { policy: "noop-warn", owner: "reader/script-tab-activation" },
  chatTabOutsideClick: { policy: "noop-warn", owner: "reader/chat-tab" },
  liveCompanionStop: { policy: "noop", owner: "live/live-companion-session" },
  noteManualReaderInteraction: { policy: "throw", owner: "reader/lifecycle" },
  syncReadingViewPlayback: { policy: "throw", owner: "reader/lifecycle" },
  flushReadingSubtitleToIndex: { policy: "throw", owner: "reader/lifecycle" }
} as const satisfies Record<ReaderSeamMethod, ReaderSeamDeclaration>);

const CONTENT_CAPABILITY_METHODS = ["persistSettings"] as const;

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

export function notifyReaderPresenter(event: ReaderPresenterEvent) {
  for (const handler of readerBusSlots().readers.slice()) {
    try {
      handler(event);
    } catch (error) {
      logWarn("[BILISCRIPT] reader presenter handler failed", { kind: event.kind, error });
    }
  }
}

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

export function requestSubtitleRefresh(options?: { forceRefresh?: boolean }): Promise<unknown> {
  const handler = resolveSeamHandler("subtitleRefresh");
  if (!handler) {
    return Promise.resolve(undefined);
  }
  try {
    return Promise.resolve(handler(options));
  } catch (error) {
    logWarn("[BILISCRIPT] subtitle refresh handler failed", { error });
    return Promise.resolve(undefined);
  }
}

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

export function subscribeUiCommand(handler: UiCommandHandler) {
  setSeamHandler("uiCommand", typeof handler === "function" ? handler : null);
}

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

export function setChatTabOutsideClickHandler(handler: ChatTabOutsideClickHandler | null): void {
  setSeamHandler("chatTabOutsideClick", typeof handler === "function" ? handler : null);
}

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

export function setLiveCompanionStopHandler(handler: SessionStopHandler | null): void {
  setSeamHandler("liveCompanionStop", typeof handler === "function" ? handler : null);
}

export function requestLiveCompanionStop(reason?: "takeover"): void {
  const handler = resolveSeamHandler("liveCompanionStop");
  if (!handler) {
    return;
  }
  try {
    handler(reason);
  } catch (error) {
    logWarn("[BILISCRIPT] liveCompanionStop handler failed", { error });
  }
}

export const readerPorts = {
  noteManualReaderInteraction(...args: unknown[]) {
    return requireSeamHandler("noteManualReaderInteraction")(...args);
  },
  syncReadingViewPlayback(...args: unknown[]) {
    return requireSeamHandler("syncReadingViewPlayback")(...args);
  },
  flushReadingSubtitleToIndex(...args: unknown[]) {
    return requireSeamHandler("flushReadingSubtitleToIndex")(...args);
  }
};
