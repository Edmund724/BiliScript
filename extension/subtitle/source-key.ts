// extension/subtitle/source-key.ts
// 「字幕轨身份」键位叶：字幕轨身份 → 缓存 source key 的编码单点，以及与编码同根
// 派生的「这是不是 ASR 变体键」判据。身份编码不归存储族模块承载：缓存键入口收
// 身份，ASR 侧显式构造 asr 身份，孤儿清理的匹配前缀取自本叶的导出常量。
//
// 身份的成员集是封闭判别联合（track / url / lang / asr），导出的四个面各司其职：
//   ① trackIdentity(subtitleId, subtitleUrl, lang)：三个散字段原始输入 → 身份，
//      优先级 id > url > lang 与 URL 归一的唯一裁定处；
//   ② subtitleSourceKey(identity)：身份 → source key，封闭四态（switch 穷尽四态，
//      新增一态必须显式给一行——身份没有看不见的支线）；
//   ③ buildSubtitleSourceKey(subtitleId, subtitleUrl, lang)：位置参数的便捷形
//      （= ①∘②），供缓存族注入面与直取用——URL 归一不会被绕开；
//   ④ isAsrVariantSourceKey(sourceKey) + ASR_SOURCE_KEY_PREFIX：ASR 变体判据与它的
//      匹配前缀，前缀由本叶唯一根常量派生、判据即前缀匹配。组键侧（ASR 伪轨身份）
//      与识别侧（孤儿清理）因此出自同一根，改编码时判据跟着改，不可能各写一套拼写
//      而悄悄漂移。
//
// 字节纪律（缓存零迁移是硬验收）：四态的产物就是**既有缓存的 source key 字节面**——
// 键形逐字节不变，老缓存继续命中、无需迁移：轨 id 整体 trim、URL 归一（hostname + 净化
// path）后空串回落 lang 分支、空语言的 unknown 兜底、ASR 分段用 ":" 原样拼接（不剔空段）。
//
// 叶子纪律：运行时依赖只有 URL 归一叶（第二套归一「削成 hostname + 净化 path」的
// 住处，本叶 import 复用、不存第二份）；不碰 chrome、不碰 state、不拖网关闭包——
// SW 侧的段缓存族工厂也消费本叶。

import { normalizeSubtitleUrlForCache } from "../bilibili/native-payload.js";

export type TrackIdentity =
  | { kind: "track"; trackId: unknown } // → id_<轨 id；trim 后非空>
  | { kind: "url"; url: unknown } // → url_<缓存键分量；归一后非空>
  | { kind: "lang"; lang: unknown } // → lang_<小写；空为 unknown>
  | { kind: "asr"; providerId: unknown; model: unknown; lang: unknown }; // → id_asr:<p>:<m>:<l>

// ASR 伪轨 id 的根名（叶内唯一根常量）：变体前缀与变体判据都从它派生。
const ASR_VARIANT_ROOT = "asr";
// ASR 变体 source key 前缀（= id_ + 根名 + ":"）。ASR 孤儿清理的匹配前缀由它派生，
// 全仓不得出现第二处 "id_asr:" 字面拼写。
export const ASR_SOURCE_KEY_PREFIX = `id_${ASR_VARIANT_ROOT}:`;

// id_ 分支分量（track 与 asr 两态共用同一语义：整体 trim 后进键）。
function trackIdComponent(rawId: unknown): string {
  return `id_${String(rawId || "").trim()}`;
}

// ASR 段值 → 文本：空段保留空串（不剔段），段间 ":" 由调用侧的拼接负责。
function asrSegmentText(value: unknown): string {
  return String(value || "");
}

// ① 三个散字段原始输入 → 身份：优先级 id > url > lang 的唯一裁定处；URL 归一
// （缓存键分量，削 query）也在这里探一次，归一后为空串即回落 lang 分支。
export function trackIdentity(subtitleId: unknown, subtitleUrl: unknown, lang: unknown): TrackIdentity {
  if (String(subtitleId || "").trim()) {
    return { kind: "track", trackId: subtitleId };
  }
  if (normalizeSubtitleUrlForCache(subtitleUrl)) {
    return { kind: "url", url: subtitleUrl };
  }
  return { kind: "lang", lang };
}

// ② 身份 → source key：封闭四态——产物即缓存键 source key 的字节面（键形就是兼容承诺，见头注字节纪律）。
// 状态来源没有第二处：track / url / lang 由 ① 的 trackIdentity 产出（优先级与 URL 回落的唯一裁定处），
// asr 由 ASR 组键侧（asr/fallback）显式构造——本函数的原始值编码不会收到 trackIdentity 不可能给出的状态。
export function subtitleSourceKey(identity: TrackIdentity): string {
  switch (identity.kind) {
    case "track":
      return trackIdComponent(identity.trackId);
    case "url":
      return `url_${normalizeSubtitleUrlForCache(identity.url)}`;
    case "lang":
      return `lang_${String(identity.lang || "").trim().toLowerCase() || "unknown"}`;
    case "asr":
      return trackIdComponent(
        `${ASR_VARIANT_ROOT}:${asrSegmentText(identity.providerId)}:${asrSegmentText(identity.model)}:${asrSegmentText(identity.lang)}`
      );
  }
}

// ③ 位置参数便捷形（①∘②）：缓存族注入面（core/cache-lru 的 toSourceKey 签名不变）
// 与直取用经它，URL 归一不被绕开。
export function buildSubtitleSourceKey(subtitleId: unknown, subtitleUrl: unknown, lang: unknown): string {
  return subtitleSourceKey(trackIdentity(subtitleId, subtitleUrl, lang));
}

// ④ ASR 变体判据：与编码同根——前缀由 ASR_VARIANT_ROOT 派生，判据即前缀匹配。
export function isAsrVariantSourceKey(sourceKey: unknown): boolean {
  return String(sourceKey || "").startsWith(ASR_SOURCE_KEY_PREFIX);
}
