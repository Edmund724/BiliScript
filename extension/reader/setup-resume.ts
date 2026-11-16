// extension/reader/setup-resume.ts — 阅读侧 AI / ASR 首配跳转与恢复统一协调模块。
//
// 收口概览、解释卡、对话与 ASR 四个首配入口的单飞保护、动态加载代次守卫、
// 一次性恢复槽与失效清理：
// - AI（overview / explain / chat）：直接将 errorClass 透传给 openReaderAiSetup，
//   保存成功后仅当 isStillValid() 仍为真时触发一次恢复，取消或失效时按原因清理；
// - ASR：提供单飞入口与页面内存视频身份令牌，供开关落盘或平台保存后重新触发字幕链。

import { extractBvid, extractPageIndex } from "../bilibili/video-id-shared.js";
import type { AsrSetupKind } from "../asr/asr-setup.js";
import type { OverviewSetupErrorClass } from "../core/overview-setup-error.js";

export type ReaderAiSetupScope = "overview" | "explain" | "chat";
export type ReaderSetupScope = "all" | ReaderAiSetupScope | "asr";
export type ReaderAiSetupCancelReason = "cancel" | "stale" | "invalid";

export interface BeginReaderAiSetupFlowOptions {
  scope: ReaderAiSetupScope;
  errorClass: OverviewSetupErrorClass;
  providerId?: string;
  isStillValid: () => boolean;
  onResume: () => void;
  onCancel?: (reason?: ReaderAiSetupCancelReason) => void;
}

export interface AsrSetupResumeToken {
  videoKey: string;
  kind: AsrSetupKind;
}

interface AiScopeState {
  openInFlight: boolean;
  sessionEpoch: number;
  pendingResume: boolean;
  onCancel: ((reason?: ReaderAiSetupCancelReason) => void) | null;
}

function createAiScopeState(): AiScopeState {
  return {
    openInFlight: false,
    sessionEpoch: 0,
    pendingResume: false,
    onCancel: null
  };
}

const aiScopes: Record<ReaderAiSetupScope, AiScopeState> = {
  overview: createAiScopeState(),
  explain: createAiScopeState(),
  chat: createAiScopeState()
};

let asrSetupOpenInFlight = false;
let asrSetupEpoch = 0;
let pendingAsrToken: AsrSetupResumeToken | null = null;

export function currentPageVideoKey(): string {
  return `${extractBvid(location.href)}|${extractPageIndex(location.href)}`;
}

export function setAsrSetupResumeToken(token: AsrSetupResumeToken): void {
  pendingAsrToken = { ...token };
}

export function peekAsrSetupResumeToken(): AsrSetupResumeToken | null {
  return pendingAsrToken ? { ...pendingAsrToken } : null;
}

export function consumeAsrSetupResumeToken(): AsrSetupResumeToken | null {
  const token = pendingAsrToken;
  pendingAsrToken = null;
  return token ? { ...token } : null;
}

export function beginReaderAiSetupFlow(options: BeginReaderAiSetupFlowOptions): Promise<void> {
  const slot = aiScopes[options.scope];
  if (slot.openInFlight) {
    return Promise.resolve();
  }
  slot.openInFlight = true;
  const sessionEpoch = ++slot.sessionEpoch;
  slot.pendingResume = true;
  slot.onCancel = options.onCancel ?? null;

  const finishCancel = (reason: ReaderAiSetupCancelReason) => {
    if (!slot.pendingResume) return;
    slot.pendingResume = false;
    const cancel = slot.onCancel;
    slot.onCancel = null;
    cancel?.(reason);
  };

  return (async () => {
    try {
      if (!options.isStillValid()) {
        if (sessionEpoch === slot.sessionEpoch) {
          finishCancel("invalid");
        }
        return;
      }
      const { openReaderAiSetup } = await import("../ui/settings-panel.js");
      if (sessionEpoch !== slot.sessionEpoch || !slot.pendingResume) {
        return;
      }
      if (!options.isStillValid()) {
        finishCancel("invalid");
        return;
      }
      const trimmedProviderId = String(options.providerId || "").trim();
      await openReaderAiSetup(
        options.errorClass,
        {
          onAfterSave: () => {
            if (sessionEpoch !== slot.sessionEpoch || !slot.pendingResume) {
              return;
            }
            slot.pendingResume = false;
            slot.onCancel = null;
            if (!options.isStillValid()) {
              options.onCancel?.("stale");
              return;
            }
            options.onResume();
          },
          onSessionEnd: () => {
            if (sessionEpoch !== slot.sessionEpoch) {
              return;
            }
            finishCancel("cancel");
          }
        },
        trimmedProviderId ? { providerId: trimmedProviderId } : undefined
      );
    } catch {
      if (sessionEpoch === slot.sessionEpoch) {
        finishCancel("invalid");
      }
    } finally {
      if (sessionEpoch === slot.sessionEpoch) {
        slot.openInFlight = false;
      }
    }
  })();
}

export function beginReaderAsrSetupFlow(): Promise<void> {
  if (asrSetupOpenInFlight) {
    return Promise.resolve();
  }
  asrSetupOpenInFlight = true;
  const epoch = ++asrSetupEpoch;
  return import("../ui/settings-panel.js")
    .then(({ openReaderAsrSetup }) => {
      if (epoch !== asrSetupEpoch) {
        return;
      }
      return openReaderAsrSetup();
    })
    .catch(() => {})
    .finally(() => {
      if (epoch === asrSetupEpoch) {
        asrSetupOpenInFlight = false;
      }
    });
}

function invalidateAiScope(scope: ReaderAiSetupScope): void {
  const slot = aiScopes[scope];
  slot.sessionEpoch += 1;
  slot.openInFlight = false;
  if (slot.pendingResume) {
    slot.pendingResume = false;
    const cancel = slot.onCancel;
    slot.onCancel = null;
    cancel?.("invalid");
  } else {
    slot.onCancel = null;
  }
}

export function invalidateReaderSetupFlows(scope: ReaderSetupScope = "all"): void {
  if (scope === "all") {
    invalidateAiScope("overview");
    invalidateAiScope("explain");
    invalidateAiScope("chat");
    asrSetupEpoch += 1;
    asrSetupOpenInFlight = false;
    pendingAsrToken = null;
    return;
  }
  if (scope === "asr") {
    asrSetupEpoch += 1;
    asrSetupOpenInFlight = false;
    pendingAsrToken = null;
    return;
  }
  invalidateAiScope(scope);
}
