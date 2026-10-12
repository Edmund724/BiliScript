// tests/helpers/artifacts.ts
// 来源对账工件的登记表 —— 验证面的**单一判定源**。
//
// 这些工件是 `.scratch/tickets/upstream-model-facts/artifacts/` 下的 06/07 号票产物与
// 01 号票的上游快照：路径、用途、生成器出处都登记在案。工件与生成器都不进库
// （`.scratch/` 被 `.gitignore:24` 忽略，生成脚本不在树上、也无 CI），新克隆里必然缺席。
//
// 5 处 `describe.skipIf` 门控 15 条来源对账用例，全部读这里的判定（hasArtifact /
// hasAllArtifacts），预检用例（tests/ai/artifact-preflight.test.ts）读 missingArtifacts()
// 把缺席报成显式状态：门控与「为什么跳过」出自同一份登记，不再各自 existsSync 一遍。

import { existsSync } from "node:fs";

/** 工件目录（仓库相对路径；vitest 以仓库根为 cwd）。 */
const ARTIFACTS = ".scratch/tickets/upstream-model-facts/artifacts";

export interface ArtifactEntry {
  /** 仓库相对路径。 */
  readonly path: string;
  /** 该工件在验证面干什么用（一句话）。 */
  readonly purpose: string;
  /** 谁生成它（一句话）。 */
  readonly generator: string;
}

/**
 * 登记表：chip 清单三件 + 逐格清单 + 请求体矩阵 + 验收覆盖矩阵 + 上游快照。
 * 顺序 = 上述防线顺序（chip 清单 → 请求矩阵 → 覆盖矩阵 → 上游快照）。
 */
export const ARTIFACT_REGISTRY: readonly ArtifactEntry[] = [
  {
    path: `${ARTIFACTS}/06-chip-source.tsv`,
    purpose: "chip 清单：逐模型的来源层与上游出处，与 resolver 的 source 对账。",
    generator: "06 号票清单生成器（upstream-model-facts/06）产出。"
  },
  {
    path: `${ARTIFACTS}/06-chip-sets.tsv`,
    purpose: "chip 清单：逐模型的可用档位集合 A'，与 resolver 的 availableLevels 对账。",
    generator: "06 号票清单生成器（upstream-model-facts/06）产出。"
  },
  {
    path: `${ARTIFACTS}/06-chip-changes.tsv`,
    purpose: "chip 清单：chip 集合的逐条变化记录（裁定 #4 的追溯面）。",
    generator: "06 号票清单生成器（upstream-model-facts/06）产出。"
  },
  {
    path: `${ARTIFACTS}/06-request-matrix.cells.tsv`,
    purpose: "请求矩阵逐格变化清单：偏好档 → 实发档 + A' + 原因。",
    generator: "06 号票清单生成器（upstream-model-facts/06）产出。"
  },
  {
    path: `${ARTIFACTS}/06-request-matrix.tsv`,
    purpose: "请求体矩阵（371 行，off/low/high 三列）：golden 用例数据的来源对账（F3）。",
    generator: "04-prune-matrix.ts 在 06 树跑出的产物。"
  },
  {
    path: `${ARTIFACTS}/07-golden-coverage.tsv`,
    purpose: "验收覆盖矩阵：valuesetId × 通道 × 档位出口形态 → 用例归属（F4）。",
    generator: "07-gen-golden-tables.ts 生成按类用例表时的同批产物。"
  },
  {
    path: `${ARTIFACTS}/models-dev-api.json`,
    purpose: "上游 models.dev 目录快照：catalog:check 接缝 B 的真产物离线对账输入。",
    generator: "01 号票保存的上游快照（upstream-model-facts/01）。"
  }
];

/** 严格模式开关：缺席即失败（本地补齐工件 / CI 挂载工件时用）。 */
export const REQUIRE_ARTIFACTS_ENV = "BILISCRIPT_REQUIRE_ARTIFACTS";

/** 单个工件是否在场（判定源，替代各处 existsSync）。 */
export function hasArtifact(path: string): boolean {
  return existsSync(path);
}

/** 一组工件是否全在场（同一门控的合并判定）。 */
export function hasAllArtifacts(paths: readonly string[]): boolean {
  return paths.every(hasArtifact);
}

/** 登记表里当前缺席的工件。 */
export function missingArtifacts(): ArtifactEntry[] {
  return ARTIFACT_REGISTRY.filter((entry) => !hasArtifact(entry.path));
}

// 测试侧的 process 声明（tests/reader/node-stubs.d.ts）只含 cwd/execPath，
// 这里按 extension/entry/content-bootstrap.ts 的同一写法就地补 env 形状。
declare const process: { env?: Record<string, string | undefined> } | undefined;

/** 严格模式是否开启（值恰为 "1"）。 */
export function artifactsRequired(): boolean {
  return typeof process !== "undefined" && process.env?.[REQUIRE_ARTIFACTS_ENV] === "1";
}

/** 缺席汇总块：期望清单 + 缺席原因 + 影响面 + 严格模式用法。 */
export function renderMissingArtifactsReport(missing: readonly ArtifactEntry[]): string {
  const lines = [
    "════════ 工件 preflight：来源对账防线未运行 ════════",
    `期望工件 ${ARTIFACT_REGISTRY.length} 件，当前缺席 ${missing.length} 件。`,
    "缺席原因：工件与生成器不进库（.scratch/ 被 .gitignore:24 忽略，生成脚本已失，无 CI）。",
    "影响面：5 处门控的 15 条来源对账用例被跳过 —— 默认 reporter 只打印 skipped 数，退出码仍为 0。",
    "缺席清单（路径 → 用途 ← 生成器）：",
    ...missing.map((entry) => `  ✗ ${entry.path}\n      用途：${entry.purpose}\n      生成器：${entry.generator}`),
    `严格模式：设 ${REQUIRE_ARTIFACTS_ENV}=1 时，缺席即本用例失败。`,
    "═════════════════════════════════════════════════════"
  ];
  return lines.join("\n");
}
