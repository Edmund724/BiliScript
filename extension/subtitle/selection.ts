// extension/subtitle/selection.ts
// 「哪条轨被选中与如何投影为目标」的唯一落点：
//   - 排序优先级（中文 → 英文 → 其余保持接口原顺序）与 previousId / URL / lang 三级
//     复用（normalizeSubtitleTracks / pickPreferredSubtitle）；
//   - 轨道目标投影与按身份找回轨（SubtitleTrackTarget / SubtitleTrackRef /
//     findTrackByRef / resolveTrackTarget，目标语言统一 `lanDoc || lan || "unknown"`）；
//   - 副轨语言两级匹配 + 主轨排除（subtitlePrimaryLangTag / findTrackByPreferredLang /
//     isMainSubtitleTrack / findSecondaryTrackByPreferredLang，口径见 GLOSSARY.md「字幕」
//     词条与 ADR-0016）；
//   - subtitleBody 按 from 升序的写入不变量排序（sortSubtitleBodyByFrom；读路径
//     findActiveSubtitleIndex 的二分依赖它）。
// 原生产物映射与 subtitleUrl 的两套归一在 bilibili/native-payload.ts；时长校验在
// subtitle/duration-validation.ts；显示文案在 subtitle/labels.ts。

import { normalizeSubtitleUrlForCache, type RawSubtitleTrack } from "../bilibili/native-payload.js";
import type { SubtitleTrack } from "../bilibili/gateway.js";
import {
  LIVE_INTERPRET_TARGET_BCP47,
  LIVE_INTERPRET_TARGET_LANG_OPTIONS,
  type LiveInterpretTargetLang
} from "../live/interpret-subtitle-preferences.js";

// 语种族别名映射（BCP-47 / ISO-639-2/3 / 地区方言码 → 统一语种族短码）。
const LANG_FAMILY_ALIASES: Record<string, string> = {
  zh: "zh",
  zho: "zh",
  chi: "zh",
  cmn: "zh",
  yue: "zh",
  wuu: "zh",
  nan: "zh",
  hak: "zh",
  en: "en",
  eng: "en",
  ja: "ja",
  jp: "ja",
  jpn: "ja",
  ko: "ko",
  kor: "ko",
  de: "de",
  deu: "de",
  ger: "de",
  fr: "fr",
  fra: "fr",
  fre: "fr",
  es: "es",
  spa: "es",
  ru: "ru",
  rus: "ru",
  it: "it",
  ita: "it",
  pt: "pt",
  por: "pt",
  tr: "tr",
  tur: "tr",
  el: "el",
  ell: "el",
  gre: "el",
  id: "id",
  ind: "id",
  in: "id",
  ms: "ms",
  msa: "ms",
  may: "ms"
};

/**
 * 语种族归一化：将 `zh-CN`/`zh-Hans`/`zh-TW`/`zh-HK`/`zh-Hant`/`ai-zh`/`asr-zh` 归为 `"zh"`，
 * `en-US`/`en-GB`/`ai-en` 归为 `"en"`，`ja`/`ja-JP`/`ai-ja` 归为 `"ja"` 等。
 */
export function getLangFamily(lan: unknown): string {
  const cleaned = String(lan || "")
    .trim()
    .toLowerCase()
    .replace(/^(ai|asr)[-_]/, "");
  if (!cleaned || cleaned === "auto" || cleaned === "unknown") {
    return "";
  }
  const primary = cleaned.split(/[-_]/)[0] || "";
  if (!primary) {
    return "";
  }
  return Object.prototype.hasOwnProperty.call(LANG_FAMILY_ALIASES, primary)
    ? LANG_FAMILY_ALIASES[primary]
    : primary;
}

export function isSameLangFamily(lanA: unknown, lanB: unknown): boolean {
  const familyA = getLangFamily(lanA);
  const familyB = getLangFamily(lanB);
  return Boolean(familyA && familyB && familyA === familyB);
}

/**
 * 轨道性质分类：
 * - `manual-cc`：UP 主或字幕组上传的原生人工轨（`!lan.startsWith("ai-") && id !== "asr"`）；
 * - `bili-ai`：B 站官方自动生成的机器轨（`lan.startsWith("ai-")`）；
 * - `asr`：BiliScript Offscreen 语音转写伪轨（`id === "asr"` 或 `asr-*` 伪轨）。
 */
