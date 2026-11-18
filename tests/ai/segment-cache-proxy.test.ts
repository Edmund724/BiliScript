// ai/segment-cache-proxy.js 出站点测试：
// - segmentCacheProxy 直通消息到 SW，载荷 context 收窄为键位字段投影
//   （subtitleBody / chapters / title 等无关大字段不过线）；
// - 读失败 / 无回执按未命中（null / []），saveSummary 写失败回 { ok: false, error }，全程不抛。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { SEGMENT_CACHE_KEY_FIELDS } from "../../extension/ai/segment-cache-key-fields.js";

type ProxyModule = typeof import("../../extension/ai/segment-cache-proxy.js");

let mod: ProxyModule;
let proxy: ProxyModule["segmentCacheProxy"];
let sendMessageMock: ReturnType<typeof vi.fn>;

const KEY_FIELDS = Object.fromEntries(
  SEGMENT_CACHE_KEY_FIELDS.map((field) => [field.context, `v-${field.key}`] as const)
);
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

describe("写路径：saveSummary 直通 SW", () => {
  it("saveSummary 载荷 context 恰为键位字段（subtitleBody/chapters/title 不过线）", async () => {
    const result = await proxy.saveSummary({ context: FULL_CONTEXT, segmentIndex: 2, budgetScale: 1, summary: "小结" });

    expect(result).toEqual({ ok: true });
    const messages = segmentCacheMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].op).toBe("save-summary");
    expect(messages[0].context).toEqual(KEY_FIELDS);
    expect(messages[0].summary).toBe("小结");
    expect(messages[0].segmentIndex).toBe(2);
  });

  it("saveSummary 失败回 { ok: false, error } 且不抛", async () => {
    sendMessageMock.mockResolvedValue({ ok: false, error: "quota" });
    await expect(
      proxy.saveSummary({ context: FULL_CONTEXT, segmentIndex: 2, budgetScale: 1, summary: "小结" })
    ).resolves.toEqual({ ok: false, error: "quota" });
  });
});

describe("读路径：直通且载荷同样收窄", () => {
  it("loadSummary / loadSummaries / loadStoredSummaries 直通对应 op", async () => {
    sendMessageMock.mockImplementation(async (message) => {
      if (message.op === "load-summary") return { ok: true, summary: "命中" };
      if (message.op === "load-summaries") return { ok: true, summaries: ["a", null] };
      if (message.op === "load-stored-summaries") return { ok: true, summaries: ["s1", "s2"] };
      return { ok: false };
    });

    expect(await proxy.loadSummary({ context: FULL_CONTEXT, segmentIndex: 2, budgetScale: 1 })).toBe("命中");
    expect(await proxy.loadSummaries({ context: FULL_CONTEXT, segmentIndexes: [1, 2], budgetScale: 1 })).toEqual(["a", null]);
    expect(await proxy.loadStoredSummaries({ context: FULL_CONTEXT })).toEqual(["s1", "s2"]);

    const messages = segmentCacheMessages();
    expect(messages.map((m) => m.op)).toEqual([
      "load-summary",
      "load-summaries",
      "load-stored-summaries"
    ]);
    expect(messages[0].context).toEqual(KEY_FIELDS);
    expect(messages[1].context).toEqual(KEY_FIELDS);
    expect(messages[2].context).toEqual(KEY_FIELDS);
  });

  it("loadL1IndexViaProxy 载荷收窄且容错返回 null", async () => {
    sendMessageMock.mockResolvedValueOnce({ ok: true, l1Index: { bvid: "BV1" } });
    expect(await mod.loadL1IndexViaProxy({ context: FULL_CONTEXT })).toEqual({ bvid: "BV1" });
    expect(segmentCacheMessages()[0].context).toEqual(KEY_FIELDS);

    sendMessageMock.mockRejectedValueOnce(new Error("boom"));
    expect(await mod.loadL1IndexViaProxy({ context: FULL_CONTEXT })).toBeNull();
  });

  it("读失败 / 无回执按未命中（null / []）", async () => {
    sendMessageMock.mockRejectedValue(new Error("message port closed"));

    expect(await proxy.loadSummary({ context: FULL_CONTEXT, segmentIndex: 1, budgetScale: 1 })).toBeNull();
    expect(await proxy.loadSummaries({ context: FULL_CONTEXT, segmentIndexes: [1], budgetScale: 1 })).toEqual([]);
    expect(await proxy.loadStoredSummaries({ context: FULL_CONTEXT })).toEqual([]);
  });
});
