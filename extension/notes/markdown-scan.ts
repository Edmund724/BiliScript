const FENCE_OPEN_RE = /^[ ]{0,3}(`{3,}|~{3,})/;

export function findFrontmatterEndLine(lines: readonly string[]): number {
  if (lines.length < 3 || lines[0].trim() !== "---") {
    return -1;
  }
  for (let i = 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === "---" || trimmed === "...") {
      return i;
    }
  }
  return -1;
}

export function scanMarkdownBodyLines(
  lines: readonly string[],
  visitor: (line: string, index: number, inBody: boolean) => void
): void {
  const frontmatterEnd = findFrontmatterEndLine(lines);
  let activeFenceChar = "";
  let activeFenceLength = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (frontmatterEnd !== -1 && index <= frontmatterEnd) {
      visitor(line, index, false);
      continue;
    }

    if (activeFenceChar) {
      const closeMatch = line.match(FENCE_OPEN_RE);
      if (
        closeMatch &&
        closeMatch[1][0] === activeFenceChar &&
        closeMatch[1].length >= activeFenceLength &&
        line.slice(closeMatch[0].length).trim() === ""
      ) {
        activeFenceChar = "";
        activeFenceLength = 0;
      }
      visitor(line, index, false);
      continue;
    }

    const openMatch = line.match(FENCE_OPEN_RE);
    if (openMatch) {
      activeFenceChar = openMatch[1][0];
      activeFenceLength = openMatch[1].length;
      visitor(line, index, false);
      continue;
    }

    visitor(line, index, true);
  }
}
