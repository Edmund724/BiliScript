// extension/asr/failure-kind.ts
// ASR 失败分类（票 04 判定表的唯一实现，双侧共用纯模块）。
//
// 为什么判定住在这里而不是归类点（fallback / 状态栏）：
// 消歧必须在**完整报文还在手上**的那一层做——429 的额度 vs 限流靠 error.type、
// speaches 的 404 靠 detail 文案，报文一旦被截断（80/200 字符）就未必还含这些
// 关键字（票 03 Q5）。因此适配器与 offscreen 管线抛出点各自传入 status + 完整
// 报文 + provider，只把 kind 这个小字符串带过 port。
//
// 三条陷阱（本模块存在的理由）：
// 1. **CDN 陷阱**：音轨从 B 站 CDN 下载，它回的 403/404 与 ASR 平台同形。若只看
//    状态码，CDN 的 403 会被报成「API Key 无效」——正是本次要修的误报的镜像。
//    故输入显式带 source，模块不从状态码猜来源。
// 2. **429 双义**：硅基流动额度=402 / 限流=429，天然可分；OpenAI 一侧两者共用
//    429，只能靠 error.type（insufficient_quota vs rate_limit_exceeded）分。分不出
//    时落 asr-quota——补救动作（充值/稍后重试）覆盖限流的「稍后重试」，反向不覆盖。
// 3. **404 撞码**：speaches「模型没下载」与「路由不存在」同为 404。两者同为配置
//    问题，分类不需要消歧（消歧只为文案服务）。
//
// 纯叶子：零 import、零状态、零 I/O（offscreen 与页面两侧都要拉进各自的图）。

// 失败信号的来源段：platform = ASR 平台的 HTTP 响应（适配器抛出点）；
// media = 音轨下载 / 解码 / 切片的管线抛出点（offscreen 侧，B 站 CDN 参与）。
export type AsrFailureSource = "platform" | "media";

// 失败类别（与 extension/core/state.ts 的 NoSubtitleReason 失败段一一对应）
export type AsrFailureKind =
  | "no-asr-config"
  | "asr-auth"
  | "asr-quota"
  | "asr-ratelimit"
  | "asr-network"
  | "asr-media"
  | "asr-server"
  | "asr-unknown";

// provider 的最小投影：429 分流看 host（本地 / 硅基流动），不看多余字段
export interface AsrFailureProviderLike {
  baseUrl?: unknown;
  type?: unknown;
}

export interface AsrFailureInput {
  source: AsrFailureSource;
  status?: number | null;
  /** 完整（未截断）响应体原文或错误消息；判定必须基于完整报文 */
  body?: string | null;
  provider?: AsrFailureProviderLike | null;
}

// 关键词表（票 04 Q7 第②级）。全部小写，匹配前对报文做 lowercase。
// 表内顺序即优先级：网络 → 配置 → 额度 → 限流 → 媒体。
//
// 注意「未配置」是配置类的宽匹配，会同时吃掉「baseUrl 未配置」；`网络` 是网络类
// 的宽匹配，会吃掉「网络错误」。窄串留在这里只为可读性与意图表达。
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

// 媒体关键词同时也是 400 与 429 之外的消歧锚点：三家平台「音频被拒收」用的状态码
// 互不相同（OpenAI 400 / 硅基流动未找到 / speaches 415），没有跨平台稳定码可用。
const MEDIA_KEYWORDS = ["格式", "format", "unsupported media", "仅支持"];

// 400 的配置侧锚点：硅基流动官方报文 `{"code":20012,"message":"Model does not exist..."}`
const CONFIG_MODEL_MARKERS = ["model does not exist", "20012", "模型不存在"];

// 本地语义 host：这几家的 429 是「限流」（本地 Whisper 无额度概念）
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"];

// 429 且报文无特征时，按 host 判：本地与硅基流动 429 都是限流，其余（OpenAI 兼容）
// 额度与限流共用 429，分不出，落额度兜底。
const RATELIMIT_HOST_MARKERS = ["siliconflow"];

