// tests/core/settings-snapshot-write.types.ts — 裸落盘入口的 seam 形状编译期断言
// （架构评审候选 7：落盘收进 module，区不再靠调用方报）。
//
// 本文件不是 vitest 用例（文件名不匹配 vitest 的 test/spec glob），由
// `pnpm typecheck`（tsc --noEmit，include tests/**/*.ts）执行：
// - `@ts-expect-error` 断言「写点再报一次区」必须编译失败——writeSnapshotKeys 的
//   入参只有「键 → 新值」，区由 SNAPSHOT_STORAGE_KEYS 的 area 反查；哪天签名又长出
//   区参数，tsc 会报 "Unused '@ts-expect-error' directive"，断言随即失败。
// - 末尾的正向对照证明写点的实际形态（只交键 → 新值）可编译。

import { writeSnapshotKeys } from "../../extension/core/settings-snapshot.js";
import { SEARCH_PROVIDER_ORDER_STORAGE } from "../../extension/search/search-provider-store.js";

export async function assertWriteSeamHasNoAreaParam(): Promise<void> {
  // @ts-expect-error 区不是入参：写点不得再报区（区由快照键面表决定）
  await writeSnapshotKeys("sync", { [SEARCH_PROVIDER_ORDER_STORAGE]: [] });

  // 正向对照：只交「哪些键的新值」
  await writeSnapshotKeys({ [SEARCH_PROVIDER_ORDER_STORAGE]: [] });
}
