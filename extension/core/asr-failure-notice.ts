// ASR 失败文案的单一真源（asr-error-reporting/06 文案表 + 04 分类法）。
//
// 为什么单列一个模块：无字幕的两套文案表曾经各写一份——reader 状态栏
//（subtitle/commit 的 buildNoSubtitleStatusMessage）与 sidepanel 拦截提示
//（chat/no-subtitle 的 buildNoSubtitleNotice），新类目必然只改一处、另一处静默
// 漂移。现在「一个 reason 一段病因 + 一段补救 + 一个补救动作」只在这里定，两个面
// 各自拼自己已冻结的前缀（前缀是各面的排版契约，不属于病因）。
//
// 为什么是叶子：它是所有人都已依赖的 core，被 content 侧两侧消费——状态栏在懒
// 加载区，而 sidepanel 拦截在常驻侧，故本模块必须是**零运行时依赖的纯函数库**，
// 且两侧拿到的是各自的实例（双实例安全）：模块级不可有可变状态。也因此它
// 只 type-import 一处类型，绝不 import asr 域的 failure-kind——kind → reason 的
// 映射与文案同住这里（一个 reason 一处文案、一处映射），判 kind 的纯逻辑留在
// asr 域，core 不该反向依赖它。
//
// 三条不可越过的口径：
// - 基础句冻结（票 06 Q10）：两个面的前缀「当前视频无字幕。」/「当前视频没有字
//   幕，无法总结。」一字不动，病因只做追加；
// - 状态栏文案永远含基础句（票 07 Q2）：改文案时若丢掉基础句，病因会静默消失
//   ——不变量由 tests/core/asr-failure-notice.test.ts 钉住；
// - 详情行是可选的附加证据，只有四个 reason 允许出现（票 06 的详情行列），
//   拿不到结构化信息时整段不出现（不写「无」）。

import type { NoSubtitleReason } from "./state.js";

// 补救动作：渲染层据此决定是否挂「前往设置」链接，文案层只说该做什么。
// none 表示用户无需动作（asr-empty：平台成功，只是没人声）。
export type AsrRemedy = "open-settings" | "retry-later" | "none";

// 详情行的输入：adapter 已把原始报文截到 200 字符（未格式化，可能带换行），
// status === -1 表示「响应体不是合法 JSON」——那是判 kind 的信号，不是可展示的
// 状态码，故只有 status > 0 才进详情行。字段值按展示口径收口（Number() /
// String()），故这里收外来原值：片级失败摘要的 status / detail 由判定层照搬，
// 不保证是数字 / 字符串。
export interface AsrFailureDetailInput {
  status?: number | string | null;
  detail?: string | number | null; // 原始报文片段（适配器已截到 200 字符），未格式化
}

export interface AsrFailureNotice {
  cause: string; // 病因句（reason 为 null 时 ""）
  remedyText: string; // 补救句（可为 ""）
  remedy: AsrRemedy; // 渲染成「前往设置」链接的开关来源
  detail: string; // 已格式化的详情行（含「（错误详情：…）」括号）；不适用/无信息 → ""
}

// 各面的冻结前缀：状态栏 = 阅读视图 header 状态行；sidepanel = 一键总结的拦截提示。
export const STATUS_LINE_BASE = "当前视频无字幕。";
export const SIDEPANEL_BASE = "当前视频没有字幕，无法总结。";

// asr-empty 在 sidepanel 的例外整句：空结果在拦截场景下要自成一件事（这个视频
// 本身没有人声，不是「没字幕所以总结不了」），故整句替换而非追加。
export const SIDEPANEL_EMPTY_NOTICE = "这个视频没有识别到语音内容，无法总结。";

// 详情行的展示宽度上限（票 06 Q13）：状态行是单行宿主，报文再长也读不完；
// 适配器侧的 200 字符是传输上限，这里是排版上限，两者互不替代。
export const ASR_FAILURE_DETAIL_MAX_CHARS = 80;

