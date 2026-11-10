// 概览快照的伴看来源槽：lifecycle 在装配协调器后登记，
// chat-tab 组合根在创建实时伴看时读取并订阅。
//
// 为什么不让 chat-tab 直接 import lifecycle：chat-tab 是二级惰性 chunk，lifecycle
// 是 reader 域组装根（模块求值时注册 reader 端口、订阅 presenter）。把它拉进
// 对话组合根的静态依赖会把「对话页」与「reader 装配」绑死在同一次模块求值上，
// 测试里多纪元重载还会撞上 reader-bus 的重复注册守卫。这里只留一个窄槽：
// 提供快照 + 订阅，两个方向的依赖都落在 reader 域内部。

import type { LiveOverviewSource } from "../live/live-overview-context.js";

export interface ReaderOverviewSource {
  getSnapshot(): LiveOverviewSource | null;
  subscribe(listener: () => void): () => void;
  ensureOverview?(options?: { forceRefresh?: boolean }): Promise<LiveOverviewSource | null>;
  cancel?(): void;
}

let currentSource: ReaderOverviewSource | null = null;
let currentSourceUnsubscribe: (() => void) | null = null;
let defaultSourcePromise: Promise<ReaderOverviewSource> | null = null;
const subscribers = new Set<() => void>();

function notifySubscribers(): void {
  for (const listener of [...subscribers]) {
    try {
      listener();
    } catch {
      // 忽略单个订阅方异常
    }
  }
}

/** lifecycle 装配协调器后单点登记；重复登记以后者为准（测试多纪元重载）。 */
export function registerReaderOverviewSource(source: ReaderOverviewSource): void {
  currentSourceUnsubscribe?.();
  currentSource = source;
  currentSourceUnsubscribe = source.subscribe(notifySubscribers);
}

async function ensureDefaultOverviewSource(): Promise<ReaderOverviewSource> {
  if (currentSource) return currentSource;
  if (defaultSourcePromise) return defaultSourcePromise;

  defaultSourcePromise = (async () => {
    const [
      { createOverviewCoordinator },
      { resolveActiveProvider },
      { confirmDialog },
      { state }
    ] = await Promise.all([
      import("./overview-coordinator.js"),
      import("../ai/active-provider.js"),
      import("../ui/confirm-dialog.js"),
      import("../core/state.js")
    ]);
    if (currentSource) return currentSource;

    const coordinator = createOverviewCoordinator({
      getClip: () => state.clip,
      isReadingViewOpen: () => state.reader.readingViewOpen,
      resolveProvider: () => resolveActiveProvider(),
      loadAnalysis: () => import("../ai/analysis.js"),
      confirm: (options) =>
        state.reader.readingViewOpen ? confirmDialog(options) : Promise.resolve(true),
      registerUiActions: () => {},
      now: () => Date.now(),
      setInterval: (...args) => setInterval(...args),
      clearInterval: (...args) => clearInterval(...args)
    });

    const source: ReaderOverviewSource = {
      getSnapshot: () => coordinator.getSnapshot(),
      subscribe: (listener) => coordinator.subscribe(listener),
      ensureOverview: async (options) => {
        await coordinator.trigger(options);
        return coordinator.getSnapshot();
      },
      cancel: () => coordinator.cancel()
    };
    registerReaderOverviewSource(source);
    return source;
  })();

  try {
    return await defaultSourcePromise;
  } finally {
    defaultSourcePromise = null;
  }
}

/** 当前概览快照；未登记（对话早于 reader 装配）时返回 null。 */
export function getReaderOverviewSource(): LiveOverviewSource | null {
  return currentSource ? currentSource.getSnapshot() : null;
}

/** 按需确保/触发当前视频概览生成；未登记时按需初始化无头文本工具宿主。 */
export async function ensureReaderOverviewSource(
  options?: { forceRefresh?: boolean }
): Promise<LiveOverviewSource | null> {
  const source = currentSource ?? (await ensureDefaultOverviewSource());
  if (typeof source.ensureOverview === "function") {
    return await source.ensureOverview(options);
  }
  return source.getSnapshot();
}

/** 概览相位/产物变化订阅；即使早于宿主登记也可提前订阅。 */
export function subscribeReaderOverviewSource(listener: () => void): () => void {
  if (typeof listener !== "function") {
    return () => {};
  }
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

/** 取消进行中的概览生成（页面卸载清理用）。 */
export function cancelReaderOverviewSource(): void {
  currentSource?.cancel?.();
}
