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
  // @ts-expect-error B 档对外只读：contextData 嵌套字段直写必须编译失败（快照深一层只读）
  chatSessionState.contextData!.title = "t";
  // @ts-expect-error B 档对外只读：liveContextData 嵌套字段直写必须编译失败（快照深一层只读）
  chatSessionState.liveContextData!.signature = "s";

  chatSessionStateForTests.contextData = null;
  chatSessionStateForTests.liveContextData = { title: "t" };
  chatSessionStateForTests.liveContextData!.signature = "s";
  chatSessionStateForTests.aiPrefs.defaultModel = "p1";
}
