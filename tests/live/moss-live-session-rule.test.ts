// tests/live/moss-live-session-rule.test.ts
// MOSS-LIVE 会话级 DNR 鉴权规则生命周期与回滚测试

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  ASR_AUDIO_SESSION_RULE_ID_BASE,
  ASR_AUDIO_SESSION_RULE_ID_MAX
} from "../../extension/asr/session-rule-manager.js";
import {
  MOSS_LIVE_WS_RULE_ID,
  setMossLiveWsAuthRule,
  clearMossLiveWsAuthRule,
  extractDomainFromUrl,
  extractOriginHeaderFromUrl,
  LiveSessionTracker,
  type LiveSessionPrepareDeps
} from "../../extension/live/live-session-tracker.js";

interface FakeRule {
  id: number;
  priority?: number;
  action?: unknown;
  condition?: unknown;
}

function installDnrStub() {
  const rules = new Map<number, FakeRule>();
  const updateSessionRules = vi.fn(
    async ({ removeRuleIds = [], addRules = [] }: { removeRuleIds?: number[]; addRules?: FakeRule[] }) => {
      for (const id of removeRuleIds) rules.delete(id);
      for (const rule of addRules) rules.set(rule.id, rule);
    }
  );
  const getSessionRules = vi.fn(async () => [...rules.values()]);
  vi.stubGlobal("chrome", {
    declarativeNetRequest: {
      updateSessionRules,
      getSessionRules
    }
  });
  return { rules, updateSessionRules, getSessionRules };
}

beforeEach(() => {
  resetModuleState();
  vi.unstubAllGlobals();
});

describe("MOSS-LIVE DNR session rules", () => {
  it("uses rule ID 9002 which does not collide with ASR dynamic rule pool", () => {
    expect(MOSS_LIVE_WS_RULE_ID).toBe(9002);
    expect(MOSS_LIVE_WS_RULE_ID).toBeLessThan(ASR_AUDIO_SESSION_RULE_ID_BASE);
    expect(MOSS_LIVE_WS_RULE_ID).toBeLessThan(ASR_AUDIO_SESSION_RULE_ID_MAX);
  });

  it("extractDomainFromUrl parses hostnames faithfully and falls back safely", () => {
    expect(extractDomainFromUrl("https://api.mosi.cn/v1")).toBe("api.mosi.cn");
    expect(extractDomainFromUrl("https://custom.live.mosi.cn:8080/v1")).toBe("custom.live.mosi.cn");
    expect(extractDomainFromUrl("")).toBe("api.mosi.cn");
  });

  it("extractOriginHeaderFromUrl normalizes HTTP(S)/WS(S) URLs to HTTP(S) origin", () => {
    expect(extractOriginHeaderFromUrl("https://api.mosi.cn/v1")).toBe("https://api.mosi.cn");
    expect(extractOriginHeaderFromUrl("wss://api.mosi.cn/v1/realtime")).toBe("https://api.mosi.cn");
    expect(extractOriginHeaderFromUrl("ws://custom.live.mosi.cn:8080/v1")).toBe("http://custom.live.mosi.cn:8080");
    expect(extractOriginHeaderFromUrl("")).toBe("https://api.mosi.cn");
  });

  it("setMossLiveWsAuthRule sets session rule with Bearer Authorization and Origin headers", async () => {
    const { rules, updateSessionRules } = installDnrStub();

    await setMossLiveWsAuthRule("test-api-key-123");

    expect(updateSessionRules).toHaveBeenCalledTimes(1);
    const added = rules.get(MOSS_LIVE_WS_RULE_ID);
    expect(added).toBeDefined();
    expect(added?.id).toBe(9002);
    expect((added?.condition as any)?.requestDomains).toEqual(["api.mosi.cn"]);
    expect((added?.condition as any)?.resourceTypes).toEqual(["websocket"]);
    expect((added?.action as any)?.requestHeaders).toEqual([
      { header: "Authorization", operation: "set", value: "Bearer test-api-key-123" },
      { header: "Origin", operation: "set", value: "https://api.mosi.cn" }
    ]);
  });

  it("setMossLiveWsAuthRule with custom baseUrl extracts domain and origin correctly", async () => {
    const { rules } = installDnrStub();

    await setMossLiveWsAuthRule("test-api-key-123", "https://custom.live.mosi.cn:8080/v1");

    const added = rules.get(MOSS_LIVE_WS_RULE_ID);
    expect((added?.condition as any)?.requestDomains).toEqual(["custom.live.mosi.cn"]);
    expect((added?.action as any)?.requestHeaders).toEqual([
      { header: "Authorization", operation: "set", value: "Bearer test-api-key-123" },
      { header: "Origin", operation: "set", value: "https://custom.live.mosi.cn:8080" }
    ]);
  });

  it("setMossLiveWsAuthRule with providerType 'gemini-live' injects x-goog-api-key and generativelanguage.googleapis.com Origin", async () => {
    const { rules } = installDnrStub();

    await setMossLiveWsAuthRule(
      "AIza-gemini-key",
      "https://generativelanguage.googleapis.com",
      "gemini-live"
    );

    const added = rules.get(MOSS_LIVE_WS_RULE_ID);
    expect((added?.condition as any)?.requestDomains).toEqual(["generativelanguage.googleapis.com"]);
    expect((added?.condition as any)?.resourceTypes).toEqual(["websocket"]);
    expect((added?.action as any)?.requestHeaders).toEqual([
      { header: "x-goog-api-key", operation: "set", value: "AIza-gemini-key" },
      { header: "Origin", operation: "set", value: "https://generativelanguage.googleapis.com" }
    ]);
  });

  it("clearMossLiveWsAuthRule removes only rule 9002 and leaves other rules untouched", async () => {
    const { rules, updateSessionRules } = installDnrStub();

    // Pre-populate with another rule (e.g. ASR rule)
    rules.set(32001, { id: 32001 });
    rules.set(MOSS_LIVE_WS_RULE_ID, { id: MOSS_LIVE_WS_RULE_ID });

    await clearMossLiveWsAuthRule();

    expect(rules.has(MOSS_LIVE_WS_RULE_ID)).toBe(false);
    expect(rules.has(32001)).toBe(true);
    expect(updateSessionRules).toHaveBeenCalledWith({
      removeRuleIds: [MOSS_LIVE_WS_RULE_ID]
    });
  });

  it("regression: rolls back rule 9002 when prepare pipeline fails after installing DNR rule", async () => {
    const { rules, updateSessionRules } = installDnrStub();

    let ruleInstalled = false;
    try {
      await setMossLiveWsAuthRule("secret-key", "https://api.mosi.cn");
      ruleInstalled = true;
      throw new Error("Offscreen document creation failed");
    } catch {
      if (ruleInstalled) {
        await clearMossLiveWsAuthRule();
      }
    }

    expect(rules.has(MOSS_LIVE_WS_RULE_ID)).toBe(false);
    expect(updateSessionRules).toHaveBeenLastCalledWith({
      removeRuleIds: [MOSS_LIVE_WS_RULE_ID]
    });
  });
});

