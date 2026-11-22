import { DEFAULT_SETTINGS } from "../core/defaults.js";
import { DEFAULT_PLAYER_AI_QUICK_PROMPT } from "../core/default-prompts.js";
import { PRESETS, ASR_PROVIDER_PRESETS } from "../core/presets.js";
import { normalizePlayerAiQuickPrompt } from "../core/validators.js";
import { buildReaderModeUrl, isSupportedBilibiliPage } from "../bilibili/video-id-shared.js";
import { openOnboardingPage, runOnInstalled } from "./on-installed.js";
import {
  EXPECTED_CONTENT_SCRIPT_VERSION,
  injectReaderContent,
  probeContentScriptVersion,
  triggerReaderModeInTab,
  triggerReaderModeToggleInTab
} from "./content-orchestration-wiring.js";
import { isBenignTabUnavailableError } from "../core/background-content-orchestration.js";
import {
  applyUnsupportedPageFeedback,
  clearUnsupportedPageFeedback,
  isWwwBilibiliPage,
  showUnsupportedPageToast
} from "./unsupported-page-feedback.js";
import { normalizeSettings, saveSettings } from "../core/settings-store.js";
import { createSaveSettingsHandler } from "../core/save-settings-handler.js";
import {
  getSettingsSnapshot,
  getProviderStore as getProviderStoreSnapshot,
  getSearchProviderOrder,
  getSearchHealth,
  invalidatingWrite,
  writeSnapshotKeys,
  PROVIDER_FAMILY_STORAGE_KEYS
} from "../core/settings-snapshot.js";
import {
  applyPlayerAiQuickActionDefaultOnMigration,
  applySubtitleTranslateDefaultMigration,
  planSearchPresetsAutoActivation
} from "./settings-migration.js";
import { registerDebugLogGate } from "../shared/debug-log-gate.js";
import { watchStorageKeys } from "../shared/watch-storage-keys.js";
import { logWarn, logWarnAlways } from "../shared/logging.js";
import { createAgentBridge, testAgentBridgeConnection } from "../agent-bridge/background.js";
import { AGENT_BRIDGE_ALARM } from "../agent-bridge/protocol.js";
import {
  aiProviderStore
} from "../core/ai-provider-store.js";
import { asrProviderStore } from "../asr/asr-provider-store.js";
import { liveProviderStore } from "../live/live-provider-store.js";
import {
  liveSessionTracker,
  clearMossLiveWsAuthRule
} from "../live/live-session-tracker.js";
import { searchProviderStore } from "../search/search-provider-store.js";
import { deleteSearchProviderAndClearCache } from "../search/search-provider-deletion.js";
import { createSearchCacheHandler } from "../search/search-cache-handler.js";
import { createSearchHealthHandler } from "../search/search-health-handler.js";
import { createResolveSearchProviderHandler } from "../search/resolve-search-provider-handler.js";
import { createSearchOptOutHook } from "../search/search-opt-out.js";
import { handleProviderHttpRequest } from "../core/provider-http.js";
import {
  createProviderMessageHandlers,
  createAsrRuntimeConfigHandler,
  createAiResolvedProviderHandler,
  createSubtitleTranslateProviderHandler,
  withOkResponse
} from "../core/provider-handlers.js";
import { createSegmentCacheHandler } from "../ai/segment-cache-handler.js";
import { createSubtitleCacheHandler } from "../subtitle/subtitle-cache-handler.js";
import { migrateLegacyLocalStorageToIdb } from "../subtitle/storage-migration.js";
import { isSwKeepalivePort } from "../ai/sw-keepalive.js";
import { bgFetchJson, isBiliUrl } from "../bilibili/gateway-core.js";
import {
  createHostPermissionHandlers,
  type PermissionGrantWindowsAdapter
} from "../core/host-permission-handlers.js";
import {
  ensureIndexTranslateSessionRule,
  ensureOffscreenDocument,
  hasOffscreenDocument,
  hasOpenBilibiliTabs,
  isOffscreenDocumentSender,
  OFFSCREEN_SENDER_REJECTION_MESSAGE,
  reapAllBiliMediaSessionRules
} from "../core/offscreen-host.js";
import { attachChatSpeechPort } from "../chat/chat-speech-bg.js";
import { handleAsrDecodePrepare, handleAsrDecodeCleanup, handleOffscreenRequestClose } from "../asr/offscreen-bridge.bg.js";
import { ASR_TASK_PREPARE, ASR_TASK_CLEANUP } from "../asr/protocol.js";
import { createMessageRouter } from "../core/message-router.js";
import {
  type BackgroundMessage,
  type BackgroundMessageHandler,
  type BackgroundMessageHandlers,
  type BackgroundMessageType,
  type BackgroundResponseOf,
  type AsrProviderListEntry,
  type MessageReplyDecision,
  type MessageSender,
  type ProviderListEntry,
  type SearchProviderListEntry,
  type LiveProviderListEntry
} from "../shared/messaging-protocol.js";