export type SubtitleTrackKind = "manual-cc" | "bili-ai" | "asr";

export function classifySubtitleTrack(
  track: { id?: unknown; lan?: unknown; subtitleUrl?: unknown } | null | undefined
): SubtitleTrackKind {
  const id = String(track?.id ?? "").trim();
  const lan = String(track?.lan ?? "").trim().toLowerCase();
  if (id === "asr" || lan === "asr" || lan.startsWith("asr-")) {
    return "asr";
  }
  if (lan.startsWith("ai-")) {
    return "bili-ai";
  }
  return "manual-cc";
}

export function isLoadableNativeTrack(
  track: { id?: unknown; lan?: unknown; subtitleUrl?: unknown } | null | undefined
): boolean {
  return classifySubtitleTrack(track) !== "asr" && String(track?.subtitleUrl ?? "").trim().length > 0;
}

/**
 * 判定视频的所有可用原生真轨是否均属同一语种族（如单条 `en-US`、单条 `zh-CN`、或
 * `zh-Hans` + `zh-Hant` / `zh-CN` + `ai-zh` 同族多轨）。
 * 同语种族多轨整体视为「单语种视频」，禁止自动配成上简下繁假双语。
 */
export function isMonolingualNativeTracks(
  tracks: readonly { id?: unknown; lan?: unknown; subtitleUrl?: unknown }[] | null | undefined
): boolean {
  const nativeTracks = (tracks || []).filter(isLoadableNativeTrack);
  if (nativeTracks.length === 0) {
    return false;
  }
  const families = new Set<string>();
  for (const track of nativeTracks) {
    const family = getLangFamily(track.lan);
    if (family) {
      families.add(family);
    }
  }
  return families.size <= 1;
}

/**
 * 判定视频是否存在跨语种族的真人工多轨（场景 A：如人工 `en-US` + 人工 `zh-CN`）。
 */
export function hasCrossLangManualTracks(
  tracks: readonly { id?: unknown; lan?: unknown; subtitleUrl?: unknown }[] | null | undefined
): boolean {
  const manualTracks = (tracks || []).filter(
    (track) => isLoadableNativeTrack(track) && classifySubtitleTrack(track) === "manual-cc"
  );
  const families = new Set(manualTracks.map((track) => getLangFamily(track.lan)).filter(Boolean));
  return families.size >= 2;
}

/**
 * 查找场景 C（存在高质量人工外语 CC，而中文仅有机器 `ai-zh`、无人工中文 CC）中的原版人工外语轨。
 */
export function findManualForeignTrackForAiRefine<
  T extends { id?: string; lan?: string; lanDoc?: string; subtitleUrl?: string }
>(tracks: readonly T[] | null | undefined): T | null {
  const nativeTracks = (tracks || []).filter(isLoadableNativeTrack);
  const hasManualZh = nativeTracks.some(
    (track) => classifySubtitleTrack(track) === "manual-cc" && getLangFamily(track.lan) === "zh"
  );
  if (hasManualZh) {
    return null;
  }
  const hasAiZh = nativeTracks.some(
    (track) => classifySubtitleTrack(track) === "bili-ai" && getLangFamily(track.lan) === "zh"
  );
  if (!hasAiZh) {
    return null;
  }
  return (
    nativeTracks.find(
      (track) => classifySubtitleTrack(track) === "manual-cc" && getLangFamily(track.lan) !== "zh"
    ) ?? null
  );
}

/**
 * 将任意目标语言输入（短码 `zh`/`en` 或 BCP-47 `zh-CN`/`en-US`）解析为词表内的短码。
 */
export function parseInterpretTargetLang(value: unknown): LiveInterpretTargetLang | null {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }
  const exact = LIVE_INTERPRET_TARGET_LANG_OPTIONS.find(
    (option) => option.value === raw.toLowerCase()
  );
  if (exact) {
    return exact.value;
  }
  const family = getLangFamily(raw);
  if (!family) {
    return null;
  }
  return LIVE_INTERPRET_TARGET_LANG_OPTIONS.find((option) => option.value === family)?.value ?? null;
}

export function toCanonicalTargetLangBcp47(targetLang: unknown): string {
  const parsed = parseInterpretTargetLang(targetLang);
  if (parsed) {
    return LIVE_INTERPRET_TARGET_BCP47[parsed];
  }
  return String(targetLang ?? "").trim() || "zh-CN";
}

