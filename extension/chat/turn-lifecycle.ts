export type SendVerdict = "accepted" | "blocked" | "ignored";

export const TURN_SETTLE_FALLBACK_MS = 4000;

export interface TurnAcceptanceWindow {
  get(): boolean;
  set(value: boolean): void;
}

export interface CreateTurnLifecycleDeps {
  accepting: TurnAcceptanceWindow;
  isStreaming: () => boolean;
  stopStream: () => void;
  forceReset: () => void;
  runAcceptance: (text: string) => Promise<SendVerdict>;
  watchdogMs?: number;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

export interface TurnLifecycle {
  send: (text: string) => Promise<SendVerdict>;
  isActive: () => boolean;
  settled: () => Promise<void>;
  stop: () => void;
  flushDeferredStop: () => boolean;
  resolve: () => void;
  discard: () => void;
}

export function createTurnLifecycle(deps: CreateTurnLifecycleDeps): TurnLifecycle {
  const watchdogMs = deps.watchdogMs ?? TURN_SETTLE_FALLBACK_MS;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => window.setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle: number) => window.clearTimeout(handle));

  let pendingSettles: Array<() => void> = [];
  let stopWhenPortReady = false;
  let watchdogTimer = 0;

  function isActive(): boolean {
    return deps.accepting.get() || deps.isStreaming();
  }

  function resolve(): void {
    if (watchdogTimer) {
      clearTimer(watchdogTimer);
      watchdogTimer = 0;
    }
    stopWhenPortReady = false;
    if (!pendingSettles.length) {
      return;
    }
    const resolvers = pendingSettles;
    pendingSettles = [];
    for (const resolveSettle of resolvers) {
      resolveSettle();
    }
  }

  function stop(): void {
    if (!deps.isStreaming()) {
      if (deps.accepting.get()) {
        stopWhenPortReady = true;
      }
      return;
    }
    deps.stopStream();
  }

  function flushDeferredStop(): boolean {
    if (!stopWhenPortReady) {
      return false;
    }
    stopWhenPortReady = false;
    stop();
    return true;
  }

  function settled(): Promise<void> {
    if (!isActive()) {
      return Promise.resolve();
    }
    const settledPromise = new Promise<void>((resolveSettle) => {
      pendingSettles.push(resolveSettle);
    });
    stop();
    if (!watchdogTimer) {
      watchdogTimer = setTimer(() => {
        watchdogTimer = 0;
        deps.forceReset();
        resolve();
      }, watchdogMs);
    }
    return settledPromise;
  }

  async function send(text: string): Promise<SendVerdict> {
    const prompt = String(text ?? "").trim();
    if (!prompt || isActive()) {
      return "ignored";
    }
    deps.accepting.set(true);
    let verdict: SendVerdict;
    try {
      verdict = await deps.runAcceptance(prompt);
    } finally {
      deps.accepting.set(false);
    }
    if (verdict === "blocked") {
      resolve();
    }
    return verdict;
  }

  function discard(): void {
    deps.accepting.set(false);
    resolve();
  }

  return { send, isActive, settled, stop, flushDeferredStop, resolve, discard };
}
