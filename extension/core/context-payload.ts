import type {
  ClipState,
  ChapterItem,
  HotComment,
  NoSubtitleReason,
  SubtitleBodyItem,
  SubtitleFetchState,
  SubtitleOption
} from "./state.js";
import type { Settings } from "./defaults.js";

export type ReaderContextPayload = {
  url: string | undefined;
  title: string;
  author: string;
  uploadDate: string;
  bvid: string;
  cid: string;
  aid: string;
  pageIndex: number;
  pageCount: number;
  pageTitle: string;
  subtitleBody: SubtitleBodyItem[];
  videoDuration: number;
  includeTimestampInBody: boolean;
  subtitleFetchState: SubtitleFetchState;
  noSubtitleReason: NoSubtitleReason;
  subtitleLang: string;
  selectedSubtitleId: string;
  selectedSubtitleUrl: string;
  subtitleOptions: SubtitleOption[];
  chapters: ChapterItem[];
  hotComments: HotComment[];
};

export const READER_CONTEXT_PAYLOAD_FIELDS: readonly (keyof ReaderContextPayload)[] = Object.freeze([
  "url",
  "title",
  "author",
  "uploadDate",
  "bvid",
  "cid",
  "aid",
  "pageIndex",
  "pageCount",
  "pageTitle",
  "subtitleBody",
  "videoDuration",
  "includeTimestampInBody",
  "subtitleFetchState",
  "noSubtitleReason",
  "subtitleLang",
  "selectedSubtitleId",
  "selectedSubtitleUrl",
  "subtitleOptions",
  "chapters",
  "hotComments"
]);

export function createReaderContextPayload({
  clip,
  settings,
  url
}: {
  clip?: Partial<ClipState>;
  settings?: Partial<Settings>;
  url?: string;
} = {}): ReaderContextPayload {
  const c = clip || {};
  const body = c.subtitleBody || [];
  const payload: ReaderContextPayload = {
    url,
    title: c.title || "",
    author: c.author || "",
    uploadDate: c.uploadDate || "",
    bvid: c.bvid || "",
    cid: c.cid || "",
    aid: c.aid || "",
    pageIndex: Number(c.pageIndex) > 0 ? Number(c.pageIndex) : 1,
    pageCount: Number(c.pageCount) > 0 ? Number(c.pageCount) : 0,
    pageTitle: c.pageTitle || "",
    subtitleBody: body,
    videoDuration: Number(c.videoDuration || 0) || 0,
    includeTimestampInBody: settings?.includeTimestampInBody !== false,
    subtitleFetchState: c.subtitleFetchState || "idle",
    noSubtitleReason: c.noSubtitleReason || null,
    subtitleLang: c.selectedSubtitleLang || "",
    selectedSubtitleId: c.selectedSubtitleId || "",
    selectedSubtitleUrl: c.selectedSubtitleUrl || "",
    subtitleOptions: c.subtitles || [],
    chapters: Array.isArray(c.chapters) ? c.chapters : [],
    hotComments: []
  };
  return payload;
}

export interface FetchedContextFacts {
  bvid: string;
  cid: string;
  aid: string;
  title: string;
  author: string;
  uploadDate: string;
  url: string | undefined;
  pageIndex: number;
  pageCount: number;
  pageTitle: string;
  duration: number;
  subtitleBody: SubtitleBodyItem[];
  selectedSubtitleId: string;
  selectedSubtitleUrl: string;
  subtitleLang: string;
  subtitleOptions: SubtitleOption[];
  chapters: ChapterItem[];
  settings?: Partial<Settings>;
}

export function createFetchedContextPayload({
  bvid,
  cid,
  aid,
  title,
  author,
  uploadDate,
  url,
  pageIndex,
  pageCount,
  pageTitle,
  duration,
  subtitleBody,
  selectedSubtitleId,
  selectedSubtitleUrl,
  subtitleLang,
  subtitleOptions,
  chapters,
  settings
}: FetchedContextFacts): ReaderContextPayload {
  const body = Array.isArray(subtitleBody) ? subtitleBody : [];
  const merged: Partial<ClipState> = {
    title,
    author,
    uploadDate,
    bvid,
    cid,
    aid,
    pageIndex,
    pageCount,
    pageTitle,
    videoDuration: duration,
    subtitleBody: body,
    subtitleFetchState: body.length > 0 ? "ready" : "idle",
    noSubtitleReason: null,
    selectedSubtitleLang: subtitleLang,
    selectedSubtitleId,
    selectedSubtitleUrl,
    subtitles: subtitleOptions,
    chapters
  };
  return createReaderContextPayload({ clip: merged, settings, url });
}

type SignatureProjection = readonly [keyof ReaderContextPayload | "cid", (s: Partial<ReaderContextPayload>) => string | number];

const SIGNATURE_FIELD_PROJECTIONS: readonly SignatureProjection[] = Object.freeze([
  ["bvid", (s: Partial<ReaderContextPayload>) => String(s.bvid || "").trim()],
  ["cid", (s: Partial<ReaderContextPayload>) => String(s.cid || "").trim() || String(s.aid || "").trim()],
  ["pageIndex", (s: Partial<ReaderContextPayload>) => (Number(s.pageIndex) > 0 ? Number(s.pageIndex) : 1)],
  ["subtitleFetchState", (s: Partial<ReaderContextPayload>) => String(s.subtitleFetchState || "idle")],
  ["subtitleBody", (s: Partial<ReaderContextPayload>) => (Array.isArray(s.subtitleBody) ? s.subtitleBody : []).length],
  ["selectedSubtitleId", (s: Partial<ReaderContextPayload>) => String(s.selectedSubtitleId || "").trim()],
  ["subtitleOptions", (s: Partial<ReaderContextPayload>) => (Array.isArray(s.subtitleOptions) ? s.subtitleOptions : []).length],
  ["chapters", (s: Partial<ReaderContextPayload>) => (Array.isArray(s.chapters) ? s.chapters : []).length],
  ["includeTimestampInBody", (s: Partial<ReaderContextPayload>) => (s.includeTimestampInBody !== false ? "1" : "0")],
  ["subtitleLang", (s: Partial<ReaderContextPayload>) => String(s.subtitleLang || "").trim()]
]);

export const SIGNATURE_PARTICIPATING_FIELDS: readonly string[] = Object.freeze(
  SIGNATURE_FIELD_PROJECTIONS.map(([name]) => name as string)
);

export const SIGNATURE_INDIRECT_FIELDS: readonly string[] = Object.freeze(["aid"]);

export const SIGNATURE_EXCLUDED_FIELDS: readonly string[] = Object.freeze([
  "hotComments",
  "url",
  "title",
  "author",
  "uploadDate",
  "pageCount",
  "pageTitle",
  "videoDuration",
  "selectedSubtitleUrl",
  "noSubtitleReason"
]);

export function computeContextStateSignature(snapshot: Partial<ReaderContextPayload>): string {
  return SIGNATURE_FIELD_PROJECTIONS.map(([, project]) => String(project(snapshot))).join("|");
}
