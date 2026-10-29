import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";

const overviewModulePath = "../../scripts/promo/video/OverviewScene";
const overviewFilePath = "scripts/promo/video/OverviewScene.tsx";

describe("概览镜头真实章节与金句分享录屏", () => {
  it("保留用户场景主标题与视频参照元数据，使用真实章节和金句分享录屏", async () => {
    const mod = await import(overviewModulePath);
    expect(mod.OVERVIEW_HEADLINE).toBe("48 分钟长视频，\n3 秒提炼章节脉络与金句。");
    expect(mod.OVERVIEW_VIDEO_REFERENCE).toEqual({
      headerText: "正在阅读：复旦赵斌《大模型公开课》48:16",
      badgeText: "复旦赵斌 · 48:16 公开课",
      captionTimestamp: "02:32",
      captionQuote: "“如果他不答，一定是零分！”"
    });

    const source = readFileSync(overviewFilePath, "utf8");
    expect(source).toContain("overview-04-chapters.mp4");
    expect(source).toContain("overview-04-quote.mp4");
    expect(source).toContain("OffthreadVideo");
    expect(source).toContain("VideoReferenceCard");
    expect(source).toContain("BottomLectureCaption");
    expect(source).not.toContain("生成金句卡");
    expect(source).not.toContain("QuotePolaroid");
  });

  it("将 165 帧（5.5 秒）镜头拆分为前 2.8 秒（84 帧）章节阅读与后 2.7 秒（81 帧）金句分享，且章节阶段隐藏底部原声字幕", async () => {
    const {
      OVERVIEW_CHAPTER_DURATION,
      OVERVIEW_QUOTE_DURATION,
      OVERVIEW_QUOTE_START_FRAME,
      overviewChapterDuration,
      overviewQuoteDuration,
      overviewPhaseAtFrame,
      overviewVoiceCaptionOpacityAtFrame
    } = await import(overviewModulePath);

    expect(OVERVIEW_CHAPTER_DURATION).toBe(84);
    expect(OVERVIEW_QUOTE_START_FRAME).toBe(84);
    expect(OVERVIEW_QUOTE_DURATION).toBe(81);
    expect(overviewChapterDuration(165)).toBe(84);
    expect(overviewQuoteDuration(165)).toBe(81);

    expect(overviewPhaseAtFrame(0, 165)).toBe("chapters");
    expect(overviewPhaseAtFrame(42, 165)).toBe("chapters");
    expect(overviewPhaseAtFrame(83, 165)).toBe("chapters");
    expect(overviewPhaseAtFrame(84, 165)).toBe("quote");
    expect(overviewPhaseAtFrame(120, 165)).toBe("quote");
    expect(overviewPhaseAtFrame(164, 165)).toBe("quote");

    expect(overviewVoiceCaptionOpacityAtFrame(0, 165)).toBe(0);
    expect(overviewVoiceCaptionOpacityAtFrame(83, 165)).toBe(0);
    expect(overviewVoiceCaptionOpacityAtFrame(92, 165)).toBe(1);
  });

  it("后 2.7 秒从真实金句列表推进到分享弹窗，不重绘产品界面", () => {
    const source = readFileSync(overviewFilePath, "utf8");
    expect(source).toContain("startFrom={45}");
    expect(source).toContain("playbackRate={1.2}");
    expect(source).toContain("QUOTE_MODAL_CROP_Y");
    expect(source).not.toContain("PaperGrainOverlay");
    expect(source).not.toContain("ReadingLampBeam");
  });
});
