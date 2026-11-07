import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installSettingsPanelBus } from "../helpers/settings-panel-bus.js";

const NOW = 1_700_000_000_000;
const DAY_MS = 86_400_000;

let CONVERSATIONS_STORAGE_KEY: string;
let getConversationTimestamp: typeof import("../../extension/chat/conversation-store.js").getConversationTimestamp;
let isConversationOlderThanRetention: typeof import("../../extension/chat/conversation-store.js").isConversationOlderThanRetention;
let filterExpiredConversations: typeof import("../../extension/chat/conversation-store.js").filterExpiredConversations;
let cleanExpiredConversations: typeof import("../../extension/chat/conversation-store.js").cleanExpiredConversations;
let createConversationStore: typeof import("../../extension/chat/conversation-store.js").createConversationStore;
type StorageArea = import("../../extension/chat/conversation-store.js").StorageArea;

let chatSessionState: typeof import("../../extension/chat/chat-state.js").chatSessionState;
let setSavedConversations: typeof import("../../extension/chat/chat-state.js").setSavedConversations;
let applyConversationIdentity: typeof import("../../extension/chat/chat-state.js").applyConversationIdentity;

function makeMockStorage(initialData: Record<string, unknown> = {}): StorageArea & {
  data: Map<string, unknown>;
  setCalls: Record<string, unknown>[];
} {
  const data = new Map<string, unknown>(Object.entries(initialData));
  const setCalls: Record<string, unknown>[] = [];
  return {
    data,
    setCalls,
    get: vi.fn(async (keys: string[]) => {
      const res: Record<string, unknown> = {};
      for (const k of keys) {
        if (data.has(k)) {
          res[k] = data.get(k);
        }
      }
      return res;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      setCalls.push(items);
      for (const [k, v] of Object.entries(items)) {
        data.set(k, v);
      }
    })
  };
}

function makeConversation(id: string, overrides: { updatedAt?: unknown; createdAt?: unknown } = {}) {
  return {
    id,
    title: `对话 ${id}`,
    contextKey: `key-${id}`,
    contextTitle: `视频 ${id}`,
    contextUrl: `https://www.bilibili.com/video/${id}`,
    isVideoContext: true,
    createdAt: NOW - 10 * DAY_MS,
    updatedAt: NOW - 10 * DAY_MS,
    contextRef: { bvid: id, cid: "1", url: `https://www.bilibili.com/video/${id}` },
    messages: [{ role: "user", content: "hello" }],
    ...overrides
  };
}

beforeEach(async () => {
  resetModuleState();
  const storeMod = await import("../../extension/chat/conversation-store.js");
  CONVERSATIONS_STORAGE_KEY = storeMod.CONVERSATIONS_STORAGE_KEY;
  getConversationTimestamp = storeMod.getConversationTimestamp;
  isConversationOlderThanRetention = storeMod.isConversationOlderThanRetention;
  filterExpiredConversations = storeMod.filterExpiredConversations;
  cleanExpiredConversations = storeMod.cleanExpiredConversations;
  createConversationStore = storeMod.createConversationStore;

  const stateMod = await import("../../extension/chat/chat-state.js");
  chatSessionState = stateMod.chatSessionState;
  setSavedConversations = stateMod.setSavedConversations;
  applyConversationIdentity = stateMod.applyConversationIdentity;
});

