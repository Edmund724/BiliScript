// extension/reader/chat-tab-lifecycle.ts — 对话 tab 初始化/激活收尾与事件编排
//（chat-tab 拆分片，工单 12）。
//
// 职责：会话单例（initialized / initInFlight / sessionClosed）+ init 四路并行时序
// + 激活/恢复/关闭三入口（经 chat-tab.ts 壳对 lazy-chat-tab 暴露）+ 全局触发源
// 绑定（storage watcher / Esc / 外点桥接）+ bindEvents 元素级绑定 + URL chip 适配
// + 意图消费/快捷动作。
// 依赖 chat-tab-core 的实例装配片；sessionClosed 导出给 core（connectPort /
// pollContext 闭包读）是模块图唯一的回边，见 core 片头注。

import { buildReaderModeUrl } from "../bilibili/reader-url.js";
import { buildContextKey, doesTabMatchContextUrl } from "../ai/conversation.js";
import { formatClock } from "../shared/clock-text.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { watchStorageKeys } from "../shared/watch-storage-keys.js";
import { chatSessionState, parseModelOptionValue } from "../chat/tab-domain.js";
import { scheduleModelSelectWidthUpdate, updateModelSelectWidth } from "../chat/model-select-width.js";
// PR3 契约：待解释意图 peek/consume/clear（消费落在本组合根）。
import {
  peekPendingExplainIntent,
  consumePendingExplainIntent,
  clearPendingExplainIntent
} from "./explain-intent.js";
import { setChatTabOutsideClickHandler } from "./chat-tab-bridge.js";
import { requestUiCommand } from "./reader-bus.js";
import { ids } from "./state.js";
import { els, requireShell } from "./chat-tab-dom.js";
// 组合根内核片（chat-tab-core.ts）：实例装配与发送重放/上下文同步内核。
import {
  autosizeInput,
  bindSubtitleStatusBus,
  bindUrlChangeTrigger,
  chatRuntime,
  conversationReplayInFlight,
  conversationStore,
  contextLoad,
  inputImages,
  isMessagesNearBottom,
  lists,
  loadContextState,
  loadProvidersAndPrefs,
  modelPanel,
  popovers,
  providerPrefs,
  removeConversationContextNotice,
  presets,
  renderInitialState,
  restartChat,
  sendFromUi,
  setStreamingUiState,
  setThinkingLevel,
  setWebSearchEnabled,
  subtitleWaiter,
  unbindSubtitleStatusBus,
  unbindUrlChangeTrigger,
  updateAsrNotice,
  widthEls,
  updateContextChip,
  updateSendBtnState,
  updateThinkingHint
} from "./chat-tab-core.js";

let initialized = false;
let initInFlight: Promise<void> | null = null;
// 会话收尾标志（closeChatSession 置位、激活路径复位）：闸住关闭后仍会兑现的
// 发送流程（subtitle-wait 等待中的 pollContext 与 connectPort），落实「关闭即
// 断流、不做后台续跑」。
export let sessionClosed = false;
// 外部设置变更 → 刷新平台/偏好（与 sidepanel bindEvents 的 storage.onChanged
// 监听同语义；player-ai 信箱键的监听属摘除任务，不在 reader 消费）。
// 区/键过滤经 shared/watch-storage-keys seam（R3 收口）：sync 区六键或
// local 区 aiProviderKeys，解绑改 unsubscribe。
let unwatchStorageKeys: (() => void) | null = null;

function bindStorageWatcher(): void {
  if (unwatchStorageKeys) {
    return;
  }
  unwatchStorageKeys = watchStorageKeys(() => {
    void refreshProvidersAndPrefsAfterExternalChange();
  }, {
    sync: [
      "aiProviders",
      "aiSystemPrompt",
      "aiInitialQuickPrompts",
      "aiPresetPrompts",
      "defaultModel",
      "aiThinkingLevel"
    ],
    local: ["aiProviderKeys"]
  });
}

function unbindStorageWatcher(): void {
  if (!unwatchStorageKeys) {
    return;
  }
  unwatchStorageKeys();
  unwatchStorageKeys = null;
}// ============================================================
// 思考档位「关不掉」提示（工单 03，对话 tab 档位区唯一的 UI 增量）
// ============================================================