const saveSettingsWithInvalidate = invalidatingWrite(
  saveSettings,
  (payload) => Object.keys((payload || {}) as object)
);

type Msg<T extends BackgroundMessageType> = Extract<BackgroundMessage, { type: T }>;
type Reply<T extends BackgroundMessageType> = (response: BackgroundResponseOf<T>) => void;

function handleGetSettings(_message: Msg<"get-settings">, _sender: MessageSender, sendResponse: Reply<"get-settings">): void {
  withOkResponse(
    (async () => ({ ok: true, settings: await getSettingsSnapshot() }))(),
    sendResponse
  );
}

const agentBridge = createAgentBridge({
  getConfig: async () => {
    const settings = await getSettingsSnapshot();
    return { enabled: settings.enableAgentBridge === true, url: settings.agentBridgeUrl };
  }
});

function handleAgentBridgeStatus(_message: Msg<"agent-bridge-status">, _sender: MessageSender, sendResponse: Reply<"agent-bridge-status">): void {
  sendResponse({ ok: true, ...agentBridge.getStatus() });
}

function handleAgentBridgeConnect(_message: Msg<"agent-bridge-connect">, _sender: MessageSender, sendResponse: Reply<"agent-bridge-connect">): void {
  withOkResponse(
    (async () => ({ ok: true, connected: await agentBridge.connect() }))(),
    sendResponse
  );
}

function handleAgentBridgeTest(message: Msg<"agent-bridge-test">, _sender: MessageSender, sendResponse: Reply<"agent-bridge-test">): void {
  withOkResponse(
    (async () => ({ ok: true, connected: await testAgentBridgeConnection(message.url) }))(),
    sendResponse
  );
}

const handleSaveSettings = createSaveSettingsHandler({
  saveSettingsWithInvalidate,
  getSettingsSnapshot,
  onSearchOptOut: createSearchOptOutHook({ logWarn }),
  onSettingsSaved: agentBridge.sync
});

const hostPermissionHandlers = createHostPermissionHandlers({
  get permissions() {
    return chrome.permissions;
  },
  get windows() {
    return (chrome as unknown as { windows?: PermissionGrantWindowsAdapter }).windows;
  },
  getRuntimeUrl: (path) => chrome.runtime.getURL(path),
  get runtimeId() {
    return (chrome.runtime as unknown as { id?: string } | undefined)?.id;
  }
});

function handleEnsureOffscreenChat(_message: Msg<"ensure-offscreen-chat">, _sender: MessageSender, sendResponse: Reply<"ensure-offscreen-chat">): void {
  withOkResponse(
    (async () => {
      await ensureIndexTranslateSessionRule().catch((error) => {
        logWarn("[BILISCRIPT] ensureIndexTranslateSessionRule failed", error);
      });
      return { ok: true, ensured: await ensureOffscreenDocument() };
    })(),
    sendResponse
  );
}

const readerTriggerFailedText = "阅读模式触发失败，请刷新浏览器网页重试";