describe("30 天会话清理纯函数与边界断言", () => {
  describe("getConversationTimestamp", () => {
    it("优先取有效正数 updatedAt", () => {
      expect(getConversationTimestamp({ updatedAt: 5000, createdAt: 1000 })).toBe(5000);
      expect(getConversationTimestamp({ updatedAt: "6000", createdAt: 1000 })).toBe(6000);
    });

    it("updatedAt 缺失、<=0 或非法时回落 createdAt", () => {
      expect(getConversationTimestamp({ createdAt: 2000 })).toBe(2000);
      expect(getConversationTimestamp({ updatedAt: 0, createdAt: 3000 })).toBe(3000);
      expect(getConversationTimestamp({ updatedAt: null, createdAt: 4000 })).toBe(4000);
      expect(getConversationTimestamp({ updatedAt: "invalid", createdAt: 5000 })).toBe(5000);
    });

    it("两者均缺失或非法时回落 0", () => {
      expect(getConversationTimestamp({})).toBe(0);
      expect(getConversationTimestamp({ updatedAt: null, createdAt: undefined })).toBe(0);
    });
  });

  describe("isConversationOlderThanRetention 边界检查", () => {
    it("29 天前的记录保留（未超期）", () => {
      const conv = makeConversation("c-29d", { updatedAt: NOW - 29 * DAY_MS });
      expect(isConversationOlderThanRetention(conv, NOW)).toBe(false);
    });

    it("恰好 30 天前的记录保留（updatedAt < now - 30d 判定为严格小于才清理）", () => {
      const conv = makeConversation("c-30d", { updatedAt: NOW - 30 * DAY_MS });
      expect(isConversationOlderThanRetention(conv, NOW)).toBe(false);
    });

    it("30 天零 1 毫秒前的记录清理", () => {
      const conv = makeConversation("c-30d-1ms", { updatedAt: NOW - (30 * DAY_MS + 1) });
      expect(isConversationOlderThanRetention(conv, NOW)).toBe(true);
    });

    it("31 天前的记录清理", () => {
      const conv = makeConversation("c-31d", { updatedAt: NOW - 31 * DAY_MS });
      expect(isConversationOlderThanRetention(conv, NOW)).toBe(true);
    });

    it("缺失 updatedAt 时正确按 createdAt 边界检查", () => {
      const convKeep = makeConversation("c-fallback-keep", { updatedAt: undefined, createdAt: NOW - 29 * DAY_MS });
      expect(isConversationOlderThanRetention(convKeep, NOW)).toBe(false);

      const convPrune = makeConversation("c-fallback-prune", { updatedAt: null, createdAt: NOW - 31 * DAY_MS });
      expect(isConversationOlderThanRetention(convPrune, NOW)).toBe(true);
    });

    it("时间戳全部无效时清理（时间戳 0 视为远超 30 天）", () => {
      const conv = makeConversation("c-invalid", { updatedAt: undefined, createdAt: undefined });
      expect(isConversationOlderThanRetention(conv, NOW)).toBe(true);
    });
  });

  describe("filterExpiredConversations", () => {
    it("正确过滤超期会话并返回保留清单与清理计数", () => {
      const conv29 = makeConversation("c29", { updatedAt: NOW - 29 * DAY_MS });
      const conv30 = makeConversation("c30", { updatedAt: NOW - 30 * DAY_MS });
      const conv31 = makeConversation("c31", { updatedAt: NOW - 31 * DAY_MS });
      const convFallback29 = makeConversation("c-fb-29", { updatedAt: undefined, createdAt: NOW - 29 * DAY_MS });
      const convFallback31 = makeConversation("c-fb-31", { updatedAt: null, createdAt: NOW - 31 * DAY_MS });

      const { kept, pruned, prunedCount } = filterExpiredConversations(
        [conv29, conv31, conv30, convFallback29, convFallback31],
        NOW
      );

      expect(prunedCount).toBe(2);
      expect(kept.map((c) => c.id)).toEqual(["c29", "c30", "c-fb-29"]);
      expect(pruned.map((c) => c.id)).toEqual(["c31", "c-fb-31"]);
    });
  });
});

describe("cleanExpiredConversations 存储扫描与内存状态同步", () => {
  it("扫描存储、清理超期会话，并同步内存中的 savedConversations 与当前会话状态", async () => {
    const expiredConv = makeConversation("expired-1", { updatedAt: NOW - 35 * DAY_MS });
    const freshConv = makeConversation("fresh-1", { updatedAt: NOW - 5 * DAY_MS });

    const storage = makeMockStorage({
      [CONVERSATIONS_STORAGE_KEY]: [expiredConv, freshConv]
    });

    // 内存预置两会话，且当前活跃会话恰为超期会话
    setSavedConversations([expiredConv as any, freshConv as any]);
    applyConversationIdentity({
      id: expiredConv.id,
      meta: { id: expiredConv.id, title: expiredConv.title }
    });

    expect(chatSessionState.currentConversationId).toBe(expiredConv.id);
    expect(chatSessionState.savedConversations).toHaveLength(2);

    const result = await cleanExpiredConversations(storage, NOW);

    expect(result.prunedCount).toBe(1);
    expect(result.kept.map((c) => c.id)).toEqual(["fresh-1"]);

    // 验证存储落盘仅保留未超期项
    const savedInStorage = storage.data.get(CONVERSATIONS_STORAGE_KEY) as any[];
    expect(savedInStorage).toHaveLength(1);
    expect(savedInStorage[0].id).toBe("fresh-1");

    // 验证内存状态：已同步为剩余会话
    expect(chatSessionState.savedConversations).toHaveLength(1);
    expect(chatSessionState.savedConversations[0].id).toBe("fresh-1");

    // 验证活跃会话已被安全拆除
    expect(chatSessionState.currentConversationId).toBe("");
    expect(chatSessionState.currentConversationMeta).toBeNull();
  });

  it("无超期记录时不触发额外写入", async () => {
    const freshConv = makeConversation("fresh-1", { updatedAt: NOW - 5 * DAY_MS });
    const storage = makeMockStorage({
      [CONVERSATIONS_STORAGE_KEY]: [freshConv]
    });

    const result = await cleanExpiredConversations(storage, NOW);
    expect(result.prunedCount).toBe(0);
    expect(storage.setCalls).toHaveLength(0);
  });
});

