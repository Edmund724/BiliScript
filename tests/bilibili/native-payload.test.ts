// bilibili/native-payload.js 直测：原生产物映射的轨道身份口径（wayfinder 06 / Q11）。
//
// 自 tests/subtitle/selection.test.ts 按概念分面搬来（用例语义不变）：映射随
// SubtitleTrack / Chapter 的声明归位 bilibili/native-payload.ts（架构评审
// 「轨道身份：selection.ts 按概念拆位」），身份口径的用例跟随落点。
//
// - mapSubtitleTracks 的身份：轨道 id 取接口的 id_str（19 位 JSON 数字 > 2^53，
//   JSON.parse 阶段尾数已丢），无 id_str 时回落 id。

import { beforeEach, describe, expect, it } from "vitest";
import { resetModuleState } from "../setup.js";
import { mapSubtitleTracks } from "../../extension/bilibili/native-payload.js";
import { getSubtitleCacheKey } from "../../extension/subtitle/cache.js";
import { trackIdentity } from "../../extension/subtitle/source-key.js";

beforeEach(() => {
  resetModuleState();
});

// BV1mAam6tEL8 的 ai-zh 轨（research/01-track-shape.md）：接口 id 是 19 位 JSON 数字
//（> 2^53），下面写 JSON.parse 之后的丢精度值，id_str 写精确值——两者成对还原真实响应。
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
    // 精确身份进缓存键分量（身份构造与写入端同取 id_str）
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
