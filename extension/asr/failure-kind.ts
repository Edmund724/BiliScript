export type AsrFailureSource = "platform" | "media";

export type AsrFailureKind =
  | "no-asr-config"
  | "asr-auth"
  | "asr-quota"
  | "asr-ratelimit"
  | "asr-network"
  | "asr-media"
  | "asr-server"
  | "asr-unknown";

export interface AsrFailureProviderLike {
  baseUrl?: unknown;
  type?: unknown;
}

export interface AsrFailureInput {
  source: AsrFailureSource;
  status?: number | null;
  body?: string | null;
  provider?: AsrFailureProviderLike | null;
}

const NETWORK_KEYWORDS = [
  "failed to fetch",
  "fetch failed",
  "networkerror",
  "net::",
  "timeout",
  "timed out",
  "econnrefused",
  "enotfound",
  "无法连接",
  "连接被拒",
  "网络"
];

const CONFIG_KEYWORDS = [
  "未授权",
  "baseurl 未配置",
  "未配置",
  "model does not exist",
  "model not found",
  "not installed locally",
  "no such model",
  "模型不存在",
  "模型没下载"
];

const QUOTA_KEYWORDS = ["insufficient_quota", "insufficient quota", "quota exceeded", "billing", "余额", "额度"];

const RATELIMIT_KEYWORDS = ["rate_limit_exceeded", "rate limit", "too many requests", "限流", "频率"];

const MEDIA_KEYWORDS = ["格式", "format", "unsupported media", "仅支持"];

const CONFIG_MODEL_MARKERS = ["model does not exist", "20012", "模型不存在"];

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"];

const RATELIMIT_HOST_MARKERS = ["siliconflow"];

function normalizeBody(body: unknown): string {
  return typeof body === "string" ? body.toLowerCase() : "";
}

function includesAny(haystack: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => haystack.includes(keyword));
}

function normalizeStatus(status: unknown): number | null {
  const value = Number(status);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function hostOf(baseUrl: unknown): string {
  if (typeof baseUrl !== "string") {
    return "";
  }
  try {
    return new URL(baseUrl).host.toLowerCase();
  } catch {
    return "";
  }
}

function classifyWithoutStatus(haystack: string, source: AsrFailureSource): AsrFailureKind {
  if (!haystack) {
    return source === "media" ? "asr-media" : "asr-unknown";
  }
  if (source === "media") {
    if (includesAny(haystack, CONFIG_KEYWORDS)) {
      return "no-asr-config";
    }
    return "asr-media";
  }
  if (includesAny(haystack, NETWORK_KEYWORDS)) {
    return "asr-network";
  }
  if (includesAny(haystack, CONFIG_KEYWORDS)) {
    return "no-asr-config";
  }
  if (includesAny(haystack, QUOTA_KEYWORDS)) {
    return "asr-quota";
  }
  if (includesAny(haystack, RATELIMIT_KEYWORDS)) {
    return "asr-ratelimit";
  }
  if (includesAny(haystack, MEDIA_KEYWORDS)) {
    return "asr-media";
  }
  return "asr-unknown";
}

function classify429(haystack: string, provider?: AsrFailureProviderLike | null): AsrFailureKind {
  if (haystack && includesAny(haystack, QUOTA_KEYWORDS)) {
    return "asr-quota";
  }
  if (haystack && includesAny(haystack, RATELIMIT_KEYWORDS)) {
    return "asr-ratelimit";
  }
  const host = hostOf(provider?.baseUrl);
  if (includesAny(host, LOCAL_HOSTS) || includesAny(host, RATELIMIT_HOST_MARKERS)) {
    return "asr-ratelimit";
  }
  return "asr-quota";
}

function classify400(haystack: string): AsrFailureKind {
  if (includesAny(haystack, MEDIA_KEYWORDS)) {
    return "asr-media";
  }
  if (includesAny(haystack, CONFIG_MODEL_MARKERS)) {
    return "no-asr-config";
  }
  return "asr-unknown";
}

export function classifyAsrFailure(input: AsrFailureInput): AsrFailureKind {
  const source: AsrFailureSource = input?.source === "media" ? "media" : "platform";
  const rawStatus = Number(input?.status);
  const haystack = normalizeBody(input?.body);

  if (rawStatus === -1) {
    return "asr-unknown";
  }

  if (rawStatus === 408) {
    return "asr-network";
  }

  const status = normalizeStatus(rawStatus);

  if (status !== null && source === "media") {
    return "asr-media";
  }

  if (status === null) {
    return classifyWithoutStatus(haystack, source);
  }

  switch (status) {
    case 401:
      return "asr-auth";
    case 402:
      return "asr-quota";
    case 403:
      return "asr-auth";
    case 404:
      return "no-asr-config";
    case 415:
      return "asr-media";
    case 400:
      return classify400(haystack);
    case 429:
      return classify429(haystack, input?.provider);
    default:
      return status >= 500 ? "asr-server" : "asr-unknown";
  }
}