describe("createConversationStore.loadAll 触发时机", () => {
  function makeDeps(overrides: Record<string, unknown> = {}) {
    return {
      loadContextState: vi.fn(async () => true),
      resolveAiConversationRef: vi.fn(async () => ({})),
      onConversationChanged: vi.fn(),
      onStreamInterrupted: vi.fn(),
      onContextNotice: vi.fn(),
      ...overrides
    };
  }

  it("当开关关闭时：即使存在 >30 天会话也不执行清理，原样保留", async () => {
    const expiredConv = makeConversation("exp-1", { updatedAt: Date.now() - 40 * DAY_MS });
    const freshConv = makeConversation("fresh-1", { updatedAt: Date.now() - 2 * DAY_MS });

    const storage = makeMockStorage({
      [CONVERSATIONS_STORAGE_KEY]: [expiredConv, freshConv]
    });

    const store = createConversationStore(
      makeDeps({
        storage,
        isCleanEnabled: () => false
      }) as any
    );

    await store.loadAll();

    expect(chatSessionState.savedConversations).toHaveLength(2);
    expect(storage.setCalls).toHaveLength(0);
  });

  it("当开关开启时：loadAll 自动清理超期会话并持久化写入存储", async () => {
    const expiredConv = makeConversation("exp-1", { updatedAt: Date.now() - 40 * DAY_MS });
    const freshConv = makeConversation("fresh-1", { updatedAt: Date.now() - 2 * DAY_MS });

    const storage = makeMockStorage({
      [CONVERSATIONS_STORAGE_KEY]: [expiredConv, freshConv]
    });

    const store = createConversationStore(
      makeDeps({
        storage,
        isCleanEnabled: () => true
      }) as any
    );

    await store.loadAll();

    expect(chatSessionState.savedConversations).toHaveLength(1);
    expect(chatSessionState.savedConversations[0].id).toBe("fresh-1");
    expect(storage.setCalls).toHaveLength(1);
    const savedInStorage = storage.data.get(CONVERSATIONS_STORAGE_KEY) as any[];
    expect(savedInStorage).toHaveLength(1);
    expect(savedInStorage[0].id).toBe("fresh-1");
  });
});

describe("设置面板开关触发即时清理", () => {
  it("用户将自动清理开关切换为 true 时，立即触发扫描已有会话并完成清理", async () => {
    const expiredConv = makeConversation("exp-toggle", {
      createdAt: Date.now() - 40 * DAY_MS,
      updatedAt: Date.now() - 40 * DAY_MS
    });
    const freshConv = makeConversation("fresh-toggle", {
      createdAt: Date.now() - 2 * DAY_MS,
      updatedAt: Date.now() - 2 * DAY_MS
    });

    // 初始化 chrome.storage.local
    await chrome.storage.local.set({
      [CONVERSATIONS_STORAGE_KEY]: [expiredConv, freshConv]
    });

    document.body.innerHTML = '<div id="biliscript-reading-view"><div id="biliscript-reading-settings-host"></div></div>';
    installSettingsPanelBus({
      "get-settings": () => ({ ok: true, settings: { cleanConversationsOlderThan30Days: false } }),
      "save-settings": () => ({ ok: true })
    });

    const panel = await import("../../extension/ui/settings-panel.js");
    // Ensure memory savedConversations is also set in this module epoch
    setSavedConversations([expiredConv as any, freshConv as any]);
    expect(chatSessionState.savedConversations).toHaveLength(2);

    panel.renderReaderSettingsPanel();

    const host = document.getElementById("biliscript-reading-settings-host")!;
    await vi.waitFor(() => {
      expect(host.dataset.biliscriptSettingsRendered).toBe("1");
    });

    const toggle = host.querySelector<HTMLInputElement>("#cleanConversationsOlderThan30Days")!;
    expect(toggle).not.toBeNull();
    expect(toggle.checked).toBe(false);

    // 用户切换开关为 true
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));

    // 验证立即完成清理
    await vi.waitFor(async () => {
      const data = await chrome.storage.local.get([CONVERSATIONS_STORAGE_KEY]);
      const list = data[CONVERSATIONS_STORAGE_KEY] as any[];
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe("fresh-toggle");
    });

    expect(chatSessionState.savedConversations).toHaveLength(1);
    expect(chatSessionState.savedConversations[0].id).toBe("fresh-toggle");
  });
});
