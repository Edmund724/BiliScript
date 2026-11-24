import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { ASR_OFFSCREEN_REJECTION_MESSAGE } from "../../extension/asr/protocol.js";
import { ASR_AUDIO_SESSION_RULE_ID_BASE } from "../../extension/asr/session-rule-manager.js";
import { OFFSCREEN_CREATE_REASONS, OFFSCREEN_URL } from "../../extension/shared/offscreen-constants.js";
import type { MessageSender } from "../../extension/shared/messaging-protocol.js";

interface FakeSessionRule {
  id: number;
  priority?: number;
  action?: unknown;
  condition?: unknown;
}

interface StubHostEnvOptions {
  contexts?: unknown[];
  contextsError?: unknown;
  omitGetContexts?: boolean;
  createError?: unknown;
  closeError?: unknown;
  initialRules?: FakeSessionRule[];
  deadTabIds?: number[];
  runtimeId?: string;
  runtimeGetUrl?: (path: string) => string;
}

function makeRuleStore(initialRules: FakeSessionRule[] = []) {
  const rules = new Map(initialRules.map((rule) => [rule.id, rule] as const));
  const updateSessionRules = vi.fn(
    async ({ removeRuleIds = [], addRules = [] }: { removeRuleIds?: number[]; addRules?: FakeSessionRule[] }) => {
      removeRuleIds.forEach((id) => rules.delete(id));
      addRules.forEach((rule) => rules.set(rule.id, rule));
    }
  );
  const getSessionRules = vi.fn(async () => [...rules.values()]);
  return { rules, updateSessionRules, getSessionRules };
}

function stubHostEnv({
  contexts,
  contextsError,
  omitGetContexts = false,
  createError,
  closeError,
  initialRules = [],
  deadTabIds = [],
  runtimeId = "test-extension-id",
  runtimeGetUrl = (path: string) => `chrome-extension://test/${path}`
}: StubHostEnvOptions = {}) {
  const ruleStore = makeRuleStore(initialRules);
  const deadTabs = new Set(deadTabIds);
  const createDocument = createError
    ? vi.fn(async (_options: { url: string; reasons: string[]; justification: string }) => Promise.reject(createError))
    : vi.fn(async (_options: { url: string; reasons: string[]; justification: string }) => ({}));
  const closeDocument = closeError
    ? vi.fn(async () => Promise.reject(closeError))
    : vi.fn(async () => {});
  const getContexts = contextsError
    ? vi.fn(async () => Promise.reject(contextsError))
    : vi.fn(async () => contexts || []);
  const tabsGet = vi.fn(async (tabId: number) => (
    deadTabs.has(tabId)
      ? Promise.reject(new Error(`No tab with id: ${tabId}.`))
      : { id: tabId }
  ));

  vi.stubGlobal("chrome", {
    ...globalThis.chrome,
    runtime: {
      ...globalThis.chrome.runtime,
      id: runtimeId || undefined,
      getURL: runtimeGetUrl,
      ...(omitGetContexts ? { getContexts: undefined } : { getContexts })
    },
    tabs: { get: tabsGet },
    offscreen: { createDocument, closeDocument },
    declarativeNetRequest: {
      updateSessionRules: ruleStore.updateSessionRules,
      getSessionRules: ruleStore.getSessionRules
    }
  });

  return {
    createDocument,
    closeDocument,
    getContexts,
    tabsGet,
    ruleStore
  };
}

beforeEach(() => {
  resetModuleState();
});

