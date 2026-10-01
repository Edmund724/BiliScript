// ai/segment-cache-proxy.js 出站点测试（段缓存写聚合 ticket 的「写单元 run-scoped」重构）：
// - 写路径只剩 createSegmentCacheWriteSession 一个入口：会话自有缓冲（模块级 Map 与
//   flushSegmentCacheRawBuffer 已退役），saveRaw 返回 void（不再声明 per-op 成败）、
//   只把同段原始段放进会话缓冲；紧随其后的 saveSummary 命中缓冲时合成一条
//   save-summary-raw 合并 op（写路径 3N→2N）；close() 把残留缓冲按 save-raw 逐条
//   await 落盘（失败经 onWriteError 上浮、不抛），重复 close 空操作。
// - 载荷 context 收窄为 SW 键位字段投影（与 SW 端 segment-cache.ts 的
//   segmentCacheKeyFields 同字段）：整份 AiContext（含 ≥200k 字符的 subtitleBody）
//   不再过线；缓冲键也按投影后短键。
// - segmentCacheProxy 只剩读半边（追问链只读），读三 op 直通、载荷同样收窄。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

type ProxyModule = typeof import("../../extension/ai/segment-cache-proxy.js");

let mod: ProxyModule;
let proxy: ProxyModule["segmentCacheProxy"];
let sendMessageMock: ReturnType<typeof vi.fn>;

// 键位 5 字段齐全的完整 AiContext：多带 title / chapters / subtitleBody（大字段）
const KEY_FIELDS = {
  bvid: "BV1p",
  cid: "1",
  selectedSubtitleId: "sub-1",
  selectedSubtitleUrl: "https://x/sub.json",
  subtitleLang: "zh-CN"
};
const FULL_CONTEXT = {
  title: "长视频",
  ...KEY_FIELDS,
  chapters: [{ from: 0, to: 10, title: "开场" }],
  subtitleBody: [{ from: 0, to: 5, content: "x".repeat(200000) }]
};

async function importProxy() {
  vi.resetModules();
  resetModuleState();
  sendMessageMock = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal("chrome", { runtime: { sendMessage: sendMessageMock } });
  mod = await import("../../extension/ai/segment-cache-proxy.js");
  proxy = mod.segmentCacheProxy;
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

describe("写会话 saveRaw：同步入缓冲，不再声明 per-op 成败", () => {
  it("saveRaw 返回 void、只入会话缓冲不发消息", async () => {
    const session = mod.createSegmentCacheWriteSession();

    const result = session.saveRaw({
      context: FULL_CONTEXT,
      segmentIndex: 2,
      budgetScale: 1,
      segments: [{ from: 0, to: 1, content: "x" }]
    });

    expect(result).toBeUndefined();
    expect(segmentCacheMessages()).toHaveLength(0);
  });

  it("close 才把缓冲落盘：saveRaw 载荷 context 恰为键位 5 字段（subtitleBody/chapters/title 不过线）", async () => {
    const session = mod.createSegmentCacheWriteSession();
    session.saveRaw({ context: FULL_CONTEXT, segmentIndex: 2, budgetScale: 1, segments: ["s"] });

    await session.close();

    const messages = segmentCacheMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].op).toBe("save-raw");
    expect(messages[0].context).toEqual(KEY_FIELDS);
    expect(messages[0].segments).toEqual(["s"]);
    expect(messages[0].segmentIndex).toBe(2);
  });

  it("缓冲键按投影后键位：仅 subtitleBody 不同 → 同键覆盖，只发一条合并 op", async () => {
    const session = mod.createSegmentCacheWriteSession();
    session.saveRaw({
      context: { ...FULL_CONTEXT, subtitleBody: [{ from: 0, to: 5, content: "a" }] },
      segmentIndex: 2,
      budgetScale: 1,
      segments: ["旧"]
    });
    session.saveRaw({
      context: { ...FULL_CONTEXT, subtitleBody: [{ from: 0, to: 5, content: "b".repeat(200000) }] },
      segmentIndex: 2,
      budgetScale: 1,
      segments: ["新"]
    });

    const result = await session.saveSummary({ context: FULL_CONTEXT, segmentIndex: 2, budgetScale: 1, summary: "小结" });

    expect(result).toEqual({ ok: true });
    const messages = segmentCacheMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].op).toBe("save-summary-raw");
    expect(messages[0].segments).toEqual(["新"]);
    expect(messages[0].context).toEqual(KEY_FIELDS);
  });
});

