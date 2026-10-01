// 工单 03：后台（SW）消息入口守卫——发送者来源、内部消息 schema、标签页归属。
//
// 守卫在路由之后、处理器执行之前：非法来源/载荷在产生任何副作用前被拒绝并
// 明确回 { ok:false }。覆盖场景：
//   - offscreen 专属消息族（segment-cache）被非 offscreen 来源调用 → 拒绝且
//     处理器零副作用；
//   - 内部 schema：save-settings / providers-save / player-ai-quick-action 的
//     形状明显非法载荷被拒；
//   - 标签页归属：player-ai-quick-action 的 message.tabId 与 sender.tab.id
//     不一致（跨标签页伪造）→ 拒绝且不向任何标签页发消息；
//   - 未知消息类型 / 非对象消息：不回包、零副作用（与既有行为一致）。
//   - 查询缓存消息族（spec §5 / §10 第 39 行）：search-cache 的发送者含
//     content（选区解释卡），**不得**进 offscreen-only 名单；tab 来源的
//     get/put 照常落到 SW 叶（跑通 put → get 命中往返）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { sendMessageToTab } from "../../extension/shared/tab-utils.js";
import { SEARCH_CACHE_KEY } from "../../extension/search/search-cache.js";
import type { MessageSender } from "../../extension/shared/messaging-protocol.js";

vi.mock("../../extension/shared/tab-utils.js", () => ({
  sendMessageToTab: vi.fn(async () => ({ ok: true })),
  waitForTabComplete: vi.fn(async () => true)
}));

const OFFSCREEN_SENDER: MessageSender = { url: "chrome-extension://test/entry/offscreen.html" };
const TAB_SENDER = (id: number): MessageSender => ({ tab: { id }, url: "https://www.bilibili.com/video/BV1/" });

// storage.local 内存 fixture：查询缓存 handler 的落盘面要能读回（单键映射）。
let localFixture: Record<string, unknown>;

function readFixture(fixture: Record<string, unknown>, keys: unknown): Record<string, unknown> {
  const requested = (
    Array.isArray(keys) ? keys : keys && typeof keys === "object" ? Object.keys(keys) : [keys]
  ) as string[];
  const out: Record<string, unknown> = {};
  for (const key of requested) {
    if (key in fixture) out[key] = fixture[key];
  }
  return out;
}

async function importBackground() {
  resetModuleState();
  localFixture = {};
  vi.stubGlobal("chrome", {
    runtime: {
      lastError: null,
      getURL: (path: string) => `chrome-extension://test/${path}`,
      sendMessage: vi.fn((_message, callback) => {
        callback?.({ ok: true });
        return undefined;
      }),
      getManifest: () => ({ version: "9.9.9" }),
      onInstalled: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn() }
    },
    tabs: { onUpdated: { addListener: vi.fn() } },
    storage: {
      local: {
        get: vi.fn(async (keys: unknown) => readFixture(localFixture, keys)),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(localFixture, items);
        }),
        remove: vi.fn(async (keys: unknown) => {
          for (const key of (Array.isArray(keys) ? keys : [keys]) as string[]) delete localFixture[key];
        })
      },
      sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
    }
  });
  await import("../../extension/entry/background.js");
  return vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0][0];
}

beforeEach(() => {
  vi.mocked(sendMessageToTab).mockClear();
});

describe("消息入口守卫：发送者来源", () => {
  it("segment-cache 被 tab 来源调用：拒绝（ok:false）且处理器零副作用", async () => {
    const listener = await importBackground();
    const storageLocalSet = vi.mocked(chrome.storage.local.set);
    storageLocalSet.mockClear();

    const sendResponse = vi.fn();
    const keepOpen = listener(
      { type: "segment-cache", op: "save-raw", context: { bvid: "BV1" }, segments: [1] },
      TAB_SENDER(7),
      sendResponse
    );

    expect(keepOpen).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "仅接受 offscreen 文档发送" });
    expect(storageLocalSet).not.toHaveBeenCalled();
  });

  it("segment-cache 由 offscreen 文档发送：通过守卫进入处理器", async () => {
    const listener = await importBackground();

    const sendResponse = vi.fn();
    const keepOpen = listener(
      { type: "segment-cache", op: "load-summary", context: { bvid: "BV1" } },
      OFFSCREEN_SENDER,
      sendResponse
    );

    expect(keepOpen).toBe(true);
    await vi.waitFor(() => {
      const resp = sendResponse.mock.calls[0]?.[0];
      expect(resp?.ok).toBe(true);
    });
  });
});

