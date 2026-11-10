// extension/live/live-session-tracker.ts
// MOSS-LIVE / Gemini Live 会话所有权追踪与 DNR 鉴权规则（ruleId: 9002）单点管理模块：
// 防止乱序 prepare、过期 cleanup 与残留标签页锁踩踏在途 WebSocket 鉴权规则。

import { ensureChatOffscreenDocument } from "../chat/offscreen-ensure.js";
import {
  getAiCredentialStatusText,
  isOfficialAiCredentialEndpoint,
  resolveAiCredentialKey,
  type AiCredentialRecordLike
} from "../core/ai-credential-reference.js";
import { hasHostPermission } from "../core/host-permissions.js";
import { getProviderStore, getSettingsSnapshot } from "../core/settings-snapshot.js";
import {
  resolveActiveLiveProviderId,
  type LiveProvider
} from "./live-provider-store.js";
import {
  resolveMossLivePermissionOrigins,
  type LiveProviderType,
  type LiveSessionChannel
} from "./moss-live-protocol.js";
import type { LiveSessionTakeoverMessage } from "../shared/messaging-protocol.js";

export type { LiveSessionChannel };

// ===== 伴看会话鉴权规则（固定 ruleId: 9002，独立于 ASR 动态区间 32001..32100） =====

export const MOSS_LIVE_WS_RULE_ID = 9002;

export function extractDomainFromUrl(url: string): string {
  try {
    return new URL(url).hostname || "api.mosi.cn";
  } catch {
    return "api.mosi.cn";
  }
}

export function extractOriginHeaderFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.host) {
      return "https://api.mosi.cn";
    }
    const protocol =
      parsed.protocol === "ws:"
        ? "http:"
        : parsed.protocol === "wss:"
          ? "https:"
          : parsed.protocol === "http:" || parsed.protocol === "https:"
            ? parsed.protocol
            : "https:";
    return `${protocol}//${parsed.host}`;
  } catch {
    return "https://api.mosi.cn";
  }
}

/**
 * 动态注入针对 WebSocket 握手的鉴权请求头（Authorization 或 x-goog-api-key）与 Origin 会话规则。
 * 规避浏览器原生 WebSocket 无法自定义请求头、MV3 SW 绕过 DNR，以及扩展页面 Origin (chrome-extension://) 被服务端同源校验拒绝的限制。
 */
export async function setMossLiveWsAuthRule(
  apiKey: string,
  baseUrl?: string,
  providerType?: LiveProviderType
): Promise<void> {
  const trimmedKey = String(apiKey || "").trim();
  const isGemini = providerType === "gemini-live";
  const defaultUrl = isGemini ? "https://generativelanguage.googleapis.com" : "https://api.mosi.cn";
  const targetUrl = baseUrl || defaultUrl;
  const domain = extractDomainFromUrl(targetUrl);
  const origin = extractOriginHeaderFromUrl(targetUrl);
  const authHeader = isGemini
    ? {
        header: "x-goog-api-key",
        operation: "set" as const,
        value: trimmedKey
      }
    : {
        header: "Authorization",
        operation: "set" as const,
        value: `Bearer ${trimmedKey}`
      };
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [MOSS_LIVE_WS_RULE_ID],
    addRules: [
      {
        id: MOSS_LIVE_WS_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            authHeader,
            {
              header: "Origin",
              operation: "set",
              value: origin
            }
          ]
        },
        condition: {
          requestDomains: [domain],
          resourceTypes: ["websocket"]
        }
      }
    ]
  });
}

/**
 * 清除 MOSS-LIVE 专属会话规则（仅移除 9002，不触碰其他规则）。
 */
export async function clearMossLiveWsAuthRule(): Promise<void> {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [MOSS_LIVE_WS_RULE_ID]
  });
}

export type LiveProviderListEntry = LiveProvider & { hasSavedKey: boolean };

export type AiProviderCredentialCandidate = AiCredentialRecordLike;

export interface LiveSessionPrepareDeps {
  getSettings: () => Promise<{
    activeLiveProviderId?: string;
    liveGeminiNativeSearch?: boolean;
    liveLowBandwidth?: boolean;
  }>;
  loadProviders: () => Promise<LiveProviderListEntry[]>;
  loadKeys: () => Promise<Record<string, string>>;
  loadAiProviders?: () => Promise<readonly AiProviderCredentialCandidate[]>;
  loadAiKeys?: () => Promise<Record<string, string>>;
  hasPermission: (baseUrl: string) => Promise<boolean>;
  setAuthRule: (apiKey: string, baseUrl: string, providerType?: LiveProviderType) => Promise<void>;
  clearAuthRule: () => Promise<void>;
  ensureOffscreen: () => Promise<unknown>;
  resolveActiveId: (providers: LiveProvider[], activeId?: string) => string;
  isTabAlive?: (tabId: number) => Promise<boolean>;
  notifyTabTakeover?: (tabId: number, channel: LiveSessionChannel) => Promise<void>;
}

