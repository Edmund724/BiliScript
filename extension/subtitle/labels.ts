import { classifySubtitleTrack, isPlatformAutoTrack, subtitlePrimaryLangTag, type SubtitleTrackOriginLike } from "./selection.js";

export const BILI_AI_TRACK_SUFFIX = "（B 站 AI）";
export const YOUTUBE_AUTO_TRACK_SUFFIX = "（YouTube 自动）";

export const ASR_SUBTITLE_SOURCE = "自配平台转写";

export function buildAsrSubtitleLabel(language: unknown): string {
  const lang = String(language ?? "").trim().toLowerCase();
  const doc = lang === "zh" ? "中文" : lang === "en" ? "英文" : "";
  return doc ? `${ASR_SUBTITLE_SOURCE}（${doc}）` : ASR_SUBTITLE_SOURCE;
}

function stripYoutubeAutoSuffix(label: string): string {
  const cleaned = label
    .replace(/\s*[（(]\s*(?:auto[- ]?generated|自动生成|自動生成)\s*[）)]\s*$/i, "")
    .trim();
  return cleaned || label;
}

export function resolveSubtitleTrackLabel(
  track: (SubtitleTrackOriginLike & { lanDoc?: string }) | null | undefined
): string {
  const lanDoc = String(track?.lanDoc ?? "").trim();
  const base = lanDoc || String(track?.lan ?? "").trim();
  if (classifySubtitleTrack(track) === "youtube-auto") {
    return stripYoutubeAutoSuffix(base);
  }
  return base;
}

export function shouldMarkAiSubtitleTracks(
  tracks: Array<(SubtitleTrackOriginLike & { lanDoc?: string }) | null | undefined> | null | undefined
): boolean {
  let hasAi = false;
  let hasOther = false;
  for (const track of tracks || []) {
    if (isPlatformAutoTrack(track)) {
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
  track: (SubtitleTrackOriginLike & { lanDoc?: string }) | null | undefined,
  marked: boolean
): string {
  const label = resolveSubtitleTrackLabel(track);
  if (!marked) {
    return label;
  }
  const kind = classifySubtitleTrack(track);
  if (kind === "bili-ai") {
    return `${label}${BILI_AI_TRACK_SUFFIX}`;
  }
  if (kind === "youtube-auto") {
    return `${label}${YOUTUBE_AUTO_TRACK_SUFFIX}`;
  }
  return label;
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
