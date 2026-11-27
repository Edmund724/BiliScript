// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONVERSATIONS_SYNC_SIGNAL_KEY,
  HISTORY_STORAGE_KEY,
  countConversationHistory,
  pruneConversationHistoryToLimit,
  readConversationHistory,
  saveConversationEntry
} from "../../extension/chat/conversation-storage.js";
import { createConversationStore, type StorageArea } from "../../extension/chat/conversation-store.js";
import {
  chatSessionState,
  resetChatSessionStateForTests
} from "../../extension/chat/chat-state.js";
import { createSubtitleIdbStore } from "../../extension/subtitle/idb-store.js";
import { configureSubtitleCacheStoreForTests } from "../../extension/subtitle/store-client.js";
import { ids } from "../../extension/reader/state.js";
import { renderReaderSettingsPanel } from "../../extension/ui/settings-panel.js";
import { formatCacheBytes } from "../../extension/ui/settings/data-retention-settings.js";
import { installSettingsPanelBus } from "../helpers/settings-panel-bus.js";
import { resetSettingsPanelState } from "../helpers/reset-settings-panel-state.js";

function makeMemoryStorage(initial: Record<string, unknown> = {}): StorageArea & {
  data: Map<string, unknown>;
} {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    data,
    get: vi.fn(async (keys: string[]) => {
      const out: Record<string, unknown> = {};
      for (const key of keys) {
        if (data.has(key)) out[key] = data.get(key);
      }
      return out;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) {
        data.set(k, v);
      }
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) data.delete(k);
    })
  };
}

function makeConversation(id: string, updatedAt: number) {
  return {
    id,
    title: `对话 ${id}`,
    contextKey: `video:BV1${id}|100`,
    contextTitle: `视频 ${id}`,
    contextUrl: `https://www.bilibili.com/video/BV1${id}/`,
    isVideoContext: true,
    createdAt: updatedAt - 1000,
    updatedAt,
    contextRef: {
      bvid: `BV1${id}`,
      cid: "100",
      url: `https://www.bilibili.com/video/BV1${id}/`,
      title: `视频 ${id}`
    },
    messages: [
      { role: "user", content: `问题 ${id}` },
      { role: "assistant", content: `回答 ${id}` }
    ]
  };
}

beforeEach(() => {
  resetChatSessionStateForTests();
  resetSettingsPanelState();
  configureSubtitleCacheStoreForTests(createSubtitleIdbStore({ indexedDB: null }));
});

describe("聊天记录 IndexedDB 持久化、迁移与条数限制", () => {
  it("首次读取时自动将旧 storage.local 历史迁入 IndexedDB 并清理旧键，且默认支持超过 60 条无限制保留", async () => {
    const legacyList = Array.from({ length: 75 }, (_, i) =>
      makeConversation(`c${i + 1}`, 10_000 + i * 100)
    );
    const local = makeMemoryStorage({ [HISTORY_STORAGE_KEY]: legacyList });

    const loaded = await readConversationHistory(local);
    expect(loaded).toHaveLength(75);
    expect(loaded[0].id).toBe("c75");
    expect(loaded[74].id).toBe("c1");
    expect(local.data.has(HISTORY_STORAGE_KEY)).toBe(false);
    expect(await countConversationHistory(local)).toBe(75);
  });

  it("按上限裁剪时保留最新 N 条、回收被删会话，并广播轻量同步信号", async () => {
    const local = makeMemoryStorage();
    for (let i = 1; i <= 5; i += 1) {
      await saveConversationEntry(makeConversation(`c${i}`, i * 1000), { storage: local, maxCount: 0 });
    }
    expect(await countConversationHistory(local)).toBe(5);
    expect(local.data.has(HISTORY_STORAGE_KEY)).toBe(false);
    expect(local.data.get(CONVERSATIONS_SYNC_SIGNAL_KEY)).toMatchObject({ op: "put", id: "c5" });

    const pruned = await pruneConversationHistoryToLimit(2, { storage: local });
    expect(pruned.keptCount).toBe(2);
    expect(pruned.removedIds.sort()).toEqual(["c1", "c2", "c3"]);
    const remaining = await readConversationHistory(local);
    expect(remaining.map((c) => c.id)).toEqual(["c5", "c4"]);
    expect(local.data.get(CONVERSATIONS_SYNC_SIGNAL_KEY)).toMatchObject({ op: "prune" });
  });

  it("createConversationStore 写入时遵守 getMaxCount 上限", async () => {
    const local = makeMemoryStorage();
    for (let i = 1; i <= 3; i += 1) {
      await saveConversationEntry(makeConversation(`old${i}`, i * 1000), { storage: local });
    }
    const store = createConversationStore({
      loadContextState: vi.fn(async () => true),
      resolveAiConversationRef: vi.fn(async () => ({})),
      onConversationChanged: vi.fn(),
      onStreamInterrupted: vi.fn(),
      onContextNotice: vi.fn(),
      storage: local,
      getMaxCount: () => 2
    });
    await store.loadAll();
    expect(chatSessionState.savedConversations).toHaveLength(3);

    await saveConversationEntry(makeConversation("new4", 999_999), { storage: local, maxCount: 2 });
    const after = await readConversationHistory(local);
    expect(after.map((c) => c.id)).toEqual(["new4", "old3"]);
  });
});

