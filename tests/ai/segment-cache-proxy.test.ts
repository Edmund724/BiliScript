// ai/segment-cache-proxy.js 写聚合缓冲测试（段缓存写聚合 ticket）：
// saveRaw 不在发送消息而是缓冲同段原始段，saveSummary 命中缓冲时合成一条
// save-summary-raw 合并 op（写路径 3N→2N）；缓冲键 = context+segmentIndex+budgetScale，
// 不同键不合并；合并回包 per-op 任一失败 → saveSummary 上浮 { ok:false }（与
// 单族写同一可观测口径）；abort/异常路径 flushSegmentCacheRawBuffer 把残留缓冲
// 按 save-raw 逐个发出；port 断开 / offscreen 自关即随文档销毁丢弃（内存态，无动作）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let proxy;
let flushSegmentCacheRawBuffer;
let sendMessageMock;

const CONTEXT = { bvid: "BV1p", cid: "1", selectedSubtitleId: "sub-1" };

async function importProxy() {
  vi.resetModules();
  resetModuleState();
  sendMessageMock = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal("chrome", { runtime: { sendMessage: sendMessageMock } });
  const mod = await import("../../extension/ai/segment-cache-proxy.js");
  proxy = mod.segmentCacheProxy;
  flushSegmentCacheRawBuffer = mod.flushSegmentCacheRawBuffer;
}

function segmentCacheMessages() {
  return sendMessageMock.mock.calls.map((c) => c[0]).filter((m) => m?.type === "segment-cache");
}

beforeEach(async () => {
  await importProxy();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("saveRaw 缓冲", () => {
  it("saveRaw 只入缓冲不发消息，立即回 { ok:true }", async () => {
    const result = await proxy.saveRaw({ context: CONTEXT, segmentIndex: 2, budgetScale: 1, segments: [{ from: 0, to: 1, content: "x" }] });

    expect(result).toEqual({ ok: true });
    expect(segmentCacheMessages()).toHaveLength(0);
  });

  it("同段 saveSummary 命中缓冲 → 合成一条 save-summary-raw（携带 summary + segments）", async () => {
    await proxy.saveRaw({ context: CONTEXT, segmentIndex: 2, budgetScale: 1, segments: [{ from: 0, to: 1, content: "x" }] });
    const result = await proxy.saveSummary({ context: CONTEXT, segmentIndex: 2, budgetScale: 1, summary: "小结" });

    expect(result).toEqual({ ok: true });
    const messages = segmentCacheMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].op).toBe("save-summary-raw");
    expect(messages[0].summary).toBe("小结");
    expect(messages[0].segments).toEqual([{ from: 0, to: 1, content: "x" }]);
    expect(messages[0].context).toEqual(CONTEXT);
    expect(messages[0].segmentIndex).toBe(2);
  });

  it("缓冲被消费：同一缓冲不会第二次合并", async () => {
    await proxy.saveRaw({ context: CONTEXT, segmentIndex: 2, budgetScale: 1, segments: [] });
    await proxy.saveSummary({ context: CONTEXT, segmentIndex: 2, budgetScale: 1, summary: "一" });
    await proxy.saveSummary({ context: CONTEXT, segmentIndex: 2, budgetScale: 1, summary: "二" });

    const messages = segmentCacheMessages();
    expect(messages.filter((m) => m.op === "save-summary-raw")).toHaveLength(1);
    expect(messages.filter((m) => m.op === "save-summary")).toHaveLength(1);
  });
});

describe("不合并的路径（缓冲键不匹配 → 单族 op 直通）", () => {
  it("无缓冲的 saveSummary 仍走 save-summary（行为不变）", async () => {
    const result = await proxy.saveSummary({ context: CONTEXT, segmentIndex: 2, budgetScale: 1, summary: "小结" });

    expect(result).toEqual({ ok: true });
    const messages = segmentCacheMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].op).toBe("save-summary");
    expect(messages[0].segments).toBeUndefined();
  });

  it("budgetScale / segmentIndex / context 任一不同 → 不合并", async () => {
    await proxy.saveRaw({ context: CONTEXT, segmentIndex: 2, budgetScale: 1, segments: ["a"] });
    // 不同预算档
    await proxy.saveSummary({ context: CONTEXT, segmentIndex: 2, budgetScale: 0.5, summary: "半档" });
    // 不同段
    await proxy.saveSummary({ context: CONTEXT, segmentIndex: 3, budgetScale: 1, summary: "邻段" });
    // 不同视频
    await proxy.saveSummary({ context: { ...CONTEXT, bvid: "BV1other" }, segmentIndex: 2, budgetScale: 1, summary: "别片" });

    const messages = segmentCacheMessages();
    expect(messages.filter((m) => m.op === "save-summary")).toHaveLength(3);
    expect(messages.filter((m) => m.op === "save-summary-raw")).toHaveLength(0);
  });
});

