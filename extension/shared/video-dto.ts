import type { SiteId } from "./site.js";

export type SubtitleFetchState = "idle" | "loading" | "ready" | "error" | "empty";

export type NoSubtitleReason =
  | null
  | "upower-exclusive"
  | "bili-login-required"
  | "youtube-no-subtitles"
  | "youtube-captions-unavailable"
  | "no-asr-config"
  | "asr-disabled"
  | "asr-auth"
  | "asr-quota"
  | "asr-ratelimit"
  | "asr-network"
  | "asr-media"
  | "asr-server"
  | "asr-unknown"
  | "asr-empty";

export type SubtitleTrackOrigin = "bilibili" | "youtube" | "asr";

export interface SubtitleTrack {
  id: string;
  lan: string;
  lanDoc?: string;
  subtitleUrl: string;
  source?: string;
  origin?: SubtitleTrackOrigin;
  kind?: string;
  site?: SiteId;
}

export type SubtitleOption = SubtitleTrack;

export interface SubtitleWord {
  word?: string;
  text?: string;
  start?: number;
  end?: number;
  startMs?: number;
  endMs?: number;
}

export interface SubtitleBodyItem {
  from: number;
  to: number;
  content: string;
  words?: SubtitleWord[];
}

export interface ChapterItem {
  title: string;
  from: number;
  to?: number;
  source?: string;
}

export interface Chapter extends ChapterItem {
  to: number;
  source: string;
}

export interface HotComment {
  uname: string;
  like: number;
  message: string;
  subMessages?: string[];
}
