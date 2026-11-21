import { beforeEach, describe, expect, it } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

let state: TestState;
let shell: typeof import("../../extension/reader/index.js");
let ids: typeof import("../../extension/reader/state.js").ids;

function metaNode(): HTMLElement {
  return document.getElementById(ids.readingMeta) as HTMLElement;
}

function selectTrack(track: { id: string; lan: string; lanDoc: string; subtitleUrl: string }, lang = track.lanDoc) {
  state.clip.setSubtitles([track]);
  state.clip.setSelectedSubtitleId(track.id);
  state.clip.setSelectedSubtitleUrl(track.subtitleUrl);
  state.clip.setSelectedSubtitleLang(lang);
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  shell = await import("../../extension/reader/index.js");
  ids = (await import("../../extension/reader/state.js")).ids;
  mountReaderSkeleton(ids);
  mountPlayerChain();
});

describe("面板 header 元信息行", () => {
  it("多P：UP主 与 分P 各占一行，且不再出现「字幕：」", () => {
    state.clip.setAuthor("硅谷101");
    state.clip.setPageCount(3);
    state.clip.setPageIndex(2);
    state.clip.setPageTitle("第二话");
    selectTrack({ id: "s1", lan: "zh-CN", lanDoc: "中文", subtitleUrl: "u1" });

    shell.renderReadingView();

    expect(metaNode().textContent).toBe("UP主：硅谷101\nP2：第二话");
    expect(metaNode().textContent).not.toContain("字幕：");
    expect(metaNode().textContent).not.toContain("人工上传");
    expect(metaNode().textContent).not.toContain("bilibili.com");
    expect(metaNode().hidden).toBe(false);
  });

  it("B站 AI 轨：meta 行不标注来源与语言", () => {
    state.clip.setAuthor("晓舟报告");
    selectTrack({ id: "s2", lan: "ai-zh", lanDoc: "中文（自动生成）", subtitleUrl: "u2" });

    shell.renderReadingView();

    expect(metaNode().textContent).toBe("UP主：晓舟报告");
  });

  it("ASR 伪轨：meta 行不出现来源串与平台名", () => {
    state.clip.setAuthor("晓舟报告");
    selectTrack(
      { id: "asr", lan: "asr-zh", lanDoc: "自配平台转写（中文）", subtitleUrl: "" },
      "自配平台转写（中文）"
    );

    shell.renderReadingView();

    expect(metaNode().textContent).toBe("UP主：晓舟报告");
    expect(metaNode().textContent).not.toContain("自配平台转写");
    expect(metaNode().textContent).not.toContain("SiliconFlow");
  });

  it("有选中语言但轨道找不到（ASR 缓存命中未塞伪轨）：meta 行只留作者", () => {
    state.clip.setAuthor("晓舟报告");
    state.clip.setSubtitles([]);
    state.clip.setSelectedSubtitleId("asr");
    state.clip.setSelectedSubtitleUrl("");
    state.clip.setSelectedSubtitleLang("自配平台转写（中文）");

    shell.renderReadingView();

    expect(metaNode().textContent).toBe("UP主：晓舟报告");
  });

  it("无字幕字段：只有作者时单行", () => {
    state.clip.setAuthor("硅谷101");
    state.clip.setSubtitles([]);
    state.clip.setSelectedSubtitleId("");
    state.clip.setSelectedSubtitleUrl("");
    state.clip.setSelectedSubtitleLang("");

    shell.renderReadingView();

    expect(metaNode().textContent).toBe("UP主：硅谷101");
  });

  it("分P 无标题：只留 P{n}，不出现裸冒号", () => {
    state.clip.setPageCount(2);
    state.clip.setPageIndex(2);
    state.clip.setPageTitle("");
    selectTrack({ id: "s1", lan: "zh-CN", lanDoc: "中文", subtitleUrl: "u1" });

    shell.renderReadingView();

    expect(metaNode().textContent).toBe("P2");
  });

  it("无作者的多P：分P行独占整块，不落空首行", () => {
    state.clip.setPageCount(4);
    state.clip.setPageIndex(3);
    state.clip.setPageTitle("第三话");

    shell.renderReadingView();

    expect(metaNode().textContent).toBe("P3：第三话");
  });

  it("单P（pageCount <= 1）：不显示分P", () => {
    state.clip.setAuthor("硅谷101");
    state.clip.setPageCount(1);
    state.clip.setPageIndex(1);
    state.clip.setPageTitle("唯一P");
    selectTrack({ id: "s1", lan: "zh-CN", lanDoc: "中文", subtitleUrl: "u1" });

    shell.renderReadingView();

    expect(metaNode().textContent).toBe("UP主：硅谷101");
  });

  it("无作者且无其余字段：整块 hidden（header 不留空行）", () => {
    state.clip.setAuthor("");
    state.clip.setSubtitles([]);
    state.clip.setSelectedSubtitleLang("");

    shell.renderReadingView();

    expect(metaNode().textContent).toBe("");
    expect(metaNode().hidden).toBe(true);
  });

  it("空态回到有内容：hidden 复位", () => {
    state.clip.setAuthor("");
    state.clip.setSubtitles([]);
    state.clip.setSelectedSubtitleLang("");
    shell.renderReadingView();

    state.clip.setAuthor("硅谷101");
    shell.renderReadingView();

    expect(metaNode().hidden).toBe(false);
    expect(metaNode().textContent).toBe("UP主：硅谷101");
  });

  it("真实模板初始态：meta 为空且 hidden（不再预置 bilibili.com）", async () => {
    const { buildUiHtml } = await import("../../extension/ui/ui-renderer.js");
    document.body.innerHTML = buildUiHtml();

    const templateMeta = document.getElementById(ids.readingMeta) as HTMLElement;
    expect(templateMeta.textContent).toBe("");
    expect(templateMeta.hidden).toBe(true);
    expect(buildUiHtml()).not.toContain("bilibili.com");
  });
});