async function triggerReaderChatInTab(
  tabId: number,
  options: {
    requireQuickActionEnabled: boolean;
    readerUrl: string;
  }
): Promise<{ ok: true }> {
  const settings = await getSettingsSnapshot();
  if (options.requireQuickActionEnabled && !settings.enablePlayerAiQuickAction) {
    throw new Error("AI 按钮未开启");
  }
  const prompt = normalizePlayerAiQuickPrompt(settings.playerAiQuickPrompt || DEFAULT_PLAYER_AI_QUICK_PROMPT);
  let url = options.readerUrl;
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== "www.bilibili.com") {
        throw new Error("当前网页不是 B 站视频页");
      }
      parsed.searchParams.set("biliscript_reader", "1");
      url = parsed.toString();
    } catch (error) {
      throw new Error((error as Error).message || "阅读视图地址无效");
    }
  }
  const triggered = await triggerReaderModeInTab(tabId, url, { prompt });
  if (!triggered) {
    throw new Error(readerTriggerFailedText);
  }
  return { ok: true };
}

function handlePlayerAiQuickAction(message: Msg<"player-ai-quick-action">, sender: MessageSender, sendResponse: Reply<"player-ai-quick-action">): MessageReplyDecision {
  const senderTabId = Number(sender.tab?.id) || 0;
  const requestedTabId = Number(message.tabId) || 0;
  if (senderTabId && requestedTabId && requestedTabId !== senderTabId) {
    sendResponse({ ok: false, error: "请求目标与发送者标签页不一致，已拒绝。" });
    return "answered";
  }
  const tabId = senderTabId || requestedTabId;
  if (!tabId) {
    sendResponse({ ok: false, error: "找不到当前标签页。" });
    return "answered";
  }

  withOkResponse(
    triggerReaderChatInTab(tabId, {
      requireQuickActionEnabled: true,
      readerUrl: ""
    }),
    sendResponse,
    (error) => (error as Error).message || "打开 AI 对话失败"
  );
  return "hold";
}

function handleFetchJson(message: Msg<"fetch-json">, _sender: MessageSender, sendResponse: Reply<"fetch-json">): MessageReplyDecision {
  const url = typeof message.url === "string" ? message.url : "";
  if (!url) {
    sendResponse({ ok: false, error: "Missing subtitle URL" });
    return "answered";
  }
  if (!isBiliUrl(url)) {
    sendResponse({ ok: false, error: "Non-Bilibili URL" });
    return "answered";
  }

  withOkResponse(
    (async () => ({ ok: true, data: await bgFetchJson(url) }))(),
    sendResponse,
    (error) => (error instanceof SyntaxError ? "Invalid JSON response" : (error as Error).message)
  );
  return "hold";
}

const aiProviderHandlers = createProviderMessageHandlers<ProviderListEntry>({
  loadProviders: aiProviderStore.loadProviders,
  saveProviders: invalidatingWrite(aiProviderStore.saveProviders, PROVIDER_FAMILY_STORAGE_KEYS.ai),
  deleteProvider: invalidatingWrite(aiProviderStore.deleteProvider, PROVIDER_FAMILY_STORAGE_KEYS.ai),
  loadKeys: aiProviderStore.loadKeys
});

const aiResolvedProviderHandler = createAiResolvedProviderHandler({
  getMergedSettings: getSettingsSnapshot,
  loadProviders: async () => (await getProviderStoreSnapshot("ai")).providers,
  loadKeys: async () => (await getProviderStoreSnapshot("ai")).keys
});

const subtitleTranslateProviderHandler = createSubtitleTranslateProviderHandler({
  getMergedSettings: getSettingsSnapshot,
  loadProviders: async () => (await getProviderStoreSnapshot("ai")).providers,
  loadKeys: async () => (await getProviderStoreSnapshot("ai")).keys
});

function handleAiPresetsList(_message: Msg<"ai-presets-list">, _sender: MessageSender, sendResponse: Reply<"ai-presets-list">): void {
  sendResponse({ ok: true, presets: PRESETS.slice() });
}

