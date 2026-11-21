import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const STATIC_EDGE_RE = /(?:^|\n)[ \t]*(?:import|export)\s+([^;]*?)\s+from\s*["'](\.[^"']+)["']/g;
const BLOCK_COMMENT_RE = /^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm;
const TYPE_ONLY_CLAUSE_RE = /^\s*type\b|^\{\s*type\s/;

export function walkExtensionFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "chunks" || name === "icons") continue;
      walkExtensionFiles(full, out);
      continue;
    }
    if (/\.(ts|js)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

export function staticImportersOf(fragment: string): string[] {
  const importers = new Set<string>();
  for (const file of walkExtensionFiles("extension")) {
    const source = readFileSync(file, "utf8").replace(BLOCK_COMMENT_RE, "");
    for (const match of source.matchAll(STATIC_EDGE_RE)) {
      if (match[2].includes(fragment) && !TYPE_ONLY_CLAUSE_RE.test(match[1])) {
        importers.add(relative("extension", file).split(sep).join("/"));
      }
    }
  }
  return [...importers].sort();
}
