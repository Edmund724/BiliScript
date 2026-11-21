import { beforeEach, describe, expect, it } from "vitest";
import { resetModuleState } from "../setup.js";
import { mapSubtitleTracks } from "../../extension/bilibili/native-payload.js";
import { getSubtitleCacheKey } from "../../extension/subtitle/cache.js";
import { trackIdentity } from "../../extension/subtitle/source-key.js";

beforeEach(() => {
  resetModuleState();
});

const AI_ZH_RAW = {
  id: 2120476497172283400,
  id_str: "2120476497172283392",
  lan: "ai-zh",
  lan_doc: "中文",
  subtitle_url: "//aisubtitle.hdslb.com/bfs/ai_subtitle/p/zh.json"
};

describe("mapSubtitleTracks：轨道身份取 id_str（wayfinder 06 / Q11）", () => {
  it("轨道身份取 id_str：不取 JSON.parse 丢过尾数的 id", () => {
    const [zh] = mapSubtitleTracks([AI_ZH_RAW]);

    expect(zh.id).toBe("2120476497172283392");
    expect(
      getSubtitleCacheKey({ bvid: "BV1mAam6tEL8", cid: "42393338874", identity: trackIdentity(zh.id, "", "") })
    ).toContain("id_2120476497172283392");
  });

  it("无 id_str（缺失 / null / 空串）回落 id；id 与 id_str 都缺为空串", () => {
    const tracks = mapSubtitleTracks([
      { id: "9", lan: "zh-CN", lan_doc: "中文", subtitle_url: "//i0.hdslb.com/bfs/a.json" },
      { id: 7, id_str: null, lan: "zh-CN", lan_doc: "中文", subtitle_url: "//i0.hdslb.com/bfs/b.json" },
      { id: 8, id_str: "", lan: "zh-CN", lan_doc: "中文", subtitle_url: "//i0.hdslb.com/bfs/c.json" },
      { id_str: "5", lan: "zh-CN", lan_doc: "中文", subtitle_url: "//i0.hdslb.com/bfs/d.json" },
      { lan: "zh-CN", lan_doc: "中文", subtitle_url: "//i0.hdslb.com/bfs/e.json" }
    ]);

    expect(tracks.map((item) => item.id)).toEqual(["9", "7", "8", "5", ""]);
  });
});