// ============================================================
// 激活 / 会话收尾（对外入口，经 reader/lazy-chat-tab 暴露）
// ============================================================

function bindGlobalTriggers(): void {
  bindSubtitleStatusBus();
  bindUrlChangeTrigger();
  bindStorageWatcher();
  // 外点关闭单委托：注册进 ui-renderer 的文档级 click 委托（chat-tab-bridge）。
  setChatTabOutsideClickHandler(popovers.handleDocumentClick);
  // Esc 关闭三个弹层（window 级监听，与文档级 click 委托不同事件，不互踩）。
  window.addEventListener("keydown", onWindowEscapeKey);
}

function unbindGlobalTriggers(): void {
  unbindSubtitleStatusBus();
  unbindUrlChangeTrigger();
  unbindStorageWatcher();
  setChatTabOutsideClickHandler(null);
  window.removeEventListener("keydown", onWindowEscapeKey);
}

function onWindowEscapeKey(event: KeyboardEvent): void {
  popovers.handleEscapeKey(event);
}
async function initChatTab({ consumeIntent }: { consumeIntent: boolean }): Promise<void> {
  requireShell();
  bindEvents();
  bindGlobalTriggers();
  // 四路互不依赖的初始化并行起跑（opt-backlog-2026-09/05）——原先 offscreen
  // 确保 → 平台列表 → 会话存档 → 上下文装配四连串行 await，总等待为各路之和
  // （会话存档还曾随 loadAll 对至多 12 条历史会话各发一次串行视频元数据请求，
  // 现已收敛到 restoreLatest 命中项单条）；并行后总等待 = 最慢一路。offscreen
  // 失败不阻断 init（catch 吞掉，与每次发送前的 ensure 复用同一自愈路径）。
  await Promise.all([
    sendRuntimeMessage({ type: "ensure-offscreen-chat" }).catch(() => null),
    loadProvidersAndPrefs().then(() => {
      // 平台列表/档位落定后：首判「关不掉」提示（此后由模型切换/档位点击/
      // 外部刷新续判）+ 模型 chip 首渲（renderModelSelect 已把选中项写进 select）。
      updateThinkingHint();
      modelPanel.renderChip();
    }),
    conversationStore.loadAll(),
    loadContextState()
  ]);
  // 会话恢复依赖存档（loadAll）与上下文（loadContextState）双双落定。
  await conversationStore.restoreLatest();
  renderInitialState();
  autosizeInput();
  initialized = true;
  // PR3 契约消费：有待解释意图 → 渲染引用卡 + 自动发送（发送成功即 consume）。
  // 快捷动作路径传 consumeIntent:false 跳过（与快捷发送互不踩踏）。
  if (consumeIntent) {
    await consumeExplainIntentIfPending();
  }
}

// 重开/重进的恢复路径（工单 08：重开从会话历史恢复）：重取平台/偏好（会话关闭
// 期间存储变更 watcher 已随触发源摘下，设置抽屉里的新增平台只能在此补读）→
// 静默重取上下文（签名短路便宜）→ 恢复匹配当前上下文的最近会话 → 按会话历史
// 重渲消息区（顺带清掉关闭时残留的流式半截节点）。
async function restoreChatSession(): Promise<void> {
  // 与 init / 外部变更刷新同口径三件：平台列表 + 模型 chip + 档位提示。
  await loadProvidersAndPrefs().catch(() => null);
  modelPanel.renderChip();
  updateThinkingHint();
  const ok = await loadContextState({ forceRefresh: false, silent: true }).catch(() => false);
  if (!ok) {
    return;
  }
  await conversationStore.restoreLatest();
  renderInitialState();
  autosizeInput();
}

export async function ensureChatTabActivated({ consumeIntent = true }: { consumeIntent?: boolean } = {}): Promise<void> {
  if (!initialized) {
    if (!initInFlight) {
      initInFlight = initChatTab({ consumeIntent }).finally(() => {
        initInFlight = null;
      });
    }
    await initInFlight;
    return;
  }
  if (sessionClosed) {
    sessionClosed = false;
    bindGlobalTriggers();
    await restoreChatSession();
  }
  // 已初始化的普通激活（tab 切回）：消费可能新写入的待解释意图（解释卡片
  // 「去对话追问」在对话 tab 已装载时点击 / 上次挂起的意图重试）。无意图时为无害 no-op。
  if (consumeIntent) {
    await consumeExplainIntentIfPending();
  }
}

