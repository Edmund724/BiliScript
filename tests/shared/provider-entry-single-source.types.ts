// tests/shared/provider-entry-single-source.types.ts — AI 条目类型单源（票
// ai-entry-type/01）的编译期断言。
//
// 本文件不是 vitest 用例（文件名不匹配 vitest 的 test/spec glob），由 `pnpm typecheck`
//（tsc --noEmit，include tests/**/*.ts）执行。两条断言互为对照，防止写成「谁都传不进」：
// - 正向：store 产物（core/ai-provider-store.AiProvider & {hasSavedKey}）必须可赋给
//   协议条目 ProviderListEntry。单源化前这条不成立（microsoft/TypeScript#15300：
//   交叉类型不获得隐式索引签名），handler 回包面的键面投影与 resolve-ai-provider
//   的形状谓词就是为绕开它而存在；store 面的 AiProvider 改为继承线格式面后成立；
// - 反向：协议条目（线格式宽松面，字段全可选）不可当 store 产物（精确必需字段）用。
//   这条钉住的是**读面口径的宽松**：chat/providers 与 ai/active-provider 对
//   name / model / presetId 的防御式读取正当依赖它，收窄会让 legacy 读点拿到
//   undefined（行为回归），不得靠断言绕过。

import type { AiProvider } from "../../extension/core/ai-provider-store.js";
import type { ProviderListEntry } from "../../extension/shared/messaging-protocol.js";

type AiProduct = AiProvider & { hasSavedKey: boolean };

declare const product: AiProduct;
declare const entry: ProviderListEntry;

export function assertProviderEntrySingleSource(): void {
  // 正向：store 产物 → 协议条目（单源后的父子关系）
  const asEntry: ProviderListEntry = product;
  // @ts-expect-error 反向：协议条目缺精确必需字段，不可赋给 store 产物
  const asProduct: AiProduct = entry;
  void asEntry;
  void asProduct;
}