describe("查询缓存消息族：来源守卫与 SW 叶往返（spec §5 / §10 第 39 行）", () => {
  it("search-cache 由 tab 来源发送：不得回「仅接受 offscreen 文档发送」（发送者含 content）", async () => {
    const listener = await importBackground();

    const sendResponse = vi.fn();
    const keepOpen = listener({ type: "search-cache", op: "get", query: "bilibili ai" }, TAB_SENDER(7), sendResponse);

    expect(keepOpen).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(sendResponse).not.toHaveBeenCalledWith(
      expect.objectContaining({ error: "仅接受 offscreen 文档发送" })
    );
    expect(sendResponse.mock.calls[0][0]).toMatchObject({ ok: true, hit: false });
  });

  it("search-cache 由 tab 来源 put：落 chrome.storage.local 单键（哈希键、无查询明文），随后 get 命中同一条", async () => {
    const listener = await importBackground();
    const entry = { results: [{ title: "t", url: "https://example.com", snippet: "s" }], platform: "Firecrawl" };

    const putResponse = vi.fn();
    listener({ type: "search-cache", op: "put", query: "bilibili ai", ...entry }, TAB_SENDER(7), putResponse);
    await vi.waitFor(() => expect(putResponse).toHaveBeenCalledWith({ ok: true }));

    const stored = localFixture[SEARCH_CACHE_KEY] as Record<string, unknown>;
    expect(Object.keys(localFixture)).toEqual([SEARCH_CACHE_KEY]);
    expect(Object.keys(stored)).toHaveLength(1);
    expect(Object.keys(stored)[0]).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(stored)).not.toContain("bilibili");

    // 归一在 SW 侧单源：大小写 / 连续空白变体命中同一条
    const getResponse = vi.fn();
    listener({ type: "search-cache", op: "get", query: "  BiliBili   AI " }, TAB_SENDER(7), getResponse);
    await vi.waitFor(() =>
      expect(getResponse).toHaveBeenCalledWith(expect.objectContaining({ ok: true, hit: true, entry }))
    );
  });
});

describe("消息入口守卫：内部消息 schema", () => {
  it.each([
    ["save-settings", { type: "save-settings", settings: "junk" }],
    ["save-settings 数组", { type: "save-settings", settings: [1, 2] }],
    ["ai-providers-save", { type: "ai-providers-save", providers: "x" }],
    ["asr-providers-save", { type: "asr-providers-save", providers: 42 }],
    ["player-ai-quick-action", { type: "player-ai-quick-action", tabId: "7" }]
  ])("%s 的非法载荷被拒：ok:false、零副作用", async (_label, message) => {
    const listener = await importBackground();

    const sendResponse = vi.fn();
    const keepOpen = listener(message, TAB_SENDER(7), sendResponse);

    expect(keepOpen).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: expect.stringContaining("载荷不合法") });
    expect(sendMessageToTab).not.toHaveBeenCalled();
  });

  it("合法载荷照常进入处理器：save-settings 对象 → ok:true", async () => {
    const listener = await importBackground();

    const sendResponse = vi.fn();
    listener({ type: "save-settings", settings: { enableDebugLogs: true } }, TAB_SENDER(7), sendResponse);

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
  });
});

describe("消息入口守卫：标签页归属", () => {
  it("player-ai-quick-action 的 tabId 与 sender.tab 不一致：拒绝且不向任何标签页发消息", async () => {
    const listener = await importBackground();

    const sendResponse = vi.fn();
    const keepOpen = listener({ type: "player-ai-quick-action", tabId: 7 }, TAB_SENDER(8), sendResponse);

    expect(keepOpen).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({
      ok: false,
      error: "请求目标与发送者标签页不一致，已拒绝。"
    });
    expect(sendMessageToTab).not.toHaveBeenCalled();
  });

  it("tabId 与 sender.tab 一致（同标签页）：照常触发 reader-enter 编排", async () => {
    const listener = await importBackground();

    const sendResponse = vi.fn();
    listener({ type: "player-ai-quick-action", tabId: 7 }, TAB_SENDER(7), sendResponse);

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
    expect(sendMessageToTab).toHaveBeenCalledWith(7, expect.objectContaining({ type: "reader-enter" }));
  });
});

describe("未知/畸形消息：零副作用", () => {
  it("未知消息类型：不回包、返回 false", async () => {
    const listener = await importBackground();

    const sendResponse = vi.fn();
    const keepOpen = listener({ type: "no-such-message" }, TAB_SENDER(7), sendResponse);

    expect(keepOpen).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it("非对象消息：不回包、返回 false", async () => {
    const listener = await importBackground();

    const sendResponse = vi.fn();
    expect(listener(null, TAB_SENDER(7), sendResponse)).toBe(false);
    expect(listener("str", TAB_SENDER(7), sendResponse)).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });
});