describe("ensureOffscreenDocument", () => {
  it("文档已存在（getContexts 命中）→ 不重复创建，返回 true", async () => {
    const { createDocument, getContexts } = stubHostEnv({
      contexts: [{ contextType: "OFFSCREEN_DOCUMENT" }]
    });
    const host = await import("../../extension/core/offscreen-host.js");

    await expect(host.ensureOffscreenDocument()).resolves.toBe(true);
    expect(getContexts).toHaveBeenCalledTimes(1);
    expect(createDocument).not.toHaveBeenCalled();
  });

  it("查无文档 → 以统一常量创建（url/reasons）", async () => {
    const { createDocument } = stubHostEnv({ contexts: [] });
    const host = await import("../../extension/core/offscreen-host.js");

    await expect(host.ensureOffscreenDocument()).resolves.toBe(true);
    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(createDocument.mock.calls[0][0]).toMatchObject({
      url: `chrome-extension://test/${OFFSCREEN_URL}`,
      reasons: [...OFFSCREEN_CREATE_REASONS],
      justification: expect.any(String)
    });
  });

  it("getContexts 缺失时 → 直接尝试创建", async () => {
    const { createDocument } = stubHostEnv({
      omitGetContexts: true
    });
    const host = await import("../../extension/core/offscreen-host.js");

    await expect(host.ensureOffscreenDocument()).resolves.toBe(true);
    expect(createDocument).toHaveBeenCalledTimes(1);
  });

  it("getContexts 抛错 → 显式记录警告日志后仍尝试创建", async () => {
    const logging = await import("../../extension/shared/logging.js");
    logging.registerDebugGate(() => true);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { createDocument, getContexts } = stubHostEnv({
        contextsError: new TypeError("getContexts failed")
      });
      const host = await import("../../extension/core/offscreen-host.js");

      await expect(host.ensureOffscreenDocument()).resolves.toBe(true);
      expect(getContexts).toHaveBeenCalledTimes(1);
      expect(createDocument).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        "[BILISCRIPT] chrome.runtime.getContexts failed",
        expect.objectContaining({ error: "getContexts failed" })
      );
    } finally {
      warnSpy.mockRestore();
      logging.registerDebugGate(() => false);
    }
  });

  it.each([
    "Only a single offscreen document may be created.",
    "Single offscreen document already exists."
  ])("createDocument 抛「文档已存在」（%s）→ 视同成功返回 true", async (message) => {
    stubHostEnv({
      contextsError: new TypeError("getContexts is not a function"),
      createError: new Error(message)
    });
    const host = await import("../../extension/core/offscreen-host.js");

    await expect(host.ensureOffscreenDocument()).resolves.toBe(true);
  });

  it("createDocument 真实失败 → 原始错误上抛", async () => {
    stubHostEnv({
      contexts: [],
      createError: new Error("offscreen.createDocument: reason not allowed")
    });
    const host = await import("../../extension/core/offscreen-host.js");

    await expect(host.ensureOffscreenDocument()).rejects.toThrow("offscreen.createDocument: reason not allowed");
  });
});

describe("closeOffscreenDocument 与 sender 校验", () => {
  it("closeOffscreenDocument 委托 chrome.offscreen.closeDocument 并透传错误", async () => {
    const { closeDocument } = stubHostEnv();
    const host = await import("../../extension/core/offscreen-host.js");

    await expect(host.closeOffscreenDocument()).resolves.toBeUndefined();
    expect(closeDocument).toHaveBeenCalledTimes(1);

    resetModuleState();
    stubHostEnv({ closeError: new Error("No current offscreen document") });
    const fresh = await import("../../extension/core/offscreen-host.js");
    await expect(fresh.closeOffscreenDocument()).rejects.toThrow("No current offscreen document");
  });

  it("isOffscreenDocumentSender 仅放行无 tab 且精确匹配 offscreen URL 的发送者，拒绝文案单源一致", async () => {
    stubHostEnv();
    const host = await import("../../extension/core/offscreen-host.js");

    expect(host.OFFSCREEN_SENDER_REJECTION_MESSAGE).toBe(ASR_OFFSCREEN_REJECTION_MESSAGE);
    const offscreenSender: MessageSender = { url: `chrome-extension://test/${OFFSCREEN_URL}` };
    const tabSender: MessageSender = { tab: { id: 7 }, url: `chrome-extension://test/${OFFSCREEN_URL}` };
    const pageSender: MessageSender = { url: "chrome-extension://test/entry/background.html" };

    expect(host.isOffscreenDocumentSender(offscreenSender)).toBe(true);
    expect(host.isOffscreenDocumentSender(tabSender)).toBe(false);
    expect(host.isOffscreenDocumentSender(pageSender)).toBe(false);
    expect(host.isOffscreenDocumentSender({})).toBe(false);
  });
});

