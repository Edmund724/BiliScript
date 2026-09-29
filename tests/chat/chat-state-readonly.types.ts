// tests/chat/chat-state-readonly.types.ts — B 档对外只读面的编译期断言（ADR-0005
// 收口：chat 状态袋 10 个散字段与身份切片一样对外只读，写入一律走意图原语）。
//
// 本文件不是 vitest 用例（文件名不匹配 vitest 的 test/spec glob），由
// `pnpm typecheck`（tsc --noEmit，include tests/**/*.ts）执行：
// - 每条 `@ts-expect-error` 断言的直写都必须编译失败；若哪天只读面被放开，
//   tsc 会报 "Unused '@ts-expect-error' directive"，断言随即失败。
// - 末尾的正向对照证明测试把手仍可写（防止只读面做成「谁都不能写」）。

import { chatSessionState, chatSessionStateForTests } from "../../extension/chat/chat-state.js";

export function assertChatSessionReadonlySurface(): void {
  // @ts-expect-error B 档对外只读：contextData 直写必须编译失败
  chatSessionState.contextData = null;
  // @ts-expect-error B 档对外只读：currentContextKey 直写必须编译失败
  chatSessionState.currentContextKey = "";
  // @ts-expect-error B 档对外只读：providers 直写必须编译失败
  chatSessionState.providers = [];
  // @ts-expect-error B 档对外只读：liveContextData 直写必须编译失败
  chatSessionState.liveContextData = null;
  // @ts-expect-error B 档对外只读：liveContextKey 直写必须编译失败
  chatSessionState.liveContextKey = "";
  // @ts-expect-error B 档对外只读：liveTabUrl 直写必须编译失败
  chatSessionState.liveTabUrl = "";
  // @ts-expect-error B 档对外只读：aiPrefs 整组直写必须编译失败
  chatSessionState.aiPrefs = { aiSystemPrompt: "", aiInitialQuickPrompts: [] };
  // @ts-expect-error B 档对外只读：aiPrefs 子字段直写必须编译失败（深一层只读）
  chatSessionState.aiPrefs.defaultModel = "p1";
  // @ts-expect-error B 档对外只读：asrTranscribingActive 直写必须编译失败
  chatSessionState.asrTranscribingActive = true;
  // @ts-expect-error B 档对外只读：aiThinkingLevel 直写必须编译失败
  chatSessionState.aiThinkingLevel = "high";
  // @ts-expect-error B 档对外只读：webSearchEnabled 直写必须编译失败
  chatSessionState.webSearchEnabled = true;

  // 正向对照：测试把手是可写形状（测试布置前置状态用；生产代码不得 import）。
  chatSessionStateForTests.contextData = null;
  chatSessionStateForTests.aiPrefs.defaultModel = "p1";
}
