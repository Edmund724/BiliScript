import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../extension/bilibili/video-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/bilibili/video-api.js")>();
  return {
    ...actual,
    fetchVideoMeta: vi.fn(async () => ({
      title: "测试视频",
      author: "UP主",
      uploadDate: "2026-01-01",
      aid: "42",
      description: "",
      defaultCid: "101",
      defaultDuration: 600,
      pages: [{ cid: "101", page: 1, part: "P1", duration: 600 }]
    })),
    fetchSubtitleBundle: vi.fn(async () => ({
      tracks: [
        { id: "sub-1", subtitleUrl: "https://s.example.com/1.json", lan: "zh-CN", lanDoc: "中文", source: "player-wbi-v2" }
      ],
      chapters: [
        { title: "开场", from: 0, to: 60, source: "player-view-points" },
        { title: "正文", from: 60, to: 600, source: "player-view-points" }
      ]
    }))
  };
});

vi.mock("../../extension/bilibili/gateway-core.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/bilibili/gateway-core.js")>();
  return {
    ...actual,
    bgFetchJson: vi.fn(async () => ({ body: [{ from: 0, to: 200, content: "第一句" }] }))
  };
});

vi.mock("../../extension/core/settings-store.js", () => ({
  getMergedSettings: vi.fn(async () => ({ includeTimestampInBody: false }))
}));

vi.mock("../../extension/subtitle/cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/subtitle/cache.js")>();
  return {
    ...actual,
    getSubtitleCacheKey: vi.fn(() => "subtitle-cache-key"),
    loadSubtitleFromCache: vi.fn(async () => null),
    saveSubtitleToCache: vi.fn(async () => ({ ok: true }))
  };
});

import { resolveAiConversationContext } from "../../extension/ai/context-resolver.js";
import { fetchSubtitleBundle, type Chapter } from "../../extension/bilibili/video-api.js";
import { bgFetchJson } from "../../extension/bilibili/gateway-core.js";
import { saveSubtitleToCache } from "../../extension/subtitle/cache.js";

const CONTEXT_REF = {
  title: "入口标题",
  url: "https://www.bilibili.com/video/BV1chapters/",
  bvid: "BV1chapters"
};

beforeEach(() => {
  vi.mocked(fetchSubtitleBundle).mockClear();
  vi.mocked(bgFetchJson).mockReset().mockResolvedValue({ body: [{ from: 0, to: 200, content: "第一句" }] });
  vi.mocked(saveSubtitleToCache).mockClear();
});

describe("resolveAiConversationContext chapters 透传与取体健壮性", () => {
  it("返回值携带字幕 bundle 的章节，并在未命中缓存时回写缓存", async () => {
    const result = await resolveAiConversationContext(CONTEXT_REF);

    expect(result.isVideoContext).toBe(true);
    expect(result.bvid).toBe("BV1chapters");
    expect(result.chapters).toEqual([
      { title: "开场", from: 0, to: 60, source: "player-view-points" },
      { title: "正文", from: 60, to: 600, source: "player-view-points" }
    ]);
    expect(fetchSubtitleBundle).toHaveBeenCalledTimes(1);
    expect(result.subtitleBody).toEqual([{ from: 0, to: 200, content: "第一句" }]);
    expect(result.videoDuration).toBe(600);
    expect(result.includeTimestampInBody).toBe(false);
    expect(saveSubtitleToCache).toHaveBeenCalledWith("subtitle-cache-key", [{ from: 0, to: 200, content: "第一句" }]);
  });

  it("首选轨时长不匹配时回退次选候选轨", async () => {
    vi.mocked(fetchSubtitleBundle).mockResolvedValueOnce({
      tracks: [
        { id: "sub-1", subtitleUrl: "https://s.example.com/1.json", lan: "zh-CN", lanDoc: "中文", source: "player-wbi-v2" },
        { id: "sub-2", subtitleUrl: "https://s.example.com/2.json", lan: "en-US", lanDoc: "English", source: "player-wbi-v2" }
      ],
      chapters: []
    });
    vi.mocked(bgFetchJson)
      .mockResolvedValueOnce({ body: [{ from: 0, to: 5, content: "过短首轨" }] })
      .mockResolvedValueOnce({ body: [{ from: 0, to: 250, content: "合规模板次轨" }] });

    const result = await resolveAiConversationContext(CONTEXT_REF);

    expect(result.selectedSubtitleId).toBe("sub-2");
    expect(result.subtitleLang).toBe("English");
    expect(result.subtitleBody).toEqual([{ from: 0, to: 250, content: "合规模板次轨" }]);
  });

  it("bundle 无章节 → chapters 为空数组（非 undefined）", async () => {
    vi.mocked(fetchSubtitleBundle).mockResolvedValueOnce({
      tracks: [{ id: "sub-1", subtitleUrl: "https://s.example.com/1.json", lan: "zh-CN", lanDoc: "中文", source: "player-wbi-v2" }],
      chapters: []
    });

    const result = await resolveAiConversationContext(CONTEXT_REF);
    expect(result.chapters).toEqual([]);
  });

  it("bundle 章节为脏值（非数组）→ chapters 回落空数组", async () => {
    vi.mocked(fetchSubtitleBundle).mockResolvedValueOnce({
      tracks: [{ id: "sub-1", subtitleUrl: "https://s.example.com/1.json", lan: "zh-CN", lanDoc: "中文", source: "player-wbi-v2" }],
      chapters: undefined as unknown as Chapter[]
    });

    const result = await resolveAiConversationContext(CONTEXT_REF);
    expect(result.chapters).toEqual([]);
  });
});
