// tests/ai/artifact-preflight.test.ts
// 验证面的显式前置状态：全仓 5 处 `describe.skipIf(!existsSync(...))` 门控 15 条来源对账
// 用例，而工件与生成器都不进库（.scratch/ 被 .gitignore:24 忽略、无 CI），缺席时默认
// reporter 只多一个 skipped 数、退出码仍为 0 —— 防线没跑和防线全绿在输出里长得一样。
//
// 这条用例永远运行：把「期望哪些工件、为什么缺席、哪几道防线因此没跑」打印成一块汇总，
// 使缺席成为显式状态；对账环境（本地补齐工件 / CI 挂载工件）设 BILISCRIPT_REQUIRE_ARTIFACTS=1
// 即把缺席变成失败。

import { describe, expect, it } from "vitest";
import { ARTIFACT_REGISTRY, artifactsRequired, missingArtifacts, renderMissingArtifactsReport } from "../helpers/artifacts.js";

describe("工件 preflight（来源对账防线的前置状态）", () => {
  it("缺席即显式报出清单与影响面；BILISCRIPT_REQUIRE_ARTIFACTS=1 时缺席即失败", () => {
    // 登记表自洽：路径唯一，每条都有用途与生成器出处（缺席状态才可读）。
    const paths = ARTIFACT_REGISTRY.map((entry) => entry.path);
    expect(ARTIFACT_REGISTRY.length).toBeGreaterThan(0);
    expect(new Set(paths).size, `登记表路径重复：${paths.join(" / ")}`).toBe(paths.length);
    for (const entry of ARTIFACT_REGISTRY) {
      expect(entry.purpose, `${entry.path} 缺用途`).not.toBe("");
      expect(entry.generator, `${entry.path} 缺生成器出处`).not.toBe("");
    }

    const missing = missingArtifacts();
    if (missing.length > 0) {
      console.log(`\n${renderMissingArtifactsReport(missing)}\n`);
    }
    if (artifactsRequired()) {
      expect(missing, "BILISCRIPT_REQUIRE_ARTIFACTS=1：来源对账工件必须齐备").toEqual([]);
    }
  });
});
