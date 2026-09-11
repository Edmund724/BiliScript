// paste.ts — "assistant answer as note section" paste normalization, extracted
// out of extension/pages/sidepanel.js (ticket 06 of sidepanel-split).
//
// Domain: notes (same dir as render.js). Pure: no DOM/chrome access, no
// sidepanel module-level state.
//
// Exported functions:
//   - normalizeMarkdownForSectionPaste(raw, baseLevel=2)  pure; re-levels markdown
//     headings for a note section and unwraps timestamp-only inline code
//
// Dependency: unwrapTimestampInlineCode lives in extension/ui/timestamp-nav.js
// (ticket 04); it is imported below.
import { unwrapTimestampInlineCode } from "../ui/timestamp-nav.js";

export function normalizeMarkdownForSectionPaste(raw: unknown, baseLevel: number = 2): string {
  const shift = Math.max(0, Number(baseLevel) || 0);
  const lines = String(raw || "").split("\n");
  const normalized: string[] = [];
  let inFence = false;

  lines.forEach((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      normalized.push(line);
      return;
    }

    if (inFence) {
      normalized.push(line);
      return;
    }

    const pasteLine = unwrapTimestampInlineCode(line);
    // ATX headings 1-6 (same ceiling as ui/markdown.js); the shifted level is
    // clamped to 6 so a deep heading never overflows into 7+ hashes, which
    // markdown would render as literal text instead of a heading.
    const headingMatch = pasteLine.match(/^(\s*)(#{1,6})(\s+.*)$/);
    if (!headingMatch) {
      normalized.push(pasteLine);
      return;
    }

    const [, indent, hashes, suffix] = headingMatch;
    const level = Math.min(hashes.length + shift, 6);
    normalized.push(`${indent}${"#".repeat(level)}${suffix}`);
  });

  return normalized.join("\n");
}
