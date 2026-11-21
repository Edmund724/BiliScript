import type { NoSubtitleReason } from "./state.js";

export type AsrRemedy = "open-settings" | "retry-later" | "none";

export interface AsrFailureDetailInput {
  status?: number | string | null;
  detail?: string | number | null;
}

export interface AsrFailureNotice {
  cause: string;
  remedyText: string;
  remedy: AsrRemedy;
  detail: string;
}

export const STATUS_LINE_BASE = "当前视频无字幕。";
export const SIDEPANEL_BASE = "当前视频没有字幕，无法总结。";

export const SIDEPANEL_EMPTY_NOTICE = "这个视频没有识别到语音内容，无法总结。";

export const ASR_FAILURE_DETAIL_MAX_CHARS = 80;

type NonNullReason = NonNullable<NoSubtitleReason>;

interface CopyEntry {
  cause: string;
  remedyText: string;
  remedy: AsrRemedy;
  allowDetail: boolean;
  retryOnSend: boolean;
  isAsrFailureKind: boolean;
}

const COPY_TABLE: Record<NonNullReason, CopyEntry> = {
  "upower-exclusive": {
    cause: "该视频为充电专属视频，未开通充电无法获取完整音轨。",
    remedyText: "开通充电后可重新抓取生成字幕",
    remedy: "retry-later",
    allowDetail: false,
    retryOnSend: false,
    isAsrFailureKind: false
  },
  "bili-login-required": {
    cause: "未登录 B 站，无法获取视频自带字幕。",
    remedyText: "请登录 B 站后重新抓取",
    remedy: "retry-later",
    allowDetail: false,
    retryOnSend: true,
    isAsrFailureKind: false
  },
  "no-asr-config": {
    cause: "语音识别平台不可用：未配置平台、域名未授权，或这个模型不存在。",
    remedyText: "请到设置页检查语音转写平台",
    remedy: "open-settings",
    allowDetail: true,
    retryOnSend: true,
    isAsrFailureKind: true
  },
  "asr-disabled": {
    cause: "语音转写开关已关闭。",
    remedyText: "可在设置页开启「无字幕时自动生成字幕」后再试",
    remedy: "open-settings",
    allowDetail: false,
    retryOnSend: true,
    isAsrFailureKind: false
  },
  "asr-auth": {
    cause: "语音识别平台拒绝了本次请求：API Key 无效、已过期，或没有权限。",
    remedyText: "请到设置页检查或更换 API Key",
    remedy: "open-settings",
    allowDetail: true,
    retryOnSend: true,
    isAsrFailureKind: true
  },
  "asr-quota": {
    cause: "语音识别平台的额度或余额不足。",
    remedyText: "请到平台充值，或稍后重试",
    remedy: "retry-later",
    allowDetail: true,
    retryOnSend: false,
    isAsrFailureKind: true
  },
  "asr-ratelimit": {
    cause: "请求过于频繁，已被语音识别平台限流。",
    remedyText: "请稍后重试",
    remedy: "retry-later",
    allowDetail: false,
    retryOnSend: false,
    isAsrFailureKind: true
  },
  "asr-network": {
    cause: "无法连接语音识别平台（网络不通或请求超时）。",
    remedyText: "请检查网络后重新抓取",
    remedy: "retry-later",
    allowDetail: false,
    retryOnSend: false,
    isAsrFailureKind: true
  },
  "asr-media": {
    cause: "这个视频的音轨下载或解码失败（可能受保护，或文件过大）。",
    remedyText: "可换一个视频，或稍后重新抓取",
    remedy: "retry-later",
    allowDetail: false,
    retryOnSend: false,
    isAsrFailureKind: true
  },
  "asr-server": {
    cause: "语音识别平台暂时不可用（服务端错误）。",
    remedyText: "请稍后重新抓取",
    remedy: "retry-later",
    allowDetail: false,
    retryOnSend: false,
    isAsrFailureKind: true
  },
  "asr-unknown": {
    cause: "语音识别失败，未能识别具体原因。",
    remedyText: "可重新抓取或稍后重试",
    remedy: "retry-later",
    allowDetail: true,
    retryOnSend: false,
    isAsrFailureKind: true
  },
  "asr-empty": {
    cause: "未识别到语音内容，这个视频可能没有人声。",
    remedyText: "",
    remedy: "none",
    allowDetail: false,
    retryOnSend: false,
    isAsrFailureKind: false
  }
};

const NULL_REASON_ENTRY: CopyEntry = {
  cause: "",
  remedyText: "可在设置页配置语音识别平台自动生成字幕。",
  remedy: "open-settings",
  allowDetail: false,
  retryOnSend: false,
  isAsrFailureKind: false
};

const UNKNOWN_ENTRY = COPY_TABLE["asr-unknown"];

function lookupCopyEntry(reason: unknown): CopyEntry | null {
  if (typeof reason !== "string" || !Object.hasOwn(COPY_TABLE, reason)) {
    return null;
  }
  return COPY_TABLE[reason as NonNullReason];
}

export function reasonFromFailureKind(kind: unknown): NoSubtitleReason {
  const entry = lookupCopyEntry(kind);
  return entry?.isAsrFailureKind ? (kind as NoSubtitleReason) : "asr-unknown";
}

function normalizeDetailText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatAsrFailureDetail(input?: AsrFailureDetailInput | null): string {
  const status = Number(input?.status);
  const hasStatus = Number.isFinite(status) && status > 0;
  const text = normalizeDetailText(input?.detail);
  const parts: string[] = [];
  if (hasStatus) {
    parts.push(`HTTP ${status}`);
  }
  if (text) {
    parts.push(text);
  }
  if (parts.length === 0) {
    return "";
  }
  const content = parts.join(": ").slice(0, ASR_FAILURE_DETAIL_MAX_CHARS);
  return `（错误详情：${content}）`;
}

export function getAsrFailureNotice(reason: NoSubtitleReason, detail?: AsrFailureDetailInput | null): AsrFailureNotice {
  const matched = reason === null ? NULL_REASON_ENTRY : lookupCopyEntry(reason);
  const entry = matched ?? UNKNOWN_ENTRY;
  return {
    cause: entry.cause,
    remedyText: entry.remedyText,
    remedy: entry.remedy,
    detail: matched?.allowDetail ? formatAsrFailureDetail(detail) : ""
  };
}

export function requiresAsrSetup(reason: NoSubtitleReason): boolean {
  return getAsrFailureNotice(reason).remedy === "open-settings";
}

export function canRetryNoSubtitleOnSend(reason: NoSubtitleReason): boolean {
  return Boolean(lookupCopyEntry(reason)?.retryOnSend);
}

export function buildAsrNoSubtitleMessage(
  surface: "status-line" | "sidepanel",
  reason: NoSubtitleReason,
  detail?: AsrFailureDetailInput | null
): string {
  if (surface === "sidepanel" && reason === "asr-empty") {
    return SIDEPANEL_EMPTY_NOTICE;
  }
  const base = surface === "sidepanel" ? SIDEPANEL_BASE : STATUS_LINE_BASE;
  const notice = getAsrFailureNotice(reason, detail);
  return [base, notice.cause, notice.remedyText, notice.detail].filter(Boolean).join(" ");
}
