import type { NoteExportTarget } from "../core/defaults.js";
import { normalizeNoteExportTarget } from "../core/validators.js";
import { READING_NOTE_DOWNLOAD_ICON, READING_NOTE_OBSIDIAN_ICON } from "./reading-icons.js";

export interface NoteExportActionVisual {
  target: NoteExportTarget;
  icon: string;
  label: string;
  successLabel: string;
  failedLabel: string;
}

export function getNoteExportActionVisual(target?: unknown): NoteExportActionVisual {
  const normalized = normalizeNoteExportTarget(target);
  if (normalized === "obsidian") {
    return {
      target: "obsidian",
      icon: READING_NOTE_OBSIDIAN_ICON,
      label: "存入 Obsidian",
      successLabel: "已唤起 Obsidian",
      failedLabel: "写入失败"
    };
  }
  return {
    target: "download",
    icon: READING_NOTE_DOWNLOAD_ICON,
    label: "导出视频笔记（.md）",
    successLabel: "已导出笔记",
    failedLabel: "导出失败"
  };
}

export function syncNoteExportIconButton(
  button: HTMLElement | null | undefined,
  target?: unknown
): NoteExportActionVisual {
  const visual = getNoteExportActionVisual(target);
  if (!button) {
    return visual;
  }
  button.dataset.noteTarget = visual.target;
  if (!button.classList.contains("is-copied") && !button.classList.contains("is-copy-failed")) {
    button.setAttribute("aria-label", visual.label);
    button.setAttribute("title", visual.label);
    button.innerHTML = visual.icon.trim();
  }
  return visual;
}
