import { buildTxt, buildVtt } from "../notes/render.js";
import { getActiveReaderDocument, getActiveReaderWindow } from "../shared/active-host.js";
import { writeActiveClipboardText } from "../shared/cross-doc.js";
import { sanitizeFileName } from "../shared/string-utils.js";
import { formatLocalDate } from "../shared/utils.js";
import { getSettings } from "../core/runtime.js";
import { logWarn } from "../shared/logging.js";
import { clipState, state } from "../core/state.js";
import { normalizeDownloadFormat } from "../core/validators.js";
import { ensureDerivedContent } from "./core.js";
import { createSecondaryLineResolver } from "./alignment.js";

export async function copySubtitleTranscript(): Promise<boolean> {
  state.setSettings(await getSettings());
  const text = buildTxt(state.clip.subtitleBody, state.settings, createSecondaryLineResolver());
  if (!text) {
    return false;
  }

  try {
    await writeActiveClipboardText(text);
    return true;
  } catch (error) {
    logWarn("[BILISCRIPT] copy subtitle transcript failed", error);
    return false;
  }
}

export async function downloadSubtitle(options?: { format?: string }): Promise<boolean> {
  state.setSettings(await getSettings());
  ensureDerivedContent();
  const format = normalizeDownloadFormat(options?.format ?? state.settings?.downloadFormat);
  let content = "";
  let fileExt = format;
  let langSuffixRaw = state.clip.selectedSubtitleLang || "subtitle";

  if (format === "txt") {
    content = state.clip.txt;
  } else if (format === "vtt") {
    content = buildVtt(state.clip.subtitleBody, createSecondaryLineResolver(), state.settings);
  } else if (format === "vtt-secondary") {
    fileExt = "vtt";
    const sec = clipState.secondarySubtitle;
    if (sec.state === "ready" && Array.isArray(sec.body) && sec.body.length > 0) {
      content = buildVtt(sec.body);
      langSuffixRaw = sec.id || "secondary";
    }
  } else {
    content = state.clip.srt;
  }

  if (!content) {
    return false;
  }

  const fallbackName = state.clip.site === "youtube" ? "youtube-subtitle" : "bilibili-subtitle";
  const safeTitle = sanitizeFileName(state.clip.title || state.clip.bvid || fallbackName);
  const langSuffix = sanitizeFileName(langSuffixRaw) || "subtitle";
  const dateRaw = state.settings?.includeDateInFilename ? state.clip.uploadDate || formatLocalDate() : "";
  const datePrefix = dateRaw ? `${sanitizeFileName(dateRaw)}-` : "";
  const filename = `${datePrefix}${safeTitle}.${langSuffix}.${fileExt}`;
  const activeDoc = getActiveReaderDocument();
  const activeWin = getActiveReaderWindow() as Window & {
    URL?: typeof URL;
    Blob?: typeof Blob;
  };
  const BlobCtor = activeWin?.Blob ?? Blob;
  const urlApi =
    activeWin?.URL && typeof activeWin.URL.createObjectURL === "function" ? activeWin.URL : URL;
  const blob = new BlobCtor([content], { type: "text/plain;charset=utf-8" });
  const url = urlApi.createObjectURL(blob);

  const a = activeDoc.createElement("a");
  a.href = url;
  a.download = filename;
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
}