function handleProviderHttp(message: Msg<"provider-http">, _sender: MessageSender, sendResponse: Reply<"provider-http">): void {
  withOkResponse(
    handleProviderHttpRequest({
      url: message.url,
      method: message.method,
      headers: message.headers,
      body: message.body
    }),
    sendResponse,
    (error) => (error as Error | undefined)?.message || String(error)
  );
}

const handleResolveSearchProvider = createResolveSearchProviderHandler({
  getSettings: getSettingsSnapshot,
  getSearchStore: () => getProviderStoreSnapshot("search"),
  getAiStore: () => getProviderStoreSnapshot("ai"),
  getOrder: getSearchProviderOrder,
  getHealth: getSearchHealth,
  now: () => Date.now()
});

const handleSearchCache = createSearchCacheHandler();
const handleSearchHealth = createSearchHealthHandler();

function handleAsrPresetsList(_message: Msg<"asr-presets-list">, _sender: MessageSender, sendResponse: Reply<"asr-presets-list">): void {
  sendResponse({ ok: true, presets: ASR_PROVIDER_PRESETS.slice() });
}

const asrProviderHandlers = createProviderMessageHandlers<AsrProviderListEntry>({
  loadProviders: asrProviderStore.loadProviders,
  saveProviders: invalidatingWrite(asrProviderStore.saveProviders, PROVIDER_FAMILY_STORAGE_KEYS.asr),
  deleteProvider: invalidatingWrite(asrProviderStore.deleteProvider, PROVIDER_FAMILY_STORAGE_KEYS.asr),
  loadKeys: asrProviderStore.loadKeys
});

const searchProviderHandlers = createProviderMessageHandlers<SearchProviderListEntry>({
  loadProviders: searchProviderStore.loadProviders,
  saveProviders: invalidatingWrite(searchProviderStore.saveProviders, PROVIDER_FAMILY_STORAGE_KEYS.search),
  deleteProvider: deleteSearchProviderAndClearCache({
    invalidatingWrite,
    storageKeys: PROVIDER_FAMILY_STORAGE_KEYS.search,
    writeSnapshotKeys
  }),
  loadKeys: searchProviderStore.loadKeys
});

const saveSearchProvidersWithInvalidate = invalidatingWrite(
  searchProviderStore.saveProviders,
  PROVIDER_FAMILY_STORAGE_KEYS.search
);

const handleGetAsrRuntimeConfig = createAsrRuntimeConfigHandler({
  getMergedSettings: getSettingsSnapshot,
  loadProviders: async () => (await getProviderStoreSnapshot("asr")).providers,
  getAsrProviderKey: async (providerId) => {
    const { keys } = await getProviderStoreSnapshot("asr");
    return String(keys[providerId] || "").trim();
  }
});

const handleSegmentCache = createSegmentCacheHandler();
const handleSubtitleCache = createSubtitleCacheHandler();

const liveProviderHandlers = createProviderMessageHandlers<LiveProviderListEntry>({
  loadProviders: liveProviderStore.loadProviders,
  saveProviders: invalidatingWrite(liveProviderStore.saveProviders, PROVIDER_FAMILY_STORAGE_KEYS.live),
  deleteProvider: invalidatingWrite(liveProviderStore.deleteProvider, PROVIDER_FAMILY_STORAGE_KEYS.live),
  loadKeys: liveProviderStore.loadKeys
});

function handleLiveSessionPrepare(
  message: Msg<"live-session-prepare">,
  sender: MessageSender,
  sendResponse: Reply<"live-session-prepare">
): void {
  withOkResponse(
    liveSessionTracker.prepare(
      message?.sessionId || "",
      sender.tab?.id
    ),
    sendResponse
  );
}

