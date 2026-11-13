import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeConversations } from "../../extension/ai/conversation.js";
import { resetChatSessionStateForTests } from "../../extension/chat/chat-state.js";
import type { StorageArea } from "../../extension/chat/conversation-store.js";
import {
  LIVE_TEXT_TOOL_TEXT_LIMITS,
  MAX_LIVE_TEXT_TOOL_RECORDS_PER_VIDEO,
  isLiveTextToolHistoryEntry
} from "../../extension/live/live-text-tool-history.js";
import { persistLiveTextToolRecord } from "../../extension/live/live-text-tool-history-storage.js";
import type { LiveTextToolRecord } from "../../extension/live/live-text-tool-records.js";

const KEY = "biliscript_ai_conversations_v1";
const VIDEO = {
  bvid: "BV1test000000",
  cid: "123",
  pageIndex: 1,
  pageTitle: "第一集",
  title: "测试视频",
  url: "https://www.bilibili.com/video/BV1test000000/"
};

function makeStorage(initial: unknown[] = []) {
  const data = new Map<string, unknown>([[KEY, initial]]);
  return {
    data,
    get: vi.fn(async (keys: string[]) => Object.fromEntries(
      keys.filter((key) => data.has(key)).map((key) => [key, data.get(key)])
    )),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    })
  };
}

function makeRecord(overrides: Partial<LiveTextToolRecord> = {}): LiveTextToolRecord {
  return {
    callId: "call-1",
    source: "gemini",
    status: "completed",
    objective: "梳理视频论点",
    summary: "结果摘要",
    markdown: "# 完整结果\n\n正文",
    startedAt: 100,
    endedAt: 200,
    durationMs: 100,
    video: { ...VIDEO },
    ...overrides
  };
}

function storedEntries(storage: ReturnType<typeof makeStorage>) {
  return normalizeConversations(storage.data.get(KEY));
}

beforeEach(() => {
  resetChatSessionStateForTests();
});

