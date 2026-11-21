import { classifySubtitleTrack, subtitlePrimaryLangTag } from "./selection.js";

export const BILI_AI_TRACK_SUFFIX = "（B 站 AI）";

export const ASR_SUBTITLE_SOURCE = "自配平台转写";

export function buildAsrSubtitleLabel(language: unknown): string {
  const lang = String(language ?? "").trim().toLowerCase();
  const doc = lang === "zh" ? "中文" : lang === "en" ? "英文" : "";
  return doc ? `${ASR_SUBTITLE_SOURCE}（${doc}）` : ASR_SUBTITLE_SOURCE;
}

export function resolveSubtitleTrackLabel(track: { lan?: string; lanDoc?: string } | null | undefined): string {
  const lanDoc = String(track?.lanDoc ?? "").trim();
  return lanDoc || String(track?.lan ?? "").trim();
}

export function shouldMarkAiSubtitleTracks(
  tracks: Array<{ id?: string; lan?: string; subtitleUrl?: string } | null | undefined> | null | undefined
): boolean {
  let hasAi = false;
  let hasOther = false;
  for (const track of tracks || []) {
    if (classifySubtitleTrack(track) === "bili-ai") {
      hasAi = true;
    } else {
      hasOther = true;
    }
    if (hasAi && hasOther) {
      return true;
    }
  }
  return false;
}

export function formatSubtitleTrackOptionLabel(
  track: { id?: string; lan?: string; lanDoc?: string; subtitleUrl?: string } | null | undefined,
  marked: boolean
): string {
  const label = resolveSubtitleTrackLabel(track);
  return marked && classifySubtitleTrack(track) === "bili-ai"
    ? `${label}${BILI_AI_TRACK_SUFFIX}`
    : label;
}

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
  return Object.prototype.hasOwnProperty.call(SUBTITLE_LANG_NAMES, tag) ? SUBTITLE_LANG_NAMES[tag] : raw;
}
