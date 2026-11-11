import { describe, expect, it, vi } from "vitest";
import { createAgentBridgeVideoService } from "../../extension/agent-bridge/video-service.js";

const bvid = "BV1test000000";
const provider = {
  id: "asr-1",
  presetId: "custom",
  name: "ASR",
  type: "openai-transcriptions",
  baseUrl: "https://asr.example.com",
  model: "whisper-1",
  supportsTimestamps: true,
  enabled: true
};

function metaPayload() {
  return {
    code: 0,
    data: {
      aid: 123,
      cid: 100,
      title: "桥接视频",
      desc: "简介",
      duration: 60,
      owner: { name: "作者" },
      pages: [
        { cid: 100, page: 1, part: "第一集", duration: 60 },
        { cid: 200, page: 2, part: "第二集", duration: 90 }
      ]
    }
  };
}

function playerPayload(withTrack = true) {
  return {
    code: 0,
    data: {
      subtitle: {
        subtitles: withTrack
          ? [{ id_str: "track-1", lan: "zh-CN", lan_doc: "中文", subtitle_url: "//i0.hdslb.com/bfs/subtitle.json" }]
          : []
      },
      view_points: [{ content: "章节", from: 0, to: 30 }]
    }
  };
}

function nativeTransport(bodyCalls: { count: number }) {
  return vi.fn(async (url: string) => {
    if (url.includes("x/web-interface/view")) return metaPayload();
    if (url.includes("x/player/wbi/v2")) return playerPayload();
    if (url.includes("i0.hdslb.com")) {
      bodyCalls.count += 1;
      return {
        body: [
          { from: 0, to: 5, content: "开头" },
          { from: 10, to: 15, content: "中段" },
          { from: 20, to: 25, content: "结尾" }
        ]
      };
    }
    throw new Error(`unexpected ${url}`);
  });
}

describe("Agent Bridge 视频服务", () => {
  it("返回分 P、章节与过滤后的原生字幕，并复用正文缓存", async () => {
    const bodyCalls = { count: 0 };
    const service = createAgentBridgeVideoService({ transport: nativeTransport(bodyCalls) });
    const query = { bvid, pageIndex: 2, from: 8, to: 18 };

    const first = await service.getSubtitles(query);
    expect(first.video).toMatchObject({ bvid, cid: "200", page: 2, pageCount: 2, duration: 90 });
    expect(first.pages).toHaveLength(2);
    expect(first.chapters).toEqual([{ title: "章节", from: 0, to: 30, source: "player-view-points" }]);
    expect(first.subtitle).toMatchObject({
      source: "player-wbi-v2",
      trackId: "track-1",
      language: "中文",
      items: [{ from: 10, to: 15, content: "中段" }]
    });

    await service.getSubtitles(query);
    expect(bodyCalls.count).toBe(1);
  });

  it("无字幕且 ASR 未开启时返回可操作错误", async () => {
    const service = createAgentBridgeVideoService({
      transport: vi.fn(async (url: string) => url.includes("view") ? metaPayload() : playerPayload(false)),
      getAsrRuntime: async () => ({ enabled: false, provider: null, language: "auto" })
    });
    await expect(service.getSubtitles({ bvid })).rejects.toThrow("请在扩展设置中开启");
  });

  it("无字幕时后台 ASR 写入同一缓存并合并并发请求", async () => {
    const transcribe = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return [{ from: 0, to: 4, content: "转写结果" }];
    });
    const service = createAgentBridgeVideoService({
      transport: vi.fn(async (url: string) => url.includes("view") ? metaPayload() : playerPayload(false)),
      getAsrRuntime: async () => ({ enabled: true, provider, language: "zh" }),
      transcribe
    });

    const [left, right] = await Promise.all([
      service.getSubtitles({ bvid }),
      service.getSubtitles({ bvid })
    ]);
    expect(left.subtitle).toMatchObject({ source: "asr", language: "自配平台转写（中文）" });
    expect(right.subtitle.items).toEqual([{ from: 0, to: 4, content: "转写结果" }]);
    await service.getSubtitles({ bvid });
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it("comments 返回前 20 条热评", async () => {
    const replies = Array.from({ length: 22 }, (_, index) => ({
      rpid: index + 1,
      member: { uname: `用户${index + 1}` },
      like: 0,
      content: { message: `评论${index + 1}` }
    }));
    const service = createAgentBridgeVideoService({
      transport: vi.fn(async (url: string) => {
        if (url.includes("view")) return metaPayload();
        if (url.includes("reply/main")) return { code: 0, data: { replies } };
        throw new Error(`unexpected ${url}`);
      })
    });
    const result = await service.getComments({ bvid });
    expect(result.comments).toHaveLength(20);
    expect(result.video).toMatchObject({ bvid, aid: "123" });
  });
});
