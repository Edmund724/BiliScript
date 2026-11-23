import { describe, expect, it } from "vitest";
import {
  buildReaderModeUrl,
  cleanVideoUrl,
  computeCurrentClipSignature,
  extractBvid,
  isFestivalPage,
  isPlaylistPage,
  isSupportedBilibiliPage,
  isSupportedVideoPage,
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

  it("活动专题页保留 /festival/<slug>（去尾部斜杠）与 bvid/p 参数，不收敛为 /video/ 且幂等", () => {
    const raw =
      "https://www.bilibili.com/festival/27kaoyanshangan/?bvid=BV1pNyWzAE2f&p=1&spm_id_from=333.40164.0.0&vd_source=abc&utm_source=x&biliscript_reader=1#top";

    expect(extractBvid(raw)).toBe("BV1pNyWzAE2f");
    expect(cleanVideoUrl(raw)).toBe(
      "https://www.bilibili.com/festival/27kaoyanshangan?bvid=BV1pNyWzAE2f&p=1"
    );

    const readerUrl = buildReaderModeUrl(raw);
    expect(readerUrl).toBe(
      "https://www.bilibili.com/festival/27kaoyanshangan?bvid=BV1pNyWzAE2f&p=1&biliscript_reader=1"
    );
    expect(buildReaderModeUrl(readerUrl)).toBe(readerUrl);
    expect(stripReaderModeUrl(readerUrl)).toBe(
      "https://www.bilibili.com/festival/27kaoyanshangan?bvid=BV1pNyWzAE2f&p=1"
    );

    const bare = "https://www.bilibili.com/festival/27kaoyanshangan/?spm_id_from=333.1007&biliscript_reader=1";
    expect(cleanVideoUrl(bare)).toBe("https://www.bilibili.com/festival/27kaoyanshangan");
    const bareReader = buildReaderModeUrl(bare);
    expect(bareReader).toBe("https://www.bilibili.com/festival/27kaoyanshangan?biliscript_reader=1");
    expect(buildReaderModeUrl(bareReader)).toBe(bareReader);
    expect(stripReaderModeUrl(bareReader)).toBe("https://www.bilibili.com/festival/27kaoyanshangan");
  });

  it("isFestivalPage 与受支持页面判定：活动页仅在携带有效 bvid 时视为受支持视频页", () => {
    const withBvid = "https://www.bilibili.com/festival/27kaoyanshangan?bvid=BV1pNyWzAE2f&spm_id_from=333.40164.0.0";
    const bare = "https://www.bilibili.com/festival/27kaoyanshangan";

    expect(isFestivalPage(withBvid)).toBe(true);
    expect(isFestivalPage("https://www.bilibili.com/festival/27kaoyanshangan/")).toBe(true);
    expect(isFestivalPage("https://www.bilibili.com/festival/")).toBe(false);
    expect(isFestivalPage("https://www.bilibili.com/festival")).toBe(false);
    expect(isFestivalPage("https://www.bilibili.com/festival/a/b?bvid=BV1pNyWzAE2f")).toBe(false);
    expect(isFestivalPage("https://example.com/festival/27kaoyanshangan?bvid=BV1pNyWzAE2f")).toBe(false);

    expect(isSupportedVideoPage(withBvid)).toBe(true);
    expect(isSupportedBilibiliPage(withBvid)).toBe(true);
    expect(isSupportedVideoPage(bare)).toBe(false);
    expect(isSupportedBilibiliPage(bare)).toBe(false);
    expect(isSupportedVideoPage("https://www.bilibili.com/festival/27kaoyanshangan?bvid=invalid")).toBe(false);
    expect(isSupportedBilibiliPage("https://www.bilibili.com/festival/27kaoyanshangan?bvid=invalid")).toBe(false);
  });

  it("收藏夹与 UP 主播单 /list/*：支持页判定、URL 净化幂等性与切集签名变化", () => {
    const mlRaw =
      "https://www.bilibili.com/list/ml4110522184/?spm_id_from=333.1387.0.0&oid=117323927129038&bvid=BV1RWaw6jEay&desc=1&sid=99&biliscript_reader=1#top";
    const upRaw = "https://www.bilibili.com/list/123456?bvid=BV1abc000000&oid=456&spm_id_from=333.999";

    expect(isPlaylistPage(mlRaw)).toBe(true);
    expect(isPlaylistPage(upRaw)).toBe(true);
    expect(isPlaylistPage("https://www.bilibili.com/list/")).toBe(false);
    expect(isPlaylistPage("https://www.bilibili.com/list/ml4110522184/extra")).toBe(false);
    expect(isPlaylistPage("https://example.com/list/ml4110522184?bvid=BV1RWaw6jEay")).toBe(false);

    expect(isSupportedVideoPage(mlRaw)).toBe(true);
    expect(isSupportedVideoPage(upRaw)).toBe(true);
    expect(isSupportedBilibiliPage(mlRaw)).toBe(true);
    expect(isSupportedBilibiliPage(upRaw)).toBe(true);

    expect(cleanVideoUrl(mlRaw)).toBe(
      "https://www.bilibili.com/list/ml4110522184?oid=117323927129038&bvid=BV1RWaw6jEay&desc=1&sid=99"
    );
    const readerUrl = buildReaderModeUrl(mlRaw);
    expect(readerUrl).toBe(
      "https://www.bilibili.com/list/ml4110522184?oid=117323927129038&bvid=BV1RWaw6jEay&desc=1&sid=99&biliscript_reader=1"
    );
    expect(buildReaderModeUrl(readerUrl)).toBe(readerUrl);
    expect(stripReaderModeUrl(readerUrl)).toBe(
      "https://www.bilibili.com/list/ml4110522184?oid=117323927129038&bvid=BV1RWaw6jEay&desc=1&sid=99"
    );

    const sig1 = computeCurrentClipSignature(
      "https://www.bilibili.com/list/ml4110522184?oid=117323927129038&bvid=BV1RWaw6jEay"
    );
    const sig2 = computeCurrentClipSignature(
      "https://www.bilibili.com/list/ml4110522184?oid=117323927999999&bvid=BV1next000001"
    );
    expect(sig1).toBe("BV1RWaw6jEay|1");
    expect(sig2).toBe("BV1next000001|1");
    expect(sig1).not.toBe(sig2);
  });

  it("非 B 站或非法 URL 原样回落", () => {
    expect(cleanVideoUrl("https://example.com/list/watchlater?bvid=BV1wl000001")).toBe(
      "https://example.com/list/watchlater?bvid=BV1wl000001"
    );
    expect(cleanVideoUrl("not-a-url")).toBe("not-a-url");
  });
});
