// subtitle/subtitle-in-hand.ts 直测：谓词只读 core/state 的 state.clip 三字段 +
// extractBvid(location.href)，是「叶子事实」——面板兜底抓取（reader/lifecycle 的
// maybeRefreshReaderSubtitleInBackground）与页面预抓取（entry/message-handler 的
// ensureSubtitlePrefetch）共用的去重守卫，两侧同一份语义。
//
// 覆盖两种判假的先决（身份不成立）与三种判真的在手/在飞形态。

import { beforeEach, describe, expect, it } from "vitest";
import { NORMAL_PAGE_URL, resetModuleState, setLocationUrl } from "../setup.js";

type StateModule = typeof import("../../extension/core/state.js");
type SubtitleInHandModule = typeof import("../../extension/subtitle/subtitle-in-hand.js");

const CURRENT_BVID = "BV1test000000";

let state: StateModule["state"];
let isSubtitleInHandOrInFlight: SubtitleInHandModule["isSubtitleInHandOrInFlight"];

beforeEach(async () => {
  resetModuleState();
  setLocationUrl(NORMAL_PAGE_URL);
  state = (await import("../../extension/core/state.js")).state;
  isSubtitleInHandOrInFlight = (await import("../../extension/subtitle/subtitle-in-hand.js"))
    .isSubtitleInHandOrInFlight;
});

describe("isSubtitleInHandOrInFlight：本视频字幕在手或在飞", () => {
  it("字幕体非空（在手）→ true", () => {
    state.clip.setBvid(CURRENT_BVID);
    state.clip.setSubtitleBody([{ from: 0, to: 5, content: "第一条" }]);
    expect(isSubtitleInHandOrInFlight()).toBe(true);
  });

  it("fetchState 为 loading（抓取在飞）→ true", () => {
    state.clip.setBvid(CURRENT_BVID);
    state.clip.setSubtitleFetchState("loading");
    expect(isSubtitleInHandOrInFlight()).toBe(true);
  });

  it("fetchState 为 ready（已接受）→ true", () => {
    state.clip.setBvid(CURRENT_BVID);
    state.clip.setSubtitleFetchState("ready");
    expect(isSubtitleInHandOrInFlight()).toBe(true);
  });

  it("字幕体空且 idle → false", () => {
    state.clip.setBvid(CURRENT_BVID);
    expect(isSubtitleInHandOrInFlight()).toBe(false);
  });

  it("clip.bvid 为空 → false（不拿空身份当同一视频）", () => {
    state.clip.setSubtitleBody([{ from: 0, to: 5, content: "残留字幕" }]);
    state.clip.setSubtitleFetchState("ready");
    expect(isSubtitleInHandOrInFlight()).toBe(false);
  });

  it("clip.bvid 与地址不一致（SPA 换片逃逸 URL 监听的残留态）→ false", () => {
    state.clip.setBvid("BV1stale00000");
    state.clip.setSubtitleBody([{ from: 0, to: 5, content: "上一个视频的字幕" }]);
    state.clip.setSubtitleFetchState("ready");
    expect(isSubtitleInHandOrInFlight()).toBe(false);
  });

  it("地址取不出 bvid 时身份不成立 → false", () => {
    setLocationUrl("https://www.bilibili.com/");
    state.clip.setBvid(CURRENT_BVID);
    state.clip.setSubtitleBody([{ from: 0, to: 5, content: "第一条" }]);
    expect(isSubtitleInHandOrInFlight()).toBe(false);
  });
});
