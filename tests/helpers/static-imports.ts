// 静态边扫描的单源：读 extension/ 源码里的相对 import / export-from 边。
//
// 口径（model-catalog 与 preset-registration-view 两份用例原先各持一份逐字相同的实现）：
//   - 掐掉「整行块注释」：行内出现的 `/*`（如 `adapters/*`）不算注释起点，否则会把
//     后面的真 import 一起吞掉；
//   - 跳过纯类型引入（`import type ...` 与 `{ type X }`）；
//   - import 与 export-from 都算边；路径口径 = 相对 extension/（posix 斜杠）。
//
// 构建产物目录（chunks）与图标目录（icons）不参与静态边扫描——两者都不含扩展源码。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const STATIC_EDGE_RE = /(?:^|\n)[ \t]*(?:import|export)\s+([^;]*?)\s+from\s*["'](\.[^"']+)["']/g;
const BLOCK_COMMENT_RE = /^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm;
const TYPE_ONLY_CLAUSE_RE = /^\s*type\b|^\{\s*type\s/;

// 源码文件清单（.ts / .js，排除 .d.ts）：入参是相对仓库根的目录（如 "extension"）。
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

// 「哪些文件静态引用（含 export-from）了该片段」这一事实，路径相对 extension/ 升序。
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
