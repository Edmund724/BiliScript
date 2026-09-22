// ai/segment-cache-handler.js SW 端消息 handler 测试（段缓存写聚合 ticket）：
// save-summary-raw 合并 op 收编——键位装配与 budgetScale 归一仍在 SW 单源完成，
// 两族合并落盘（saveSegmentSummaryWithRaw），回包带 per-op 结果（summarySaved /
// rawSaved）保住失败可观测性；既有单族 op（save-summary / save-raw）行为不变。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import type { SegmentCacheMessage, SegmentCacheResponse, SendResponse } from "../../extension/shared/messaging-protocol.js";

let mod: typeof import("../../extension/ai/segment-cache-handler.js");
let storage: ReturnType<typeof createMemoryStorage>;
let handler: ReturnType<typeof import("../../extension/ai/segment-cache-handler.js").createSegmentCacheHandler>;

function createMemoryStorage() {
  const map = new Map();
  const local = {
    get: vi.fn(async (keys) => {
      if (keys === null || keys === undefined) {
        return Object.fromEntries(map.entries());
      }
      const want = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of want) {
        if (map.has(k)) {
          out[k] = map.get(k);
        }
      }
      return out;
    }),
    set: vi.fn(async (items) => {
      for (const [key, value] of Object.entries(items)) {
        map.set(key, value);
      }
    }),
    remove: vi.fn(async (keys) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        map.delete(k);
      }
    })
  };
  return { map, local };
}

async function importModules() {
  vi.resetModules();
  resetModuleState();
  storage = createMemoryStorage();
  vi.stubGlobal("chrome", { storage: { local: storage.local } });
  mod = await import("../../extension/ai/segment-cache-handler.js");
  handler = mod.createSegmentCacheHandler();
}

function request(message: SegmentCacheMessage): Promise<SegmentCacheResponse> {
  return new Promise<SegmentCacheResponse>((resolve) => handler(message, {}, resolve as SendResponse));
}

const CONTEXT = { bvid: "BV1h", cid: "9", selectedSubtitleId: "sub-1", selectedSubtitleUrl: "", subtitleLang: "" };

beforeEach(async () => {
  await importModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("save-summary-raw 合并 op", () => {
  it("一条消息落两族数据 + 两族索引；回包 ok:true 且 per-op 都成功", async () => {
    const response = await request({
      type: "segment-cache",
      op: "save-summary-raw",
      context: CONTEXT,
      segmentIndex: 3,
      budgetScale: 1,
      summary: "合并小结",
      segments: [{ from: 0, to: 5, content: "x" }]
    });

    expect(response.ok).toBe(true);
    expect(response.summarySaved).toEqual({ ok: true });
    expect(response.rawSaved).toEqual({ ok: true });
    // 键位装配在 SW：bvid/cid/字幕轨 + 段序号（常态档无代后缀）
    const rawKey = "boc_lvs_raw_BV1h_9_id_sub-1_3";
    const summaryKey = "boc_lvs_summary_BV1h_9_id_sub-1_3";
    expect(storage.map.get(rawKey)).toMatchObject({ segments: [{ from: 0, to: 5, content: "x" }] });
    expect(storage.map.get(summaryKey)).toMatchObject({ summary: "合并小结" });
    // 两族分键索引都登记（readFamilyKeys 可读回）
    const lru = await import("../../extension/core/cache-lru.js");
    expect(await lru.readFamilyKeys("boc_lvs_raw_", "BV1h")).toEqual([rawKey]);
    expect(await lru.readFamilyKeys("boc_lvs_summary_", "BV1h")).toEqual([summaryKey]);
  });

  it("budgetScale 归一留在 SW：0.5 档 summary key 带 _b50 后缀（raw 同规则随键装配）", async () => {
    const response = await request({
      type: "segment-cache",
      op: "save-summary-raw",
      context: CONTEXT,
      segmentIndex: 3,
      budgetScale: 0.5,
      summary: "半档小结",
      segments: []
    });

    expect(response.ok).toBe(true);
    expect(storage.map.has("boc_lvs_summary_BV1h_9_id_sub-1_3_b50")).toBe(true);
    expect(storage.map.has("boc_lvs_raw_BV1h_9_id_sub-1_3_b50")).toBe(true);
  });

  it("写失败 → ok:false + per-op 带 error（粗粒度同果），不抛", async () => {
    storage.local.set.mockImplementation(async (items) => {
      if (Object.keys(items).some((k) => k.startsWith("boc_lvs_raw_") || k.startsWith("boc_lvs_summary_"))) {
        throw new Error("quota");
      }
      for (const [key, value] of Object.entries(items)) {
        storage.map.set(key, value);
      }
    });

    const response = await request({
      type: "segment-cache",
      op: "save-summary-raw",
      context: CONTEXT,
      segmentIndex: 3,
      budgetScale: 1,
      summary: "合并小结",
      segments: []
    });

    expect(response.ok).toBe(false);
    expect(response.summarySaved?.ok).toBe(false);
    expect(response.rawSaved?.ok).toBe(false);
    expect(String(response.summarySaved?.error || "")).toContain("缓存写入失败");
  });
});

describe("既有单族 op 行为不变", () => {
  it("save-summary / save-raw 仍各写各族并回 ok", async () => {
    const r1 = await request({ type: "segment-cache", op: "save-summary", context: CONTEXT, segmentIndex: 1, budgetScale: 1, summary: "单小结" });
    const r2 = await request({ type: "segment-cache", op: "save-raw", context: CONTEXT, segmentIndex: 1, budgetScale: 1, segments: [{ from: 0, to: 1, content: "y" }] });

    expect(r1).toEqual({ ok: true });
    expect(r2).toEqual({ ok: true });
    expect(storage.map.get("boc_lvs_summary_BV1h_9_id_sub-1_1")).toMatchObject({ summary: "单小结" });
    expect(storage.map.get("boc_lvs_raw_BV1h_9_id_sub-1_1")).toMatchObject({ segments: [{ from: 0, to: 1, content: "y" }] });
  });
});
