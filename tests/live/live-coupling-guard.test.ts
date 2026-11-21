import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const EXTENSION_ROOT = join(process.cwd(), "extension");

const STATIC_IMPORT_RE =
  /(?:^|\n)[ \t]*(?:import|export)\s+([^;]*?)\s+from\s*["'](\.[^"']+)["']/g;
const SIDE_EFFECT_IMPORT_RE = /(?:^|\n)[ \t]*import\s*["'](\.[^"']+)["']/g;

function resolveTsTarget(fromFile: string, spec: string): string | null {
  let target = resolve(dirname(fromFile), spec);
  if (target.endsWith(".js")) {
    target = target.slice(0, -3) + ".ts";
  }
  if (!existsSync(target) && existsSync(target + ".ts")) {
    target += ".ts";
  }
  return existsSync(target) ? target : null;
}

function collectStaticClosure(entryRel: string): Set<string> {
  const visited = new Set<string>();
  const stack = [resolve(EXTENSION_ROOT, entryRel)];

  while (stack.length > 0) {
    const file = stack.pop()!;
    if (visited.has(file) || !existsSync(file)) continue;
    visited.add(file);

    const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of source.matchAll(STATIC_IMPORT_RE)) {
      const clause = match[1];
      if (/^\s*type\b/.test(clause) || /^\{\s*type\s/.test(clause)) continue;
      const target = resolveTsTarget(file, match[2]);
      if (target) stack.push(target);
    }
    for (const match of source.matchAll(SIDE_EFFECT_IMPORT_RE)) {
      const target = resolveTsTarget(file, match[1]);
      if (target) stack.push(target);
    }
  }

  return new Set(
    [...visited].map((file) => relative(EXTENSION_ROOT, file).replace(/\\/g, "/"))
  );
}

describe("live / player-ai 静态耦合与内容侧密钥隔离守卫", () => {
  it("ai/player-ai.ts 不静态拖入实时伴看运行时、同传菜单、字幕缓存、BM25、AI 协议栈或 ASR 管线", () => {
    const closure = collectStaticClosure("ai/player-ai.ts");
    const forbidden = [
      "live/live-companion-session.ts",
      "live/live-overlay-binding.ts",
      "live/live-chat-controller.ts",
      "live/fullscreen-live-overlay.ts",
      "live/player-interpret.ts",
      "subtitle/cache.ts",
      "ai/l0-bm25.ts",
      "ai/subtitle-translate.ts",
      "ai/completion.ts",
      "asr/pipeline.ts",
      "asr/asr-provider-store.ts"
    ];
    expect(forbidden.filter((item) => closure.has(item))).toEqual([]);
  });

  it("ui/script-button.ts 不静态拖入阅读壳与金句分享重模块", () => {
    const closure = collectStaticClosure("ui/script-button.ts");
    const forbidden = [
      "reader/shell.ts",
      "reader/quote-share-export.ts",
      "reader/quote-share-modal.ts"
    ];
    expect(forbidden.filter((item) => closure.has(item))).toEqual([]);
  });

  it("live/live-companion-session.ts 不静态导入 live/player-interpret.ts 或同传控制器", () => {
    const closure = collectStaticClosure("live/live-companion-session.ts");
    const forbidden = [
      "live/player-interpret.ts",
      "live/interpret-session-controller.ts"
    ];
    expect(forbidden.filter((item) => closure.has(item))).toEqual([]);
  });

  it("live/interpret-session-controller.ts 不静态导入翻译协议栈、ASR 管线或 ASR 存储直读模块", () => {
    const closure = collectStaticClosure("live/interpret-session-controller.ts");
    const forbidden = [
      "ai/subtitle-translate.ts",
      "ai/completion.ts",
      "asr/pipeline.ts",
      "asr/asr-provider-store.ts"
    ];
    expect(forbidden.filter((item) => closure.has(item))).toEqual([]);
  });

  it("live/live-chat-controller.ts 不在内容脚本直调 liveProviderStore 或 chrome.storage", () => {
    const source = readFileSync(
      resolve(EXTENSION_ROOT, "live/live-chat-controller.ts"),
      "utf8"
    );
    expect(source).not.toMatch(/\bliveProviderStore\b/);
    expect(source).not.toMatch(/\bchrome\.storage\b/);
  });
});
