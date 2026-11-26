import { state } from "../core/state.js";
import type { KnownSettings, NoteExportTarget } from "../core/defaults.js";
import { getSettings } from "../core/runtime.js";
import { getReaderOverviewSource } from "../reader/live-overview-source.js";
import { getActiveReaderDocument, getActiveReaderWindow } from "../shared/active-host.js";
import { writeActiveClipboardText } from "../shared/cross-doc.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { createSecondaryLineResolver } from "../subtitle/alignment.js";
import { sanitizeFileName } from "../shared/string-utils.js";
import type { SiteId } from "../shared/site.js";
import { formatLocalDate } from "../shared/utils.js";
import { logWarn } from "../shared/logging.js";
import { stripThinkBlocks } from "../ui/markdown.js";
import { loadVideoHighlights, resolveHighlightVideoKey } from "./highlights-store.js";
import {
  resolveNoteKeyframes,
  type NoteKeyframeCandidate,
  type NoteKeyframeResolveContext,
  type ResolveNoteKeyframesFn
} from "./keyframes.js";
import { getLatestCapturedFrames } from "./turn-frame-cache.js";
import {
  buildNoteTemplateVariables,
  buildObsidianUri,
  linkifyNoteTimestamps,
  renderNoteTemplate
} from "./template.js";

export type {
  NoteKeyframeCandidate,
  NoteKeyframeResolveContext,
  ResolveNoteKeyframesFn
} from "./keyframes.js";

export interface RenderCurrentVideoNoteOptions {
  aiNoteMarkdown?: string;
  resolveKeyframes?: ResolveNoteKeyframesFn;
  capturedFrames?: readonly NoteKeyframeCandidate[];
  linkifyTimestamps?: boolean;
}

export interface RenderedCurrentNote {
  markdown: string;
  fileName: string;
  title: string;
  bvid: string;
  videoId: string;
  site: SiteId;
  pageUrl: string;
  vault: string;
  folder: string;
}

function cleanVideoPageUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.searchParams.delete("biliscript_reader");
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

async function renderCurrentVideoNoteWithSettings(
  settings: KnownSettings,
  options?: RenderCurrentVideoNoteOptions
): Promise<RenderedCurrentNote> {
  const clip = state.clip;
  const pageUrl = cleanVideoPageUrl(
    clip.currentUrl || (typeof location !== "undefined" ? location.href : "")
  );
  const videoKey = resolveHighlightVideoKey(clip.bvid, pageUrl, clip.site);
  const highlights = await loadVideoHighlights(videoKey);
  const overviewSnapshot = getReaderOverviewSource();
  const analysis = overviewSnapshot?.analysis ?? null;
  const cleanedAiNote =
    options?.aiNoteMarkdown !== undefined ? stripThinkBlocks(options.aiNoteMarkdown) : "";

  const variables = buildNoteTemplateVariables({
    meta: {
      site: clip.site,
      title: clip.title,
      bvid: clip.bvid,
      author: clip.author,
      url: pageUrl,
      uploadDate: clip.uploadDate,
      description: clip.description,
      videoDuration: clip.videoDuration,
      chapters: clip.chapters
    },
    body: clip.subtitleBody,
    settings,
    secondaryFor: createSecondaryLineResolver(),
    overview: analysis
      ? {
          summary: analysis.summary,
          chapters: analysis.chapters,
          quotes: analysis.quotes
        }
      : null,
    highlights,
    aiNote: cleanedAiNote
  });

  let markdown = renderNoteTemplate(settings.noteExportTemplate, variables);
  if (markdown && typeof options?.resolveKeyframes === "function") {
    markdown = await options.resolveKeyframes(markdown, {
      site: variables.site,
      bvid: variables.bvid,
      videoId: variables.videoId,
      cid: clip.cid,
      pageUrl,
      includeKeyframes: Boolean(settings.noteIncludeKeyframes),
      capturedFrames: options.capturedFrames
    });
  }
  if (markdown && options?.linkifyTimestamps) {
    markdown = linkifyNoteTimestamps(markdown, {
      site: variables.site,
      pageUrl,
      bvid: variables.bvid,
      videoId: variables.videoId
    });
  }

  const safeTitle = sanitizeFileName(variables.title || variables.videoId || variables.bvid || "video-note");
  const dateRaw = settings.includeDateInFilename ? clip.uploadDate || formatLocalDate() : "";
  const datePrefix = dateRaw ? `${sanitizeFileName(dateRaw)}-` : "";
  const fileName = `${datePrefix}${safeTitle}.md`;

  return {
    markdown,
    fileName,
    title: variables.title,
    bvid: variables.bvid,
    videoId: variables.videoId,
    site: variables.site,
    pageUrl,
    vault: String(settings.obsidianVaultName || "").trim(),
    folder: String(settings.obsidianFolder || "").trim()
  };
}