export type LiveFailureKind =
  | "provider-unconfigured"
  | "key-missing"
  | "key-rejected"
  | "gemini-credential"
  | "permission-denied"
  | "microphone"
  | "network"
  | "unknown";

export interface LiveSessionPrepareResult {
  ok: boolean;
  provider?: LiveProviderListEntry;
  sessionId?: string;
  liveGeminiNativeSearch?: boolean;
  liveLowBandwidth?: boolean;
  error?: string;
  failureKind?: LiveFailureKind;
}

export interface LiveSessionCleanupResult {
  ok: boolean;
  error?: string;
}

async function isTabAliveByChromeTabs(tabId: number): Promise<boolean> {
  if (typeof chrome === "undefined" || typeof chrome.tabs?.get !== "function") {
    return true;
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    return Boolean(tab);
  } catch {
    return false;
  }
}

async function notifyTabTakeoverByChromeTabs(tabId: number, channel: LiveSessionChannel): Promise<void> {
  if (typeof chrome === "undefined" || typeof chrome.tabs?.sendMessage !== "function") {
    return;
  }
  const message: LiveSessionTakeoverMessage = { type: "live-session-takeover", channel };
  try {
    // 携带通道：旧标签页只停止被接管的通道（伴看/同传），不波及其并行会话
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // 忽略旧标签页可能已关闭或未就绪的异常
  }
}

function resolvePrepareDeps(overrides?: Partial<LiveSessionPrepareDeps>): Required<LiveSessionPrepareDeps> {
  return {
    getSettings: overrides?.getSettings ?? getSettingsSnapshot,
    loadProviders: overrides?.loadProviders ?? (async () => (await getProviderStore("live")).providers),
    loadKeys: overrides?.loadKeys ?? (async () => (await getProviderStore("live")).keys),
    loadAiProviders: overrides?.loadAiProviders ?? (async () => (await getProviderStore("ai")).providers),
    loadAiKeys: overrides?.loadAiKeys ?? (async () => (await getProviderStore("ai")).keys),
    hasPermission: overrides?.hasPermission ?? hasHostPermission,
    setAuthRule: overrides?.setAuthRule ?? setMossLiveWsAuthRule,
    clearAuthRule: overrides?.clearAuthRule ?? clearMossLiveWsAuthRule,
    ensureOffscreen: overrides?.ensureOffscreen ?? ensureChatOffscreenDocument,
    resolveActiveId: overrides?.resolveActiveId ?? resolveActiveLiveProviderId,
    isTabAlive: overrides?.isTabAlive ?? isTabAliveByChromeTabs,
    notifyTabTakeover: overrides?.notifyTabTakeover ?? notifyTabTakeoverByChromeTabs
  };
}

interface LiveChannelState {
  latestRequestedOwner: string | null;
  activeRuleOwner: string | null;
  ownerTabId: number | null;
}

/**
 * 会话所有权追踪：伴看（companion）与同传（interpret）两个通道各自维护
 * latest/owner/tab 状态，跨标签页接管只在同通道内发生；DNR 鉴权规则
 * （ruleId: 9002，同域名同 Key）由两通道共享——任一通道 cleanup 只释放自己
 * 的持有，规则在最后一个持有者释放时才真正清除。
 */
export class LiveSessionTracker {
  private readonly channels = new Map<LiveSessionChannel, LiveChannelState>();
  private readonly ruleHolders = new Set<LiveSessionChannel>();

  private channelState(channel: LiveSessionChannel): LiveChannelState {
    let state = this.channels.get(channel);
    if (!state) {
      state = { latestRequestedOwner: null, activeRuleOwner: null, ownerTabId: null };
      this.channels.set(channel, state);
    }
    return state;
  }

  getLatestOwner(channel: LiveSessionChannel = "companion"): string | null {
    return this.channels.get(channel)?.latestRequestedOwner ?? null;
  }

  getActiveRuleOwner(channel: LiveSessionChannel = "companion"): string | null {
    return this.channels.get(channel)?.activeRuleOwner ?? null;
  }

  getOwnerTabId(channel: LiveSessionChannel = "companion"): number | null {
    return this.channels.get(channel)?.ownerTabId ?? null;
  }

