import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {OVERVIEW_TIMELINE, SCENES} from "../../scripts/promo/timeline.mjs";

const overviewModulePath = "../../scripts/promo/video/OverviewScene";
const overviewFilePath = "scripts/promo/video/OverviewScene.tsx";

describe("首幕：TL;DR 与章节时间戳、点章节跳播、点金句生成分享卡", () => {
  it("导出主标题、TL;DR、2 个章节与金句，章节和金句均保留", async () => {
    const mod = await import(overviewModulePath);
    expect(mod.OVERVIEW_HEADLINE).toBe("48 分钟公开课，\n3 秒提炼脉络与结论");
    expect(mod.OVERVIEW_TLDR.bold).toContain("接得上、对得齐");
    expect(mod.OVERVIEW_CHAPTERS.map((chapter: {timestamp: string}) => chapter.timestamp)).toEqual(["00:00", "02:32"]);

    const source = readFileSync(overviewFilePath, "utf8");
    expect(source).toContain("VideoReferenceCard");
    expect(source).toContain("BottomLectureCaption");
    expect(source).toContain("分享金句卡片");
  });

  it("首幕从 0 帧开始，按 TL;DR → 章节 → 点章节跳播 → 点金句分享卡排布，且在镜头内收束", () => {
    expect(SCENES[0]).toMatchObject({id: "overview", from: 0, duration: OVERVIEW_TIMELINE.duration});
    expect(SCENES[1]).toMatchObject({id: "subtitle", from: OVERVIEW_TIMELINE.duration});
    const {tldrAt, chaptersAt, chapterClickAt, chapterSeekFrames, quoteClickAt, quoteStartAt, quoteLiftFrames, duration} = OVERVIEW_TIMELINE;
    expect(tldrAt).toBeLessThan(chaptersAt);
    expect(chaptersAt).toBeLessThan(chapterClickAt);
    expect(chapterClickAt + chapterSeekFrames).toBeLessThan(quoteClickAt);
    expect(quoteClickAt).toBeLessThan(quoteStartAt);
    expect(quoteStartAt + quoteLiftFrames).toBeLessThan(duration);
  });

  it("金句分享卡抬升进度与原声字幕按金句起点计时", async () => {
    const mod = await import(overviewModulePath);
    const {quoteStartAt, duration} = OVERVIEW_TIMELINE;
    expect(mod.OVERVIEW_POLAROID_QUOTE).toContain("如果他不答，一定是零分！");
    expect(mod.OVERVIEW_QUOTE_START_FRAME).toBe(quoteStartAt);
    expect(mod.OVERVIEW_QUOTE_DURATION).toBe(duration - quoteStartAt);
    expect(mod.overviewQuoteLiftProgress(quoteStartAt)).toBe(0);
    expect(mod.overviewQuoteLiftProgress(quoteStartAt + 18)).toBe(1);
    expect(mod.overviewVoiceCaptionOpacityAtFrame(quoteStartAt - 1)).toBe(0);
    expect(mod.overviewVoiceCaptionOpacityAtFrame(quoteStartAt + 6)).toBe(1);

    const source = readFileSync(overviewFilePath, "utf8");
    expect(source).toContain('data-preset="mist-deep-sea"');
    expect(source).toContain('data-pattern="rays"');
  });
});