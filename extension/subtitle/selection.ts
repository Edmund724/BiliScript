// extension/subtitle/selection.ts
// 「哪条轨被选中」的唯一落点（架构评审「轨道身份：selection.ts 按概念拆位」之后留下的
// 那一个概念）：
//   - 排序优先级（中文 → 英文 → 其余保持接口原顺序）与 previousId / URL / lang 三级
//     复用（normalizeSubtitleTracks / pickPreferredSubtitle）；
//   - 副轨语言两级匹配 + 主轨排除（subtitlePrimaryLangTag / findTrackByPreferredLang /
//     isMainSubtitleTrack / findSecondaryTrackByPreferredLang，口径见 CONTEXT.md「字幕」
//     词条与 ADR-0016）；
//   - subtitleBody 按 from 升序的写入不变量排序（sortSubtitleBodyByFrom；读路径
//     findActiveSubtitleIndex 的二分依赖它）。
// 按概念搬走的邻居（逐字搬迁、零逻辑改动）：原生产物映射与 subtitleUrl 的两套归一 →
// bilibili/native-payload.ts；时长校验 → subtitle/duration-validation.ts；
// 显示文案 → subtitle/labels.ts。

import { normalizeSubtitleUrlForCache, type RawSubtitleTrack } from "../bilibili/native-payload.js";
import type { SubtitleTrack } from "../bilibili/gateway.js";

export interface PreferredSubtitleContext {
  previousId?: string;
  previousUrl?: string;
  previousLang?: string;
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
  return String(lan || "")
    .trim()
    .toLowerCase()
    .replace(/^(ai|asr)-/, "")
    .split("-")[0];
}

export function findTrackByPreferredLang<T extends { lan?: string; subtitleUrl?: string }>(
  tracks: readonly T[] | null | undefined,
  preference: unknown
): T | null {
  const wanted = String(preference || "")
    .trim()
    .toLowerCase();
  const target = subtitlePrimaryLangTag(wanted);
  if (!target) {
    return null;
  }
  const loadable = (tracks || []).filter((track) => String(track.subtitleUrl || "").trim().length > 0);
  return (
    loadable.find((track) => String(track.lan || "").trim().toLowerCase() === wanted) ||
    loadable.find((track) => subtitlePrimaryLangTag(track.lan) === target) ||
    null
  );
}

// 主轨判据（两侧 id 都非空才可能同轨）：任一侧为空串都不算——未选轨（主列哨兵）与
// 缺 id 的轨都不该被误判成「主副同轨」，那会把副列推进空态。
export function isMainSubtitleTrack(track: { id?: string } | null | undefined, mainTrackId: unknown): boolean {
  const id = String(track?.id || "");
  return !!id && id === String(mainTrackId || "");
}

// 副字幕的目标轨 = 上面的语言两级命中 + **排除主轨**（bilingual-subtitles/06 +
// 2026-10-06 图外回访）。命中主轨时返回 null，而**不是**顺位退到同语言的另一条轨：
// 偏好 zh-CN、主轨是人工 zh-CN 时退到 ai-zh 仍是两份中文，用户要的是「没有可对照的
// 第二语言」这个结论。
// 判据必须住在这个共享叶子里：目标轨的装载入口有两条（弹层副列与 reader 生命周期
// 的自动装载），只在一处加，另一处就会把主轨抓进副轨槽 ⇒ 列表出两份一样的正文，
// 而弹层副列同时写着「主副字幕相同」（文案与 state 两说）。
export function findSecondaryTrackByPreferredLang<T extends { id?: string; lan?: string; subtitleUrl?: string }>(
  tracks: readonly T[] | null | undefined,
  preference: unknown,
  mainTrackId: unknown
): T | null {
  const track = findTrackByPreferredLang(tracks, preference);
  if (!track || isMainSubtitleTrack(track, mainTrackId)) {
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