  reset(): void {
    this.channels.clear();
    this.ruleHolders.clear();
  }

  prepare(
    sessionId: string,
    depsOrTabId?: Partial<LiveSessionPrepareDeps> | number,
    maybeTabId?: number
  ): Promise<LiveSessionPrepareResult> {
    return this.prepareFor("companion", sessionId, depsOrTabId, maybeTabId);
  }

  async prepareFor(
    channel: LiveSessionChannel,
    sessionId: string,
    depsOrTabId?: Partial<LiveSessionPrepareDeps> | number,
    maybeTabId?: number
  ): Promise<LiveSessionPrepareResult> {
    const overrides = typeof depsOrTabId === "object" && depsOrTabId !== null ? depsOrTabId : undefined;
    const tabId = typeof depsOrTabId === "number" ? depsOrTabId : maybeTabId;
    const deps = resolvePrepareDeps(overrides);
    const state = this.channelState(channel);

    if (state.ownerTabId !== null && typeof tabId === "number" && state.ownerTabId !== tabId) {
      const conflictingTabId = state.ownerTabId;
      const alive = await deps.isTabAlive(conflictingTabId);
      if (alive) {
        // 同通道内用户切换到另一个标签页并开启会话时，自动通知并关闭前一个标签页的会话
        void deps.notifyTabTakeover(conflictingTabId, channel).catch(() => {});
      }
      if (state.ownerTabId === conflictingTabId) {
        await this.cleanupByTabFor(channel, conflictingTabId, deps.clearAuthRule);
      }
    }

    const targetSessionId = sessionId.trim() || `live-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    state.latestRequestedOwner = targetSessionId;
    if (typeof tabId === "number") {
      state.ownerTabId = tabId;
    }

    const clearCurrentTabOwnershipIfUnchanged = () => {
      if (state.latestRequestedOwner === targetSessionId) {
        state.ownerTabId = null;
      }
    };

    // 回滚：仅当本通道的活跃规则仍属于本次会话时才释放持有（同通道更新的
    // prepare 已接管时不得释放）；规则只在没有任何通道持有时才真正清除
    // （同传/伴看另一方可能仍在用同一条握手规则）。
    const releaseRuleHoldIfOwned = async () => {
      if (state.activeRuleOwner !== targetSessionId) return;
      state.activeRuleOwner = null;
      this.ruleHolders.delete(channel);
      if (this.ruleHolders.size === 0) {
        try {
          await deps.clearAuthRule();
        } catch {
          // 忽略回滚错误
        }
      }
    };

    let ruleInstalledForSession = false;
    try {
      const settings = await deps.getSettings();
      const providers = await deps.loadProviders();
      const activeId = deps.resolveActiveId(providers, settings.activeLiveProviderId);
      const activeProvider = providers.find((p) => p.id === activeId);
      if (!activeProvider) {
        clearCurrentTabOwnershipIfUnchanged();
        return {
          ok: false,
          failureKind: "provider-unconfigured",
          error: "未配置 MOSS-LIVE 平台，请先在设置中添加平台并填写 API Key"
        };
      }

      const isGeminiLive =
        activeProvider.type === "gemini-live" || activeProvider.presetId === "gemini-live";
      let apiKey = "";
      if (isGeminiLive) {
        if (!isOfficialAiCredentialEndpoint("gemini-live", activeProvider.baseUrl)) {
          clearCurrentTabOwnershipIfUnchanged();
          return {
            ok: false,
            failureKind: "gemini-credential",
            error: getAiCredentialStatusText("gemini-live", "unofficial")
          };
        }
        const [aiProviders, aiKeys] = await Promise.all([
          deps.loadAiProviders(),
          deps.loadAiKeys()
        ]);
        const cred = resolveAiCredentialKey("gemini-live", aiProviders, aiKeys);
        if (!cred.key) {
          clearCurrentTabOwnershipIfUnchanged();
          return {
            ok: false,
            failureKind: "gemini-credential",
            error: getAiCredentialStatusText("gemini-live", cred.status)
          };
        }
        apiKey = cred.key;
      } else {
        const keys = await deps.loadKeys();
        apiKey = String(keys[activeId] || "").trim();
        if (!apiKey) {
          clearCurrentTabOwnershipIfUnchanged();
          return {
            ok: false,
            failureKind: "key-missing",
            error: "未配置 MOSS-LIVE 密钥，请先在设置中填写 API Key"
          };
        }
      }

      const providerType: LiveProviderType = isGeminiLive ? "gemini-live" : "moss-live";
      const [baseUrl, wsUrl] = resolveMossLivePermissionOrigins(
        activeProvider.baseUrl,
        activeProvider.model,
        providerType
      );
      const [hasHttpPerm, hasWsPerm] = await Promise.all([
        deps.hasPermission(baseUrl),
        deps.hasPermission(wsUrl)
      ]);
      const hasPerm = hasHttpPerm && hasWsPerm;
      if (!hasPerm) {
        clearCurrentTabOwnershipIfUnchanged();
        return {
          ok: false,
          failureKind: "permission-denied",
          error: `未授予平台域名权限（${baseUrl}），请在设置中重新保存该平台以授予权限`
        };
      }

      // 检查在权限校验与配置读取期间是否已被更新的会话请求取代
      if (state.latestRequestedOwner !== targetSessionId) {
        return { ok: false, error: "会话准备已过期" };
      }

      await deps.setAuthRule(apiKey, baseUrl, providerType);
      ruleInstalledForSession = true;
      state.activeRuleOwner = targetSessionId;
      this.ruleHolders.add(channel);

      await deps.ensureOffscreen();

      // 再次核对所有权：确保在确保 offscreen 期间未被更新的 prepare 取代
      if (state.latestRequestedOwner !== targetSessionId) {
        await releaseRuleHoldIfOwned();
        return { ok: false, error: "会话准备已过期" };
      }

      return {
        ok: true,
        provider: activeProvider,
        sessionId: targetSessionId,
        ...(typeof activeProvider.liveGeminiNativeSearch === "boolean"
          ? { liveGeminiNativeSearch: activeProvider.liveGeminiNativeSearch }
          : typeof settings.liveGeminiNativeSearch === "boolean"
            ? { liveGeminiNativeSearch: settings.liveGeminiNativeSearch }
            : {}),
        ...(typeof settings.liveLowBandwidth === "boolean"
          ? { liveLowBandwidth: settings.liveLowBandwidth }
          : {})
      };
    } catch (error) {
      clearCurrentTabOwnershipIfUnchanged();
      if (ruleInstalledForSession) {
        await releaseRuleHoldIfOwned();
      }
      return { ok: false, error: (error as Error)?.message || String(error) };
    }
  }

  cleanup(
    sessionId?: string,
    clearAuthRule: () => Promise<void> = clearMossLiveWsAuthRule
  ): Promise<LiveSessionCleanupResult> {
    return this.cleanupFor("companion", sessionId, clearAuthRule);
  }

  async cleanupFor(
    channel: LiveSessionChannel,
    sessionId?: string,
    clearAuthRule: () => Promise<void> = clearMossLiveWsAuthRule
  ): Promise<LiveSessionCleanupResult> {
    const state = this.channelState(channel);
    const targetSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
    try {
      if (targetSessionId) {
        if (state.latestRequestedOwner && state.latestRequestedOwner !== targetSessionId) {
          // 存在更新的准备请求，旧会话的 cleanup 不得清理新会话规则
          return { ok: true };
        }
        if (state.activeRuleOwner && state.activeRuleOwner !== targetSessionId) {
          // 活跃规则属于其他会话，旧会话的 cleanup 不得清理新会话规则
          return { ok: true };
        }
      }
      state.latestRequestedOwner = null;
      state.activeRuleOwner = null;
      state.ownerTabId = null;
      this.ruleHolders.delete(channel);
      // 规则由两通道共享：另一方仍持有时保留规则
      if (this.ruleHolders.size === 0) {
        await clearAuthRule();
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error)?.message || String(error) };
    }
  }

  cleanupByTab(
    tabId: number,
    clearAuthRule: () => Promise<void> = clearMossLiveWsAuthRule
  ): Promise<LiveSessionCleanupResult> {
    return this.cleanupByTabFor("companion", tabId, clearAuthRule);
  }

  async cleanupByTabFor(
    channel: LiveSessionChannel,
    tabId: number,
    clearAuthRule: () => Promise<void> = clearMossLiveWsAuthRule
  ): Promise<LiveSessionCleanupResult> {
    const state = this.channelState(channel);
    if (state.ownerTabId !== tabId) {
      return { ok: true };
    }
    state.latestRequestedOwner = null;
    state.activeRuleOwner = null;
    state.ownerTabId = null;
    this.ruleHolders.delete(channel);
    try {
      if (this.ruleHolders.size === 0) {
        await clearAuthRule();
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error)?.message || String(error) };
    }
  }
}

export const liveSessionTracker = new LiveSessionTracker();