function normalizeBody(body: unknown): string {
  return typeof body === "string" ? body.toLowerCase() : "";
}

function includesAny(haystack: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => haystack.includes(keyword));
}

// 有效 HTTP 状态码：可转成有限数且 > 0。0 / 负数 / NaN / Infinity 都不是真实状态码
// （与 shared/error-helpers 的 isRetryableNetworkError 同口径），-1 是适配器的
// 「响应体不是合法 JSON」哨兵，单独处理。
function normalizeStatus(status: unknown): number | null {
  const value = Number(status);
  return Number.isFinite(value) && value > 0 ? value : null;
}

// 从 baseUrl 取 host：解析失败 / 非字符串返回空串（不误命中本地规则）。
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

// 判定次序 0d：无有效状态码时的关键词消歧（也是媒体来源的兜底）。
function classifyWithoutStatus(haystack: string, source: AsrFailureSource): AsrFailureKind {
  if (!haystack) {
    // 无报文可看：媒体来源的抛出点全是音轨问题，平台来源无从判断
    return source === "media" ? "asr-media" : "asr-unknown";
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
  // 无命中：媒体来源默认落媒体类（音轨取不到 / 解不了），平台来源无从判断
  return source === "media" ? "asr-media" : "asr-unknown";
}

// 429 双义分流：报文特征优先（最具体）→ host 默认 → 额度兜底。
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
  // OpenAI 兼容的 429 额度 / 限流同码，分不出时落额度（票 04 Q2：合并文案的落点）
  return "asr-quota";
}

// 400 三分：格式关键词 → 媒体；模型/错误码锚点 → 配置；其余不猜。票 04 只给了
// 「含 A 则 X、含 B 则 Y」的并列条件、没有定优先级，两者同时命中时按此序取先者
//（定序只为让函数单值，不改票里任何一条条件）。
function classify400(haystack: string): AsrFailureKind {
  if (includesAny(haystack, MEDIA_KEYWORDS)) {
    return "asr-media";
  }
  if (includesAny(haystack, CONFIG_MODEL_MARKERS)) {
    return "no-asr-config";
  }
  return "asr-unknown";
}

// 判定入口。次序见票 04：0a 哨兵 → 0b 408 → 0c 媒体来源 → 0d 无状态码关键词
// → 1 平台状态码表 → 2 unknown。
export function classifyAsrFailure(input: AsrFailureInput): AsrFailureKind {
  const source: AsrFailureSource = input?.source === "media" ? "media" : "platform";
  const rawStatus = Number(input?.status);
  const haystack = normalizeBody(input?.body);

  // 0a. 适配器哨兵：响应到了但体不是合法 JSON，无从判断是平台故障还是配置问题
  if (rawStatus === -1) {
    return "asr-unknown";
  }

  // 0b. 408（请求超时）是网络语义，与来源段无关（先于 0c 的媒体来源短路）
  if (rawStatus === 408) {
    return "asr-network";
  }

  const status = normalizeStatus(rawStatus);

  // 0c. 媒体来源 + 有效状态码：判定次序第 0 步（不看状态码就能定的）先于状态码表，
  // 而媒体来源的抛出点全是音轨下载 / 解码 / 切片问题，故这里不查表——CDN 的 403/404
  // 与平台同形（票 04 Q8 的镜像误报），5xx/429 也不该落成平台故障或额度。
  if (status !== null && source === "media") {
    return "asr-media";
  }

  // 0d. 无有效状态码：靠关键词消歧，媒体来源默认落媒体类
  if (status === null) {
    return classifyWithoutStatus(haystack, source);
  }

  // 1. 平台状态码表（source === "platform" 且 status > 0）
  switch (status) {
    case 401:
      return "asr-auth";
    case 402:
      return "asr-quota";
    case 403:
      // 硅基流动「权限不足」与 speaches「Key 无效」撞码，两家补救动作同为一个
      // （去设置检查 Key / 权限），故一律 auth。
      return "asr-auth";
    case 404:
      // 路由不对 / 模型没下载两种子情形同为配置问题（消歧只为文案服务）。
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
