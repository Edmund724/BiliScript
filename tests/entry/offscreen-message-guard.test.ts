import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { sendMessageToTab } from "../../extension/shared/tab-utils.js";
import { SEARCH_CACHE_KEY } from "../../extension/search/search-cache.js";
import type { MessageSender } from "../../extension/shared/messaging-protocol.js";

vi.mock("../../extension/shared/tab-utils.js", () => ({
  sendMessageToTab: vi.fn(async () => ({ ok: true })),
  waitForTabComplete: vi.fn(async () => true)
}));

const TAB_SENDER = (id: number): MessageSender => ({ tab: { id }, url: "https://www.bilibili.com/video/BV1/" });

let localFixture: Record<string, unknown>;
let syncFixture: Record<string, unknown>;

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
  syncFixture = {};
  vi.stubGlobal("chrome", {
    ...globalThis.chrome,
    runtime: {
      ...globalThis.chrome.runtime,
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
    tabs: { ...globalThis.chrome.tabs, onUpdated: { addListener: vi.fn() } },
    storage: {
      ...globalThis.chrome.storage,
      local: {
        get: vi.fn(async (keys: unknown) => readFixture(localFixture, keys)),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(localFixture, items);
        }),
        remove: vi.fn(async (keys: unknown) => {
          for (const key of (Array.isArray(keys) ? keys : [keys]) as string[]) delete localFixture[key];
        })
      },
      sync: {
        get: vi.fn(async (keys: unknown) => readFixture(syncFixture, keys)),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(syncFixture, items);
        }),
        remove: vi.fn(async (keys: unknown) => {
          for (const key of (Array.isArray(keys) ? keys : [keys]) as string[]) delete syncFixture[key];
        })
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
    }
  });
  await import("../../extension/entry/background.js");
  return vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0][0];
}

beforeEach(() => {
  vi.mocked(sendMessageToTab).mockClear();
});

describe("查询缓存消息族：来源守卫（spec §5 / §10 第 39 行）", () => {
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

  it("search-cache 未知 op → ok:false + 错误文案（消息边界不静默吞）", async () => {
    const listener = await importBackground();

    const sendResponse = vi.fn();
    const keepOpen = listener({ type: "search-cache", op: "purge", query: "bilibili ai" }, TAB_SENDER(7), sendResponse);

    expect(keepOpen).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(sendResponse.mock.calls[0][0]).toEqual({
      ok: false,
      error: "不支持的搜索缓存操作：purge"
    });
  });
});

describe("撤回同意：清空查询缓存（spec §6.7 / §10 第 40 行）", () => {
  type BackgroundListener = (
    message: unknown,
    sender: MessageSender,
    sendResponse: (response: unknown) => void
  ) => unknown;

  async function seedCacheEntry(listener: BackgroundListener, query: string): Promise<void> {
    const respond = vi.fn();
    listener(
      {
        type: "search-cache",
        op: "put",
        query,
        results: [{ title: "t", url: "https://example.com", snippet: "s" }],
        platform: "Firecrawl"
      },
      TAB_SENDER(7),
      respond
    );
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith({ ok: true }));
    expect(localFixture[SEARCH_CACHE_KEY]).toBeTruthy();
  }

  async function expectCacheMiss(listener: BackgroundListener, query: string): Promise<void> {
    const respond = vi.fn();
    listener({ type: "search-cache", op: "get", query }, TAB_SENDER(7), respond);
    await vi.waitFor(() =>
      expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true, hit: false }))
    );
  }

  it("删搜索平台记录（search-providers-delete）→ 整张缓存清空、随后读未命中", async () => {
    const listener = await importBackground();
    await seedCacheEntry(listener, "bilibili ai");

    const deleteResponse = vi.fn();
    listener({ type: "search-providers-delete", providerId: "search_firecrawl" }, TAB_SENDER(7), deleteResponse);
    await vi.waitFor(() => expect(deleteResponse).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));

    expect(localFixture[SEARCH_CACHE_KEY]).toBeUndefined();
    await expectCacheMiss(listener, "bilibili ai");
  });
});

describe("消息入口守卫：内部消息 schema", () => {
  it.each([
    ["save-settings", { type: "save-settings", settings: "junk" }],
    ["save-settings 数组", { type: "save-settings", settings: [1, 2] }],
    ["ai-providers-save", { type: "ai-providers-save", providers: "x" }],
    ["asr-providers-save", { type: "asr-providers-save", providers: 42 }],
    ["search-providers-save", { type: "search-providers-save", providers: "x" }],
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