export function closeChatSession(): void {
  if (!initialized) {
    return;
  }
  sessionClosed = true;
  // 断流收口（chat-runtime 断连路径已兜底 UI 态）：断 port、清在途一问一答与
  // 慢响应计时器；未流式时为无害空操作。
  chatRuntime.resetStreamState();
  setStreamingUiState(false);
  // 挂起中的 subtitle-wait 立即失效（pollContext 的 closed 闸 → wait 兑现
  // false → 发送流程提前返回并清等待提示）。
  subtitleWaiter.kick();
  popovers.hidePresetPopover();
  popovers.hideHistoryPopover();
  popovers.hideModelPanel();
  removeConversationContextNotice();
  updateAsrNotice();
  // 会话收尾（意图已被 lifecycle.clearPendingExplainIntent 清掉）：引用卡随之
  // 隐藏，下次激活按无意图渲染。
  hideExplainIntentCard();
  unbindGlobalTriggers();
}
// ============================================================
// player-ai 快捷动作消费 seam（工单 08 决议：阅读模式内点击 = 定位/聚焦对话
// tab + 自动发送快捷提示词；PR4b 概览「生成完整笔记」按钮同 seam 直发）
// ============================================================

export async function runQuickActionPrompt(prompt: string): Promise<boolean> {
  // 定位/聚焦对话 tab（不触达字幕 tab 的滚动状态）。切 tab + 激活由壳经
  // set-tab:chat 命令统一执行（arch-review-2026-09/10）；consumeIntent:false
  // 透传给壳的激活入口——与快捷发送互不踩踏，不消费待解释意图。下方再显式
  // await 激活：命令是 fire-and-forget，发送流程必须等装载/恢复落定。
  requestUiCommand("set-tab:chat", { consumeIntent: false });
  // 首次调用完成装载；已装载时为幂等 no-op（不消费待解释意图——与快捷动作
  // 发送互不踩踏）。
  await ensureChatTabActivated({ consumeIntent: false });
  const text = String(prompt || "").trim();
  if (!text) {
    autosizeInput();
    els.input?.focus?.();
    return false;
  }
  await startNewConversation();
  return sendViaInputBox(text);
}
// ============================================================
// PR3 契约消费：待解释意图 → 引用卡（时间戳 pill 母题）+ 自动发送
// ============================================================

// 解释提示词模板：引用句 + 时间戳 pill 文案，发送出去的消息自带引用上下文。
// 两种口径：卡片「去对话追问」带选中片段 → 解释这个词句；整句意图（无
// selection）→ 解释这句字幕。
function buildExplainPrompt(intent: { from: number; content: string; selection?: string }): string {
  const stamp = formatClock(intent.from, { hours: "auto" });
  if (intent.selection) {
    return `请结合视频上下文解释我选中的词句：「${intent.selection}」。它出自字幕句「${intent.content}」（${stamp}）。说明它的含义、背景，以及在这句话里指什么。`;
  }
  return `请结合视频上下文解释这句字幕：「${intent.content}」（${stamp}）。说明它的含义、背景，以及与前后文的关系。`;
}

function renderExplainIntentCard(intent: { from: number; content: string; selection?: string }): void {
  if (!els.intentCard) {
    return;
  }
  const quote = els.intentCard.querySelector<HTMLElement>(".biliscript-reading-chat-intent-quote");
  if (quote) {
    quote.textContent = intent.selection ? `「${intent.selection}」｜${intent.content}` : `「${intent.content}」`;
  }
  const stamp = els.intentCard.querySelector<HTMLElement>(".biliscript-reading-chat-intent-time");
  if (stamp) {
    stamp.textContent = formatClock(intent.from, { hours: "auto" });
  }
  els.intentCard.hidden = false;
}

function hideExplainIntentCard(): void {
  if (els.intentCard) {
    els.intentCard.hidden = true;
  }
}

