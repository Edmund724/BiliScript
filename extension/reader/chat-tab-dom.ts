// extension/reader/chat-tab-dom.ts — 对话 tab DOM 状态袋（chat-tab 拆分片，工单 12）。
//
// 模块级 els 在求值时解析（对话 tab 只在面板壳存在后装载，与 sidepanel 的页面
// 加载时序同构）；els 与 requireShell 被 core / lifecycle 两片共用，放最底层
// 两片之间才没有环（零对 core/lifecycle 的依赖）。

import { ids } from "./state.js";
import type { ModelSelectWidthEls } from "../chat/model-select-width.js";

export const els = {
  root: document.getElementById(ids.readingChatRoot) as HTMLElement,
  contextChip: document.getElementById(ids.readingChatContextChip) as HTMLButtonElement,
  refreshBtn: document.getElementById(ids.readingChatRefreshBtn) as HTMLButtonElement,
  modelSelect: document.getElementById(ids.readingChatModelSelect) as HTMLSelectElement,
  modelChip: document.getElementById(ids.readingChatModelChip) as HTMLButtonElement,
  modelPanel: document.getElementById(ids.readingChatModelPanel) as HTMLElement,
  modelPanelList: document.getElementById(ids.readingChatModelList) as HTMLElement,
  thinkingToggle: document.getElementById(ids.readingChatThinkingToggle) as HTMLElement,
  thinkingBtns: document.querySelectorAll<HTMLElement>(`#${ids.readingChatThinkingToggle} .chat-thinking-btn`),
  // 联网搜索开关 pill（spec §4，输入行 + 右侧）
  webSearchPill: document.getElementById(ids.readingChatWebSearchPill) as HTMLElement | null,
  // 思考档位「关不掉」提示行（工单 03，模板默认 hidden）
  thinkingHint: document.getElementById(ids.readingChatThinkingHint) as HTMLElement | null,
  newChatBtn: document.getElementById(ids.readingChatNewBtn) as HTMLButtonElement,
  presetBtn: document.getElementById(ids.readingChatPresetBtn) as HTMLButtonElement,
  historyBtn: document.getElementById(ids.readingChatHistoryBtn) as HTMLButtonElement,
  presetPopover: document.getElementById(ids.readingChatPresetPopover) as HTMLElement,
  presetList: document.getElementById(ids.readingChatPresetList) as HTMLElement,
  presetInput: document.getElementById(ids.readingChatPresetInput) as HTMLInputElement,
  presetAddBtn: document.getElementById(ids.readingChatPresetAddBtn) as HTMLButtonElement,
  historyPopover: document.getElementById(ids.readingChatHistoryPopover) as HTMLElement,
  historyList: document.getElementById(ids.readingChatHistoryList) as HTMLElement,
  historyClearBtn: document.getElementById(ids.readingChatHistoryClearBtn) as HTMLButtonElement | null,
  messages: document.getElementById(ids.readingChatMessages) as HTMLElement,
  input: document.getElementById(ids.readingChatInput) as HTMLTextAreaElement,
  // 图片附件区（image-input 02 号票，模板默认 hidden）
  imageStrip: document.getElementById(ids.readingChatImageStrip) as HTMLElement | null,
  sendBtn: document.getElementById(ids.readingChatSendBtn) as HTMLButtonElement,
  asrNotice: document.getElementById(ids.readingChatAsrNotice) as HTMLElement | null,
  intentCard: document.getElementById(ids.readingChatIntent) as HTMLElement | null
};
export function requireShell(): void {
  if (!els.root || !els.messages || !els.input) {
    throw new Error("AI 对话 tab 壳未就绪（readingChat* DOM 缺失）");
  }
}
