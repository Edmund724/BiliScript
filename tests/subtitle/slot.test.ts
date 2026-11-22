import { beforeEach, describe, expect, it } from "vitest";
import { resetModuleState } from "../setup.js";
import { clipState, emptySecondarySubtitle } from "../../extension/core/state.js";
import type { SubtitleBodyItem, NoSubtitleReason } from "../../extension/core/state.js";
import { install,
  clearToEmpty,
  installSecondary,
  markSecondaryLoading,
  markSecondaryError,
  clearSecondary,
  clearAllForVideoSwitch
} from "../../extension/subtitle/slot.js";

const SAMPLE_BODY_A: SubtitleBodyItem[] = [
  { from: 0, to: 1.5, content: "Hello" },
  { from: 1.5, to: 3.0, content: "World" }
];

const SAMPLE_BODY_B: SubtitleBodyItem[] = [
  { from: 0, to: 1.5, content: "你好" },
  { from: 1.5, to: 3.0, content: "世界" }
];

const PRIMARY_IDENTITY = {
  id: "sub-zh-1",
  url: "https://i0.hdslb.com/zh.json",
  lang: "zh-CN"
};

const SECONDARY_IDENTITY = {
  id: "sub-en-2",
  url: "https://i0.hdslb.com/en.json"
};

function captureClipSnapshot() {
  return {
    selectedSubtitleId: clipState.selectedSubtitleId,
    selectedSubtitleUrl: clipState.selectedSubtitleUrl,
    selectedSubtitleLang: clipState.selectedSubtitleLang,
    subtitleBody: clipState.subtitleBody,
    subtitleFetchState: clipState.subtitleFetchState,
    noSubtitleReason: clipState.noSubtitleReason,
    noSubtitleDetail: clipState.noSubtitleDetail,

    secondarySubtitle: {
      id: clipState.secondarySubtitle.id,
      url: clipState.secondarySubtitle.url,
      body: clipState.secondarySubtitle.body,
      state: clipState.secondarySubtitle.state
    },

    markdown: clipState.markdown,
    srt: clipState.srt,
    txt: clipState.txt,

    bvid: clipState.bvid,
    aid: clipState.aid,
    cid: clipState.cid,
    title: clipState.title,
    author: clipState.author,
    chapters: clipState.chapters,
    hotComments: clipState.hotComments,
    fetchRunId: clipState.fetchRunId
  };
}

function diffSnapshotKeys(
  before: ReturnType<typeof captureClipSnapshot>,
  after: ReturnType<typeof captureClipSnapshot>
): string[] {
  const keys = Object.keys(before) as (keyof typeof before)[];
  const changed: string[] = [];
  for (const k of keys) {
    if (k === "secondarySubtitle") {
      const bSec = before.secondarySubtitle;
      const aSec = after.secondarySubtitle;
      if (
        bSec.id !== aSec.id ||
        bSec.url !== aSec.url ||
        bSec.body !== aSec.body ||
        bSec.state !== aSec.state
      ) {
        changed.push(k);
      }
    } else if (before[k] !== after[k]) {
      changed.push(k);
    }
  }
  return changed.sort();
}

function seedDirtyClipState() {
  clipState.setBvid("BV1dirty000");
  clipState.setAid("123456");
  clipState.setCid("789101");
  clipState.setTitle("测试脏视频标题");
  clipState.setAuthor("测试脏UP主");
  clipState.setChapters([{ title: "章1", from: 0 }]);
  clipState.setHotComments([{ uname: "测试用户", like: 1, message: "热评1" }]);
  clipState.setMarkdown("# 脏 Markdown");
  clipState.setSrt("1\n00:00:00,000 --> 00:00:01,000\n脏SRT");
  clipState.setTxt("0:00 脏TXT");

  clipState.setSelectedSubtitleId("old-sub-id");
  clipState.setSelectedSubtitleUrl("https://old.url");
  clipState.setSelectedSubtitleLang("old-lang");
  clipState.setSubtitleBody([{ from: 0, to: 1, content: "旧字幕" }]);
  clipState.setSubtitleFetchState("ready");
  clipState.setNoSubtitleReason("no-asr-config");
  clipState.setNoSubtitleDetail("（错误详情：ASR平台未授权）");

  clipState.applySecondarySubtitle({
    id: "old-sec-id",
    url: "https://old.sec.url",
    body: [{ from: 0, to: 1, content: "old secondary" }]
  });
}