export async function renderCurrentVideoNote(
  options?: RenderCurrentVideoNoteOptions
): Promise<RenderedCurrentNote> {
  const settings = await getSettings();
  state.setSettings(settings);
  return renderCurrentVideoNoteWithSettings(settings, options);
}

export async function copyCurrentVideoNote(
  options?: RenderCurrentVideoNoteOptions
): Promise<boolean> {
  try {
    const rendered = await renderCurrentVideoNote(options);
    if (!rendered.markdown) {
      return false;
    }
    await writeActiveClipboardText(rendered.markdown);
    return true;
  } catch (error) {
    logWarn("[BILISCRIPT] copy templated note failed", error);
    return false;
  }
}

function triggerActiveBlobDownload(markdown: string, fileName: string): void {
  const activeDoc = getActiveReaderDocument();
  const activeWin = getActiveReaderWindow() as Window & {
    URL?: typeof URL;
    Blob?: typeof Blob;
  };
  const BlobCtor = activeWin?.Blob ?? Blob;
  const urlApi =
    activeWin?.URL && typeof activeWin.URL.createObjectURL === "function" ? activeWin.URL : URL;
  const blob = new BlobCtor([markdown], { type: "text/markdown;charset=utf-8" });
  const url = urlApi.createObjectURL(blob);
  const a = activeDoc.createElement("a");
  a.href = url;
  a.download = fileName;
  (activeDoc.body ?? activeDoc.documentElement)?.appendChild(a);
  try {
    a.click();
    a.remove();
  } finally {
    try {
      urlApi.revokeObjectURL(url);
    } catch {
    }
  }
}

export async function downloadCurrentVideoNote(
  options?: RenderCurrentVideoNoteOptions
): Promise<boolean> {
  try {
    const rendered = await renderCurrentVideoNote(options);
    if (!rendered.markdown) {
      return false;
    }
    triggerActiveBlobDownload(rendered.markdown, rendered.fileName);
    return true;
  } catch (error) {
    logWarn("[BILISCRIPT] download templated note failed", error);
    return false;
  }
}

export interface OpenObsidianResult {
  ok: boolean;
  usedClipboardFallback: boolean;
  uri?: string;
  error?: string;
}

function triggerProtocolUri(uri: string): void {
  const activeDoc = getActiveReaderDocument();
  const link = activeDoc.createElement("a");
  link.href = uri;
  link.rel = "noopener noreferrer";
  link.style.display = "none";
  (activeDoc.body ?? activeDoc.documentElement)?.appendChild(link);
  link.click();
  link.remove();
}

async function triggerObsidianExport(rendered: RenderedCurrentNote): Promise<OpenObsidianResult> {
  const { uri, usedClipboardFallback } = buildObsidianUri({
    vault: rendered.vault,
    folder: rendered.folder,
    fileName: rendered.fileName,
    content: rendered.markdown
  });
  if (usedClipboardFallback) {
    try {
      await writeActiveClipboardText(rendered.markdown);
    } catch (clipError) {
      logWarn("[BILISCRIPT] obsidian clipboard fallback copy failed", clipError);
      return {
        ok: false,
        usedClipboardFallback: true,
        error: "笔记较长需经剪贴板写入 Obsidian，但剪贴板权限被拒绝"
      };
    }
  }
  triggerProtocolUri(uri);
  return { ok: true, usedClipboardFallback, uri };
}

export async function openCurrentVideoInObsidian(
  options?: RenderCurrentVideoNoteOptions
): Promise<OpenObsidianResult> {
  try {
    const rendered = await renderCurrentVideoNote(options);
    if (!rendered.markdown) {
      return { ok: false, usedClipboardFallback: false, error: "当前视频暂无可导出的笔记内容" };
    }
    return await triggerObsidianExport(rendered);
  } catch (error) {
    logWarn("[BILISCRIPT] open obsidian uri failed", error);
    return {
      ok: false,
      usedClipboardFallback: false,
      error: (error as Error)?.message || "唤起 Obsidian 失败"
    };
  }
}

export interface DispatchNoteExportOptions {
  target?: NoteExportTarget;
  aiNoteMarkdown?: string;
  autoTrigger?: boolean;
  resolveKeyframes?: ResolveNoteKeyframesFn;
  capturedFrames?: readonly NoteKeyframeCandidate[];
}

