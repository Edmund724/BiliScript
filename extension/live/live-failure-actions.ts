import type { LiveFailureKind } from "./live-session-tracker.js";

export type LiveSettingsTarget = "live" | "gemini-key";

export interface LiveFailureActions {
  kind: LiveFailureKind;
  reason: string;
  showSettings: boolean;
  settingsLabel: string | null;
  settingsTarget: LiveSettingsTarget;
  settingsPrimary: boolean;
  showRetry: boolean;
  retryLabel: string;
  retryPrimary: boolean;
}

const FAILURE_SETTINGS_LABELS: Partial<Record<LiveFailureKind, string>> = {
  "provider-unconfigured": "设置伴看",
  "key-missing": "填写 Key",
  "key-rejected": "检查 Key",
  "gemini-credential": "配置 Gemini Key",
  "permission-denied": "设置伴看"
};

export function resolveLiveFailureActions(
  failureKind?: LiveFailureKind,
  error?: string
): LiveFailureActions {
  const kind: LiveFailureKind = failureKind || "unknown";
  const settingsLabel = FAILURE_SETTINGS_LABELS[kind] ?? null;
  const showSettings = settingsLabel !== null;
  const settingsTarget: LiveSettingsTarget = kind === "gemini-credential" ? "gemini-key" : "live";
  const settingsPrimary =
    kind === "provider-unconfigured" ||
    kind === "key-missing" ||
    kind === "key-rejected" ||
    kind === "gemini-credential";
  const showRetry = kind !== "provider-unconfigured" && kind !== "key-missing";
  const retryLabel = kind === "permission-denied" ? "重新授权" : "重试";
  const reason =
    kind === "unknown"
      ? "实时伴看启动失败，请重试"
      : error || "伴看连接失败，请重试";
  return {
    kind,
    reason,
    showSettings,
    settingsLabel,
    settingsTarget,
    settingsPrimary,
    showRetry,
    retryLabel,
    retryPrimary: showRetry && !settingsPrimary
  };
}
