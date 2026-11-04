// extension/live/live-session-tracker.ts
// MOSS-LIVE 会话所有权追踪器：防止乱序 prepare 与过期 cleanup 踩踏 DNR 鉴权规则。

import type { LiveProvider } from "./live-provider-normalize.js";
import { resolveMossLiveWsUrl } from "./moss-live-protocol.js";

export type LiveProviderListEntry = LiveProvider & { hasSavedKey: boolean };

export interface LiveSessionPrepareDeps {
  getSettings: () => Promise<{ activeLiveProviderId?: string }>;
  loadProviders: () => Promise<LiveProviderListEntry[]>;
  loadKeys: () => Promise<Record<string, string>>;
  hasPermission: (baseUrl: string) => Promise<boolean>;
  setAuthRule: (apiKey: string, baseUrl: string) => Promise<void>;
  clearAuthRule: () => Promise<void>;
  ensureOffscreen: () => Promise<unknown>;
  resolveActiveId: (providers: LiveProvider[], activeId?: string) => string;
}

export interface LiveSessionPrepareResult {
  ok: boolean;
  provider?: LiveProviderListEntry;
  sessionId?: string;
  error?: string;
}

export interface LiveSessionCleanupResult {
  ok: boolean;
  error?: string;
}

export class LiveSessionTracker {
  private latestRequestedOwner: string | null = null;
  private activeRuleOwner: string | null = null;

  getLatestOwner(): string | null {
    return this.latestRequestedOwner;
  }

  getActiveRuleOwner(): string | null {
    return this.activeRuleOwner;
  }

  reset(): void {
    this.latestRequestedOwner = null;
    this.activeRuleOwner = null;
  }

  async prepare(
    sessionId: string,
    deps: LiveSessionPrepareDeps
  ): Promise<LiveSessionPrepareResult> {
    const targetSessionId = sessionId.trim() || `live-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.latestRequestedOwner = targetSessionId;

    let ruleInstalledForSession = false;
    try {
      const settings = await deps.getSettings();
      const providers = await deps.loadProviders();
      const activeId = deps.resolveActiveId(providers, settings.activeLiveProviderId);
      const activeProvider = providers.find((p) => p.id === activeId);
      if (!activeProvider) {
        return { ok: false, error: "未配置 MOSS-LIVE 平台，请先在设置中添加平台并填写 API Key" };
      }
      const keys = await deps.loadKeys();
      const apiKey = String(keys[activeId] || "").trim();
      if (!apiKey) {
        return { ok: false, error: "未配置 MOSS-LIVE 密钥，请先在设置中填写 API Key" };
      }
      const baseUrl = activeProvider.baseUrl || "https://api.mosi.cn";
      const [hasHttpPerm, hasWsPerm] = await Promise.all([
        deps.hasPermission(baseUrl),
        deps.hasPermission(resolveMossLiveWsUrl(baseUrl, activeProvider.model))
      ]);
      const hasPerm = hasHttpPerm && hasWsPerm;
      if (!hasPerm) {
        return { ok: false, error: `未授予平台域名权限（${baseUrl}），请在设置中重新保存该平台以授予权限` };
      }

      // 检查在权限校验与配置读取期间是否已被更新的会话请求取代
      if (this.latestRequestedOwner !== targetSessionId) {
        return { ok: false, error: "会话准备已过期" };
      }

      await deps.setAuthRule(apiKey, baseUrl);
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
        sessionId: targetSessionId
      };
    } catch (error) {
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
    sessionId: string | undefined,
    clearAuthRule: () => Promise<void>
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
      await clearAuthRule();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error)?.message || String(error) };
    }
  }
}

export const liveSessionTracker = new LiveSessionTracker();
