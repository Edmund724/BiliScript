import { isStaleRunError } from "../shared/error-helpers.js";
import { logWarn } from "../shared/logging.js";
import { ensureSummarizeChain, type SummarizeChain } from "./lazy.js";
import { isSubtitleInHandOrInFlight } from "./subtitle-in-hand.js";

function hasReadyVideoDuration(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  const videos = document.querySelectorAll("video");
  for (const video of videos) {
    if (video.closest("[data-biliscript-historical-frame]")) {
      continue;
    }
    const duration = Number(video.duration);
    if (Number.isFinite(duration) && duration > 0) {
      return true;
    }
  }
  return false;
}

function waitForLightweightVideoMetadata(timeoutMs = 5000, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || typeof document === "undefined") {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const start = Date.now();
    let timer = 0;
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        window.clearTimeout(timer);
        timer = 0;
      }
      signal?.removeEventListener("abort", finish);
      resolve();
    };

    if (signal) {
      signal.addEventListener("abort", finish, { once: true });
    }

    const check = () => {
      if (settled) {
        return;
      }
      if (hasReadyVideoDuration() || Date.now() - start >= timeoutMs) {
        finish();
        return;
      }
      timer = window.setTimeout(check, 150);
    };
    check();
  });
}

export interface KickSubtitleFetchPolicy {
  skipIfInHandOrInFlight?: boolean;
  recheckAfterVideoMetadata?: boolean;
  onInHandOrInFlight?: () => void;
  awaitVideoMetadata?: boolean;
  signal?: AbortSignal;
  onChainLoadFailed?: (error: unknown) => void;
  continueAfterChainLoadFailed?: boolean;
  awaitRefresh?: boolean;
  isRefreshFailureSilent?: (error: unknown) => boolean;
  onRefreshFailed?: (error: unknown) => void;
  afterRefreshSettled?: () => void;
}

function runKickRefresh(
  runRefresh: () => Promise<unknown>,
  policy: KickSubtitleFetchPolicy
): Promise<boolean> | boolean {
  const settleRefreshFailure = (error: unknown) => {
    const isSilent = policy.isRefreshFailureSilent ?? isStaleRunError;
    if (!isSilent(error)) {
      (policy.onRefreshFailed ?? ((e: unknown) =>
        logWarn("[BILISCRIPT] subtitle kick refresh failed", { error: e })))(error);
    }
  };
  if (policy.awaitRefresh === false) {
    void (async () => {
      try {
        await runRefresh();
      } catch (error) {
        settleRefreshFailure(error);
      }
    })();
    return true;
  }
  return (async () => {
    try {
      await runRefresh();
    } catch (error) {
      settleRefreshFailure(error);
    }
    if (!policy.signal?.aborted) {
      policy.afterRefreshSettled?.();
    }
    return true;
  })();
}

export function kickSubtitleFetch(
  refresh: (chain: SummarizeChain) => Promise<unknown>,
  policy?: KickSubtitleFetchPolicy & { continueAfterChainLoadFailed?: false }
): Promise<boolean>;
export function kickSubtitleFetch(
  refresh: (chain: SummarizeChain | null) => Promise<unknown>,
  policy: KickSubtitleFetchPolicy & { continueAfterChainLoadFailed: true }
): Promise<boolean>;
export async function kickSubtitleFetch(
  refresh: (chain: SummarizeChain) => Promise<unknown>,
  policy: KickSubtitleFetchPolicy = {}
): Promise<boolean> {
  if (policy.signal?.aborted) {
    return true;
  }
  if (policy.skipIfInHandOrInFlight && isSubtitleInHandOrInFlight()) {
    return true;
  }
  if (policy.awaitVideoMetadata) {
    await waitForLightweightVideoMetadata(5000, policy.signal);
    if (policy.signal?.aborted) {
      return true;
    }
  }
  if (policy.recheckAfterVideoMetadata && isSubtitleInHandOrInFlight()) {
    policy.onInHandOrInFlight?.();
    return true;
  }
  let runRefresh: () => Promise<unknown>;
  try {
    const chain = await ensureSummarizeChain();
    runRefresh = () => refresh(chain);
  } catch (error) {
    (policy.onChainLoadFailed ?? ((e: unknown) =>
      logWarn("[BILISCRIPT] subtitle kick (summarize chain load) failed", { error: e })))(error);
    if (!policy.continueAfterChainLoadFailed) {
      return false;
    }
    const nullableRefresh = refresh as (chain: SummarizeChain | null) => Promise<unknown>;
    runRefresh = () => nullableRefresh(null);
  }
  return runKickRefresh(runRefresh, policy);
}
