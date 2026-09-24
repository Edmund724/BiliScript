// 双实例纪律守卫（构建期守卫的接线锁，content-dual-instance-guard，2026-09-18）：
//
// content 两轮构建把共享底座各装一份实例。「允许双实例模块清单」+ 含模块级可变
// 状态模块的头注 BOC_DUAL_INSTANCE_STATEFUL 声明 + build-content.js 的
// assertDualInstanceAllowlist 对账（实测双实例集合 vs 清单、mutable 位 vs 头注
// 标记），把此前「懒侧不碰模块级可变状态」的隐形约定变显式（背景与裁决见
// docs/adr/0008）。
//
// 本测试锁三件事（构建期守卫本身由 npm run build 每次跑）：
//   1. 守卫函数、清单、selfCheck 接线在场（删掉守卫要显式改这里）；
//   2. 清单与头注逐模块一致：mutable: true ⇔ 源文件头注有标记，且清单源码
//      文件都存在（清单漂移在测试期就现形，不必等构建）；
//   3. 对账纯函数 diffDualInstanceAllowlist / sourcesFromMap 的行为：清单外
//      新双实例模块（懒侧新 import 含可变状态模块的事故形态）被报出、清单
//      漂移被报出、完全一致时零误报。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  diffDualInstanceAllowlist,
  sourcesFromMap,
} from "../../scripts/build-guards.js";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const BUILD_CONTENT = "scripts/build-content.js";
const MARKER = "BOC_DUAL_INSTANCE_STATEFUL";

// 从 build-content.js 解析清单（与守卫同一份数据源，不复制清单内容）。
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
    // selfCheck 以守卫的返回值收尾——守卫失败即 selfCheck 失败（build fail fast）
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
    const extensionRoot = "/repo/extension";
    const mainMap = {
      sources: [
        "../core/state.ts",
        "../core/types.d.ts",
        "../../node_modules/dep/index.ts",
        "../entry/content-main.mjs",
      ],
    };
    expect(sourcesFromMap(mainMap, "/repo/extension/entry", extensionRoot)).toEqual([
      "core/state.ts",
    ]);
    const chunkMap = { sources: ["../../shared/messaging.ts"] };
    expect(
      sourcesFromMap(chunkMap, "/repo/extension/entry/chunks", extensionRoot)
    ).toEqual(["shared/messaging.ts"]);
  });
});
