// 测试共享的 chrome.runtime 桩：把「按 message.type 分发 + 未登记 type 的兜底」这条契约
// 从各用例的私有桩里收上来，按语境的回包风格给两个入口——
//   - callbackStyleSendMessage：content 侧（回包只经 callback，返回值恒 undefined）；
//   - installMinimalChromeHost：offscreen / SW 侧（promise 式回包，或 replyStyle: "both"
//     同时答 callback 与 promise），并按需装 storage 与 offscreen、登记 onConnect 监听器。
//
// 与 tests/setup.ts 的关系：缺省全局桩（callback 式 sendMessage + 内存 storage + onMessage）
// 带 `if (!globalThis.chrome)` 守卫，vi.unstubAllGlobals() 之后不会自动装回；本文件的入口
// 因此必须在 beforeEach / 用例体内调用，不得提到模块顶层。
//
// 两条现在写进契约、但既有用例仍按旧口径使用的事实（收编只统一形状，不改行为）：
//   - 未登记 type 缺省回 `{ ok: true }`。真实 MV3 里没有 handler 的消息不会有应答，这条
//     兜底因此会掩盖消息名漂移（拼错 type 的用例照样绿）；要收紧就在这里改一处。
//   - installMinimalChromeHost 缺省装的是**最小面**，不继承既有 chrome 的其余成员：
//     offscreen 记号的用例本就只该看见 runtime（+ 本用例显式要的 storage / offscreen），
//     继承会把 getURL 一类常驻侧能力带进来。需要沿用缺省桩其余面的用例传 preserveExisting。

import { vi, type Mock } from "vitest";
import { createMemoryStorageArea, type ChromeHostStorageArea } from "./memory-storage-area.js";

/** 回包表：值是常量回包，或 (message) => 回包（可 async）。 */
export type RuntimeReplies = Record<string, unknown | ((message: unknown) => unknown)>;

export interface RuntimeReplyOptions {
  /** 未登记 type 的回包（缺省 `{ ok: true }`，与 tests/setup.ts 缺省桩同口径）。 */
  fallback?: unknown;
}

function replyFor(replies: RuntimeReplies, fallback: unknown, message: unknown): unknown {
  const type = String((message as { type?: unknown } | null)?.type ?? "");
  if (!Object.prototype.hasOwnProperty.call(replies, type)) {
    return fallback;
  }
  const reply = replies[type];
  return typeof reply === "function" ? (reply as (message: unknown) => unknown)(message) : reply;
}

/** content 侧回包风格：读 callback、返回 undefined（与真实 MV3 的同步形态同形）。 */
export function callbackStyleSendMessage(replies: RuntimeReplies = {}, options: RuntimeReplyOptions = {}): Mock {
  const fallback = "fallback" in options ? options.fallback : { ok: true };
  return vi.fn((message: unknown, callback?: (response: unknown) => void) => {
    callback?.(replyFor(replies, fallback, message));
    return undefined;
  });
}

export interface MinimalChromeHostOptions extends RuntimeReplyOptions {
  /** 按 message.type 分发的回包表（缺省空表 ⇒ 一律走 fallback）。 */
  replies?: RuntimeReplies;
  /**
   * 回包风格：`"promise"`（缺省，只答 await）或 `"both"`（callback 与 promise 都答，
   * 供同一条链上两种发送方式都要回包的用例）。
   */
  replyStyle?: "promise" | "both";
  /** 装 chrome.runtime.onConnect 监听器登记（连接由用例手驱 onConnectListeners）。 */
  onConnect?: boolean;
  /** 装 chrome.offscreen.closeDocument 桩。 */
  offscreen?: boolean;
  /** 装 chrome.storage.local（内存面）；缺省不装——该语境本就只有 runtime。 */
  storage?: boolean;
  /** 沿用既有 chrome 的其余成员（缺省 false = 只装本台最小面）。 */
  preserveExisting?: boolean;
}

export interface MinimalChromeHost {
  sendMessage: Mock;
  /** 已登记的 onConnect 监听器（按登记顺序；未装 onConnect 时是空数组）。 */
  onConnectListeners: Array<(port: chrome.runtime.Port) => void>;
  /** 装了 storage 时的内存面（未装为 null）。 */
  storage: ChromeHostStorageArea | null;
}

/**
 * 装一台最小 chrome：runtime（+ 可选的 storage.local / offscreen），onConnect 监听器登记在
 * 本台宿主内——用例不再各自拼 `vi.stubGlobal("chrome", …)` 与监听器数组。
 */
export function installMinimalChromeHost(options: MinimalChromeHostOptions = {}): MinimalChromeHost {
  const fallback = "fallback" in options ? options.fallback : { ok: true };
  const sendMessage =
    options.replyStyle === "both"
      ? vi.fn((message: unknown, callback?: (response: unknown) => void) => {
          const reply = replyFor(options.replies ?? {}, fallback, message);
          callback?.(reply);
          return Promise.resolve(reply);
        })
      : vi.fn(async (message: unknown) => replyFor(options.replies ?? {}, fallback, message));

  const onConnectListeners: Array<(port: chrome.runtime.Port) => void> = [];
  const storage = options.storage ? createMemoryStorageArea() : null;

  const previous = options.preserveExisting
    ? (globalThis.chrome as unknown as Record<string, unknown> | undefined)
    : undefined;
  const previousRuntime = (previous?.runtime ?? {}) as Record<string, unknown>;

  const runtime: Record<string, unknown> = { ...previousRuntime, sendMessage };
  if (options.onConnect) {
    runtime.onConnect = {
      addListener: (fn: (port: chrome.runtime.Port) => void) => onConnectListeners.push(fn)
    };
  }

  const chromeStub: Record<string, unknown> = { ...previous, runtime };
  if (storage) {
    chromeStub.storage = { ...(previous?.storage as Record<string, unknown> | undefined), local: storage };
  }
  if (options.offscreen) {
    chromeStub.offscreen = { closeDocument: vi.fn(async () => {}) };
  }
  vi.stubGlobal("chrome", chromeStub);

  return { sendMessage, onConnectListeners, storage };
}