describe("LiveSessionTracker ownership and race condition defense", () => {
  function createFakeDeps(overrides: Partial<LiveSessionPrepareDeps> = {}): LiveSessionPrepareDeps {
    return {
      getSettings: async () => ({ activeLiveProviderId: "moss-1" }),
      loadProviders: async () => [
        {
          id: "moss-1",
          presetId: "moss-live",
          name: "MOSS",
          type: "moss-live",
          baseUrl: "https://api.mosi.cn",
          model: "moss-live-1.0",
          enabled: true,
          hasSavedKey: true
        }
      ],
      loadKeys: async () => ({ "moss-1": "test-key" }),
      loadAiProviders: async () => [],
      loadAiKeys: async () => ({}),
      hasPermission: async () => true,
      setAuthRule: vi.fn(async () => {}),
      clearAuthRule: vi.fn(async () => {}),
      ensureOffscreen: vi.fn(async () => true),
      resolveActiveId: (providers) => providers[0]?.id || "",
      ...overrides
    };
  }

  it("classifies an unconfigured live provider at the prepare boundary", async () => {
    const tracker = new LiveSessionTracker();

    const result = await tracker.prepare(
      "session-without-provider",
      createFakeDeps({ loadProviders: async () => [] })
    );

    expect(result).toMatchObject({
      ok: false,
      failureKind: "provider-unconfigured"
    });
  });

  it("classifies a missing provider-owned API key at the prepare boundary", async () => {
    const tracker = new LiveSessionTracker();

    const result = await tracker.prepare(
      "session-without-key",
      createFakeDeps({ loadKeys: async () => ({}) })
    );

    expect(result).toMatchObject({ ok: false, failureKind: "key-missing" });
  });

  it("stop -> immediate restart with out-of-order prepare/permission completion: old prepare does not finish as active owner and does not overwrite rule", async () => {
    const tracker = new LiveSessionTracker();
    let resolvePerm1!: (v: boolean) => void;
    const permPromise1 = new Promise<boolean>((resolve) => {
      resolvePerm1 = resolve;
    });

    const setAuthRule = vi.fn(async () => {});
    const clearAuthRule = vi.fn(async () => {});

    // Session 1 starts, slow permission check
    const prep1Promise = tracker.prepare("session-1", createFakeDeps({
      hasPermission: () => permPromise1,
      setAuthRule,
      clearAuthRule
    }));

    expect(tracker.getLatestOwner()).toBe("session-1");

    // Immediate stop and restart with Session 2
    await tracker.cleanup("session-1", clearAuthRule);
    expect(clearAuthRule).toHaveBeenCalledTimes(1);

    // Session 2 prepare runs fast
    const prep2Promise = tracker.prepare("session-2", createFakeDeps({
      hasPermission: async () => true,
      setAuthRule,
      clearAuthRule
    }));

    const res2 = await prep2Promise;
    expect(res2.ok).toBe(true);
    expect(res2.sessionId).toBe("session-2");
    expect(tracker.getLatestOwner()).toBe("session-2");
    expect(tracker.getActiveRuleOwner()).toBe("session-2");
    expect(setAuthRule).toHaveBeenCalledTimes(1);

    // Now Session 1's slow permission finally resolves
    resolvePerm1(true);
    const res1 = await prep1Promise;

    // Session 1 must not succeed, must not finish as active owner, must not call setAuthRule again
    expect(res1.ok).toBe(false);
    expect(res1.error).toContain("已过期");
    expect(tracker.getLatestOwner()).toBe("session-2");
    expect(tracker.getActiveRuleOwner()).toBe("session-2");
    expect(setAuthRule).toHaveBeenCalledTimes(1);

    // Stale cleanup for Session 1 must not clear Session 2's active rule (must not add a second clear call)
    await tracker.cleanup("session-1", clearAuthRule);
    expect(clearAuthRule).toHaveBeenCalledTimes(1);
    expect(tracker.getActiveRuleOwner()).toBe("session-2");
  });

  it("failed old prepare rollback does not clear a newer owner's rule", async () => {
    const tracker = new LiveSessionTracker();
    let rejectOffscreen1!: (err: Error) => void;
    const offscreenPromise1 = new Promise((_, reject) => {
      rejectOffscreen1 = reject;
    });

    const setAuthRule = vi.fn(async () => {});
    const clearAuthRule = vi.fn(async () => {});

    // Session 1 starts, installs rule, but ensureOffscreen hangs
    const prep1Promise = tracker.prepare("session-1", createFakeDeps({
      ensureOffscreen: () => offscreenPromise1,
      setAuthRule,
      clearAuthRule
    }));

    // Wait for session 1 to install rule
    await vi.waitFor(() => {
      expect(tracker.getActiveRuleOwner()).toBe("session-1");
    });

    // Session 2 arrives and takes over
    const prep2Promise = tracker.prepare("session-2", createFakeDeps({
      setAuthRule,
      clearAuthRule
    }));

    const res2 = await prep2Promise;
    expect(res2.ok).toBe(true);
    expect(tracker.getActiveRuleOwner()).toBe("session-2");
    expect(tracker.getLatestOwner()).toBe("session-2");

    // Session 1 ensureOffscreen now fails
    rejectOffscreen1(new Error("Offscreen crash"));
    const res1 = await prep1Promise;
    expect(res1.ok).toBe(false);

    // Must NOT have called clearAuthRule (which would delete session-2's rule)
    expect(clearAuthRule).not.toHaveBeenCalled();
    expect(tracker.getActiveRuleOwner()).toBe("session-2");
  });

  it("rejects prepare when WebSocket (wss://) host permission is missing even if https:// is granted", async () => {
    const tracker = new LiveSessionTracker();
    const setAuthRule = vi.fn(async () => {});
    const res = await tracker.prepare(
      "session-ws-perm",
      createFakeDeps({
        hasPermission: async (url) => url.startsWith("https://"),
        setAuthRule
      })
    );
    expect(res.ok).toBe(false);
    expect(res.failureKind).toBe("permission-denied");
    expect(res.error).toContain("未授予平台域名权限");
    expect(setAuthRule).not.toHaveBeenCalled();
  });

  it("notifies old tab and takes over directly when prepare comes from another tab", async () => {
    const tracker = new LiveSessionTracker();
    const setAuthRule = vi.fn(async () => {});
    const clearAuthRule = vi.fn(async () => {});
    const isTabAlive = vi.fn(async (id: number) => id === 101);
    const notifyTabTakeover = vi.fn(async () => {});

    const res1 = await tracker.prepare(
      "session-tab-101",
      createFakeDeps({ setAuthRule, clearAuthRule, isTabAlive, notifyTabTakeover }),
      101
    );
    expect(res1.ok).toBe(true);
    expect(tracker.getOwnerTabId()).toBe(101);
    expect(tracker.getActiveRuleOwner()).toBe("session-tab-101");

    const res2 = await tracker.prepare(
      "session-tab-202",
      createFakeDeps({ setAuthRule, clearAuthRule, isTabAlive, notifyTabTakeover }),
      202
    );
    expect(res2.ok).toBe(true);
    expect(notifyTabTakeover).toHaveBeenCalledWith(101, "companion");
    expect(tracker.getOwnerTabId()).toBe(202);
    expect(tracker.getActiveRuleOwner()).toBe("session-tab-202");
    expect(setAuthRule).toHaveBeenCalledTimes(2);
  });

  it("reaps dead ownerTabId via chrome.tabs.get and allows a new tab to take over", async () => {
    const { rules } = installDnrStub();
    // Simulate chrome.tabs.get rejecting for dead tab 101
    (globalThis.chrome as any).tabs = {
      get: vi.fn(async (id: number) => {
        if (id === 101) {
          throw new Error("No tab with id: 101.");
        }
        return { id };
      })
    };

    const tracker = new LiveSessionTracker();
    const clearSpy = vi.fn(async () => {
      await clearMossLiveWsAuthRule();
    });
    const setSpy = vi.fn(async (key: string, url?: string, providerType?: any) => {
      await setMossLiveWsAuthRule(key, url, providerType);
    });

    const res1 = await tracker.prepare(
      "session-dead-tab",
      createFakeDeps({ setAuthRule: setSpy, clearAuthRule: clearSpy }),
      101
    );
    expect(res1.ok).toBe(true);
    expect(tracker.getOwnerTabId()).toBe(101);
    expect(rules.has(MOSS_LIVE_WS_RULE_ID)).toBe(true);

    // Tab 101 died without cleanup; Tab 202 now prepares
    const res2 = await tracker.prepare(
      "session-new-tab",
      createFakeDeps({ setAuthRule: setSpy, clearAuthRule: clearSpy }),
      202
    );
    expect(res2.ok).toBe(true);
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledTimes(2);
    expect(tracker.getOwnerTabId()).toBe(202);
    expect(tracker.getActiveRuleOwner()).toBe("session-new-tab");
    expect(rules.has(MOSS_LIVE_WS_RULE_ID)).toBe(true);
  });

  it("prepares gemini-live session using AI Gemini key and configures gemini-live DNR auth rule", async () => {
    const tracker = new LiveSessionTracker();
    const setAuthRule = vi.fn(async () => {});
    const checkedOrigins: string[] = [];

    const res = await tracker.prepare(
      "session-gemini-ok",
      createFakeDeps({
        getSettings: async () => ({ activeLiveProviderId: "gemini-live-1", liveGeminiNativeSearch: true }),
        loadProviders: async () => [
          {
            id: "gemini-live-1",
            presetId: "gemini-live",
            name: "Gemini Live",
            type: "gemini-live",
            baseUrl: "https://generativelanguage.googleapis.com",
            model: "gemini-3.1-flash-live-preview",
            enabled: true,
            hasSavedKey: false,
            credentialRef: { kind: "ai-provider-preset", presetId: "gemini" }
          }
        ],
        loadAiProviders: async () => [
          {
            id: "ai-gemini-1",
            presetId: "gemini",
            name: "Google Gemini",
            type: "gemini-native",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            model: "gemini-3-flash-preview",
            enabled: true,
            hasSavedKey: true
          }
        ],
        loadAiKeys: async () => ({ "ai-gemini-1": "AIza-shared-key" }),
        hasPermission: async (origin) => {
          checkedOrigins.push(origin);
          return true;
        },
        setAuthRule
      })
    );

    expect(res.ok).toBe(true);
    expect(res.liveGeminiNativeSearch).toBe(true);
    expect(res.provider).toMatchObject({
      id: "gemini-live-1",
      name: "Gemini Live",
      type: "gemini-live",
      baseUrl: "https://generativelanguage.googleapis.com",
      model: "gemini-3.1-flash-live-preview"
    });
    expect(checkedOrigins).toEqual([
      "https://generativelanguage.googleapis.com",
      "wss://generativelanguage.googleapis.com"
    ]);
    expect(setAuthRule).toHaveBeenCalledWith(
      "AIza-shared-key",
      "https://generativelanguage.googleapis.com",
      "gemini-live"
    );
  });

  it("returns explicit Chinese errors when gemini-live lacks AI Gemini record, key, or uses unofficial endpoint", async () => {
    const tracker = new LiveSessionTracker();
    const geminiLiveProvider = {
      id: "gemini-live-1",
      presetId: "gemini-live",
      name: "Gemini Live",
      type: "gemini-live" as const,
      baseUrl: "https://generativelanguage.googleapis.com",
      model: "gemini-3.1-flash-live-preview",
      enabled: true,
      hasSavedKey: false
    };

    const missingProviderRes = await tracker.prepare(
      "session-gemini-no-provider",
      createFakeDeps({
        loadProviders: async () => [geminiLiveProvider],
        loadAiProviders: async () => []
      })
    );
    expect(missingProviderRes.ok).toBe(false);
    expect(missingProviderRes.error).toBe("尚未配置官方 Gemini AI Key");

    const missingKeyRes = await tracker.prepare(
      "session-gemini-no-key",
      createFakeDeps({
        loadProviders: async () => [geminiLiveProvider],
        loadAiProviders: async () => [
          {
            id: "ai-gemini-1",
            presetId: "gemini",
            name: "Google Gemini",
            type: "gemini-native",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            model: "gemini-3-flash-preview",
            enabled: true,
            hasSavedKey: false
          }
        ],
        loadAiKeys: async () => ({})
      })
    );
    expect(missingKeyRes.ok).toBe(false);
    expect(missingKeyRes.error).toBe("官方 Gemini AI Key 缺失或引用已失效");

    const unofficialAiRes = await tracker.prepare(
      "session-gemini-unofficial-ai",
      createFakeDeps({
        loadProviders: async () => [geminiLiveProvider],
        loadAiProviders: async () => [
          {
            id: "ai-gemini-1",
            presetId: "gemini",
            name: "Google Gemini",
            type: "gemini-native",
            baseUrl: "https://my-gemini-proxy.example.com/v1beta",
            model: "gemini-3-flash-preview",
            enabled: true,
            hasSavedKey: true
          }
        ],
        loadAiKeys: async () => ({ "ai-gemini-1": "proxy-key" })
      })
    );
    expect(unofficialAiRes.ok).toBe(false);
    expect(unofficialAiRes.error).toBe("AI 平台配置的并非 Gemini 官方接口地址");

    const unofficialLiveRes = await tracker.prepare(
      "session-gemini-unofficial-live",
      createFakeDeps({
        loadProviders: async () => [
          {
            ...geminiLiveProvider,
            baseUrl: "https://custom-live-proxy.example.com"
          }
        ],
        loadAiProviders: async () => [
          {
            id: "ai-gemini-1",
            presetId: "gemini",
            name: "Google Gemini",
            type: "gemini-native",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            model: "gemini-3-flash-preview",
            enabled: true,
            hasSavedKey: true
          }
        ],
        loadAiKeys: async () => ({ "ai-gemini-1": "AIza-key" })
      })
    );
    expect(unofficialLiveRes.ok).toBe(false);
    expect(unofficialLiveRes.error).toBe("AI 平台配置的并非 Gemini 官方接口地址");
  });

  it("classifies Gemini credential setup and endpoint failures separately from provider-owned keys", async () => {
    const tracker = new LiveSessionTracker();
    const provider = {
      id: "gemini-live-1",
      presetId: "gemini-live",
      name: "Gemini Live",
      type: "gemini-live" as const,
      baseUrl: "https://generativelanguage.googleapis.com",
      model: "gemini-3.1-flash-live-preview",
      enabled: true,
      hasSavedKey: false
    };

    const missingCredential = await tracker.prepare(
      "session-gemini-credential",
      createFakeDeps({ loadProviders: async () => [provider], loadAiProviders: async () => [] })
    );
    const unofficialEndpoint = await tracker.prepare(
      "session-gemini-endpoint",
      createFakeDeps({
        loadProviders: async () => [{ ...provider, baseUrl: "https://proxy.example.com" }]
      })
    );

    expect(missingCredential).toMatchObject({ ok: false, failureKind: "gemini-credential" });
    expect(unofficialEndpoint).toMatchObject({ ok: false, failureKind: "gemini-credential" });
  });
});

