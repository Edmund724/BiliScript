// extension/entry/clip-switch-transaction.ts
// 换片事务：一次 URL 变化（切视频 / 切 P / 跳进阅读模式地址）的换片编排唯一落点。
// 机制侧（core/url-watcher 的 history 补丁与 href 轮询、popstate / hashchange）
// 只把变化交给 handleUrlChange()；签名判定、换片身份写入、抓取代次递增、旧片级
// DisposableContext 中止、各域步骤的启动次序与完成边都在本模块收口。步骤本身由
// 调用点注入——事务只编排次序与错误收口口径，不静态依赖任何域。

import {
  contentEventBus,
  getCurrentClipScope,
  resetClipScope
} from "../shared/content-event-bus.js";
import {
  createTypedEventBus,
  type EventSubscribeOptions
} from "../shared/typed-event-bus.js";

export interface ClipSwitchTransactionDeps {
  /** 当前地址 */
  readUrl(): string;
  /** 按当前页身份计算的 clip 签名 */
  computeSignature(): string;
  /** 已落账的 clip 签名 */
  readSignature(): string;
  /** 落账换片身份（地址 + 签名） */
  writeIdentity(url: string, signature: string): void;
  /** 当前抓取代次 */
  readRunId(): number;
  /** 覆写抓取代次（fetchRunId 的唯一递增写点） */
  writeRunId(runId: number): void;
  /** 页面状态恢复成普通页（阅读表 / 门控属性的 DOM 守卫） */
  enforceNormalPageStateIfNeeded(url: string): void;
  isReaderViewOpen(): boolean;
  isReaderMode(url: string): boolean;
  isSupportedVideoPage(url: string): boolean;
  shouldAutoOpen?(url: string): boolean;
  isPlayerAiLoaded(): boolean;
  ensureUiReady(): Promise<void>;
  resetClipState(): void | Promise<void>;
  syncPlayerAiQuickAction(): void | Promise<void>;
  enterReaderShellOnUrlNavigation(url: string): void | Promise<void>;
  refreshReaderClip(): void | Promise<void>;
  exitReaderShell(): void | Promise<void>;
  startSubtitlePrefetch(): void;
  logWarn(message: string, detail?: unknown): void;
}

export interface ClipSwitchTransaction {
  /** 机制入口（popstate / hashchange / host:url-change）的唯一调用点 */
  handleUrlChange(): void;
  /** 订阅完成边；返回退订函数，支持 `{ signal?: AbortSignal }` 自动退订 */
  subscribeSettled(listener: () => void, options?: EventSubscribeOptions): () => void;
  /** 当前视频（BV / 分 P）作用域的 AbortSignal，切集时自动 abort 回收 */
  getClipSignal(): AbortSignal;
}

export function createClipSwitchTransaction(deps: ClipSwitchTransactionDeps): ClipSwitchTransaction {
  const localBus = createTypedEventBus<{ settled: void }>();

  function publishSettled(url: string, signature: string): void {
    localBus.emit("settled");
    contentEventBus.emit("clip:switch-settled", { url, signature });
  }

  function handleUrlChange(): void {
    const nextUrl = deps.readUrl();
    const nextSignature = deps.computeSignature();
    if (nextSignature === deps.readSignature()) {
      if (
        !deps.isReaderMode(nextUrl) ||
        !deps.isSupportedVideoPage(nextUrl) ||
        deps.isReaderViewOpen()
      ) {
        return;
      }
      const entering = (async () => {
        try {
          await deps.enterReaderShellOnUrlNavigation(nextUrl);
        } catch (error) {
          deps.logWarn("[BILISCRIPT] reading shell load failed", error);
        }
      })();
      void Promise.allSettled([entering]).then(() => publishSettled(nextUrl, nextSignature));
      return;
    }

    // 切集边界：一次性中止上一个视频作用域的全部监听器与定时器，再重建新作用域。
    resetClipScope();
    deps.writeIdentity(nextUrl, nextSignature);
    const nextRunId = deps.readRunId() + 1;
    deps.writeRunId(nextRunId);
    contentEventBus.emit("clip:switch-start", {
      url: nextUrl,
      signature: nextSignature,
      runId: nextRunId
    });
    deps.enforceNormalPageStateIfNeeded(nextUrl);

    const isSupported = deps.isSupportedVideoPage(nextUrl);
    const shouldEnter =
      isSupported && (deps.isReaderMode(nextUrl) || Boolean(deps.shouldAutoOpen?.(nextUrl)));
    const started: Array<Promise<void>> = [];

    // reset 步骤：UI 壳只在阅读视图已开或本次正要进入时才需要；普通页换片不装载 ui chunk。
    started.push(
      (async () => {
        if (deps.isReaderViewOpen() || shouldEnter) {
          try {
            await deps.ensureUiReady();
          } catch (error) {
            deps.logWarn("[BILISCRIPT] UI shell ensure after URL change failed", error);
            return;
          }
        }
        try {
          await deps.resetClipState();
        } catch (error) {
          deps.logWarn("[BILISCRIPT] clip state reset after URL change failed", error);
        }
      })()
    );

    if (deps.isPlayerAiLoaded()) {
      started.push(
        (async () => {
          try {
            await deps.syncPlayerAiQuickAction();
          } catch {
            // 同步失败静默
          }
        })()
      );
    }

    if (!isSupported) {
      if (deps.isReaderViewOpen()) {
        started.push(
          (async () => {
            await deps.exitReaderShell();
          })()
        );
      }
    } else if (!deps.isReaderViewOpen() && shouldEnter) {
      started.push(
        (async () => {
          try {
            await deps.enterReaderShellOnUrlNavigation(nextUrl);
          } catch (error) {
            deps.logWarn("[BILISCRIPT] reading shell load failed", error);
          }
        })()
      );
    } else if (deps.isReaderViewOpen() || shouldEnter) {
      started.push(
        (async () => {
          await deps.refreshReaderClip();
        })()
      );
    } else {
      deps.startSubtitlePrefetch();
    }

    // 完成边：allSettled 不 reject，故恰好发布一次。
    void Promise.allSettled(started).then(() => publishSettled(nextUrl, nextSignature));
  }

  return {
    handleUrlChange,
    subscribeSettled(listener, options) {
      return localBus.on("settled", listener, options);
    },
    getClipSignal() {
      return getCurrentClipScope().signal;
    }
  };
}
