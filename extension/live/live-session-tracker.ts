// extension/live/live-session-tracker.ts
// MOSS-LIVE / Gemini Live 会话所有权追踪与 DNR 鉴权规则（ruleId: 9002）单点管理模块：
// 防止乱序 prepare、过期 cleanup 与残留标签页锁踩踏在途 WebSocket 鉴权规则。

import { ensureChatOffscreenDocument } from "../chat/offscreen-ensure.js";
import { hasHostPermission } from "../core/host-permissions.js";
import { getProviderStore, getSettingsSnapshot } from "../core/settings-snapshot.js";
import {
  GEMINI_LIVE_ROW_STATUS_TEXT,
  isOfficialGeminiEndpoint,
  resolveGeminiCredential,
  type GeminiAiRecordLike
} from "./gemini-live-credential.js";
import {
  resolveActiveLiveProviderId,
  type LiveProvider
} from "./live-provider-store.js";
import {
  resolveMossLivePermissionOrigins,
  type LiveProviderType
} from "./moss-live-protocol.js";

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

export type AiProviderCredentialCandidate = GeminiAiRecordLike;

export interface LiveSessionPrepareDeps {
  getSettings: () => Promise<{ activeLiveProviderId?: string; liveGeminiNativeSearch?: boolean }>;
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
  notifyTabTakeover?: (tabId: number) => Promise<void>;
}

