import { describe, expect, it } from "vitest";
import {
  buildReaderModeUrl,
  cleanVideoUrl,
  stripReaderModeUrl
} from "../../extension/bilibili/video-id-shared.js";

describe("video-id-shared URL 净化与阅读模式 URL", () => {
  it("普通视频页收敛为规范 /video/BV.../ 并仅保留分 P 参数", () => {
    expect(
      cleanVideoUrl("https://www.bilibili.com/video/BV1abc000000/?p=2&spm_id_from=333.1007&biliscript_reader=1#reply")
    ).toBe("https://www.bilibili.com/video/BV1abc000000/?p=2");
    expect(
      buildReaderModeUrl("https://www.bilibili.com/video/BV1abc000000/?p=2&vd_source=xyz")
    ).toBe("https://www.bilibili.com/video/BV1abc000000/?p=2&biliscript_reader=1");
  });

  it("稍后再看页保留 /list/watchlater（去除尾部斜杠）与上下文参数，剥离追踪参数与 biliscript_reader", () => {
    const raw =
      "https://www.bilibili.com/list/watchlater/?bvid=BV1wl000001&oid=170001&p=2&desc=1&spm_id_from=333.1007&vd_source=abc&share_source=copy_web&utm_source=test&biliscript_reader=1#top";

    expect(cleanVideoUrl(raw)).toBe(
      "https://www.bilibili.com/list/watchlater?bvid=BV1wl000001&oid=170001&p=2&desc=1"
    );
    expect(buildReaderModeUrl(raw)).toBe(
      "https://www.bilibili.com/list/watchlater?bvid=BV1wl000001&oid=170001&p=2&desc=1&biliscript_reader=1"
    );
  });

  it("稍后再看无 bvid 裸地址同样去斜杠并保证 buildReaderModeUrl / stripReaderModeUrl 幂等", () => {
    const bare = "https://www.bilibili.com/list/watchlater/?spm_id_from=333.1007&biliscript_reader=1";
    expect(cleanVideoUrl(bare)).toBe("https://www.bilibili.com/list/watchlater");

    const readerUrl = buildReaderModeUrl(bare);
    expect(readerUrl).toBe("https://www.bilibili.com/list/watchlater?biliscript_reader=1");
    expect(buildReaderModeUrl(readerUrl)).toBe(readerUrl);
    expect(stripReaderModeUrl(readerUrl)).toBe("https://www.bilibili.com/list/watchlater");
  });

  it("非 B 站或非法 URL 原样回落", () => {
    expect(cleanVideoUrl("https://example.com/list/watchlater?bvid=BV1wl000001")).toBe(
      "https://example.com/list/watchlater?bvid=BV1wl000001"
    );
    expect(cleanVideoUrl("not-a-url")).toBe("not-a-url");
  });
});