describe("同段合并写：saveSummary 命中会话缓冲", () => {
  it("合成一条 save-summary-raw（summary + segments 同行）", async () => {
    const session = mod.createSegmentCacheWriteSession();
    session.saveRaw({ context: FULL_CONTEXT, segmentIndex: 2, budgetScale: 1, segments: [{ from: 0, to: 1, content: "x" }] });

    const result = await session.saveSummary({ context: FULL_CONTEXT, segmentIndex: 2, budgetScale: 1, summary: "小结" });

    expect(result).toEqual({ ok: true });
    const messages = segmentCacheMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].op).toBe("save-summary-raw");
    expect(messages[0].summary).toBe("小结");
    expect(messages[0].segments).toEqual([{ from: 0, to: 1, content: "x" }]);
    expect(messages[0].context).toEqual(KEY_FIELDS);
  });

  it("缓冲被消费：同一缓冲不会第二次合并", async () => {
    const session = mod.createSegmentCacheWriteSession();
    session.saveRaw({ context: FULL_CONTEXT, segmentIndex: 2, budgetScale: 1, segments: [] });
    await session.saveSummary({ context: FULL_CONTEXT, segmentIndex: 2, budgetScale: 1, summary: "一" });
    await session.saveSummary({ context: FULL_CONTEXT, segmentIndex: 2, budgetScale: 1, summary: "二" });

    const messages = segmentCacheMessages();
    expect(messages.filter((m) => m.op === "save-summary-raw")).toHaveLength(1);
    expect(messages.filter((m) => m.op === "save-summary")).toHaveLength(1);
  });

  it("无缓冲的 saveSummary 仍走 save-summary（行为不变）", async () => {
    const session = mod.createSegmentCacheWriteSession();

    const result = await session.saveSummary({ context: FULL_CONTEXT, segmentIndex: 2, budgetScale: 1, summary: "小结" });

    expect(result).toEqual({ ok: true });
    const messages = segmentCacheMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].op).toBe("save-summary");
    expect(messages[0].context).toEqual(KEY_FIELDS);
    expect(messages[0].segments).toBeUndefined();
  });

  it("键位任一不同（轨道字段 / 段序号 / 预算档）→ 不合并，残留留给 close 补落", async () => {
    const session = mod.createSegmentCacheWriteSession();
    session.saveRaw({ context: FULL_CONTEXT, segmentIndex: 2, budgetScale: 1, segments: ["a"] });
    // 不同字幕轨
    await session.saveSummary({ context: { ...FULL_CONTEXT, selectedSubtitleUrl: "其他轨" }, segmentIndex: 2, budgetScale: 1, summary: "别轨" });
    // 不同预算档
    await session.saveSummary({ context: FULL_CONTEXT, segmentIndex: 2, budgetScale: 0.5, summary: "半档" });
    // 邻段
    await session.saveSummary({ context: FULL_CONTEXT, segmentIndex: 3, budgetScale: 1, summary: "邻段" });

    const messages = segmentCacheMessages();
    expect(messages.filter((m) => m.op === "save-summary")).toHaveLength(3);
    expect(messages.filter((m) => m.op === "save-summary-raw")).toHaveLength(0);

    await session.close();
    const flushed = segmentCacheMessages().filter((m) => m.op === "save-raw");
    expect(flushed).toHaveLength(1);
    expect(flushed[0].segments).toEqual(["a"]);
  });
});

describe("失败可观测性", () => {
  it("合并回包 per-op 任一失败 → saveSummary 回 { ok:false, error }、缓冲保留", async () => {
    sendMessageMock.mockImplementation(async () => ({
      ok: false,
      summarySaved: { ok: false, error: "缓存写入失败（已淘汰旧视频后重试仍失败）：quota" },
      rawSaved: { ok: true }
    }));

    const session = mod.createSegmentCacheWriteSession();
    session.saveRaw({ context: FULL_CONTEXT, segmentIndex: 2, budgetScale: 1, segments: [] });
    const result = await session.saveSummary({ context: FULL_CONTEXT, segmentIndex: 2, budgetScale: 1, summary: "小结" });

    expect(result.ok).toBe(false);
    expect(String(result.error || "")).toContain("缓存写入失败");

    // 失败不消费缓冲：close 按 save-raw 补落
    sendMessageMock.mockImplementation(async () => ({ ok: true }));
    await session.close();
    expect(segmentCacheMessages().filter((m) => m.op === "save-raw")).toHaveLength(1);
  });
});

