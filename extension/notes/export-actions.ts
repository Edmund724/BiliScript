import { state } from "../core/state.js";
import { getSettings } from "../core/runtime.js";
import { getReaderOverviewSource } from "../reader/live-overview-source.js";
import { getActiveReaderDocument, getActiveReaderWindow } from "../shared/active-host.js";
import { writeActiveClipboardText } from "../shared/cross-doc.js";
import { createSecondaryLineResolver } from "../subtitle/alignment.js";
import { sanitizeFileName } from "../shared/string-utils.js";
import type { SiteId } from "../shared/site.js";
import { formatLocalDate } from "../shared/utils.js";
import { logWarn } from "../shared/logging.js";
import { loadVideoHighlights, resolveHighlightVideoKey } from "./highlights-store.js";
import {
  buildNoteTemplateVariables,
  buildObsidianUri,
  renderNoteTemplate
} from "./template.js";

export interface RenderedCurrentNote {
  markdown: string;
  fileName: string;
  title: string;
  bvid: string;
  videoId: string;
  site: SiteId;
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

export async function renderCurrentVideoNote(): Promise<RenderedCurrentNote> {
  const settings = await getSettings();
  state.setSettings(settings);

  const clip = state.clip;
  const pageUrl = cleanVideoPageUrl(
    clip.currentUrl || (typeof location !== "undefined" ? location.href : "")
  );
  const videoKey = resolveHighlightVideoKey(clip.bvid, pageUrl, clip.site);
  const highlights = await loadVideoHighlights(videoKey);
  const overviewSnapshot = getReaderOverviewSource();
  const analysis = overviewSnapshot?.analysis ?? null;

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
    highlights
  });

  const markdown = renderNoteTemplate(settings.noteExportTemplate, variables);
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
    vault: String(settings.obsidianVaultName || "").trim(),
    folder: String(settings.obsidianFolder || "").trim()
  };
}

export async function copyCurrentVideoNote(): Promise<boolean> {
  try {
    const rendered = await renderCurrentVideoNote();
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

export async function downloadCurrentVideoNote(): Promise<boolean> {
  try {
    const rendered = await renderCurrentVideoNote();
    if (!rendered.markdown) {
      return false;
    }
    const activeDoc = getActiveReaderDocument();
    const activeWin = getActiveReaderWindow() as Window & {
      URL?: typeof URL;
      Blob?: typeof Blob;
    };
    const BlobCtor = activeWin?.Blob ?? Blob;
    const urlApi =
      activeWin?.URL && typeof activeWin.URL.createObjectURL === "function" ? activeWin.URL : URL;
    const blob = new BlobCtor([rendered.markdown], { type: "text/markdown;charset=utf-8" });
    const url = urlApi.createObjectURL(blob);
    const a = activeDoc.createElement("a");
    a.href = url;
    a.download = rendered.fileName;
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

export async function openCurrentVideoInObsidian(): Promise<OpenObsidianResult> {
  try {
    const rendered = await renderCurrentVideoNote();
    if (!rendered.markdown) {
      return { ok: false, usedClipboardFallback: false, error: "当前视频暂无可导出的笔记内容" };
    }
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
  } catch (error) {
    logWarn("[BILISCRIPT] open obsidian uri failed", error);
    return {
      ok: false,
      usedClipboardFallback: false,
      error: (error as Error)?.message || "唤起 Obsidian 失败"
    };
  }
}
