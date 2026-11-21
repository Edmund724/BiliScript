//   - 每条 `@ts-expect-error` 断言的直写都必须编译失败（缺一格 / 孤儿键 / 词表叶外的键）；
//     tsc 会报 "Unused '@ts-expect-error' directive"，断言随即失败；

import { PLATFORM_IDENTITY_KEYS, type PlatformKey } from "../../extension/ai/platform-identity-vocab.js";
import { PROVIDERS } from "../../extension/ai/thinking-profiles.js";
import {
  MESSAGES_OFF_EXIT,
  MESSAGES_ON_EXIT,
  MESSAGES_TIER_EXIT,
  type MessagesOffExitCell
} from "../../extension/ai/thinking-wire-map.js";

export function assertPlatformKeyClosure(): void {
  const tier: Record<PlatformKey, unknown> = MESSAGES_TIER_EXIT;
  const off: Record<PlatformKey, unknown> = MESSAGES_OFF_EXIT;
  const on: Record<PlatformKey, unknown> = MESSAGES_ON_EXIT;
  const providers: Record<PlatformKey, unknown> = PROVIDERS;
  const leaf: readonly PlatformKey[] = PLATFORM_IDENTITY_KEYS;
  void [tier, off, on, providers, leaf];

  // @ts-expect-error 少一个平台键就不再满足 Record<PlatformKey, …>
  const missingCell: Record<PlatformKey, MessagesOffExitCell> = { ...MESSAGES_OFF_EXIT } as Omit<Record<PlatformKey, MessagesOffExitCell>, "mimo">;
  void missingCell;

  const orphanCell: Record<PlatformKey, MessagesOffExitCell> = {
    ...MESSAGES_OFF_EXIT,
    // @ts-expect-error 对象字面量的多余属性判据：ghost 不是词表叶的键
    ghost: { kind: "native", provenance: { level: "推断", source: "测试注入的孤儿格" } }
  };
  void orphanCell;

  // @ts-expect-error 孤儿键在封闭键表上无从索引（结构上不可能成为一格）
  const ghostLookup: MessagesOffExitCell = MESSAGES_OFF_EXIT.ghost;
  void ghostLookup;

  // @ts-expect-error 任意串不是 PlatformKey（成员资格由 isPlatformKey 判定）
  const notAKey: PlatformKey = "ghost";
  void notAKey;
}