function handleLiveSessionCleanup(
  message: Msg<"live-session-cleanup">,
  _sender: MessageSender,
  sendResponse: Reply<"live-session-cleanup">
): void {
  withOkResponse(
    liveSessionTracker.cleanup(
      message?.sessionId
    ),
    sendResponse
  );
}

const offloadTaskHandlers = new Map<string, (message: unknown, sender: MessageSender, sendResponse: Reply<"offload-task">) => void>([
  [ASR_TASK_PREPARE, handleAsrDecodePrepare],
  [ASR_TASK_CLEANUP, handleAsrDecodeCleanup]
]);

function handleOffloadTask(message: Msg<"offload-task">, _sender: MessageSender, sendResponse: Reply<"offload-task">): MessageReplyDecision {
  const taskType = String(message.taskType || "").trim();
  const handler = offloadTaskHandlers.get(taskType);
  if (!handler) {
    sendResponse({ ok: false, error: "不支持的 offscreen 任务类型：" + taskType });
    return "answered";
  }
  handler(message, _sender, sendResponse);
  return "hold";
}

function handleOffscreenRequestCloseMsg(_message: Msg<"offscreen-request-close">, sender: MessageSender, sendResponse: Reply<"offscreen-request-close">): void {
  void handleOffscreenRequestClose(_message, sender, sendResponse);
}

function handleGetDebugLogGate(_message: Msg<"get-debug-log-gate">, _sender: MessageSender, sendResponse: Reply<"get-debug-log-gate">): void {
  withOkResponse(
    (async () => {
      const settings = await getSettingsSnapshot();
      return { ok: true, enabled: settings.enableDebugLogs };
    })(),
    sendResponse
  );
}

function handleOpenOnboarding(_message: Msg<"open-onboarding">, _sender: MessageSender, sendResponse: Reply<"open-onboarding">): void {
  withOkResponse(
    (async () => {
      const opened = await openOnboardingPage({
        getURL: (path) => chrome.runtime.getURL(path),
        createTab: (createProperties) => chrome.tabs.create(createProperties),
        logWarn
      });
      return opened ? { ok: true } : { ok: false, error: "打开引导页失败" };
    })(),
    sendResponse
  );
}

const messageHandlerTable = {
  "get-settings": handleGetSettings,
  "save-settings": handleSaveSettings,
  "agent-bridge-status": handleAgentBridgeStatus,
  "agent-bridge-connect": handleAgentBridgeConnect,
  "agent-bridge-test": handleAgentBridgeTest,
  "request-provider-origins": hostPermissionHandlers.requestProviderOrigins,
  "check-provider-origin": hostPermissionHandlers.checkProviderOrigin,
  "revoke-provider-origin": hostPermissionHandlers.revokeProviderOrigin,
  "ensure-offscreen-chat": handleEnsureOffscreenChat,
  "player-ai-quick-action": handlePlayerAiQuickAction,
  "fetch-json": handleFetchJson,
  "ai-providers-list": aiProviderHandlers.list,
  "ai-presets-list": handleAiPresetsList,
  "get-ai-provider-key": aiProviderHandlers.get,
  "ai-providers-save": aiProviderHandlers.save,
  "ai-providers-delete": aiProviderHandlers.remove,
  "provider-http": handleProviderHttp,
  "resolve-ai-provider": aiResolvedProviderHandler,
  "resolve-subtitle-translate-provider": subtitleTranslateProviderHandler,
  "asr-presets-list": handleAsrPresetsList,
  "asr-providers-list": asrProviderHandlers.list,
  "asr-providers-save": asrProviderHandlers.save,
  "asr-providers-delete": asrProviderHandlers.remove,
  "get-asr-runtime-config": handleGetAsrRuntimeConfig,
  "search-providers-list": searchProviderHandlers.list,
  "search-providers-save": searchProviderHandlers.save,
  "search-providers-delete": searchProviderHandlers.remove,
  "live-providers-list": liveProviderHandlers.list,
  "live-providers-save": liveProviderHandlers.save,
  "live-providers-delete": liveProviderHandlers.remove,
  "live-session-prepare": handleLiveSessionPrepare,
  "live-session-cleanup": handleLiveSessionCleanup,

  "resolve-search-provider": handleResolveSearchProvider,
  "search-cache": handleSearchCache,
  "search-health": handleSearchHealth,
  "segment-cache": handleSegmentCache,
  "subtitle-cache": handleSubtitleCache,
  "offload-task": handleOffloadTask,
  "offscreen-request-close": handleOffscreenRequestCloseMsg,
  "get-debug-log-gate": handleGetDebugLogGate,
  "open-onboarding": handleOpenOnboarding,
  "permission-grant-result": hostPermissionHandlers.permissionGrantResult
} satisfies BackgroundMessageHandlers;

