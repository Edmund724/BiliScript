// tests/ai/thinking-wire-keys.types.ts — 「四张平台键表的键集恰等于平台身份键词表叶」的
// 编译期断言（架构评审候选 6）。本文件不是 vitest 用例（文件名不匹配 vitest 的 test/spec
// glob），由 `pnpm typecheck`（tsc --noEmit，include tests/**/*.ts）执行：
//   - 每条 `@ts-expect-error` 断言的直写都必须编译失败（缺一格 / 孤儿键 / 词表叶外的键）；
//     若哪天有人把 `Record<PlatformKey, …>` 换回宽类型（或改用 satisfies 而丢了表侧判据），
//     tsc 会报 "Unused '@ts-expect-error' directive"，断言随即失败；
//   - 末尾正向对照证明四张真实表照常通过（防止断言写成「谁都通不过」）。
//
// 为什么用类型而不是运行期用例：候选 6 的收益正是「新增平台缺一格 = 装配期红」——运行期
// 只能看见「表里少一格」（旧的三段键集对账），看不见「有人把封闭注解拆了」。运行期的逐格
// 行为断言仍在 tests/ai/thinking-wire-map.test.ts（键集只留一条语义断言）。

import { PLATFORM_IDENTITY_KEYS, type PlatformKey } from "../../extension/ai/platform-identity-vocab.js";
import { PROVIDERS } from "../../extension/ai/thinking-profiles.js";
import {
  MESSAGES_OFF_EXIT,
  MESSAGES_ON_EXIT,
  MESSAGES_TIER_EXIT,
  type MessagesOffExitCell
} from "../../extension/ai/thinking-wire-map.js";

export function assertPlatformKeyClosure(): void {
  // ===== 正向对照：四张真实表的键集就是词表叶（类型身份） =====
  const tier: Record<PlatformKey, unknown> = MESSAGES_TIER_EXIT;
  const off: Record<PlatformKey, unknown> = MESSAGES_OFF_EXIT;
  const on: Record<PlatformKey, unknown> = MESSAGES_ON_EXIT;
  const providers: Record<PlatformKey, unknown> = PROVIDERS;
  const leaf: readonly PlatformKey[] = PLATFORM_IDENTITY_KEYS;
  void [tier, off, on, providers, leaf];

  // ===== 缺一格 = tsc 红（新增平台只补了三张出口表、漏了一格） =====
  // @ts-expect-error 少一个平台键就不再满足 Record<PlatformKey, …>
  const missingCell: Record<PlatformKey, MessagesOffExitCell> = { ...MESSAGES_OFF_EXIT } as Omit<Record<PlatformKey, MessagesOffExitCell>, "mimo">;
  void missingCell;

  // ===== 孤儿键 = tsc 红（词表叶之外的键进不了表） =====
  const orphanCell: Record<PlatformKey, MessagesOffExitCell> = {
    ...MESSAGES_OFF_EXIT,
    // @ts-expect-error 对象字面量的多余属性判据：ghost 不是词表叶的键
    ghost: { kind: "native", provenance: { level: "推断", source: "测试注入的孤儿格" } }
  };
  void orphanCell;

  // @ts-expect-error 孤儿键在封闭键表上无从索引（结构上不可能成为一格）
  const ghostLookup: MessagesOffExitCell = MESSAGES_OFF_EXIT.ghost;
  void ghostLookup;

  // ===== 词表叶的键是封闭联合（不是 string） =====
  // @ts-expect-error 任意串不是 PlatformKey（成员资格由 isPlatformKey 判定）
  const notAKey: PlatformKey = "ghost";
  void notAKey;
}