/**
 * 返回剔除与源轨同语种族后的候选翻译目标语言列表（根除 `zh -> zh` / `en -> en` 同族自翻译）。
 */
export function getAvailableTargetLangOptions(
  sourceLan: unknown
): ReadonlyArray<(typeof LIVE_INTERPRET_TARGET_LANG_OPTIONS)[number]> {
  const sourceFamily = getLangFamily(sourceLan);
  if (!sourceFamily) {
    return LIVE_INTERPRET_TARGET_LANG_OPTIONS;
  }
  return LIVE_INTERPRET_TARGET_LANG_OPTIONS.filter(
    (option) => getLangFamily(option.value) !== sourceFamily
  );
}

/**
 * 解析翻译目标语言（短码）：自动过滤掉与 `sourceLan` 同语种族的偏好；
 * 源轨属 `"zh"` 族时默认回落 `"en"`（`en-US`），非 `"zh"` 族默认回落 `"zh"`（`zh-CN`）。
 */
export function resolveTargetLang(
  sourceLan: unknown,
  preferredTargetLan?: unknown
): LiveInterpretTargetLang {
  const sourceFamily = getLangFamily(sourceLan);
  const preferred = parseInterpretTargetLang(preferredTargetLan);
  if (preferred && (!sourceFamily || getLangFamily(preferred) !== sourceFamily)) {
    return preferred;
  }
  return sourceFamily === "zh" ? "en" : "zh";
}

/**
 * 解析翻译目标语言的规范 BCP-47 标签（如 `"zh-CN"` / `"en-US"`）。
 */
export function resolveTargetLangBcp47(
  sourceLan: unknown,
  preferredTargetLan?: unknown
): string {
  return LIVE_INTERPRET_TARGET_BCP47[resolveTargetLang(sourceLan, preferredTargetLan)];
}

export interface PreferredSubtitleContext {
  previousId?: string;
  previousUrl?: string;
  previousLang?: string;
}

// 轨道目标投影：id/url 取自轨，lang 统一按 `lanDoc || lan || "unknown"` 归一
//（主轨抓取、主列手动切轨、副轨自动装载与副列改选共用同一口径；selectedSubtitleLang
// 参与上下文签名与段缓存键，轨 id 为空时 lang 还是 per-track 缓存 source key 的分量）。
export interface SubtitleTrackTarget {
  id: string;
  url: string;
  lang: string;
}

// 选项行或外部引用给出的轨身份（id 优先，回退 URL；lang 为兜底语言标签）。
export interface SubtitleTrackRef {
  id?: string;
  url?: string;
  subtitleUrl?: string;
  lang?: string;
  lan?: string;
  lanDoc?: string;
}

// 按轨身份在轨列里找回轨（id 优先，回退 URL）。
export function findTrackByRef<T extends { id?: string; subtitleUrl?: string }>(
  tracks: readonly T[] | null | undefined,
  ref: { id?: string; url?: string; subtitleUrl?: string } | null | undefined
): T | null {
  const id = String(ref?.id || "");
  const url = String(ref?.url || ref?.subtitleUrl || "");
  return (
    (tracks || []).find(
      (track) => (!!id && String(track.id || "") === id) || (!!url && String(track.subtitleUrl || "") === url)
    ) ?? null
  );
}

// 轨或轨引用 → 规范目标投影（`lanDoc || lan || lang || "unknown"`）。
// 传入 tracks 时先按轨身份（id 优先，回退 URL）在轨列中找回完整轨再投影，
// 使得仅持 DOM 选项 `{ id, url, lang: track.lan }` 的调用方也能拿到轨的 `lanDoc`；
// 轨列中找不到时回退到入参自身的字段。
export function resolveTrackTarget(
  trackOrRef: SubtitleTrackRef | null | undefined,
  tracks?: readonly { id?: string; subtitleUrl?: string; lan?: string; lanDoc?: string }[] | null
): SubtitleTrackTarget {
  const resolved = tracks ? (findTrackByRef(tracks, trackOrRef) ?? trackOrRef) : trackOrRef;
  return {
    id: String(resolved?.id || ""),
    url: String(resolved?.subtitleUrl || (resolved as SubtitleTrackRef | undefined)?.url || ""),
    lang: String(resolved?.lanDoc || resolved?.lan || (resolved as SubtitleTrackRef | undefined)?.lang || "unknown")
  };
}