describe("SW 侧串行生命周期队列与关闭代际号", () => {
  it("close 执行中并发 ensure：严格等 closeDocument 完成后才检测并重建文档（无撞车）", async () => {
    let hasDocument = true;
    const events: string[] = [];
    let finishClose!: () => void;

    stubHostEnv();
    chrome.runtime.getContexts = vi.fn(async () => {
      events.push("getContexts");
      return hasDocument ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : [];
    });
    chrome.offscreen = {
      closeDocument: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            events.push("close:start");
            finishClose = () => {
              hasDocument = false;
              events.push("close:end");
              resolve();
            };
          })
      ),
      createDocument: vi.fn(async () => {
        events.push("createDocument");
        hasDocument = true;
      })
    };

    const host = await import("../../extension/core/offscreen-host.js");
    const closePromise = host.closeOffscreenDocument();
    const ensurePromise = host.ensureOffscreenDocument();

    await Promise.resolve();
    expect(events).toEqual(["close:start"]);

    finishClose();
    await expect(closePromise).resolves.toBeUndefined();
    await expect(ensurePromise).resolves.toBe(true);
    expect(events).toEqual(["close:start", "close:end", "getContexts", "createDocument"]);
  });

  it("队列中存在等待中的 ensure 时，排队的 close 检测到更新代际号直接跳过关闭并复用现有文档", async () => {
    let hasDocument = false;
    let finishFirstCreate!: () => void;

    stubHostEnv();
    chrome.runtime.getContexts = vi.fn(async () => (hasDocument ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : []));
    const closeDocument = vi.fn(async () => {
      hasDocument = false;
    });
    const createDocument = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishFirstCreate = () => {
            hasDocument = true;
            resolve();
          };
        })
    );
    chrome.offscreen = { createDocument, closeDocument };

    const host = await import("../../extension/core/offscreen-host.js");
    const firstEnsure = host.ensureOffscreenDocument();
    await vi.waitFor(() => expect(createDocument).toHaveBeenCalledTimes(1));

    const closeResult = host.tryCloseOffscreenDocument();
    const secondEnsure = host.ensureOffscreenDocument();

    finishFirstCreate();
    await expect(firstEnsure).resolves.toBe(true);
    await expect(closeResult).resolves.toBe(false);
    await expect(secondEnsure).resolves.toBe(true);

    expect(closeDocument).not.toHaveBeenCalled();
    expect(createDocument).toHaveBeenCalledTimes(1);
  });

  it("并发多次 ensure 单飞合并，仅触发一次 createDocument", async () => {
    let finishCreate!: () => void;
    stubHostEnv({ contexts: [] });
    const createDocument = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCreate = resolve;
        })
    );
    chrome.offscreen = { createDocument, closeDocument: vi.fn(async () => {}) };

    const host = await import("../../extension/core/offscreen-host.js");
    const p1 = host.ensureOffscreenDocument();
    const p2 = host.ensureOffscreenDocument();
    const p3 = host.ensureOffscreenDocument();

    await vi.waitFor(() => expect(createDocument).toHaveBeenCalledTimes(1));
    finishCreate();
    await expect(Promise.all([p1, p2, p3])).resolves.toEqual([true, true, true]);
    expect(createDocument).toHaveBeenCalledTimes(1);
  });

  it("队头 close 抛错不影响后续排队的 ensure 正常执行", async () => {
    let rejectClose!: (error: Error) => void;
    stubHostEnv({ contexts: [] });
    const createDocument = vi.fn(async () => {});
    const closeDocument = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectClose = reject;
        })
    );
    chrome.offscreen = { createDocument, closeDocument };

    const host = await import("../../extension/core/offscreen-host.js");
    const closePromise = host.closeOffscreenDocument();
    const ensurePromise = host.ensureOffscreenDocument();

    rejectClose(new Error("No current offscreen document"));
    await expect(closePromise).rejects.toThrow("No current offscreen document");
    await expect(ensurePromise).resolves.toBe(true);
    expect(createDocument).toHaveBeenCalledTimes(1);
  });

  it("hasOpenBilibiliTabs 按 *://*.bilibili.com/* 查询；异常时保守返回 true", async () => {
    stubHostEnv();
    const query = vi.fn(async () => [{ id: 1 }]);
    (chrome.tabs as unknown as { query: typeof query }).query = query;
    const host = await import("../../extension/core/offscreen-host.js");

    await expect(host.hasOpenBilibiliTabs()).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith({ url: host.BILIBILI_TAB_URL_PATTERN });

    query.mockResolvedValueOnce([]);
    await expect(host.hasOpenBilibiliTabs()).resolves.toBe(false);

    query.mockRejectedValueOnce(new Error("tabs unavailable"));
    await expect(host.hasOpenBilibiliTabs()).resolves.toBe(true);
  });

  it("hasOpenSupportedTabs 按 B 站与 YouTube 显式模式查询；异常时保守返回 true", async () => {
    stubHostEnv();
    const query = vi.fn(async () => [{ id: 2, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }]);
    (chrome.tabs as unknown as { query: typeof query }).query = query;
    const host = await import("../../extension/core/offscreen-host.js");

    await expect(host.hasOpenSupportedTabs()).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith({ url: [...host.SUPPORTED_TAB_URL_PATTERNS] });

    query.mockResolvedValueOnce([]);
    await expect(host.hasOpenSupportedTabs()).resolves.toBe(false);

    query.mockRejectedValueOnce(new Error("tabs unavailable"));
    await expect(host.hasOpenSupportedTabs()).resolves.toBe(true);
  });
});