// peek 意图 → 渲染引用卡 → 自动发送解释提示词；发送成功（发送流程受理）才
// consumePendingExplainIntent——一次意图只发一次。发送被 subtitle-wait 挂起时
// sendMessage 的 promise 不提前兑现（等待在其内部 await），意图保持 pending
// 直到真正发出或用户取消（引用卡上的取消按钮）。
async function consumeExplainIntentIfPending(): Promise<void> {
  const intent = peekPendingExplainIntent();
  if (!intent || !intent.content) {
    hideExplainIntentCard();
    return;
  }
  renderExplainIntentCard(intent);
  const sent = await autoSendPrompt(buildExplainPrompt(intent));
  if (sent) {
    consumePendingExplainIntent();
    hideExplainIntentCard();
  }
}

// 发送芯（runQuickActionPrompt / autoSendPrompt 的共同尾部）：填输入框 →
// autosize → sendMessage → 折算是否受理。两函数头部的闸（新会话 vs 双发闸、
// 空串聚焦 vs 空串直 false）语义不同，不并入本芯。
// 受理成功 = 发送路径清空了输入框（ensureCurrentContextForSend 通过后才会清）；
// false = 被 provider/上下文/无字幕闸拦下（notice 已显示）。
async function sendViaInputBox(text: string): Promise<boolean> {
  els.input.value = text;
  autosizeInput();
  // 回放让出期发送同样先等回放落定（否则新消息插进未完成回放的中间）。
  await conversationReplayInFlight;
  // sendMessage 兑现即发送流程已出结果（subtitle-wait 挂起在其内部 await）。
  await chatRuntime.sendMessage();
  return els.input.value === "" || chatRuntime.hasPendingUserPrompt();
}

// 自动发送共用体：填输入框 → sendMessage → 折算是否受理。流式中/有待发 prompt
// 时不注入第二次发送（双发竞态闸也会拦下），返回 false 让意图保持 pending。
async function autoSendPrompt(text: string): Promise<boolean> {
  if (!text.trim()) {
    return false;
  }
  if (chatRuntime.isStreaming() || chatRuntime.hasPendingUserPrompt()) {
    return false;
  }
  return sendViaInputBox(text);
}
// ============================================================
// bindEvents（元素级绑定；全局触发源见 bindGlobalTriggers）
// ============================================================

// 消息区滚动通知 rAF 合帧（10-2）：滚动事件的判定回调会在每次触发时读
// scrollHeight（强制布局）。按帧合批——同帧多条 scroll 只判定/通知一次，
// scrollHeight 读沉到帧回调，且来自 scrollToBottom 的写后紧跟读不再交错。
let scrollSyncFrame = 0;
function flushScrollAutoScrollSync(): void {
  scrollSyncFrame = 0;
  chatRuntime.setAutoScroll(isMessagesNearBottom());
}
function scheduleScrollAutoScrollSync(): void {
  if (scrollSyncFrame) {
    return;
  }
  if (typeof window.requestAnimationFrame === "function") {
    scrollSyncFrame = window.requestAnimationFrame(flushScrollAutoScrollSync);
  } else {
    scrollSyncFrame = window.setTimeout(flushScrollAutoScrollSync, 16);
  }
}