chrome.runtime.onInstalled.addListener(async (details) => {
  await runOnInstalled(details, {
    installReason:
      (chrome.runtime as unknown as { OnInstalledReason?: { INSTALL?: string } }).OnInstalledReason?.INSTALL ?? "install",
    getURL: (path) => chrome.runtime.getURL(path),
    createTab: (createProperties) => chrome.tabs.create(createProperties),
    logWarn,
    reapSessionRules: async () => {
      await reapAllBiliMediaSessionRules();
      await clearMossLiveWsAuthRule();
      await ensureIndexTranslateSessionRule();
    },
    initializeSettingsStorage,
    autoActivateSearchPresets,
    migrateLegacyStorage: () => migrateLegacyLocalStorageToIdb()
  });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab.url) return;
  if (!isSupportedBilibiliPage(tab.url)) return;

  try {
    const loadedVersion = await probeContentScriptVersion(tabId);
    if (loadedVersion !== EXPECTED_CONTENT_SCRIPT_VERSION) {
      await injectReaderContent(tabId);
    }
  } catch (error) {
    if (!isBenignTabUnavailableError(error)) {
      logWarn("[BILISCRIPT] speculative reader content reinjection failed", error);
    }
  }
});

chrome.action.onClicked.addListener(
  async (tab) => {
    const tabId = tab.id ?? 0;
    if (!tabId) {
      return;
    }
    if (isSupportedBilibiliPage(tab.url)) {
      let triggered = false;
      let triggerError: unknown = null;
      try {
        triggered = await triggerReaderModeInTab(tabId, buildReaderModeUrl(tab.url || ""));
      } catch (error) {
        triggerError = error;
      }
      if (triggered) {
        await clearUnsupportedPageFeedback(tabId);
      } else {
        if (triggerError) {
          logWarn("[BILISCRIPT] toolbar action click: reader-enter 触发失败", triggerError);
        } else {
          logWarn("[BILISCRIPT] toolbar action click: reader-enter 触发失败（重试耗尽）");
        }
        await Promise.allSettled([
          chrome.action.setBadgeText({ tabId, text: "!" }),
          chrome.action.setTitle({
            tabId,
            title: "BiliScript｜文摘面板打开失败，请刷新浏览器网页重试"
          })
        ]);
      }
      return;
    }
    await applyUnsupportedPageFeedback(tabId);
    if (isWwwBilibiliPage(tab.url)) {
      try {
        await showUnsupportedPageToast(tabId);
      } catch (error) {
        logWarnAlways("[BILISCRIPT] unsupported-page toast injection failed", error);
      }
    }
  }
);

const TOGGLE_READER_COMMAND = "toggle-reader";