beforeEach(() => {
  resetModuleState();
});

describe("extension/subtitle/slot", () => {
  describe("结构性特征对账：clearAllForVideoSwitch 清除字段为 install（主轨）与 installSecondary（副轨）写入字段的并集", () => {
    it("install 写入字段集合与 installSecondary 写入字段集合无重叠，clearAllForVideoSwitch 清除字段恰为二者并集（默认 keepFetchState: false）", () => {
      clipState.setSelectedSubtitleId("initial-id");
      clipState.setSelectedSubtitleUrl("initial-url");
      clipState.setSelectedSubtitleLang("initial-lang");
      clipState.setSubtitleBody([]);
      clipState.setSubtitleFetchState("idle");
      clipState.setNoSubtitleReason("asr-disabled");
      clipState.setNoSubtitleDetail("detail-to-be-cleared");

      const beforeInstall = captureClipSnapshot();
      install(PRIMARY_IDENTITY, SAMPLE_BODY_A);
      const afterInstall = captureClipSnapshot();
      const installChangedKeys = diffSnapshotKeys(beforeInstall, afterInstall);

      expect(installChangedKeys).toEqual([
        "noSubtitleDetail",
        "noSubtitleReason",
        "selectedSubtitleId",
        "selectedSubtitleLang",
        "selectedSubtitleUrl",
        "subtitleBody",
        "subtitleFetchState"
      ]);

      const beforeSec = captureClipSnapshot();
      installSecondary(SECONDARY_IDENTITY, SAMPLE_BODY_B);
      const afterSec = captureClipSnapshot();
      const installSecChangedKeys = diffSnapshotKeys(beforeSec, afterSec);

      expect(installSecChangedKeys).toEqual(["secondarySubtitle"]);

      const unionKeys = Array.from(new Set([...installChangedKeys, ...installSecChangedKeys])).sort();
      expect(unionKeys).toEqual([
        "noSubtitleDetail",
        "noSubtitleReason",
        "secondarySubtitle",
        "selectedSubtitleId",
        "selectedSubtitleLang",
        "selectedSubtitleUrl",
        "subtitleBody",
        "subtitleFetchState"
      ]);

      seedDirtyClipState();
      const beforeClear = captureClipSnapshot();
      clearAllForVideoSwitch();
      const afterClear = captureClipSnapshot();
      const clearChangedKeys = diffSnapshotKeys(beforeClear, afterClear);

      expect(clearChangedKeys).toEqual(unionKeys);

      expect(clipState.selectedSubtitleId).toBe("");
      expect(clipState.selectedSubtitleUrl).toBe("");
      expect(clipState.selectedSubtitleLang).toBe("");
      expect(clipState.subtitleBody).toEqual([]);
      expect(clipState.subtitleFetchState).toBe("idle");
      expect(clipState.noSubtitleReason).toBeNull();
      expect(clipState.noSubtitleDetail).toBe("");
      expect(clipState.secondarySubtitle).toEqual(emptySecondarySubtitle());

      expect(clipState.bvid).toBe("BV1dirty000");
      expect(clipState.title).toBe("测试脏视频标题");
      expect(clipState.author).toBe("测试脏UP主");
      expect(clipState.chapters).toEqual([{ title: "章1", from: 0 }]);
      expect(clipState.hotComments).toEqual([{ uname: "测试用户", like: 1, message: "热评1" }]);
      expect(clipState.markdown).toBe("# 脏 Markdown");
      expect(clipState.srt).toBe("1\n00:00:00,000 --> 00:00:01,000\n脏SRT");
      expect(clipState.txt).toBe("0:00 脏TXT");
    });

    it("clearAllForVideoSwitch({ keepFetchState: true }) 保留现有 subtitleFetchState，其余并集字段全部清空", () => {
      seedDirtyClipState();
      clipState.setSubtitleFetchState("error");

      const beforeClear = captureClipSnapshot();
      clearAllForVideoSwitch({ keepFetchState: true });
      const afterClear = captureClipSnapshot();
      const clearChangedKeys = diffSnapshotKeys(beforeClear, afterClear);

      expect(clearChangedKeys).toEqual([
        "noSubtitleDetail",
        "noSubtitleReason",
        "secondarySubtitle",
        "selectedSubtitleId",
        "selectedSubtitleLang",
        "selectedSubtitleUrl",
        "subtitleBody"
      ]);

      expect(clipState.subtitleFetchState).toBe("error");
      expect(clipState.selectedSubtitleId).toBe("");
      expect(clipState.selectedSubtitleUrl).toBe("");
      expect(clipState.selectedSubtitleLang).toBe("");
      expect(clipState.subtitleBody).toEqual([]);
      expect(clipState.noSubtitleReason).toBeNull();
      expect(clipState.noSubtitleDetail).toBe("");
      expect(clipState.secondarySubtitle).toEqual(emptySecondarySubtitle());
    });
  });

  describe("05 票副轨隔离不变量：clearToEmpty 仅将主轨置为 empty，副轨槽保持原样不变", () => {
    it("clearToEmpty 显式指定 reason 时，重置主轨字段与 reason，绝对不影响副轨槽内容与状态", () => {
      install(PRIMARY_IDENTITY, SAMPLE_BODY_A);
      installSecondary(SECONDARY_IDENTITY, SAMPLE_BODY_B);

      const secondaryBefore = { ...clipState.secondarySubtitle };

      clearToEmpty("asr-disabled");

      expect(clipState.selectedSubtitleId).toBe("");
      expect(clipState.selectedSubtitleUrl).toBe("");
      expect(clipState.selectedSubtitleLang).toBe("");
      expect(clipState.subtitleBody).toEqual([]);
      expect(clipState.subtitleFetchState).toBe("empty");
      expect(clipState.noSubtitleReason).toBe("asr-disabled");

      expect(clipState.secondarySubtitle).toEqual(secondaryBefore);
      expect(clipState.secondarySubtitle.id).toBe("sub-en-2");
      expect(clipState.secondarySubtitle.url).toBe("https://i0.hdslb.com/en.json");
      expect(clipState.secondarySubtitle.body).toEqual(SAMPLE_BODY_B);
      expect(clipState.secondarySubtitle.state).toBe("ready");
    });

    it("clearToEmpty 缺省 reason（undefined）时保留原有 noSubtitleReason", () => {
      clipState.setNoSubtitleReason("no-asr-config");
      installSecondary(SECONDARY_IDENTITY, SAMPLE_BODY_B);
      const secondaryBefore = { ...clipState.secondarySubtitle };

      clearToEmpty();

      expect(clipState.subtitleFetchState).toBe("empty");
      expect(clipState.noSubtitleReason).toBe("no-asr-config");
      expect(clipState.secondarySubtitle).toEqual(secondaryBefore);
    });

    it("clearToEmpty(null) 可将 noSubtitleReason 显式置为 null", () => {
      clipState.setNoSubtitleReason("asr-quota");
      installSecondary(SECONDARY_IDENTITY, SAMPLE_BODY_B);

      clearToEmpty(null);

      expect(clipState.subtitleFetchState).toBe("empty");
      expect(clipState.noSubtitleReason).toBeNull();
      expect(clipState.secondarySubtitle.state).toBe("ready");
    });
  });

  describe("隔离不变量：副轨动词绝不触碰主轨状态", () => {
    it("installSecondary 写入副轨不改变主轨 selected 三项、subtitleFetchState 与 noSubtitle*", () => {
      install(PRIMARY_IDENTITY, SAMPLE_BODY_A);
      clipState.setNoSubtitleDetail("detail-preserved");

      const primarySelectedId = clipState.selectedSubtitleId;
      const primarySelectedUrl = clipState.selectedSubtitleUrl;
      const primarySelectedLang = clipState.selectedSubtitleLang;
      const primaryFetchState = clipState.subtitleFetchState;
      const primaryBody = clipState.subtitleBody;
      const primaryReason = clipState.noSubtitleReason;
      const primaryDetail = clipState.noSubtitleDetail;

      installSecondary(SECONDARY_IDENTITY, SAMPLE_BODY_B);

      expect(clipState.selectedSubtitleId).toBe(primarySelectedId);
      expect(clipState.selectedSubtitleUrl).toBe(primarySelectedUrl);
      expect(clipState.selectedSubtitleLang).toBe(primarySelectedLang);
      expect(clipState.subtitleFetchState).toBe(primaryFetchState);
      expect(clipState.subtitleBody).toBe(primaryBody);
      expect(clipState.noSubtitleReason).toBe(primaryReason);
      expect(clipState.noSubtitleDetail).toBe(primaryDetail);

      expect(clipState.secondarySubtitle.id).toBe("sub-en-2");
      expect(clipState.secondarySubtitle.url).toBe("https://i0.hdslb.com/en.json");
      expect(clipState.secondarySubtitle.body).toEqual(SAMPLE_BODY_B);
      expect(clipState.secondarySubtitle.state).toBe("ready");
    });
  });

  describe("副轨辅助动词：markSecondaryLoading / markSecondaryError", () => {
    it("markSecondaryLoading 乐观写入副轨目标身份，清空副轨正文，置为 loading 态，且不影响主轨", () => {
      install(PRIMARY_IDENTITY, SAMPLE_BODY_A);

      markSecondaryLoading({ id: "sec-target-1", url: "https://sec-target-url" });

      expect(clipState.secondarySubtitle).toEqual({
        id: "sec-target-1",
        url: "https://sec-target-url",
        body: [],
        state: "loading"
      });
      expect(clipState.selectedSubtitleId).toBe(PRIMARY_IDENTITY.id);
      expect(clipState.subtitleFetchState).toBe("ready");
    });

    it("markSecondaryError 保留目标轨身份，清空正文，置为 error 态，且不影响主轨", () => {
      install(PRIMARY_IDENTITY, SAMPLE_BODY_A);
      markSecondaryLoading({ id: "sec-target-1", url: "https://sec-target-url" });

      markSecondaryError();

      expect(clipState.secondarySubtitle).toEqual({
        id: "sec-target-1",
        url: "https://sec-target-url",
        body: [],
        state: "error"
      });
      expect(clipState.selectedSubtitleId).toBe(PRIMARY_IDENTITY.id);
      expect(clipState.subtitleFetchState).toBe("ready");
    });

    it("markSecondaryError(target) 原子写入目标轨身份并直接置为 error 态，无需先经过 loading", () => {
      install(PRIMARY_IDENTITY, SAMPLE_BODY_A);
      installSecondary(SECONDARY_IDENTITY, SAMPLE_BODY_B);

      markSecondaryError({ id: "translate-zh", url: "" });

      expect(clipState.secondarySubtitle).toEqual({
        id: "translate-zh",
        url: "",
        body: [],
        state: "error"
      });
      expect(clipState.selectedSubtitleId).toBe(PRIMARY_IDENTITY.id);
      expect(clipState.subtitleFetchState).toBe("ready");
    });

    it("clearSecondary 复位副轨为空槽，且不影响主轨", () => {
      install(PRIMARY_IDENTITY, SAMPLE_BODY_A);
      installSecondary(SECONDARY_IDENTITY, SAMPLE_BODY_B);

      clearSecondary();

      expect(clipState.secondarySubtitle).toEqual(emptySecondarySubtitle());
      expect(clipState.selectedSubtitleId).toBe(PRIMARY_IDENTITY.id);
      expect(clipState.subtitleFetchState).toBe("ready");
      expect(clipState.subtitleBody).toEqual(SAMPLE_BODY_A);
    });
  });
});
