// core/offscreen-host.ts tests (Firefox Event Page hidden iframe host):
// covers idempotent creation, singleflight concurrency, load completion, error rollback,
// close teardown, and Firefox moz-extension:// offscreen sender verification.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { OFFSCREEN_URL } from "../../extension/shared/offscreen-constants.js";
import type { MessageSender } from "../../extension/shared/messaging-protocol.js";

const FIREFOX_BASE = "moz-extension://firefox-uuid/";
const FIREFOX_OFFSCREEN_URL = `${FIREFOX_BASE}${OFFSCREEN_URL}`;
const OFFSCREEN_IFRAME_ID = "biliscript-offscreen-iframe";

function stubFirefoxHostEnv(options?: {
  updateSessionRules?: (opts: { removeRuleIds?: number[]; addRules?: unknown[] }) => Promise<void>;
}) {
  const rules = new Map<number, unknown>();
  const updateSessionRules = vi.fn(
    options?.updateSessionRules ??
      (async ({ removeRuleIds = [], addRules = [] }: { removeRuleIds?: number[]; addRules?: Array<{ id: number }> }) => {
        removeRuleIds.forEach((id) => rules.delete(id));
        addRules.forEach((rule) => rules.set(rule.id, rule));
      })
  );
  const getSessionRules = vi.fn(async () => [...rules.values()]);

  vi.stubGlobal("chrome", {
    ...globalThis.chrome,
    offscreen: undefined,
    runtime: {
      ...globalThis.chrome.runtime,
      id: "biliscript@edmund724.github.io",
      getURL: vi.fn((path: string) => `${FIREFOX_BASE}${path}`)
    },
    declarativeNetRequest: {
      updateSessionRules,
      getSessionRules
    }
  });

  return { rules, updateSessionRules, getSessionRules };
}

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
  stubFirefoxHostEnv();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("Firefox Event Page 隐藏 iframe Offscreen 宿主", () => {
  it("初次创建挂入隐藏 iframe 并等待 load 完成", async () => {
    const host = await import("../../extension/core/offscreen-host.js");

    let settled = false;
    const ensurePromise = host.ensureOffscreenDocument().then((value) => {
      settled = true;
      return value;
    });

    const iframe = document.getElementById(OFFSCREEN_IFRAME_ID) as HTMLIFrameElement | null;
    expect(iframe).toBeInstanceOf(HTMLIFrameElement);
    expect(iframe?.parentElement).toBe(document.body);
    expect(iframe?.hidden).toBe(true);
    expect(iframe?.style.display).toBe("none");
    expect(iframe?.src).toBe(FIREFOX_OFFSCREEN_URL);
    expect(settled).toBe(false);

    iframe?.dispatchEvent(new Event("load"));
    await expect(ensurePromise).resolves.toBe(true);
  });

  it("已存在存活 iframe 时幂等返回 true 且不重复挂载", async () => {
    const host = await import("../../extension/core/offscreen-host.js");

    const firstEnsure = host.ensureOffscreenDocument();
    const firstIframe = document.getElementById(OFFSCREEN_IFRAME_ID) as HTMLIFrameElement;
    firstIframe.dispatchEvent(new Event("load"));
    await expect(firstEnsure).resolves.toBe(true);

    await expect(host.ensureOffscreenDocument()).resolves.toBe(true);
    expect(document.querySelectorAll(`#${OFFSCREEN_IFRAME_ID}`)).toHaveLength(1);
    expect(document.getElementById(OFFSCREEN_IFRAME_ID)).toBe(firstIframe);
  });

  it("并发单飞合并：同一 tick 多次调用仅挂载一个 iframe 并共享同一 load 结果", async () => {
    const host = await import("../../extension/core/offscreen-host.js");

    const p1 = host.ensureOffscreenDocument();
    const p2 = host.ensureOffscreenDocument();
    const p3 = host.ensureOffscreenDocument();

    const iframes = document.querySelectorAll(`#${OFFSCREEN_IFRAME_ID}`);
    expect(iframes).toHaveLength(1);

    iframes[0].dispatchEvent(new Event("load"));
    await expect(Promise.all([p1, p2, p3])).resolves.toEqual([true, true, true]);
  });

  it("load 失败触发 error 时移除节点、释放单飞锁并允许后续重试成功", async () => {
    const host = await import("../../extension/core/offscreen-host.js");

    const p1 = host.ensureOffscreenDocument();
    const p2 = host.ensureOffscreenDocument();
    const failedIframe = document.getElementById(OFFSCREEN_IFRAME_ID) as HTMLIFrameElement;

    failedIframe.dispatchEvent(new Event("error"));
    await expect(p1).rejects.toThrow("Failed to load offscreen iframe");
    await expect(p2).rejects.toThrow("Failed to load offscreen iframe");
    expect(document.getElementById(OFFSCREEN_IFRAME_ID)).toBeNull();
    expect(failedIframe.isConnected).toBe(false);

    const retryPromise = host.ensureOffscreenDocument();
    const retriedIframe = document.getElementById(OFFSCREEN_IFRAME_ID) as HTMLIFrameElement;
    expect(retriedIframe).toBeInstanceOf(HTMLIFrameElement);
    expect(retriedIframe).not.toBe(failedIframe);

    retriedIframe.dispatchEvent(new Event("load"));
    await expect(retryPromise).resolves.toBe(true);
  });

  it("挂载期同步抛出异常时不锁死单飞锁并允许后续重试成功", async () => {
    const host = await import("../../extension/core/offscreen-host.js");
    const appendSpy = vi.spyOn(document.body, "appendChild").mockImplementationOnce(() => {
      throw new Error("appendChild sync failure");
    });

    await expect(host.ensureOffscreenDocument()).rejects.toThrow("appendChild sync failure");
    expect(document.getElementById(OFFSCREEN_IFRAME_ID)).toBeNull();
    appendSpy.mockRestore();

    const retryPromise = host.ensureOffscreenDocument();
    const retriedIframe = document.getElementById(OFFSCREEN_IFRAME_ID) as HTMLIFrameElement;
    expect(retriedIframe).toBeInstanceOf(HTMLIFrameElement);
    retriedIframe.dispatchEvent(new Event("load"));
    await expect(retryPromise).resolves.toBe(true);
  });

  it("存在 contentWindow 为 null 的失效节点时清理并重建新 iframe", async () => {
    const host = await import("../../extension/core/offscreen-host.js");

    const staleIframe = document.createElement("iframe");
    staleIframe.id = OFFSCREEN_IFRAME_ID;
    Object.defineProperty(staleIframe, "contentWindow", { value: null, configurable: true });
    document.body.appendChild(staleIframe);

    const ensurePromise = host.ensureOffscreenDocument();
    const freshIframe = document.getElementById(OFFSCREEN_IFRAME_ID) as HTMLIFrameElement;
    expect(freshIframe).not.toBe(staleIframe);
    expect(staleIframe.isConnected).toBe(false);
    expect(document.querySelectorAll(`#${OFFSCREEN_IFRAME_ID}`)).toHaveLength(1);

    freshIframe.dispatchEvent(new Event("load"));
    await expect(ensurePromise).resolves.toBe(true);
  });

  it("closeOffscreenDocument 将 iframe src 置为 about:blank 并从 DOM 摘除，重复关闭幂等", async () => {
    const host = await import("../../extension/core/offscreen-host.js");

    const ensurePromise = host.ensureOffscreenDocument();
    const iframe = document.getElementById(OFFSCREEN_IFRAME_ID) as HTMLIFrameElement;
    iframe.dispatchEvent(new Event("load"));
    await ensurePromise;

    await host.closeOffscreenDocument();
    expect(iframe.src).toBe("about:blank");
    expect(iframe.isConnected).toBe(false);
    expect(document.getElementById(OFFSCREEN_IFRAME_ID)).toBeNull();

    await expect(host.closeOffscreenDocument()).resolves.toBeUndefined();
  });

  it("加载未完成时调用 closeOffscreenDocument 会中断在途 promise、释放锁并移除 DOM", async () => {
    const host = await import("../../extension/core/offscreen-host.js");

    const pendingEnsure = host.ensureOffscreenDocument();
    const iframe = document.getElementById(OFFSCREEN_IFRAME_ID) as HTMLIFrameElement;

    await host.closeOffscreenDocument();
    await expect(pendingEnsure).rejects.toThrow("Offscreen iframe closed before load completed.");
    expect(iframe.src).toBe("about:blank");
    expect(iframe.isConnected).toBe(false);

    const nextEnsure = host.ensureOffscreenDocument();
    const nextIframe = document.getElementById(OFFSCREEN_IFRAME_ID) as HTMLIFrameElement;
    nextIframe.dispatchEvent(new Event("load"));
    await expect(nextEnsure).resolves.toBe(true);
  });

  it("Firefox 串行队列：在途 close 后紧跟新 ensure 时可顺序重建隐藏 iframe 并完整摘除旧帧", async () => {
    const host = await import("../../extension/core/offscreen-host.js");

    const firstEnsure = host.ensureOffscreenDocument();
    const firstIframe = document.getElementById(OFFSCREEN_IFRAME_ID) as HTMLIFrameElement;
    firstIframe.dispatchEvent(new Event("load"));
    await expect(firstEnsure).resolves.toBe(true);

    const closePromise = host.closeOffscreenDocument();
    const rebuildPromise = host.ensureOffscreenDocument();

    await expect(closePromise).resolves.toBeUndefined();
    expect(firstIframe.src).toBe("about:blank");
    expect(firstIframe.isConnected).toBe(false);

    await vi.waitFor(() => expect(document.getElementById(OFFSCREEN_IFRAME_ID)).toBeInstanceOf(HTMLIFrameElement));
    const rebuiltIframe = document.getElementById(OFFSCREEN_IFRAME_ID) as HTMLIFrameElement;
    expect(rebuiltIframe).not.toBe(firstIframe);
    rebuiltIframe.dispatchEvent(new Event("load"));
    await expect(rebuildPromise).resolves.toBe(true);
  });

  it("isOffscreenDocumentSender 放行无 tab 的 Firefox 扩展 offscreen 子帧并拒绝其他来源", async () => {
    const host = await import("../../extension/core/offscreen-host.js");

    const validSender: MessageSender = { url: FIREFOX_OFFSCREEN_URL };
    const validWithId: MessageSender = { id: "biliscript@edmund724.github.io", url: FIREFOX_OFFSCREEN_URL };
    const tabSender: MessageSender = { tab: { id: 3 }, url: FIREFOX_OFFSCREEN_URL };
    const bgPageSender: MessageSender = { url: `${FIREFOX_BASE}_generated_background_page.html` };
    const grantPageSender: MessageSender = { url: `${FIREFOX_BASE}entry/permission-grant.html` };
    const foreignExtSender: MessageSender = { url: `moz-extension://other-uuid/${OFFSCREEN_URL}` };

    expect(host.isOffscreenDocumentSender(validSender)).toBe(true);
    expect(host.isOffscreenDocumentSender(validWithId)).toBe(true);
    expect(host.isOffscreenDocumentSender(tabSender)).toBe(false);
    expect(host.isOffscreenDocumentSender(bgPageSender)).toBe(false);
    expect(host.isOffscreenDocumentSender(grantPageSender)).toBe(false);
    expect(host.isOffscreenDocumentSender(foreignExtSender)).toBe(false);
    expect(host.isOffscreenDocumentSender({})).toBe(false);
  });

  it("Firefox DNR 规则使用 moz-extension UUID 作为 initiatorDomains 并限定 tabIds: [-1]，不传入 gecko.id", async () => {
    const { rules } = stubFirefoxHostEnv();
    const host = await import("../../extension/core/offscreen-host.js");

    const loadAndSettle = async () => {
      const promise = host.acquireBiliMediaSessionRule("video-media");
      await vi.waitFor(() => expect(document.getElementById(OFFSCREEN_IFRAME_ID)).toBeInstanceOf(HTMLIFrameElement));
      const iframe = document.getElementById(OFFSCREEN_IFRAME_ID) as HTMLIFrameElement;
      iframe.dispatchEvent(new Event("load"));
      return promise;
    };

    const ruleId = await loadAndSettle();
    expect(rules.get(ruleId)).toMatchObject({
      condition: {
        requestDomains: [...host.BILI_MEDIA_CDN_DOMAINS],
        initiatorDomains: ["firefox-uuid"],
        tabIds: [-1],
        resourceTypes: ["media"]
      }
    });
  });

  it("Firefox 运行时若拒绝 initiatorDomains，则保留 tabIds: [-1] 隔离并降级重试成功", async () => {
    let attempts = 0;
    const { rules, updateSessionRules } = stubFirefoxHostEnv({
      updateSessionRules: async ({ removeRuleIds = [], addRules = [] }) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("Invalid domain in initiatorDomains");
        }
        removeRuleIds.forEach((id) => rules.delete(id));
        (addRules as Array<{ id: number }>).forEach((rule) => rules.set(rule.id, rule));
      }
    });
    const host = await import("../../extension/core/offscreen-host.js");

    const promise = host.acquireBiliMediaSessionRule("video-media");
    await vi.waitFor(() => expect(document.getElementById(OFFSCREEN_IFRAME_ID)).toBeInstanceOf(HTMLIFrameElement));
    (document.getElementById(OFFSCREEN_IFRAME_ID) as HTMLIFrameElement).dispatchEvent(new Event("load"));
    const ruleId = await promise;

    expect(updateSessionRules).toHaveBeenCalledTimes(2);
    expect(rules.get(ruleId)).toEqual({
      id: ruleId,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Referer", operation: "set", value: host.BILI_MEDIA_ORIGIN_PAGE },
          { header: "Origin", operation: "set", value: host.BILI_MEDIA_ORIGIN_PAGE }
        ],
        responseHeaders: [{ header: "Access-Control-Allow-Origin", operation: "set", value: "*" }]
      },
      condition: {
        requestDomains: [...host.BILI_MEDIA_CDN_DOMAINS],
        tabIds: [-1],
        resourceTypes: ["media"]
      }
    });
  });
});
