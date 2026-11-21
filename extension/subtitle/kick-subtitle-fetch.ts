import { waitForVideoMetadata } from "../bilibili/video-probe.js";
import { isStaleRunError } from "../shared/error-helpers.js";
import { logWarn } from "../shared/logging.js";
import { ensureSummarizeChain, type SummarizeChain } from "./lazy.js";
import { isSubtitleInHandOrInFlight } from "./subtitle-in-hand.js";

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

export function kickSubtitleFetch(
  refresh: (chain: SummarizeChain) => Promise<unknown>,
  policy?: KickSubtitleFetchPolicy & { continueAfterChainLoadFailed?: false }
): Promise<boolean>;
export function kickSubtitleFetch(
  refresh: (chain: SummarizeChain | null) => Promise<unknown>,
  policy: KickSubtitleFetchPolicy & { continueAfterChainLoadFailed: true }
): Promise<boolean>;
export async function kickSubtitleFetch(
  refresh: (chain: never) => Promise<unknown>,
  policy: KickSubtitleFetchPolicy = {}
): Promise<boolean> {
  if (policy.signal?.aborted) {
    return true;
  }
  if (policy.skipIfInHandOrInFlight && isSubtitleInHandOrInFlight()) {
    return true;
  }
  if (policy.awaitVideoMetadata) {
    await waitForVideoMetadata(5000, policy.signal);
    if (policy.signal?.aborted) {
      return true;
    }
  }
  if (policy.recheckAfterVideoMetadata && isSubtitleInHandOrInFlight()) {
    policy.onInHandOrInFlight?.();
    return true;
  }
  let chain: SummarizeChain | null = null;
  try {
    chain = await ensureSummarizeChain();
  } catch (error) {
    (policy.onChainLoadFailed ?? ((e: unknown) =>
      logWarn("[BILISCRIPT] subtitle kick (summarize chain load) failed", { error: e })))(error);
    if (!policy.continueAfterChainLoadFailed) {
      return false;
    }
  }
  const settleRefreshFailure = (error: unknown) => {
    const isSilent = policy.isRefreshFailureSilent ?? isStaleRunError;
    if (!isSilent(error)) {
      (policy.onRefreshFailed ?? ((e: unknown) =>
        logWarn("[BILISCRIPT] subtitle kick refresh failed", { error: e })))(error);
    }
  };
  const runRefresh = async () => refresh(chain as never);
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
  try {
    await runRefresh();
  } catch (error) {
    settleRefreshFailure(error);
  }
  policy.afterRefreshSettled?.();
  return true;
}