export interface LiveSessionPrepareResult {
  ok: boolean;
  provider?: LiveProviderListEntry;
  sessionId?: string;
  liveGeminiNativeSearch?: boolean;
  error?: string;
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

async function notifyTabTakeoverByChromeTabs(tabId: number): Promise<void> {
  if (typeof chrome === "undefined" || typeof chrome.tabs?.sendMessage !== "function") {
    return;
  }
  try {
    await chrome.tabs.sendMessage(tabId, { type: "live-session-takeover" });
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

export class LiveSessionTracker {
  private latestRequestedOwner: string | null = null;
  private activeRuleOwner: string | null = null;
  private ownerTabId: number | null = null;

  getLatestOwner(): string | null {
    return this.latestRequestedOwner;
  }

  getActiveRuleOwner(): string | null {
    return this.activeRuleOwner;
  }

  getOwnerTabId(): number | null {
    return this.ownerTabId;
  }

  reset(): void {
    this.latestRequestedOwner = null;
    this.activeRuleOwner = null;
    this.ownerTabId = null;
  }

  async prepare(
    sessionId: string,
    depsOrTabId?: Partial<LiveSessionPrepareDeps> | number,
    maybeTabId?: number
  ): Promise<LiveSessionPrepareResult> {
    const overrides = typeof depsOrTabId === "object" && depsOrTabId !== null ? depsOrTabId : undefined;
    const tabId = typeof depsOrTabId === "number" ? depsOrTabId : maybeTabId;
    const deps = resolvePrepareDeps(overrides);

    if (this.ownerTabId !== null && typeof tabId === "number" && this.ownerTabId !== tabId) {
      const conflictingTabId = this.ownerTabId;
      const alive = await deps.isTabAlive(conflictingTabId);
      if (alive) {
        // 用户切换到另一个视频标签页并开启实时伴看时，自动通知并关闭前一个视频标签页的伴看
        void deps.notifyTabTakeover(conflictingTabId).catch(() => {});
      }
      if (this.ownerTabId === conflictingTabId) {
        await this.cleanupByTab(conflictingTabId, deps.clearAuthRule);
      }
    }

    const targetSessionId = sessionId.trim() || `live-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.latestRequestedOwner = targetSessionId;
    if (typeof tabId === "number") {
      this.ownerTabId = tabId;
    }

    const clearCurrentTabOwnershipIfUnchanged = () => {
      if (this.latestRequestedOwner === targetSessionId) {
        this.ownerTabId = null;
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
        return { ok: false, error: "未配置 MOSS-LIVE 平台，请先在设置中添加平台并填写 API Key" };
      }

      const isGeminiLive =
        activeProvider.type === "gemini-live" || activeProvider.presetId === "gemini-live";
      let apiKey = "";
      if (isGeminiLive) {
        if (!isOfficialGeminiEndpoint(activeProvider.baseUrl)) {
          clearCurrentTabOwnershipIfUnchanged();
          return { ok: false, error: GEMINI_LIVE_ROW_STATUS_TEXT.unofficial };
        }
        const [aiProviders, aiKeys] = await Promise.all([
          deps.loadAiProviders(),
          deps.loadAiKeys()
        ]);
        const cred = resolveGeminiCredential(aiProviders);
        if (cred.status !== "ok") {
          clearCurrentTabOwnershipIfUnchanged();
          return { ok: false, error: GEMINI_LIVE_ROW_STATUS_TEXT[cred.status] };
        }
        const recordId = cred.record?.id ? String(cred.record.id).trim() : "";
        apiKey = recordId ? String(aiKeys[recordId] || "").trim() : "";
        if (!apiKey) {
          clearCurrentTabOwnershipIfUnchanged();
          return { ok: false, error: GEMINI_LIVE_ROW_STATUS_TEXT["no-key"] };
        }
      } else {
        const keys = await deps.loadKeys();
        apiKey = String(keys[activeId] || "").trim();
        if (!apiKey) {
          clearCurrentTabOwnershipIfUnchanged();
          return { ok: false, error: "未配置 MOSS-LIVE 密钥，请先在设置中填写 API Key" };
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
        return { ok: false, error: `未授予平台域名权限（${baseUrl}），请在设置中重新保存该平台以授予权限` };
      }

      // 检查在权限校验与配置读取期间是否已被更新的会话请求取代
      if (this.latestRequestedOwner !== targetSessionId) {
        return { ok: false, error: "会话准备已过期" };
      }

      await deps.setAuthRule(apiKey, baseUrl, providerType);
      ruleInstalledForSession = true;
      this.activeRuleOwner = targetSessionId;

      await deps.ensureOffscreen();

      // 再次核对所有权：确保在确保 offscreen 期间未被更新的 prepare 取代
      if (this.latestRequestedOwner !== targetSessionId) {
        if (this.activeRuleOwner === targetSessionId) {
          this.activeRuleOwner = null;
          try {
            await deps.clearAuthRule();
          } catch {}
        }
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
            : {})
      };
    } catch (error) {
      clearCurrentTabOwnershipIfUnchanged();
      if (ruleInstalledForSession && this.activeRuleOwner === targetSessionId) {
        this.activeRuleOwner = null;
        try {
          await deps.clearAuthRule();
        } catch {
          // 忽略回滚错误
        }
      }
      return { ok: false, error: (error as Error)?.message || String(error) };
    }
  }

  async cleanup(
    sessionId?: string,
    clearAuthRule: () => Promise<void> = clearMossLiveWsAuthRule
  ): Promise<LiveSessionCleanupResult> {
    const targetSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
    try {
      if (targetSessionId) {
        if (this.latestRequestedOwner && this.latestRequestedOwner !== targetSessionId) {
          // 存在更新的准备请求，旧会话的 cleanup 不得清理新会话规则
          return { ok: true };
        }
        if (this.activeRuleOwner && this.activeRuleOwner !== targetSessionId) {
          // 活跃规则属于其他会话，旧会话的 cleanup 不得清理新会话规则
          return { ok: true };
        }
      }
      this.latestRequestedOwner = null;
      this.activeRuleOwner = null;
      this.ownerTabId = null;
      await clearAuthRule();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error)?.message || String(error) };
    }
  }

  async cleanupByTab(
    tabId: number,
    clearAuthRule: () => Promise<void> = clearMossLiveWsAuthRule
  ): Promise<LiveSessionCleanupResult> {
    if (this.ownerTabId !== tabId) {
      return { ok: true };
    }
    this.latestRequestedOwner = null;
    this.activeRuleOwner = null;
    this.ownerTabId = null;
    try {
      await clearAuthRule();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error)?.message || String(error) };
    }
  }
}

export const liveSessionTracker = new LiveSessionTracker();