describe("B 站媒体防盗链 DNR 会话规则生命周期", () => {
  it("audio-xhr 与 video-media 分别写入对应规则并在 release 时校验归属", async () => {
    const { ruleStore } = stubHostEnv({ contexts: [{ contextType: "OFFSCREEN_DOCUMENT" }] });
    const host = await import("../../extension/core/offscreen-host.js");

    const audioId = await host.acquireBiliMediaSessionRule("audio-xhr", "t7");
    const mediaId = await host.acquireBiliMediaSessionRule("video-media");

    expect(audioId).toBe(ASR_AUDIO_SESSION_RULE_ID_BASE);
    expect(mediaId).toBe(ASR_AUDIO_SESSION_RULE_ID_BASE + 1);
    expect(host.getBiliMediaSessionRuleOwner(audioId)).toBe("t7");
    expect(host.getBiliMediaSessionRuleOwner(mediaId)).toBe("o");
    expect(ruleStore.rules.get(audioId)).toMatchObject({
      condition: {
        requestDomains: [...host.BILI_MEDIA_CDN_DOMAINS],
        initiatorDomains: ["test-extension-id"],
        tabIds: [host.NON_TAB_DNR_TAB_ID],
        resourceTypes: ["xmlhttprequest"]
      }
    });
    expect(ruleStore.rules.get(mediaId)).toMatchObject({
      action: {
        responseHeaders: [{ header: "Access-Control-Allow-Origin", operation: "set", value: "*" }]
      },
      condition: {
        requestDomains: [...host.BILI_MEDIA_CDN_DOMAINS],
        initiatorDomains: ["test-extension-id"],
        tabIds: [host.NON_TAB_DNR_TAB_ID],
        resourceTypes: ["media"]
      }
    });

    await expect(host.releaseBiliMediaSessionRule(audioId, "t8")).rejects.toThrow("防盗链规则不属于当前来源");
    expect(ruleStore.rules.has(audioId)).toBe(true);

    await host.releaseBiliMediaSessionRule(audioId, "t7");
    expect(ruleStore.rules.has(audioId)).toBe(false);
    expect(host.getBiliMediaSessionRuleOwner(audioId)).toBe("");

    await host.releaseBiliMediaSessionRule(mediaId);
    expect(ruleStore.rules.has(mediaId)).toBe(false);
  });

  it("withBiliMediaSessionRule 在成功与失败路径均释放规则", async () => {
    const { ruleStore } = stubHostEnv({ contexts: [{ contextType: "OFFSCREEN_DOCUMENT" }] });
    const host = await import("../../extension/core/offscreen-host.js");

    const result = await host.withBiliMediaSessionRule("video-media", async () => {
      expect(ruleStore.rules.size).toBe(1);
      return "ok";
    });
    expect(result).toBe("ok");
    expect(ruleStore.rules.size).toBe(0);

    await expect(
      host.withBiliMediaSessionRule("video-media", async () => {
        expect(ruleStore.rules.size).toBe(1);
        throw new Error("capture failed");
      })
    ).rejects.toThrow("capture failed");
    expect(ruleStore.rules.size).toBe(0);
  });

  it("reapAllBiliMediaSessionRules 清空池区间规则并保留区间外规则", async () => {
    const { ruleStore } = stubHostEnv({
      contexts: [{ contextType: "OFFSCREEN_DOCUMENT" }],
      initialRules: [{ id: 32001 }, { id: 9002 }]
    });
    const host = await import("../../extension/core/offscreen-host.js");

    await host.reapAllBiliMediaSessionRules();

    expect(ruleStore.rules.has(32001)).toBe(false);
    expect(ruleStore.rules.has(9002)).toBe(true);

    const nextId = await host.acquireBiliMediaSessionRule("audio-xhr", "t1");
    expect(nextId).toBe(ASR_AUDIO_SESSION_RULE_ID_BASE);
  });

  it("acquireBiliMediaSessionRule 在下次分配前回收已关闭标签页的残留规则", async () => {
    const deadTabs = new Set<number>();
    const { ruleStore } = stubHostEnv({
      contexts: [{ contextType: "OFFSCREEN_DOCUMENT" }]
    });
    (globalThis.chrome as unknown as { tabs: { get: (id: number) => Promise<{ id: number }> } }).tabs.get = vi.fn(
      async (id: number) => (deadTabs.has(id) ? Promise.reject(new Error(`No tab with id: ${id}.`)) : { id })
    );
    const host = await import("../../extension/core/offscreen-host.js");

    const deadRuleId = await host.acquireBiliMediaSessionRule("audio-xhr", "t7");
    deadTabs.add(7);
    const reusedRuleId = await host.acquireBiliMediaSessionRule("video-media", "t9");

    expect(reusedRuleId).toBe(deadRuleId);
    expect(ruleStore.rules.size).toBe(1);
    expect(host.getBiliMediaSessionRuleOwner(reusedRuleId)).toBe("t9");
  });

  it("Chromium 缺失 runtime.id 时回退从 runtime.getURL 提取扩展域名，且 updateSessionRules 失败时不绕过 initiatorDomains", async () => {
    const { ruleStore } = stubHostEnv({
      contexts: [{ contextType: "OFFSCREEN_DOCUMENT" }],
      runtimeId: ""
    });
    const host = await import("../../extension/core/offscreen-host.js");

    const ruleId = await host.acquireBiliMediaSessionRule("video-media");
    expect(ruleStore.rules.get(ruleId)).toMatchObject({
      condition: {
        initiatorDomains: ["test"],
        tabIds: [-1],
        resourceTypes: ["media"]
      }
    });
    await host.releaseBiliMediaSessionRule(ruleId);

    ruleStore.updateSessionRules.mockRejectedValueOnce(new Error("Invalid initiatorDomains"));
    await expect(host.acquireBiliMediaSessionRule("video-media")).rejects.toThrow("Invalid initiatorDomains");
    expect(ruleStore.updateSessionRules).toHaveBeenCalledTimes(3);
  });

  it("runtime.getURL 返回空串时静默回退无 initiatorDomains，返回非法非空 URL 时记 logWarn 且不阻断规则注册", async () => {
    const logging = await import("../../extension/shared/logging.js");
    logging.registerDebugGate(() => true);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const emptyEnv = stubHostEnv({
        contexts: [{ contextType: "OFFSCREEN_DOCUMENT" }],
        runtimeId: "",
        runtimeGetUrl: () => ""
      });
      let host = await import("../../extension/core/offscreen-host.js");
      const emptyRuleId = await host.acquireBiliMediaSessionRule("video-media");
      expect(emptyEnv.ruleStore.rules.get(emptyRuleId)?.condition).not.toHaveProperty("initiatorDomains");
      expect(warnSpy).not.toHaveBeenCalled();

      vi.resetModules();
      const malformedEnv = stubHostEnv({
        contexts: [{ contextType: "OFFSCREEN_DOCUMENT" }],
        runtimeId: "",
        runtimeGetUrl: () => "not-a-valid-url"
      });
      host = await import("../../extension/core/offscreen-host.js");
      const malformedRuleId = await host.acquireBiliMediaSessionRule("video-media");
      expect(malformedEnv.ruleStore.rules.get(malformedRuleId)?.condition).not.toHaveProperty("initiatorDomains");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        "[BILISCRIPT] resolveExtensionInitiatorDomain failed to parse runtime URL",
        expect.objectContaining({ baseUrl: "not-a-valid-url" })
      );
    } finally {
      warnSpy.mockRestore();
      logging.registerDebugGate(() => false);
    }
  });
});
