// extension/shared/content-event-bus.ts
// 内容脚本进程内共享的强类型事件总线（挂 globalThis 跨实例槽）。
//
// 双实例纪律标记：BILISCRIPT_DUAL_INSTANCE_STATEFUL——content 两轮构建下常驻包
// （content-main.mjs）与懒加载区（chunks/*）各持一份模块实例；本总线的事件注册表、
// 字幕状态相位镜像与当前片级生命周期控制器统一挂在 globalThis 槽上，确保常驻侧
// 与懒加载侧对齐到同一份进程内总线。

import {
  createDisposableContext,
  createTypedEventBus,
  type DisposableContext,
  type TypedEventBus
} from "./typed-event-bus.js";

export interface ClipSwitchStartEvent {
  url: string;
  signature: string;
  runId: number;
}

export interface ClipSwitchSettledEvent {
  url: string;
  signature: string;
}

export interface HostUrlChangeEvent {
  url: string;
}

export interface ContentEventMap {
  /** 字幕抓取 / ASR 转写相位变更（asr-transcribing / asr-done / asr-failed / subtitle-ready） */
  "subtitle:status-phase": string;
  /** 阅读壳完成退出事务后的通知（触发页内按钮恢复常速自查并补回） */
  "reader:closed": void;
  /** B 站 SPA 导航 / URL 变化机制事件（取代 window CustomEvent） */
  "host:url-change": HostUrlChangeEvent;
  /** 换片事务同步段触发：新 clip 身份与 runId 已落账，旧片级作用域已中止 */
  "clip:switch-start": ClipSwitchStartEvent;
  /** 换片事务异步步骤全部 settle 后的完成边 */
  "clip:switch-settled": ClipSwitchSettledEvent;
}

interface ContentEventBusSlot {
  bus: TypedEventBus<ContentEventMap>;
  lastSubtitleStatusPhase: string;
  clipScope: DisposableContext;
}

const CONTENT_EVENT_BUS_SLOT_KEY = "__BILISCRIPT_EVENT_BUS__";

function getContentEventBusSlot(): ContentEventBusSlot {
  const host = globalThis as unknown as Record<string, ContentEventBusSlot | undefined>;
  let slot = host[CONTENT_EVENT_BUS_SLOT_KEY];
  if (!slot) {
    slot = {
      bus: createTypedEventBus<ContentEventMap>(),
      lastSubtitleStatusPhase: "",
      clipScope: createDisposableContext()
    };
    host[CONTENT_EVENT_BUS_SLOT_KEY] = slot;
  }
  return slot;
}

export function getContentEventBus(): TypedEventBus<ContentEventMap> {
  return getContentEventBusSlot().bus;
}

export const contentEventBus: TypedEventBus<ContentEventMap> = {
  on(event, listener, options) {
    return getContentEventBusSlot().bus.on(event, listener, options);
  },
  once(event, listener, options) {
    return getContentEventBusSlot().bus.once(event, listener, options);
  },
  emit(event, ...args) {
    return getContentEventBusSlot().bus.emit(event, ...args);
  },
  listenerCount(event) {
    return getContentEventBusSlot().bus.listenerCount(event);
  },
  clear() {
    getContentEventBusSlot().bus.clear();
  }
};

export function getLastSubtitleStatusPhase(): string {
  return getContentEventBusSlot().lastSubtitleStatusPhase;
}

export function setLastSubtitleStatusPhase(phase: string): void {
  getContentEventBusSlot().lastSubtitleStatusPhase = phase;
}

/** 获取当前视频（BV / 分 P）生命周期作用域；切集时自动 abort 回收全部挂接资源。 */
export function getCurrentClipScope(): DisposableContext {
  const slot = getContentEventBusSlot();
  if (slot.clipScope.isDisposed()) {
    slot.clipScope = createDisposableContext();
  }
  return slot.clipScope;
}

/** 切集边界：一次性中止旧 clip 的 AbortController 并创建新作用域。 */
export function resetClipScope(): DisposableContext {
  const slot = getContentEventBusSlot();
  slot.clipScope.dispose();
  slot.clipScope = createDisposableContext();
  return slot.clipScope;
}