function subtitlePriority(item: SubtitleTrack | RawSubtitleTrack): number {
  const lan = String(item?.lan || "").toLowerCase();
  const label = String((item as { lanDoc?: string }).lanDoc || "").toLowerCase();

  // 优先级：中文（包含 AI 中文）-> 英文 -> 其他
  if (lan === "zh-cn" || lan === "zh-hans") {
    return 0;
  }
  if (lan === "zh") {
    return 1;
  }
  if (lan.includes("zh")) {
    return 2;
  }
  if (label.includes("中文")) {
    return 3;
  }

  if (lan === "en" || lan === "en-us" || lan === "en-gb") {
    return 10;
  }
  if (lan.includes("en")) {
    return 11;
  }
  if (label.includes("英文") || label.includes("英语") || label.includes("english")) {
    return 12;
  }

  return 50;
}

export function normalizeSubtitleTracks(subtitles?: SubtitleTrack[] | RawSubtitleTrack[] | null): SubtitleTrack[] {
  // 排序键只比优先级：同优先级保持输入顺序（= 接口原顺序 = 播放器菜单顺序）。
  // 历史上同优先级还依次比 lanDoc 的字符串序（代码单元序，混合文字下不可读）、
  // 数字 id 升序，末尾再以 subtitleUrl 的 localeCompare 兜底；二级键在真实数据上
  // 把 8 条 ai-* 样本的「其余」段排成 ai-id / ai-es / ai-pt / ai-ar / ai-th / ai-ja
  // （research/01-track-shape.md），与接口原顺序、与播放器菜单都不同——三个二级键
  // 已按 Q8′ 一并去掉。
  // 已知副作用（接受）：视频只有非中英轨时 pickPreferredSubtitle 的 tracks[0]
  // 兜底从「字典序第一条」变为「接口第一条」，影响面为 0。
  // Array.prototype.sort 自 ES2019 起保证稳定，同优先级因此保持输入顺序。
  return [...(subtitles || [])].sort((a, b) => subtitlePriority(a) - subtitlePriority(b)) as SubtitleTrack[];
}

export function pickPreferredSubtitle(
  subtitles: SubtitleTrack[] | RawSubtitleTrack[] | null | undefined,
  { previousId = "", previousUrl = "", previousLang = "" }: PreferredSubtitleContext = {}
): SubtitleTrack | null {
  const tracks = subtitles || [];
  if (tracks.length === 0) {
    return null;
  }

  // 先按轨道 id 复用，最稳定
  if (previousId) {
    const byId = tracks.find((item) => String(item.id || "") === String(previousId));
    if (byId) {
      return byId as SubtitleTrack;
    }
  }

  // 其次按 URL 路径复用（忽略 auth_key 等动态参数）
  const prevUrlKey = normalizeSubtitleUrlForCache(previousUrl);
  if (prevUrlKey) {
    const byUrl = tracks.find(
      (item) => normalizeSubtitleUrlForCache((item as { subtitleUrl?: string }).subtitleUrl) === prevUrlKey
    );
    if (byUrl) {
      return byUrl as SubtitleTrack;
    }
  }

  const normalizedPrevLang = String(previousLang || "").trim().toLowerCase();
  if (normalizedPrevLang) {
    const byLang = tracks.find((item) => {
      const label = String((item as { lanDoc?: string }).lanDoc || item.lan || "").trim().toLowerCase();
      return label === normalizedPrevLang;
    });
    if (byLang) {
      return byLang as SubtitleTrack;
    }
  }

  // 默认直接拿排序后的第一条：中文优先，其次英文。
  return tracks[0] as SubtitleTrack;
}