export type DispatchNoteExportMethod =
  | "obsidian"
  | "obsidian-clipboard"
  | "background-download"
  | "blob-download";

export interface DispatchNoteExportResult {
  ok: boolean;
  target: NoteExportTarget;
  method?: DispatchNoteExportMethod;
  fileName?: string;
  markdown?: string;
  usedClipboardFallback?: boolean;
  usedBlobFallback?: boolean;
  downloadId?: number;
  uri?: string;
  error?: string;
}

export async function dispatchNoteExport(
  options?: DispatchNoteExportOptions
): Promise<DispatchNoteExportResult> {
  const settings = await getSettings();
  state.setSettings(settings);
  const resolvedTarget = options?.target ?? settings.noteExportTarget;
  const target: NoteExportTarget = resolvedTarget === "obsidian" ? "obsidian" : "download";

  try {
    const rendered = await renderCurrentVideoNoteWithSettings(settings, {
      aiNoteMarkdown: options?.aiNoteMarkdown,
      resolveKeyframes: options?.resolveKeyframes ?? resolveNoteKeyframes,
      capturedFrames: options?.capturedFrames ?? getLatestCapturedFrames(),
      linkifyTimestamps: true
    });
    if (!rendered.markdown) {
      return {
        ok: false,
        target,
        error: "当前视频暂无可导出的笔记内容"
      };
    }

    if (target === "obsidian") {
      const obsidianRes = await triggerObsidianExport(rendered);
      if (!obsidianRes.ok) {
        return {
          ok: false,
          target,
          fileName: rendered.fileName,
          markdown: rendered.markdown,
          usedClipboardFallback: obsidianRes.usedClipboardFallback,
          error: obsidianRes.error
        };
      }
      return {
        ok: true,
        target,
        method: obsidianRes.usedClipboardFallback ? "obsidian-clipboard" : "obsidian",
        fileName: rendered.fileName,
        markdown: rendered.markdown,
        usedClipboardFallback: obsidianRes.usedClipboardFallback,
        uri: obsidianRes.uri
      };
    }

    const subdir = String(settings.noteDownloadSubdir || "").trim();
    const shouldTryBackground = Boolean(subdir) || Boolean(options?.autoTrigger);

    if (shouldTryBackground) {
      let bgError = "";
      let shouldFallbackToBlob = false;
      try {
        const bgRes = await sendRuntimeMessage({
          type: "download-note-artifact",
          markdown: rendered.markdown,
          fileName: rendered.fileName,
          ...(subdir ? { subdir } : {})
        });
        if (bgRes?.ok) {
          return {
            ok: true,
            target,
            method: "background-download",
            fileName: rendered.fileName,
            markdown: rendered.markdown,
            downloadId: bgRes.downloadId
          };
        }
        if (!bgRes || bgRes.fallbackRequired === true) {
          shouldFallbackToBlob = true;
          bgError = bgRes?.error || "";
        } else {
          return {
            ok: false,
            target,
            method: "background-download",
            fileName: rendered.fileName,
            markdown: rendered.markdown,
            error: bgRes.error || "下载失败"
          };
        }
      } catch (error) {
        logWarn("[BILISCRIPT] background download-note-artifact failed, falling back to blob", error);
        shouldFallbackToBlob = true;
        bgError = (error as Error)?.message || "";
      }

      if (shouldFallbackToBlob) {
        try {
          triggerActiveBlobDownload(rendered.markdown, rendered.fileName);
          return {
            ok: true,
            target,
            method: "blob-download",
            fileName: rendered.fileName,
            markdown: rendered.markdown,
            usedBlobFallback: true
          };
        } catch (blobError) {
          logWarn("[BILISCRIPT] blob fallback download failed", blobError);
          return {
            ok: false,
            target,
            fileName: rendered.fileName,
            markdown: rendered.markdown,
            usedBlobFallback: true,
            error: (blobError as Error)?.message || bgError || "导出笔记下载失败"
          };
        }
      }
    }

    triggerActiveBlobDownload(rendered.markdown, rendered.fileName);
    return {
      ok: true,
      target,
      method: "blob-download",
      fileName: rendered.fileName,
      markdown: rendered.markdown,
      usedBlobFallback: false
    };
  } catch (error) {
    logWarn("[BILISCRIPT] dispatchNoteExport failed", error);
    return {
      ok: false,
      target,
      error: (error as Error)?.message || "导出笔记失败"
    };
  }
}