describe("伴看文本工具历史留档", () => {
  it("完成与失败按视频分组，刷新重载保留，重试同一 callId 只更新逻辑记录", async () => {
    const storage = makeStorage();
    const sensitive = {
      systemPrompt: "SYSTEM-SECRET",
      subtitleBody: "FULL-SUBTITLES",
      context: ["PRIVATE-CONTEXT"],
      apiKey: "CREDENTIAL"
    };
    await persistLiveTextToolRecord({
      ...makeRecord(),
      ...sensitive,
      video: { ...VIDEO, ...sensitive }
    } as LiveTextToolRecord, storage);
    await persistLiveTextToolRecord(makeRecord({
      callId: "call-2",
      status: "failed",
      summary: "失败前已有摘要",
      markdown: "失败前已有全文",
      error: "文本模型限流",
      startedAt: 250,
      endedAt: 300
    }), storage);

    let entries = storedEntries(storage);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(isLiveTextToolHistoryEntry(entry)).toBe(true);
    if (!isLiveTextToolHistoryEntry(entry)) throw new Error("expected live entry");
    expect(entry).toMatchObject({
      id: `live:${VIDEO.bvid}:${VIDEO.cid}`,
      kind: "live-text-tool",
      title: VIDEO.title,
      contextTitle: VIDEO.title,
      contextUrl: VIDEO.url,
      messages: []
    });
    expect(entry.records.map((record) => record.callId)).toEqual(["call-2", "call-1"]);
    expect(entry.records[0]).toMatchObject({
      status: "failed",
      error: "文本模型限流",
      summary: "失败前已有摘要",
      markdown: "失败前已有全文"
    });
    const serialized = JSON.stringify(entry);
    for (const secret of Object.values(sensitive).flat()) {
      expect(serialized).not.toContain(secret);
    }

    await persistLiveTextToolRecord(makeRecord({
      summary: "重试后的摘要",
      markdown: "重试后的全文",
      startedAt: 400,
      endedAt: 500
    }), storage);
    entries = storedEntries(storage);
    expect(entries).toHaveLength(1);
    if (!isLiveTextToolHistoryEntry(entries[0])) throw new Error("expected live entry");
    expect(entries[0].records).toHaveLength(2);
    expect(entries[0].records.find((record) => record.callId === "call-1")).toMatchObject({
      summary: "重试后的摘要",
      markdown: "重试后的全文",
      startedAt: 400,
      endedAt: 500
    });
  });

  it("运行中记录与缺失视频身份的记录不落盘", async () => {
    const storage = makeStorage();
    await persistLiveTextToolRecord(makeRecord({ status: "running", endedAt: undefined }), storage);
    await persistLiveTextToolRecord(makeRecord({ video: undefined }), storage);
    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.set).not.toHaveBeenCalled();
  });

  it("每视频只留最新 20 次调用，文本按 Unicode 字符截断且不切断代理对", () => {
    const raw = {
      id: "legacy-id-is-rebuilt",
      kind: "live-text-tool",
      contextTitle: "题".repeat(300),
      contextRef: VIDEO,
      records: Array.from({ length: 22 }, (_, index) => makeRecord({
        callId: `call-${index + 1}`,
        startedAt: index * 10,
        endedAt: index * 10 + 1
      }))
    };
    raw.records[21] = makeRecord({
      callId: "call-22",
      status: "failed",
      objective: "😀".repeat(LIVE_TEXT_TOOL_TEXT_LIMITS.objective + 1),
      summary: "摘".repeat(LIVE_TEXT_TOOL_TEXT_LIMITS.summary + 1),
      markdown: "文".repeat(LIVE_TEXT_TOOL_TEXT_LIMITS.markdown + 1),
      error: "错".repeat(LIVE_TEXT_TOOL_TEXT_LIMITS.error + 1),
      startedAt: 210,
      endedAt: 220
    });

    const [entry] = normalizeConversations([raw]);
    if (!isLiveTextToolHistoryEntry(entry)) throw new Error("expected live entry");
    expect(entry.records).toHaveLength(MAX_LIVE_TEXT_TOOL_RECORDS_PER_VIDEO);
    expect(entry.records.at(-1)?.callId).toBe("call-3");
    expect(Array.from(entry.title)).toHaveLength(LIVE_TEXT_TOOL_TEXT_LIMITS.title);
    const latest = entry.records[0];
    expect(Array.from(latest.objective)).toHaveLength(LIVE_TEXT_TOOL_TEXT_LIMITS.objective);
    expect(latest.objective.endsWith("…")).toBe(true);
    expect(Array.from(latest.objective).every((char) => char === "😀" || char === "…")).toBe(true);
    expect(Array.from(latest.summary)).toHaveLength(LIVE_TEXT_TOOL_TEXT_LIMITS.summary);
    expect(Array.from(latest.markdown)).toHaveLength(LIVE_TEXT_TOOL_TEXT_LIMITS.markdown);
    expect(Array.from(latest.error || "")).toHaveLength(LIVE_TEXT_TOOL_TEXT_LIMITS.error);
  });

  it("损坏类别安全丢弃，旧版普通会话不丢，混合历史仍最多 60 条", () => {
    const legacy = {
      id: "ordinary",
      title: "旧版会话",
      contextKey: "video:BV1legacy000|1",
      contextTitle: "旧版视频",
      contextUrl: "https://www.bilibili.com/video/BV1legacy000",
      createdAt: 1,
      updatedAt: 2,
      contextRef: { bvid: "BV1legacy000", cid: "1" },
      messages: [{ role: "user", content: "旧消息" }]
    };
    const validLive = {
      kind: "live-text-tool",
      contextRef: VIDEO,
      records: [makeRecord()]
    };
    const normalized = normalizeConversations([
      null,
      "bad",
      { kind: "live-text-tool", contextRef: VIDEO, records: "bad" },
      { kind: "live-text-tool", contextRef: VIDEO, records: [{ ...makeRecord(), status: "running" }] },
      validLive,
      legacy
    ]);
    expect(normalized).toHaveLength(2);
    expect(normalized.some(isLiveTextToolHistoryEntry)).toBe(true);
    expect(normalized.some((entry) => entry.id === "ordinary")).toBe(true);

    const many = Array.from({ length: 65 }, (_, index) => ({
      kind: "live-text-tool",
      contextRef: { ...VIDEO, bvid: `BV${index}`, cid: String(index) },
      updatedAt: index + 1,
      records: [makeRecord({ callId: `call-${index}`, endedAt: index + 1 })]
    }));
    const capped = normalizeConversations(many);
    expect(capped).toHaveLength(60);
    expect(capped[0].updatedAt).toBe(65);
    expect(capped.at(-1)?.updatedAt).toBe(6);
  });
});
