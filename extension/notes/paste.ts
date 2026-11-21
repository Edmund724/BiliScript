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
