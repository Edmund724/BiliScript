export interface CreateSubtitleWaiterDeps {
  pollContext: () => Promise<{ ok: boolean; pending: boolean }>;
  showWaitingNotice: () => void;
  removeNotice: () => void;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (handle: number) => void;
  pollIntervalMs: number;
}

export interface SubtitleWaiter {
  wait: () => Promise<boolean>;
  kick: () => void;
  cancel: () => void;
}

export function createSubtitleWaiter(deps: CreateSubtitleWaiterDeps): SubtitleWaiter {
  const {
    pollContext,
    showWaitingNotice,
    removeNotice,
    setTimer,
    clearTimer,
    pollIntervalMs
  } = deps;

  let token = 0;
  let activeFinish: ((ok: boolean) => void) | null = null;
  let kickCurrent: (() => void) | null = null;

  function wait(): Promise<boolean> {
    if (activeFinish) {
      activeFinish(false);
    }
    return new Promise((resolve) => {
      let timer: number | null = null;
      let ticking = false;
      const currentToken = ++token;
      const finish = (ok: boolean) => {
        if (currentToken !== token) {
          return;
        }
        activeFinish = null;
        kickCurrent = null;
        if (timer !== null) {
          clearTimer(timer);
          timer = null;
        }
        removeNotice();
        resolve(ok);
      };
      activeFinish = finish;
      const tick = async () => {
        if (ticking) {
          return;
        }
        if (timer !== null) {
          clearTimer(timer);
          timer = null;
        }
        ticking = true;
        try {
          const outcome = await pollContext();
          if (currentToken !== token) {
            return;
          }
          if (!outcome?.ok) {
            finish(false);
            return;
          }
          if (!outcome.pending) {
            finish(true);
            return;
          }
          showWaitingNotice();
          timer = setTimer(() => {
            timer = null;
            void tick();
          }, pollIntervalMs);
        } finally {
          ticking = false;
        }
      };
      kickCurrent = () => {
        if (currentToken === token) {
          void tick();
        }
      };
      void tick();
    });
  }

  return {
    wait,
    kick: () => {
      if (kickCurrent) {
        kickCurrent();
      }
    },
    cancel: () => {
      if (!activeFinish) {
        return;
      }
      activeFinish(false);
      token += 1;
    }
  };
}