describe("LiveSessionTracker tab takeover and rule ownership", () => {
  function createFakeDeps(overrides: Partial<LiveSessionPrepareDeps> = {}): LiveSessionPrepareDeps {
    return {
      getSettings: async () => ({ activeLiveProviderId: "moss-1" }),
      loadProviders: async () => [
        {
          id: "moss-1",
          presetId: "moss-live",
          name: "MOSS",
          type: "moss-live",
          baseUrl: "https://api.mosi.cn",
          model: "moss-live-1.0",
          enabled: true,
          hasSavedKey: true
        }
      ],
      loadKeys: async () => ({ "moss-1": "test-key" }),
      loadAiProviders: async () => [],
      loadAiKeys: async () => ({}),
      hasPermission: async () => true,
      setAuthRule: vi.fn(async () => {}),
      clearAuthRule: vi.fn(async () => {}),
      ensureOffscreen: vi.fn(async () => true),
      resolveActiveId: (providers) => providers[0]?.id || "",
      ...overrides
    };
  }

  it("stale cleanup never clears the newer session's rule", async () => {
    const tracker = new LiveSessionTracker();
    const setAuthRule = vi.fn(async () => {});
    const clearAuthRule = vi.fn(async () => {});
    const deps = createFakeDeps({ setAuthRule, clearAuthRule });
    await tracker.prepare("comp-1", deps);

    await tracker.cleanup("comp-stale", clearAuthRule);
    expect(clearAuthRule).not.toHaveBeenCalled();
    expect(tracker.getActiveRuleOwner()).toBe("comp-1");

    await tracker.cleanup("comp-1", clearAuthRule);
    expect(clearAuthRule).toHaveBeenCalledTimes(1);
    expect(tracker.getActiveRuleOwner()).toBeNull();
  });

  it("regression: stale prepare expiry does not release the newer session's rule hold", async () => {
    const tracker = new LiveSessionTracker();
    const setAuthRule = vi.fn(async () => {});
    const clearAuthRule = vi.fn(async () => {});
    let resolveOffscreen1!: (v: boolean) => void;
    const offscreenPromise1 = new Promise((resolve) => {
      resolveOffscreen1 = resolve;
    });

    const prep1 = tracker.prepare(
      "comp-1",
      createFakeDeps({ setAuthRule, clearAuthRule, ensureOffscreen: () => offscreenPromise1 })
    );
    await vi.waitFor(() => {
      expect(tracker.getActiveRuleOwner()).toBe("comp-1");
    });
    const prep2 = await tracker.prepare("comp-2", createFakeDeps({ setAuthRule, clearAuthRule }));
    expect(prep2.ok).toBe(true);
    expect(tracker.getActiveRuleOwner()).toBe("comp-2");

    resolveOffscreen1(true);
    const res1 = await prep1;
    expect(res1.ok).toBe(false);
    expect(clearAuthRule).not.toHaveBeenCalled();
    expect(tracker.getActiveRuleOwner()).toBe("comp-2");
  });

  it("cross-tab prepare triggers tab takeover notification and cleans up previous tab", async () => {
    const tracker = new LiveSessionTracker();
    const setAuthRule = vi.fn(async () => {});
    const clearAuthRule = vi.fn(async () => {});
    const isTabAlive = vi.fn(async () => true);
    const notifyTabTakeover = vi.fn(async () => {});
    const deps = createFakeDeps({ setAuthRule, clearAuthRule, isTabAlive, notifyTabTakeover });

    await tracker.prepare("comp-tab-1", deps, 101);
    expect(tracker.getOwnerTabId()).toBe(101);
    expect(tracker.getActiveRuleOwner()).toBe("comp-tab-1");

    const res2 = await tracker.prepare("comp-tab-2", deps, 202);
    expect(res2.ok).toBe(true);
    expect(notifyTabTakeover).toHaveBeenCalledWith(101, "companion");
    expect(tracker.getOwnerTabId()).toBe(202);
    expect(tracker.getActiveRuleOwner()).toBe("comp-tab-2");
  });
});