describe("失败可观测性（per-op 结果汇入）", () => {
  it("合并回包 per-op 任一失败 → saveSummary 回 { ok:false, error }", async () => {
    sendMessageMock.mockImplementation(async () => ({
      ok: false,
      summarySaved: { ok: false, error: "缓存写入失败（已淘汰旧视频后重试仍失败）：quota" },
      rawSaved: { ok: true }
    }));

    await proxy.saveRaw({ context: CONTEXT, segmentIndex: 2, budgetScale: 1, segments: [] });
    const result = await proxy.saveSummary({ context: CONTEXT, segmentIndex: 2, budgetScale: 1, summary: "小结" });

    expect(result.ok).toBe(false);
    expect(String(result.error || "")).toContain("缓存写入失败");
  });

  it("save-summary-raw 无回执 / 抛错 → 按既有口径回 { ok:false }（不抛），缓冲保留待 flush 补落", async () => {
    sendMessageMock.mockRejectedValue(new Error("message port closed"));
    await proxy.saveRaw({ context: CONTEXT, segmentIndex: 2, budgetScale: 1, segments: ["s2"] });
    const result = await proxy.saveSummary({ context: CONTEXT, segmentIndex: 2, budgetScale: 1, summary: "小结" });

    expect(result.ok).toBe(false);
    expect(String(result.error || "")).toContain("message port closed");

    // 失败不消费缓冲：abort/异常路径 flush 按 save-raw 补落（丢失口径收窄到崩溃一档）
    sendMessageMock.mockResolvedValue({ ok: true });
    await flushSegmentCacheRawBuffer();
    const flushed = segmentCacheMessages().filter((m) => m.op === "save-raw");
    expect(flushed).toHaveLength(1);
    expect(flushed[0].segments).toEqual(["s2"]);
  });
});

describe("flushSegmentCacheRawBuffer：abort/异常路径的残留缓冲落盘", () => {
  it("缓冲的 raw 按 save-raw 逐个发出并清空缓冲（再次 flush 为空操作）", async () => {
    await proxy.saveRaw({ context: CONTEXT, segmentIndex: 0, budgetScale: 1, segments: ["s0"] });
    await proxy.saveRaw({ context: CONTEXT, segmentIndex: 1, budgetScale: 1, segments: ["s1"] });
    // 一个已被 saveSummary 消费，一个残留
    await proxy.saveSummary({ context: CONTEXT, segmentIndex: 0, budgetScale: 1, summary: "小结0" });
    expect(segmentCacheMessages()).toHaveLength(1);

    await flushSegmentCacheRawBuffer();

    const flushed = segmentCacheMessages().filter((m) => m.op === "save-raw");
    expect(flushed).toHaveLength(1);
    expect(flushed[0].segmentIndex).toBe(1);
    expect(flushed[0].segments).toEqual(["s1"]);

    await flushSegmentCacheRawBuffer();
    expect(segmentCacheMessages().filter((m) => m.op === "save-raw")).toHaveLength(1);
  });

  it("flush 自身失败不抛出（不阻断 abort 收束）", async () => {
    sendMessageMock.mockRejectedValue(new Error("message port closed"));
    await proxy.saveRaw({ context: CONTEXT, segmentIndex: 1, budgetScale: 1, segments: ["s1"] });

    await expect(flushSegmentCacheRawBuffer()).resolves.toBeUndefined();
    // 缓冲仍被清空（失败条目不再重试，代价与今天 saveRaw 静默失败同量级）
    sendMessageMock.mockResolvedValue({ ok: true });
    await flushSegmentCacheRawBuffer();
    expect(segmentCacheMessages().filter((m) => m.op === "save-raw")).toHaveLength(1);
  });
});

describe("读路径不变", () => {
  it("loadSummary / loadSummaries / loadStoredRaw 仍直通对应 op", async () => {
    sendMessageMock.mockImplementation(async (message) => {
      if (message.op === "load-summary") return { ok: true, summary: "命中" };
      if (message.op === "load-summaries") return { ok: true, summaries: ["a", null] };
      if (message.op === "load-stored-raw") return { ok: true, storedSegments: [{ index: 1 }] };
      return { ok: false };
    });

    expect(await proxy.loadSummary({ context: CONTEXT, segmentIndex: 2, budgetScale: 1 })).toBe("命中");
    expect(await proxy.loadSummaries({ context: CONTEXT, segmentIndexes: [1, 2], budgetScale: 1 })).toEqual(["a", null]);
    expect(await proxy.loadStoredRaw({ context: CONTEXT, userPrompt: "追问" })).toEqual([{ index: 1 }]);
    expect(segmentCacheMessages().map((m) => m.op)).toEqual(["load-summary", "load-summaries", "load-stored-raw"]);
  });
});