describe("close：会话收尾统一落盘", () => {
  it("残留缓冲按 save-raw 逐条发出并清空；二次 close 空操作", async () => {
    const session = mod.createSegmentCacheWriteSession();
    session.saveRaw({ context: FULL_CONTEXT, segmentIndex: 0, budgetScale: 1, segments: ["s0"] });
    session.saveRaw({ context: FULL_CONTEXT, segmentIndex: 1, budgetScale: 1, segments: ["s1"] });
    // 一个已被 saveSummary 消费，一个残留
    await session.saveSummary({ context: FULL_CONTEXT, segmentIndex: 0, budgetScale: 1, summary: "小结0" });
    expect(segmentCacheMessages()).toHaveLength(1);

    await session.close();

    const flushed = segmentCacheMessages().filter((m) => m.op === "save-raw");
    expect(flushed).toHaveLength(1);
    expect(flushed[0].segmentIndex).toBe(1);
    expect(flushed[0].segments).toEqual(["s1"]);
    expect(flushed[0].context).toEqual(KEY_FIELDS);

    await session.close();
    expect(segmentCacheMessages().filter((m) => m.op === "save-raw")).toHaveLength(1);
  });

  it("close await 落盘完成：发送未结算时 close 不结算", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    sendMessageMock.mockImplementation(async (message) => {
      if (message.op === "save-raw") {
        await gate;
      }
      return { ok: true };
    });

    const session = mod.createSegmentCacheWriteSession();
    session.saveRaw({ context: FULL_CONTEXT, segmentIndex: 1, budgetScale: 1, segments: ["s1"] });
    let settled = false;
    const closing = session.close().then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await closing;
    expect(settled).toBe(true);
  });

  it("close 中单条失败：经 onWriteError 上浮、不抛、缓冲不重试", async () => {
    const onWriteError = vi.fn();
    sendMessageMock.mockRejectedValue(new Error("message port closed"));
    const session = mod.createSegmentCacheWriteSession({ onWriteError });
    session.saveRaw({ context: FULL_CONTEXT, segmentIndex: 1, budgetScale: 1, segments: ["s1"] });
    session.saveRaw({ context: FULL_CONTEXT, segmentIndex: 2, budgetScale: 1, segments: ["s2"] });

    await expect(session.close()).resolves.toBeUndefined();
    expect(onWriteError).toHaveBeenCalledTimes(2);
    expect(String(onWriteError.mock.calls[0][0])).toContain("message port closed");

    // 失败条目不再重试（缓冲已清空）
    expect(segmentCacheMessages().filter((m) => m.op === "save-raw")).toHaveLength(2);
  });

  it("缺省无 onWriteError：close 失败同样静默不抛", async () => {
    sendMessageMock.mockRejectedValue(new Error("message port closed"));
    const session = mod.createSegmentCacheWriteSession();
    session.saveRaw({ context: FULL_CONTEXT, segmentIndex: 1, budgetScale: 1, segments: ["s1"] });

    await expect(session.close()).resolves.toBeUndefined();
  });
});

describe("读路径：直通且载荷同样收窄", () => {
  it("loadSummary / loadSummaries / loadStoredRaw 直通对应 op", async () => {
    sendMessageMock.mockImplementation(async (message) => {
      if (message.op === "load-summary") return { ok: true, summary: "命中" };
      if (message.op === "load-summaries") return { ok: true, summaries: ["a", null] };
      if (message.op === "load-stored-raw") return { ok: true, storedSegments: [{ index: 1 }] };
      return { ok: false };
    });

    expect(await proxy.loadSummary({ context: FULL_CONTEXT, segmentIndex: 2, budgetScale: 1 })).toBe("命中");
    expect(await proxy.loadSummaries({ context: FULL_CONTEXT, segmentIndexes: [1, 2], budgetScale: 1 })).toEqual(["a", null]);
    expect(await proxy.loadStoredRaw({ context: FULL_CONTEXT, userPrompt: "追问" })).toEqual([{ index: 1 }]);

    const messages = segmentCacheMessages();
    expect(messages.map((m) => m.op)).toEqual(["load-summary", "load-summaries", "load-stored-raw"]);
    expect(messages[0].context).toEqual(KEY_FIELDS);
    expect(messages[1].context).toEqual(KEY_FIELDS);
    // load-stored-raw 的命中段预过滤（SW 侧章节名档）仍需章节表：键位 5 字段之外只保留 chapters
    expect(messages[2].context).toEqual({ ...KEY_FIELDS, chapters: FULL_CONTEXT.chapters });
  });

  it("写会话的读 op 与 proxy 同口径（同一发送路径）", async () => {
    sendMessageMock.mockImplementation(async () => ({ ok: true, summary: "命中" }));
    const session = mod.createSegmentCacheWriteSession();

    expect(await session.loadSummary({ context: FULL_CONTEXT, segmentIndex: 1, budgetScale: 1 })).toBe("命中");
    expect(segmentCacheMessages()[0].context).toEqual(KEY_FIELDS);
  });

  it("读失败 / 无回执按未命中（行为不变）", async () => {
    sendMessageMock.mockRejectedValue(new Error("message port closed"));

    expect(await proxy.loadSummary({ context: FULL_CONTEXT, segmentIndex: 1, budgetScale: 1 })).toBeNull();
    expect(await proxy.loadSummaries({ context: FULL_CONTEXT, segmentIndexes: [1], budgetScale: 1 })).toEqual([]);
    expect(await proxy.loadStoredRaw({ context: FULL_CONTEXT, userPrompt: "" })).toEqual([]);
  });
});