describe("高级设置页：聊天保留条数、视频缓存合并上限与占用显示", () => {
  it("调小聊天条数会弹确认框；取消回退选项，确认后立即保存并裁剪", async () => {
    const idb = createSubtitleIdbStore({ indexedDB: null });
    configureSubtitleCacheStoreForTests(idb);
    for (let i = 1; i <= 25; i += 1) {
      await saveConversationEntry(makeConversation(`conv_${i}`, i * 1000));
    }

    const savedPatches: Array<Record<string, unknown>> = [];
    document.body.innerHTML = `<div id="${ids.readingView}"><div id="${ids.readingSettingsPanel}"><div id="${ids.readingSettingsHost}"></div></div></div>`;
    installSettingsPanelBus({
      "get-settings": () => ({
        ok: true,
        settings: { chatHistoryMaxCount: 0, videoCacheMaxMb: 150, enableDebugLogs: false }
      }),
      "save-settings": (msg: { settings?: Record<string, unknown> }) => {
        if (msg?.settings) savedPatches.push(msg.settings);
        return { ok: true };
      }
    });

    await renderReaderSettingsPanel();
    const chatSelect = document.querySelector<HTMLSelectElement>("#chatHistoryMaxCount")!;
    expect(chatSelect.value).toBe("0");

    chatSelect.value = "20";
    chatSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector(".confirm-dialog-cancel")).not.toBeNull();
    });
    document.querySelector<HTMLButtonElement>(".confirm-dialog-cancel")!.click();
    await vi.waitFor(() => {
      expect(chatSelect.value).toBe("0");
    });
    expect(savedPatches).toEqual([]);
    expect(await countConversationHistory()).toBe(25);

    chatSelect.value = "20";
    chatSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector(".confirm-dialog-confirm")).not.toBeNull();
    });
    document.querySelector<HTMLButtonElement>(".confirm-dialog-confirm")!.click();
    await vi.waitFor(async () => {
      expect(await countConversationHistory()).toBe(20);
    });
    expect(savedPatches).toContainEqual({ chatHistoryMaxCount: 20 });
  });

  it("字幕与概览共享字节上限，设置页展示当前占用并在切换上限后立即淘汰刷新", async () => {
    let clock = 1000;
    const idb = createSubtitleIdbStore({
      indexedDB: null,
      maxBytes: 150 * 1024 * 1024,
      now: () => (clock += 10)
    });
    configureSubtitleCacheStoreForTests(idb);

    await idb.putRawTrack({
      bvid: "BV1old",
      cid: "1",
      trackKey: "id_cc1",
      items: [{ from: 0, to: 10, content: "a".repeat(20_000) }]
    });
    await idb.putAiArtifact({
      key: "biliscript_lvs_analysis_final_BV1new_2",
      family: "biliscript_lvs_analysis_final_",
      bvid: "BV1new",
      cid: "2",
      payload: { overview: "b".repeat(20_000) }
    });

    const initialUsage = await idb.getVideoCacheUsage();
    expect(initialUsage.subtitleBytes).toBeGreaterThan(20_000);
    expect(initialUsage.artifactBytes).toBeGreaterThan(20_000);
    expect(initialUsage.totalBytes).toBe(initialUsage.subtitleBytes + initialUsage.artifactBytes);

    const narrowed = await idb.setVideoCacheMaxBytes(initialUsage.artifactBytes + 1024);
    expect(narrowed.evictedPageIds).toContain("BV1old:1");
    expect(narrowed.usage.totalBytes).toBeLessThanOrEqual(initialUsage.artifactBytes + 1024);

    document.body.innerHTML = `<div id="${ids.readingView}"><div id="${ids.readingSettingsPanel}"><div id="${ids.readingSettingsHost}"></div></div></div>`;
    const savedPatches: Array<Record<string, unknown>> = [];
    installSettingsPanelBus({
      "get-settings": () => ({
        ok: true,
        settings: { chatHistoryMaxCount: 0, videoCacheMaxMb: 150, enableDebugLogs: false }
      }),
      "save-settings": (msg: { settings?: Record<string, unknown> }) => {
        if (msg?.settings) savedPatches.push(msg.settings);
        return { ok: true };
      }
    });

    await renderReaderSettingsPanel();
    const usageEl = document.querySelector<HTMLElement>("#videoCacheUsage")!;
    const cacheSelect = document.querySelector<HTMLSelectElement>("#videoCacheMaxMb")!;
    await vi.waitFor(() => {
      expect(usageEl.textContent).toBe(`${formatCacheBytes(narrowed.usage.totalBytes)} / 150 MB`);
    });

    cacheSelect.value = "500";
    cacheSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => {
      expect(savedPatches).toContainEqual({ videoCacheMaxMb: 500 });
      expect(usageEl.textContent).toBe(`${formatCacheBytes(narrowed.usage.totalBytes)} / 500 MB`);
    });
  });
});