chrome.commands.onCommand.addListener(async (command, commandTab) => {
  if (command !== TOGGLE_READER_COMMAND) {
    return;
  }
  let targetTab = commandTab;
  if (!targetTab?.id || !targetTab?.url) {
    const queried = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    targetTab = queried?.[0] ?? targetTab;
  }
  const tabId = targetTab?.id ?? 0;
  if (!tabId) {
    return;
  }
  if (isSupportedBilibiliPage(targetTab?.url)) {
    let triggered = false;
    let triggerError: unknown = null;
    try {
      triggered = await triggerReaderModeToggleInTab(tabId, buildReaderModeUrl(targetTab?.url || ""));
    } catch (error) {
      triggerError = error;
    }
    if (triggered) {
      await clearUnsupportedPageFeedback(tabId);
    } else if (triggerError) {
      logWarn("[BILISCRIPT] toggle-reader command: reader-toggle 触发失败", triggerError);
    } else {
      logWarn("[BILISCRIPT] toggle-reader command: reader-toggle 触发失败（重试耗尽）");
    }
    return;
  }
  await applyUnsupportedPageFeedback(tabId);
  if (isWwwBilibiliPage(targetTab?.url)) {
    try {
      await showUnsupportedPageToast(tabId);
    } catch (error) {
      logWarnAlways("[BILISCRIPT] unsupported-page toast injection failed", error);
    }
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  void clearUnsupportedPageFeedback(tabId);
});

chrome.tabs.onRemoved.addListener(() => {
  void (async () => {
    if (await hasOpenBilibiliTabs()) {
      return;
    }
    if (!(await hasOffscreenDocument())) {
      return;
    }
    await Promise.resolve(
      chrome.runtime.sendMessage({ type: "offscreen-bilibili-tabs-empty" })
    ).catch(() => {});
  })().catch(() => {});
});

chrome.runtime.onConnect.addListener((port) => {
  if (attachChatSpeechPort(port)) {
    return;
  }
  if (hostPermissionHandlers.attachKeepalivePort(port)) {
    return;
  }
  if (!isSwKeepalivePort(port)) {
    return;
  }
});

watchStorageKeys(() => void agentBridge.sync(), { sync: ["enableAgentBridge", "agentBridgeUrl"] });
chrome.runtime.onStartup.addListener(() => {
  void agentBridge.sync();
  void ensureIndexTranslateSessionRule().catch((error) => {
    logWarn("[BILISCRIPT] ensureIndexTranslateSessionRule onStartup failed", error);
  });
  void migrateLegacyLocalStorageToIdb().catch((error) => {
    logWarn("[BILISCRIPT] legacy storage migration onStartup failed", error);
  });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AGENT_BRIDGE_ALARM) void agentBridge.sync();
});
void agentBridge.sync();
void migrateLegacyLocalStorageToIdb().catch((error) => {
  logWarn("[BILISCRIPT] legacy storage migration on cold start failed", error);
});

registerDebugLogGate();

watchStorageKeys((changes) => {
  void Promise.resolve(
    chrome.runtime.sendMessage({
      type: "debug-log-gate-changed",
      enabled: Boolean(changes.enableDebugLogs.newValue)
    })
  ).catch(() => {});
}, { sync: ["enableDebugLogs"] });

const messageRouter = createMessageRouter({
  handlers: messageHandlerTable,
  senders: { offscreen: isOffscreenDocumentSender },
  rejectionMessage: OFFSCREEN_SENDER_REJECTION_MESSAGE
});

chrome.runtime.onMessage.addListener(messageRouter);

async function initializeSettingsStorage() {
  const syncCurrent = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  applyPlayerAiQuickActionDefaultOnMigration(syncCurrent);
  applySubtitleTranslateDefaultMigration(syncCurrent);
  await writeSnapshotKeys(normalizeSettings({ ...DEFAULT_SETTINGS, ...syncCurrent }));
}

async function autoActivateSearchPresets(): Promise<void> {
  const settings = await getSettingsSnapshot();
  const { providers } = await getProviderStoreSnapshot("search");
  const plan = planSearchPresetsAutoActivation(settings, providers);
  if (plan.providersToAdd.length > 0) {
    await saveSearchProvidersWithInvalidate([...providers, ...plan.providersToAdd]);
  }
  if (plan.activeSearchProviderId !== undefined) {
    await writeSnapshotKeys({ activeSearchProviderId: plan.activeSearchProviderId });
  }
  if (plan.shouldWriteFlag) {
    await writeSnapshotKeys({ searchPresetsAutoActivated: true });
  }
}
