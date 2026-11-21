import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installChromeHost, type ChromeHost } from "../helpers/chrome-host.js";
import type { SegmentCacheMessage, SegmentCacheResponse, SendResponse } from "../../extension/shared/messaging-protocol.js";

let mod: typeof import("../../extension/ai/segment-cache-handler.js");
let storage: ChromeHost;
let handler: ReturnType<typeof import("../../extension/ai/segment-cache-handler.js").createSegmentCacheHandler>;

async function importModules() {
  vi.resetModules();
  resetModuleState();
  storage = installChromeHost();
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

describe("分段小结读写 op", () => {
  it("save-summary / load-summary / load-summaries 正常读写并装配键位", async () => {
    const r1 = await request({ type: "segment-cache", op: "save-summary", context: CONTEXT, segmentIndex: 1, budgetScale: 1, summary: "单小结1" });
    const r2 = await request({ type: "segment-cache", op: "save-summary", context: CONTEXT, segmentIndex: 2, budgetScale: 1, summary: "单小结2" });

    expect(r1).toEqual({ ok: true });
    expect(r2).toEqual({ ok: true });
    const { defaultSubtitleIdbStore } = await import("../../extension/subtitle/idb-store.js");
    expect(await defaultSubtitleIdbStore.getAiArtifact("biliscript_lvs_summary_BV1h_9_id_sub-1_1")).toMatchObject({
      payload: "单小结1"
    });
    expect(storage.map.has("biliscript_lvs_summary_BV1h_9_id_sub-1_1")).toBe(false);

    const single = await request({ type: "segment-cache", op: "load-summary", context: CONTEXT, segmentIndex: 1, budgetScale: 1 });
    expect(single).toEqual({ ok: true, summary: "单小结1" });

    const batch = await request({ type: "segment-cache", op: "load-summaries", context: CONTEXT, segmentIndexes: [1, 2, 3], budgetScale: 1 });
    expect(batch).toEqual({ ok: true, summaries: ["单小结1", "单小结2", null] });
  });

  it("load-stored-summaries 按段序号升序返回，默认档排除 _b50 后缀", async () => {
    await request({ type: "segment-cache", op: "save-summary", context: CONTEXT, segmentIndex: 2, budgetScale: 1, summary: "小结2" });
    await request({ type: "segment-cache", op: "save-summary", context: CONTEXT, segmentIndex: 1, budgetScale: 1, summary: "小结1" });
    await request({ type: "segment-cache", op: "save-summary", context: CONTEXT, segmentIndex: 1, budgetScale: 0.5, summary: "半档小结1" });

    const stored = await request({ type: "segment-cache", op: "load-stored-summaries", context: CONTEXT });
    expect(stored).toEqual({ ok: true, summaries: ["小结1", "小结2"] });
  });
});

describe("load-l1-index 读取 L1 章节目录缓存", () => {
  it("按 bvid + cid + 字幕轨匹配已落盘的 L1 索引；缺失/未命中返回 null", async () => {
    const { buildL1VideoIndex, buildL1IndexCacheKey, saveL1Index } = await import("../../extension/ai/l1-chapter-index.js");
    const missing = await request({ type: "segment-cache", op: "load-l1-index", context: CONTEXT });
    expect(missing).toEqual({ ok: true, l1Index: null });

    const record = buildL1VideoIndex({
      bvid: CONTEXT.bvid,
      cid: CONTEXT.cid,
      subtitleId: CONTEXT.selectedSubtitleId,
      subtitleSignature: "sig_sw_1",
      videoDuration: 1800,
      globalSummary: "SW 宿主读取测试",
      chapters: [{ from: 0, to: 1800, title: "第一章", coreThesis: "核心测试论点" }]
    });
    const key = buildL1IndexCacheKey({
      bvid: CONTEXT.bvid,
      cid: CONTEXT.cid,
      subtitleId: CONTEXT.selectedSubtitleId,
      subtitleSignature: "sig_sw_1"
    });
    await saveL1Index(key, record);

    const hit = await request({ type: "segment-cache", op: "load-l1-index", context: CONTEXT });
    expect(hit.ok).toBe(true);
    expect(hit.l1Index?.globalSummary).toBe("SW 宿主读取测试");
    expect(hit.l1Index?.chapters[0].title).toBe("第一章");
  });
});