function bindEvents(): void {
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void sendFromUi();
    }
  });
  // 图片粘贴（image-input 02 号票）：仅当剪贴板含 image/* 时拦截（纯文本/其它
  // 非图片内容不 preventDefault，既有粘贴行为不变）；压缩与上限判定在
  // chat/chat-input-images.ts，拒绝提示走消息区通知条。
  els.input.addEventListener("paste", (e) => {
    inputImages.handlePaste(e);
  });
  els.input.addEventListener("input", () => {
    autosizeInput();
    updateSendBtnState();
  });
  els.messages.addEventListener("scroll", scheduleScrollAutoScrollSync);
  els.contextChip.addEventListener("click", () => {
    void openCurrentContextInReader();
  });
  els.newChatBtn.addEventListener("click", () => {
    void startNewConversation();
  });
  els.refreshBtn.addEventListener("click", () => refreshContextManually());
  els.presetBtn.addEventListener("click", popovers.togglePresetPopover);
  els.historyBtn.addEventListener("click", popovers.toggleHistoryPopover);
  els.historyClearBtn?.addEventListener("click", () => {
    void conversationStore.clearAll();
  });
  // 模型 chip：点开模型 + 思考档位面板。
  els.modelChip.addEventListener("click", popovers.toggleModelPanel);
  // 发送键：空闲走与回车同一发送路径；流式中同键变停止键（圆形 + 方块图标）。
  els.sendBtn.addEventListener("click", () => {
    if (els.sendBtn.classList.contains("is-stop")) {
      chatRuntime.stopActiveStream();
      return;
    }
    void sendFromUi();
  });
  els.presetAddBtn.addEventListener("click", () => presets.addPresetPrompt());
  els.presetInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      presets.addPresetPrompt();
    }
  });
  els.modelSelect.addEventListener("change", () => {
    // multi-model-catalog：选项值是「平台 id\u0001模型 id」复合值。选中项的
    // 持久化 = 复合值进 chrome.storage.local（providers 模块的 setSelectedProvider，
    // renderModelSelect 的选中回落直接消费）；sync settings 的 defaultModel 仍是
    // 裸平台 id（SW 激活平台解析的消费口径不变）。
    const selected = parseModelOptionValue(els.modelSelect.value);
    const providerId = selected.providerId;
    if (providerId) {
      providerPrefs.setSelectedProvider(els.modelSelect.value);
      chatSessionState.aiPrefs.defaultModel = providerId;
      chrome.storage.sync.set({ defaultModel: providerId }).catch(() => {});
    } else {
      chatSessionState.aiPrefs.defaultModel = "";
      chrome.storage.sync.set({ defaultModel: "" }).catch(() => {});
    }
    updateModelSelectWidth(widthEls);
    // 模型选择变化：重渲 chip 文案（模型名）+ 重判提示（含从「关不掉」模型
    // 切回可关模型时消失）。
    modelPanel.renderChip();
    updateThinkingHint();
  });
  els.thinkingBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      // setThinkingLevel 首行同步写 chatSessionState.aiThinkingLevel，紧随的
      // 重判读到的是新档位（档位切走即收提示，切回 Off 再现）。
      void setThinkingLevel(btn.dataset.level || "off");
      // chip 上的档位文案随新档位重渲。
      modelPanel.renderChip();
      updateThinkingHint();
    });
  });
  // 联网搜索开关（spec §4）：点击即改全局记忆（sync settings.webSearchEnabled）。
  if (els.webSearchPill) {
    els.webSearchPill.addEventListener("click", () => {
      void setWebSearchEnabled(!chatSessionState.webSearchEnabled);
    });
  }
  window.addEventListener("resize", onWindowResize);
  // 容器层委托（对话 tab 根节点 #readingChatRoot，元素随态重建而容器不换，
  // 对齐 batched-render 头注的容器委托先例）：
  //   1. 引用卡取消：[data-chat-intent-action="cancel"] 点击；
  //   2. 图片附件删除：[data-chat-image-remove] 点击（附件条目由
  //      chat/chat-input-images.ts 重建，容器委托对每次重建的键都生效）；
  //   3. 无平台空态「前往设置」：[id=readingChatOpenSettings] 点击 → 打开侧边栏
  //      设置抽屉（arch-slim-2/06 死绑定修复——该链接由 renderInitialState →
  //      resetConversationView 用 innerHTML 后建，原先 ui-renderer 在壳构建时
  //      getElementById 直绑，绑定时点早于元素诞生、监听器永远挂不上；容器
  //      委托对每次重建的链接都生效。href="#" 的默认跳转一并 preventDefault）。
  els.root.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const intentBtn = target?.closest<HTMLElement>("[data-chat-intent-action]");
    if (intentBtn && intentBtn.dataset.chatIntentAction === "cancel") {
      clearPendingExplainIntent();
      hideExplainIntentCard();
      return;
    }
    const removeBtn = target?.closest<HTMLElement>("[data-chat-image-remove]");
    if (removeBtn) {
      inputImages.removeAt(Number(removeBtn.dataset.chatImageRemove));
      return;
    }
    if (target?.closest<HTMLElement>(`[id="${ids.readingChatOpenSettings}"]`)) {
      // stopPropagation 必须有：打开抽屉的点击若继续冒泡到 ui-renderer 的文档级
      // click 委托，会被「settingsExpanded 已开 + 点在面板外」判定当成外点立即
      // 关闭（与壳内 readingSettingsToggleBtn 的 stopPropagation 同一先例）。
      event.preventDefault();
      event.stopPropagation();
      requestUiCommand("open-settings");
    }
  });
}