// ===== 副字幕语言匹配（bilingual-subtitles 05/06 号票）=====
//
// 真实 `lan` 有两种形态：人工上传的 CC 轨是 BCP-47（`zh-CN` / `en-US`），B站 AI 生成轨
// 是 `ai-` + ISO-639-1 小写码（`ai-en`），本扩展的 ASR 伪轨是 `asr-zh`；而全局偏好
//（settings.secondarySubtitleLang）存的是轨自己的 `lan`，默认值取 BCP-47 的 `en-US`。
//
// `subtitlePrimaryLangTag`：摘掉 `ai-` / `asr-` 前缀后取第一段，两种形态因此可比。
// `findTrackByPreferredLang` 两级匹配：
//   a. **完整 `lan` 精确命中优先**——偏好 `en-US` 时落人工 CC 轨；混源视频（同时有
//      `en-US` 与 `ai-en`）的结果不依赖轨序；
//   b. 精确命中不了再退回主语言子标签——偏好 `en-US` 命中 `ai-en`。
// 只考虑 `subtitleUrl` 非空的真轨：ASR 伪轨是主轨的兜底，不是可对照的第二语言。
// 返回 `null` = 本视频没有可用的目标语言轨，调用方据此留空（不替用户猜）。
export function subtitlePrimaryLangTag(lan: unknown): string {
  return getLangFamily(lan);
}

export function findTrackByPreferredLang<T extends { id?: string; lan?: string; subtitleUrl?: string }>(
  tracks: readonly T[] | null | undefined,
  preference: unknown
): T | null {
  const wanted = String(preference || "")
    .trim()
    .toLowerCase();
  const target = getLangFamily(wanted);
  if (!target) {
    return null;
  }
  const loadable = (tracks || []).filter((track) => isLoadableNativeTrack(track));
  const exactManual = loadable.find(
    (track) =>
      classifySubtitleTrack(track) === "manual-cc" &&
      String(track.lan || "").trim().toLowerCase() === wanted
  );
  if (exactManual) {
    return exactManual;
  }
  const exactAny = loadable.find((track) => String(track.lan || "").trim().toLowerCase() === wanted);
  if (exactAny) {
    return exactAny;
  }
  const familyManual = loadable.find(
    (track) => classifySubtitleTrack(track) === "manual-cc" && getLangFamily(track.lan) === target
  );
  if (familyManual) {
    return familyManual;
  }
  return loadable.find((track) => getLangFamily(track.lan) === target) || null;
}

// 主轨判据（两侧 id 都非空才可能同轨）：任一侧为空串都不算——未选轨（主列哨兵）与
// 缺 id 的轨都不该被误判成「主副同轨」，那会把副列推进空态。
export function isMainSubtitleTrack(track: { id?: string } | null | undefined, mainTrackId: unknown): boolean {
  const id = String(track?.id || "");
  return !!id && id === String(mainTrackId || "");
}

// 副字幕的目标轨 = 语言两级命中 + 排除主轨本身 + 排除与主轨同一语种族的轨（严禁将
// 同属 "zh" 族的 zh-Hans 与 zh-Hant 或 zh-CN 与 ai-zh 自动配成假双语）。
export function findSecondaryTrackByPreferredLang<T extends { id?: string; lan?: string; subtitleUrl?: string }>(
  tracks: readonly T[] | null | undefined,
  preference: unknown,
  mainTrackId: unknown
): T | null {
  const track = findTrackByPreferredLang(tracks, preference);
  if (!track || isMainSubtitleTrack(track, mainTrackId)) {
    return null;
  }
  const mainIdStr = String(mainTrackId || "");
  const mainTrack = mainIdStr
    ? (tracks || []).find((item) => String(item?.id || "") === mainIdStr) ?? null
    : null;
  if (mainTrack && isSameLangFamily(track.lan, mainTrack.lan)) {
    return null;
  }
  return track;
}

// 候选10 批1：写入端统一保证 subtitleBody 按 from 升序（稳定排序，同 from
// 保持原有相对顺序，与读路径旧线性扫描的命中顺序一致）。core.js 的
// findActiveSubtitleIndex 二分查找依赖该不变量；读路径一律不排序。
// 唯一写入点为字幕接受事务（subtitle/commit.js acceptSubtitle）；缓存写入前
// 的调用方预备排序（fetcher 网络路径落缓存）是仅有的例外。
// 返回新数组，不原地修改入参（调用方持有的原引用保持不变）。
export function sortSubtitleBodyByFrom<T>(body: T[] | null | undefined): T[] | null | undefined {
  if (!Array.isArray(body)) {
    return body;
  }
  return [...body].sort(
    (a, b) => (Number((a as { from?: unknown }).from || 0) || 0) - (Number((b as { from?: unknown }).from || 0) || 0)
  );
}
