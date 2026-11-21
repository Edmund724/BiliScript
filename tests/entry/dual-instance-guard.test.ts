import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  diffDualInstanceAllowlist,
  sourcesFromMap,
} from "../../scripts/build-guards.js";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const BUILD_CONTENT = "scripts/build-content.js";
const MARKER = "BILISCRIPT_DUAL_INSTANCE_STATEFUL";

function parseAllowlist() {
  const entries = [];
  for (const match of read(BUILD_CONTENT).matchAll(
    /\{ source: "([^"]+)", mutable: (true|false) \}/g
  )) {
    entries.push({ source: match[1], mutable: match[2] === "true" });
  }
  return entries;
}

describe("双实例纪律守卫（构建期接线）", () => {
  it("build-content.js 声明守卫、清单并在 selfCheck 里调用", () => {
    const text = read(BUILD_CONTENT);
    expect(text.includes("assertDualInstanceAllowlist()")).toBe(true);
    expect(text.includes("assertSharedSlotsInBothRegions() &&")).toBe(true);
  });

  it("清单非空、源码文件都在，且 mutable 位与头注标记逐模块一致", () => {
    const entries = parseAllowlist();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const rel = `extension/${entry.source}`;
      expect(existsSync(join(ROOT, rel)), `${rel} 不存在`).toBe(true);
      const hasMarker = read(rel).includes(MARKER);
      expect(
        hasMarker,
        `${entry.source}：mutable=${entry.mutable} 与头注标记（${hasMarker}）不一致`
      ).toBe(entry.mutable);
    }
  });

  it("对账：清单外的新双实例模块被报出（懒侧新 import 事故形态）", () => {
    const allowlist = ["core/state.ts", "shared/utils.ts"];
    const actual = [...allowlist, "core/url-watcher.ts"];
    const { unexpected, missing } = diffDualInstanceAllowlist(actual, allowlist);
    expect(unexpected).toEqual(["core/url-watcher.ts"]);
    expect(missing).toEqual([]);
  });

  it("对账：清单漂移（模块不再双实例）被报出，完全一致时零误报", () => {
    const allowlist = ["core/state.ts", "core/url-watcher.ts"];
    const drift = diffDualInstanceAllowlist(["core/state.ts"], allowlist);
    expect(drift.unexpected).toEqual([]);
    expect(drift.missing).toEqual(["core/url-watcher.ts"]);
    const clean = diffDualInstanceAllowlist(allowlist, allowlist);
    expect(clean.unexpected).toEqual([]);
    expect(clean.missing).toEqual([]);
  });

  it("sourcemap 归一化：只留 extension/ 内 .ts 源，map 相对路径按 map 目录解析", () => {
    const extensionRoot = resolve("repo-fixture", "extension");
    const entryDir = join(extensionRoot, "entry");
    const mainMap = {
      sources: [
        "../core/state.ts",
        "../core/types.d.ts",
        "../../node_modules/dep/index.ts",
        "../entry/content-main.mjs",
      ],
    };
    expect(sourcesFromMap(mainMap, entryDir, extensionRoot)).toEqual(["core/state.ts"]);
    const chunkMap = { sources: ["../../shared/messaging.ts"] };
    expect(sourcesFromMap(chunkMap, join(entryDir, "chunks"), extensionRoot)).toEqual([
      "shared/messaging.ts",
    ]);
  });
});
