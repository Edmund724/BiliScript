import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";

const overviewModulePath = "../../scripts/promo/video/OverviewScene";
const overviewFilePath = "scripts/promo/video/OverviewScene.tsx";

describe("概览镜头局部放大双章节脉络与金句拍立得印证", () => {
  it("导出用户场景主标题、2 个局部放大章节卡片与视频参照元数据，移除密集 4 章节原片录屏墙", async () => {
    const mod = await import(overviewModulePath);
    expect(mod.OVERVIEW_HEADLINE).toBe("48 分钟长视频，\n3 秒提炼章节脉络与金句。");
    expect(mod.OVERVIEW_VIDEO_REFERENCE).toEqual({
      headerText: "正在阅读：复旦赵斌《大模型公开课》48:16",
      badgeText: "复旦赵斌 · 48:16 公开课",
      captionTimestamp: "02:32",
      captionQuote: "“如果他不答，一定是零分！”"
    });
    expect(mod.OVERVIEW_CHAPTERS).toHaveLength(2);
    expect(mod.OVERVIEW_CHAPTERS.map((chapter: {timestamp: string}) => chapter.timestamp)).toEqual(["00:00", "02:32"]);

    const source = readFileSync(overviewFilePath, "utf8");
    expect(source).not.toContain("AI 为什么爱犯幻觉？");
    expect(source).not.toContain("SpatialChapterStack");
    expect(source).not.toContain("VoiceWaveBar");
    expect(source).not.toContain("overview-04-chapters.mp4");
    expect(source).toContain("VideoReferenceCard");
    expect(source).toContain("BottomLectureCaption");
    expect(source).toContain("生成金句卡");
  });

  it("将 165 帧（5.5 秒）镜头拆分为前 2.8 秒（84 帧）双章节聚焦阅读与后 2.7 秒（81 帧）金句拍立得印证，且章节阶段隐藏底部原声字幕", async () => {
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

  it("后 2.7 秒从金句提炼栏平滑抬升定格单张 3D 拍立得金句成片卡，移除三次换色快门与 6×6 选项网格", async () => {
    const mod = await import(overviewModulePath);
    expect(mod.OVERVIEW_POLAROID_QUOTE).toContain("如果他不答，一定是零分！");
    expect(mod.overviewQuoteLiftProgress(84)).toBe(0);
    expect(mod.overviewQuoteLiftProgress(102)).toBe(1);
    expect(mod.overviewQuoteLiftProgress(150)).toBe(1);

    const source = readFileSync(overviewFilePath, "utf8");
    expect(source).not.toContain("PaletteSwatches");
    expect(source).not.toContain("modalPalettes");
    expect(source).not.toContain("无纹样");
    expect(source).not.toContain("等高线");
  });
});
