// 字幕显示文案叶（架构评审「轨道身份：selection.ts 按概念拆位」，自
// subtitle/selection.ts 逐字搬出，零逻辑改动）：面向用户的文案投影住这一处，
// 选轨 / 匹配口径不在这里（后者留 selection.ts）。
//
// 四支各自的 spec 注释随代码一并搬来：
//   - ASR_SUBTITLE_SOURCE / buildAsrSubtitleLabel：本扩展 ASR 回退伪轨的来源串；
//   - resolveSubtitleTrackLabel / shouldMarkAiSubtitleTracks：阅读面板字幕工具条选轨
//     控件的选项文字与 `[AI]` 标判据；
//   - resolveSubtitleLangLabel：lan → 用户可读语言名（副列「本视频没有 xx 轨」文案）。
//
// 语言名的查表键复用 subtitlePrimaryLangTag（selection.ts 的匹配口径）：能匹配上
// `ai-ja` 的偏好，名字也取同一格——文案与匹配同口径，故本叶 import selection。

import { subtitlePrimaryLangTag } from "./selection.js";

// ===== 来源标签（2026-09 用户决议，2026-10-04 收窄） =====
// 面板 meta 行的「字幕：来源（语言）」投影已按 2026-10-04 用户决议整条删除（不再
// 注明字幕来源）：人工上传 / B站 AI 识别 两支、语言归一与轨道身份判定一并退场，
// 此处只留本扩展 ASR 回退伪轨要用的来源串。平台名不进串：平台归设置页，串只回答
//「这段字幕是怎么来的」。
export const ASR_SUBTITLE_SOURCE = "自配平台转写";

// ASR 伪轨的来源串：生成时定型——语言档位只有发起转写那一刻知道，auto 档不附
// 语言（宁缺勿猜）。同一个串写进伪轨 lanDoc 与 selectedSubtitleLang，下载文件名
// 与 AI 上下文因此自动一致。
export function buildAsrSubtitleLabel(language: unknown): string {
  const lang = String(language ?? "").trim().toLowerCase();
  const doc = lang === "zh" ? "中文" : lang === "en" ? "英文" : "";
  return doc ? `${ASR_SUBTITLE_SOURCE}（${doc}）` : ASR_SUBTITLE_SOURCE;
}

// ===== 选轨控件的标签口径（票 subtitle-track-picker/08） =====
// 唯一消费点是阅读面板字幕工具条的选轨控件（reader/subtitle-tab-ui.ts）。
// 选项文字 = lanDoc 原文：Q5 裁定零处理——B站 AI 轨的 lanDoc 本就是裸语言名
//（本仓样本 8 条实测无「（自动生成）」尾巴，research/01-track-shape.md），
// 旧实现那套「剥机器尾巴」的归一对这批数据是空操作。lanDoc 缺失（空串）时
// 回落 lan，避免列表里出现空白项（接口未给语言名的兜底，不是归一）。
export function resolveSubtitleTrackLabel(track: { lan?: string; lanDoc?: string } | null | undefined): string {
  const lanDoc = String(track?.lanDoc ?? "").trim();
  return lanDoc || String(track?.lan ?? "").trim();
}

// `[AI]` 标只在列表内来源不唯一时显示（Q5′ / 08 号票口径）：仅当列表里同时
// 存在 B站 AI 轨（lan 以 `ai-` 开头）**与非 AI 轨**（含本扩展 ASR 伪轨
// `asr-zh`、人工上传轨）时才需要区分来源。单源列表一律不标——本仓样本 8 条
// 全是 ai-*，旧实现（判据只看单条 lan 前缀）会给出 8 个零信息量的 [AI]。
export function shouldMarkAiSubtitleTracks(
  tracks: Array<{ lan?: string } | null | undefined> | null | undefined
): boolean {
  let hasAi = false;
  let hasOther = false;
  for (const track of tracks || []) {
    if (String(track?.lan || "").toLowerCase().startsWith("ai-")) {
      hasAi = true;
    } else {
      hasOther = true;
    }
    // 两类都见到即判定唯一依据已成立；判据是「同时存在」，不数个数。
    if (hasAi && hasOther) {
      return true;
    }
  }
  return false;
}

// `lan` → 用户可读的语言名（唯一消费点：副列 ②「本视频没有 xx 轨」的文案，2026-10-06
// 用户裁决：这一态里不出现机器码）。偏好里存的是轨自己的 `lan`（`ai-ja` / `ja-JP` /
// `zh-CN`），原样拼进文案就是 `本视频没有 ai-ja 轨`——用户读不出是哪门语言，而同一个副列的
// 语言列表显示的是 B站 `lanDoc`（`日本語`），同一屏两套名字。
// 查表键 = 主语言子标签（复用 subtitlePrimaryLangTag 摘 `ai-`/`asr-` 前缀再取首段），
// 与 findTrackByPreferredLang 的匹配同口径：能匹配上 `ai-ja` 的偏好，名字也取同一格。
// 表只列有据可查的语言：本仓样本的 8 条 ai-* 轨（zh/en/ja/es/ar/pt/th/id）+ ko（B站人工
// CC 的常见档）。未命中回落 `lan` 原文——宁缺勿猜，不替 B站没给的语言编名字。
const SUBTITLE_LANG_NAMES: Record<string, string> = {
  zh: "中文",
  en: "英语",
  ja: "日语",
  ko: "韩语",
  es: "西班牙语",
  pt: "葡萄牙语",
  ar: "阿拉伯语",
  th: "泰语",
  id: "印尼语"
};

export function resolveSubtitleLangLabel(lan: unknown): string {
  const raw = String(lan ?? "").trim();
  const tag = subtitlePrimaryLangTag(raw);
  // 表查键走 hasOwn：`constructor` 之类不是语言码，别从原型链上兜出个函数来。
  return Object.prototype.hasOwnProperty.call(SUBTITLE_LANG_NAMES, tag) ? SUBTITLE_LANG_NAMES[tag] : raw;
}
