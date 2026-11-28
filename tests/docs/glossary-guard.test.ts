import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const GLOSSARY_ROOT = "GLOSSARY.md";
const GLOSSARY_VOLUMES = [
  "docs/glossary/subtitle.md",
  "docs/glossary/ai.md",
  "docs/glossary/live.md",
  "docs/glossary/reader.md"
] as const;
const SCANNED_DOCS = [GLOSSARY_ROOT, ...GLOSSARY_VOLUMES, "AGENTS.md"] as const;
const MAX_ROOT_GLOSSARY_BYTES = 4096;

const REPO_PATH_RE = /\b(?:extension|docs|scripts|tests)\/[A-Za-z0-9._\-/]+/g;
const MARKDOWN_LINK_RE = /\[[^\]]+\]\(([^)#\s]+)(?:#[^)\s]*)?\)/g;

function readUtf8(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf8");
}

function normalizeCandidatePath(raw: string): string {
  return raw.replace(/[),.;:：。，；、\]"'`]+$/g, "");
}

function isWildcardOrTemplatePath(candidate: string): boolean {
  return candidate.includes("*") || candidate.includes("<") || candidate.includes(">") || candidate.includes("{");
}

function collectCitedPaths(relDoc: string): string[] {
  const text = readUtf8(relDoc);
  const found = new Set<string>();

  for (const match of text.matchAll(REPO_PATH_RE)) {
    const cleaned = normalizeCandidatePath(match[0]);
    if (!cleaned || isWildcardOrTemplatePath(cleaned)) {
      continue;
    }
    found.add(cleaned);
  }

  const baseDir = dirname(join(ROOT, relDoc));
  for (const match of text.matchAll(MARKDOWN_LINK_RE)) {
    const rawTarget = normalizeCandidatePath(match[1] || "");
    if (
      !rawTarget ||
      /^https?:\/\//i.test(rawTarget) ||
      rawTarget.startsWith("mailto:") ||
      isWildcardOrTemplatePath(rawTarget)
    ) {
      continue;
    }
    const resolvedAbs = resolve(baseDir, rawTarget);
    const relFromRoot = resolvedAbs.slice(ROOT.length + 1).replace(/\\/g, "/");
    found.add(relFromRoot);
  }

  return [...found].sort();
}

describe("GLOSSARY 按域分卷与仓库路径守卫", () => {
  it("根目录 GLOSSARY.md 体积 <= 4,096 B UTF-8 且包含核心术语与四域导航", () => {
    const content = readUtf8(GLOSSARY_ROOT);
    const byteLength = new TextEncoder().encode(content).byteLength;
    expect(byteLength).toBeLessThanOrEqual(MAX_ROOT_GLOSSARY_BYTES);

    for (const term of ["文摘面板", "独立窗口", "置顶画中画", "普通窗口", "站点", "视频存储键", "平台自动字幕"]) {
      expect(content, `根 GLOSSARY.md 缺少核心术语：${term}`).toContain(term);
    }
    for (const volume of GLOSSARY_VOLUMES) {
      expect(content, `根 GLOSSARY.md 缺少分卷索引：${volume}`).toContain(volume);
    }
  });

  it("docs/glossary/ 四个域分卷均存在且非空", () => {
    for (const volume of GLOSSARY_VOLUMES) {
      const abs = join(ROOT, volume);
      expect(existsSync(abs), `缺少域分卷：${volume}`).toBe(true);
      expect(readUtf8(volume).trim().length).toBeGreaterThan(200);
    }
  });

  it("GLOSSARY.md、docs/glossary/*.md 与 AGENTS.md 零残留 raw-retrieval 等死路径", () => {
    const forbiddenTokens = ["raw-retrieval", "turn-lifecycle.ts", "provider-editor-catalog.ts"];
    const hits: string[] = [];
    for (const relDoc of SCANNED_DOCS) {
      const content = readUtf8(relDoc);
      for (const token of forbiddenTokens) {
        if (content.includes(token)) {
          hits.push(`${relDoc}: ${token}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("GLOSSARY.md、docs/glossary/*.md 与 AGENTS.md 引用的所有仓库路径 100% 真实存在", () => {
    const missing: string[] = [];
    for (const relDoc of SCANNED_DOCS) {
      const cited = collectCitedPaths(relDoc);
      for (const relTarget of cited) {
        if (!existsSync(join(ROOT, relTarget))) {
          missing.push(`${relDoc} -> ${relTarget}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
