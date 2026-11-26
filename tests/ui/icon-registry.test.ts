import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderUiIcon, UI_ICON_PATHS, UI_ICON_STROKE_WIDTH, type UiIconName } from "../../extension/ui/icon-registry.js";
import { READING_HEADER_ICONS } from "../../extension/ui/reading-header-icons.js";
import {
  READING_CHECK_ICON,
  READING_CHEVRON_DOWN_ICON,
  READING_CLOSE_ICON,
  READING_COPY_ICON,
  READING_DOWNLOAD_ICON,
  READING_NOTE_DOWNLOAD_ICON,
  READING_NOTE_OBSIDIAN_ICON,
  READING_PLAY_ICON,
  READING_RESET_ICON,
  READING_SHARE_ICON,
  READING_SPEAKER_ICON,
  READING_STOP_ICON
} from "../../extension/ui/reading-icons.js";

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.resolve(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("UI 统一图标注册表 (icon-registry)", () => {
  it("所有注册图标均通过 renderUiIcon 输出统一 24x24 网格与 1.75 线宽", () => {
    const names = Object.keys(UI_ICON_PATHS) as UiIconName[];
    expect(names.length).toBeGreaterThan(25);
    expect(UI_ICON_STROKE_WIDTH).toBe(1.75);

    for (const name of names) {
      const svg = renderUiIcon(name);
      expect(svg).toMatch(/^<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1\.75" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true">/);
      expect(svg).toMatch(/<\/svg>$/);
      expect(UI_ICON_PATHS[name].length).toBeGreaterThan(0);
    }
  });

  it("reading-icons 与 reading-header-icons 均从统一图标注册表派生", () => {
    expect(READING_COPY_ICON).toBe(renderUiIcon("copy"));
    expect(READING_CHECK_ICON).toBe(renderUiIcon("check"));
    expect(READING_DOWNLOAD_ICON).toBe(renderUiIcon("download"));
    expect(READING_PLAY_ICON).toBe(renderUiIcon("play", { fill: "currentColor" }));
    expect(READING_SPEAKER_ICON).toBe(renderUiIcon("speaker"));
    expect(READING_STOP_ICON).toBe(renderUiIcon("stop"));
    expect(READING_RESET_ICON).toBe(renderUiIcon("reset"));
    expect(READING_SHARE_ICON).toBe(renderUiIcon("share"));
    expect(READING_CLOSE_ICON).toBe(renderUiIcon("close"));
    expect(READING_CHEVRON_DOWN_ICON).toBe(renderUiIcon("chevronDown"));
    expect(READING_NOTE_DOWNLOAD_ICON).toBe(renderUiIcon("fileDown"));
    expect(READING_NOTE_OBSIDIAN_ICON).toBe(renderUiIcon("bookMarked"));

    expect(READING_HEADER_ICONS.detach).toBe(renderUiIcon("externalLink"));
    expect(READING_HEADER_ICONS.redock).toBe(renderUiIcon("redock"));
    expect(READING_HEADER_ICONS.theme).toBe(renderUiIcon("sun"));
    expect(READING_HEADER_ICONS.themeDark).toBe(renderUiIcon("moon"));
    expect(READING_HEADER_ICONS.settings).toBe(renderUiIcon("settings"));
    expect(READING_HEADER_ICONS.close).toBe(renderUiIcon("close"));
    expect(READING_HEADER_ICONS.back).toBe(renderUiIcon("arrowLeft"));
  });

  it("UI / Reader / Chat / Live 模块除显式豁免外无散落手写 <svg>", () => {
    const root = process.cwd();
    const dirs = ["extension/ui", "extension/reader", "extension/chat", "extension/live"];
    const exemptMaxCounts = new Map<string, number>([
      ["extension/ui/icon-registry.ts", 1],
      ["extension/ui/icons.ts", 6],
      ["extension/reader/chat-suggestions-slot.ts", 1],
      ["extension/reader/chat-template.ts", 2],
      ["extension/reader/quote-share-export.ts", 6]
    ]);

    const violations: string[] = [];
    for (const relDir of dirs) {
      for (const file of collectTsFiles(path.resolve(root, relDir))) {
        const rel = file.slice(root.length + 1).replace(/\\/g, "/");
        const content = fs.readFileSync(file, "utf8");
        const count = (content.match(/<svg\b/g) || []).length;
        const allowed = exemptMaxCounts.get(rel) ?? 0;
        if (count > allowed) {
          violations.push(`${rel}: 发现 ${count} 处 <svg（允许上限 ${allowed}）`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