function onWindowResize(): void {
  // resize 路径读写交错（P2-3）：经 rAF 合帧，一帧至多跑一次「读布局 → 写宽度」。
  scheduleModelSelectWidthUpdate(widthEls);
}
// chip 点击的 reader 适配（sidepanel 版为 openCurrentContextUrl：chrome.tabs.update
// 跳转活动标签页）。content script 无 chrome.tabs：同视频只做静默强刷；绑定会话
// 指向别的视频时页内导航到目标 URL（保留 biliscript_reader=1，阅读模式随 URL 恢复）。
// URL 拼法单源在 bilibili/reader-url.ts 的 buildReaderModeUrl（arch-slim-2/03）。
async function openCurrentContextInReader(): Promise<void> {
  const targetUrl = String(chatSessionState.contextData?.url || chatSessionState.currentConversationMeta?.contextUrl || "").trim();
  if (!targetUrl) {
    return;
  }
  try {
    if (doesTabMatchContextUrl(location.href, targetUrl)) {
      await loadContextState({ forceRefresh: true, silent: true });
      return;
    }
    location.href = buildReaderModeUrl(targetUrl);
  } catch {}
}
// AI 平台 / 预设：实现在 ../chat/providers.ts，本文件只组装 deps 并保留「外部
// 设置变更 → 刷新」编排（流式守卫 + 重渲染留在组合根）。
async function refreshProvidersAndPrefsAfterExternalChange(): Promise<void> {
  // 选中平台回退取 providers 模块的 storage 闭包缓存。
  const previousProviderId = String(els.modelSelect?.value || providerPrefs.getStoredSelectedProviderId() || "").trim();
  await loadProvidersAndPrefs({ preferredProviderId: previousProviderId });
  // 外部变更可能整体替换平台列表/选中平台/档位：与 init 同口径重渲 chip + 重判提示。
  modelPanel.renderChip();
  updateThinkingHint();
  if (chatRuntime.isStreaming()) {
    return;
  }
  lists.renderHistoryList();
  renderInitialState();
}
// 【整段迁移自 sidepanel.ts】手动刷新（含刷新键 loading 与转写提示收尾）。
async function refreshContextManually(): Promise<void> {
  if (els.refreshBtn.disabled) {
    return;
  }
  setRefreshing(true);
  try {
    const ok = await loadContextState({ forceRefresh: true });
    if (ok) {
      if (!chatSessionState.contextData || !chatSessionState.providers.length || !chatSessionState.chatHistory.length) {
        renderInitialState();
      } else {
        lists.renderSuggestions();
      }
    }
  } finally {
    setRefreshing(false);
  }
}

function setRefreshing(isRefreshing: boolean): void {
  els.refreshBtn.disabled = isRefreshing;
  els.refreshBtn.classList.toggle("is-loading", isRefreshing);
  if (isRefreshing) {
    els.refreshBtn.setAttribute("aria-busy", "true");
  } else {
    els.refreshBtn.removeAttribute("aria-busy");
    // 刷新结束即转写（若有）收尾，收起“正在音频转写”提示（非转写相位时隐藏）。
    updateAsrNotice();
  }
}

// 【整段迁移自 sidepanel.ts】开启新会话：隐藏 popover → 强刷静默取上下文 →
// live 快照落地主上下文 → restartChat(keepContext) → 初始态渲染。
async function startNewConversation(): Promise<void> {
  popovers.hidePresetPopover();
  popovers.hideHistoryPopover();
  popovers.hideModelPanel();
  setRefreshing(true);
  try {
    await loadContextState({ forceRefresh: true, silent: true });
  } finally {
    setRefreshing(false);
  }
  if (chatSessionState.liveContextData) {
    chatSessionState.contextData = { ...chatSessionState.liveContextData };
    chatSessionState.currentContextKey = chatSessionState.liveContextKey || buildContextKey(chatSessionState.liveContextData);
    updateContextChip();
  }
  restartChat({ keepContext: true });
  renderInitialState();
}
