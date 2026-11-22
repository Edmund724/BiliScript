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
  readUrl(): string;
  computeSignature(): string;
  readSignature(): string;
  writeIdentity(url: string, signature: string): void;
  readRunId(): number;
  writeRunId(runId: number): void;
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
  handleUrlChange(): void;
  subscribeSettled(listener: () => void, options?: EventSubscribeOptions): () => void;
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
          } catch (error) {
            deps.logWarn("[BILISCRIPT] syncPlayerAiQuickAction after URL change failed", error);
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
