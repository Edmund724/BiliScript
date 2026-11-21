import { buildTxt, buildVtt } from "../notes/render.js";
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
    await navigator.clipboard.writeText(text);
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

  const safeTitle = sanitizeFileName(state.clip.title || state.clip.bvid || "bilibili-subtitle");
  const langSuffix = sanitizeFileName(langSuffixRaw) || "subtitle";
  const dateRaw = state.settings?.includeDateInFilename ? state.clip.uploadDate || formatLocalDate() : "";
  const datePrefix = dateRaw ? `${sanitizeFileName(dateRaw)}-` : "";
  const filename = `${datePrefix}${safeTitle}.${langSuffix}.${fileExt}`;
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  return true;
}