// 「病因句 + 补救句 + 补救动作 + 详情开放 + 发送重抓 + 失败类白名单」单表真源。
// 键类型取 NoSubtitleReason 去掉 null 后的全联合：联合新增取值而漏配条目时，这里
// 直接是 tsc 错误，不会静默落到未知兜底。
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
  // 语义涵盖「平台 / 模型不可用」：未配置平台、域名未授权、baseUrl 缺失、模型
  // 不存在、模型没下载——补救动作统一去设置页检查。
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
  // 额度不足的补救是充值而非改设置，故不附「前往设置」链接。
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
  // 中性句：判不出原因时必须保住「去哪看」的线索——详情行是这类的主要出口。
  "asr-unknown": {
    cause: "语音识别失败，未能识别具体原因。",
    remedyText: "可重新抓取或稍后重试",
    remedy: "retry-later",
    allowDetail: true,
    retryOnSend: false,
    isAsrFailureKind: true
  },
  // 平台成功但没人声：不是失败，没有可做的事，故补救句为空。
  "asr-empty": {
    cause: "未识别到语音内容，这个视频可能没有人声。",
    remedyText: "",
    remedy: "none",
    allowDetail: false,
    retryOnSend: false,
    isAsrFailureKind: false
  }
};

// reason 为 null = 从未归类（旧快照 / 原因缺失）：只有通用补救句，不编病因。
// null 是联合里的一个取值，但不能当 COPY_TABLE 的键，故单列。
const NULL_REASON_ENTRY: CopyEntry = {
  cause: "",
  remedyText: "可在设置页配置语音识别平台自动生成字幕。",
  remedy: "open-settings",
  allowDetail: false,
  retryOnSend: false,
  isAsrFailureKind: false
};

// 判不出原因时的兜底：绝不返回 null——null 会落成「无原因」文案并丢掉详情，
// 而中性句 + 重新抓取是唯一安全的出口。
const UNKNOWN_ENTRY = COPY_TABLE["asr-unknown"];

function lookupCopyEntry(reason: unknown): CopyEntry | null {
  if (typeof reason !== "string" || !Object.hasOwn(COPY_TABLE, reason)) {
    return null;
  }
  return COPY_TABLE[reason as NonNullReason];
}

// kind（asr/failure-kind.ts 判出的 8 个失败类）→ reason；未知/缺失或非失败类
// → "asr-unknown"（绝不返回 null）。
export function reasonFromFailureKind(kind: unknown): NoSubtitleReason {
  const entry = lookupCopyEntry(kind);
  return entry?.isAsrFailureKind ? (kind as NoSubtitleReason) : "asr-unknown";
}

// 连续空白（含换行）折叠为单个空格并 trim：报文来自平台，常带 JSON 缩进与换行，
// 摊平成一行才塞得进单行宿主。
function normalizeDetailText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

// 详情行：无结构化信息时返回 ""（整段不出现，不写「无」）。
export function formatAsrFailureDetail(input?: AsrFailureDetailInput | null): string {
  const status = Number(input?.status);
  const hasStatus = Number.isFinite(status) && status > 0;
  const text = normalizeDetailText(input?.detail);
  // status 与报文各自可选：只有报文时不加状态码前缀，只有状态码时不加多余冒号。
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

// 按 reason 取「病因 + 补救 + 补救动作 +（可选）详情行」。unknown / 联合外取值
// 一律落中性句；detail 只在单表 allowDetail=true 的已知 reason 上出现。
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

// 配置类梗阻的判定：补救动作是「去设置」的 reason 才有可落地的设置动作。
// 字幕空态 / 概览空态 / 对话拦截三处的动作渲染都只读这一条，不在各面重写 remedy 比较。
export function requiresAsrSetup(reason: NoSubtitleReason): boolean {
  return getAsrFailureNotice(reason).remedy === "open-settings";
}

// 发送闸重抓策略：用户修复配置（未配置 / 关闭 / 鉴权）或登录 B 站后再次发送时
// 允许重新起跑抓取；未归类（null）与其余失败类仍按原规则拦截，避免无谓的重复转写。
export function canRetryNoSubtitleOnSend(reason: NoSubtitleReason): boolean {
  return Boolean(lookupCopyEntry(reason)?.retryOnSend);
}

// surface 各自拼自己已冻结的前缀：过滤空段后单空格连接，避免原因缺失时留下
// 双空格或尾空格。sidepanel 的 asr-empty 是唯一例外（整句替换）。
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
