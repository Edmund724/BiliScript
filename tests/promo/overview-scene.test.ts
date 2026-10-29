import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";

const overviewModulePath = "../../scripts/promo/video/OverviewScene";
const overviewFilePath = "scripts/promo/video/OverviewScene.tsx";

describe("概览镜头「左讲功能、右看案例」与 2.6 秒章节脉络主角化 (Ticket 03)", () => {
  it("导出用户场景主标题与当前 B 站视频参照元数据，彻底移除课程议题标题", async () => {
    const mod = await import(overviewModulePath);
    expect(mod.OVERVIEW_HEADLINE).toBe("48 分钟长视频，\n3 秒提炼章节脉络与金句。");
    expect(mod.OVERVIEW_VIDEO_REFERENCE).toEqual({
      headerText: "正在阅读：复旦赵斌《大模型公开课》48:16",
      badgeText: "复旦赵斌 · 48:16 公开课",
      captionTimestamp: "02:32",
      captionQuote: "“如果他不答，一定是零分！”"
    });

    const source = readFileSync(overviewFilePath, "utf8");
    expect(source).not.toContain("AI 为什么爱犯幻觉？");
    expect(source).not.toContain("SpatialChapterStack");
    expect(source).not.toContain("VoiceWaveBar");
    expect(source).toContain("VideoReferenceCard");
    expect(source).toContain("BottomLectureCaption");
  });

  it("将 120 帧镜头拆分为前 2.6 秒（78 帧）章节脉络主角与后 1.4 秒（42 帧）金句拍立得成片", async () => {
    const {
      OVERVIEW_CHAPTER_DURATION,
      OVERVIEW_QUOTE_DURATION,
      OVERVIEW_QUOTE_START_FRAME,
      overviewChapterDuration,
      overviewQuoteDuration,
      overviewPhaseAtFrame
    } = await import(overviewModulePath);

    expect(OVERVIEW_CHAPTER_DURATION).toBe(78);
    expect(OVERVIEW_QUOTE_START_FRAME).toBe(78);
    expect(OVERVIEW_QUOTE_DURATION).toBe(42);
    expect(overviewChapterDuration(120)).toBe(78);
    expect(overviewQuoteDuration(120)).toBe(42);

    expect(overviewPhaseAtFrame(0, 120)).toBe("chapters");
    expect(overviewPhaseAtFrame(36, 120)).toBe("chapters");
    expect(overviewPhaseAtFrame(77, 120)).toBe("chapters");
    expect(overviewPhaseAtFrame(78, 120)).toBe("quote");
    expect(overviewPhaseAtFrame(96, 120)).toBe("quote");
    expect(overviewPhaseAtFrame(119, 120)).toBe("quote");
  });

  it("后 1.4 秒直接平滑抬升定格单张 3D 拍立得金句成片卡，移除三次换色快门与 6×6 选项网格", async () => {
    const mod = await import(overviewModulePath);
    expect(mod.OVERVIEW_POLAROID_QUOTE).toContain("如果他不答，一定是零分！");
    expect(mod.overviewQuoteLiftProgress(78)).toBe(0);
    expect(mod.overviewQuoteLiftProgress(96)).toBe(1);
    expect(mod.overviewQuoteLiftProgress(114)).toBe(1);

    const source = readFileSync(overviewFilePath, "utf8");
    expect(source).not.toContain("PaletteSwatches");
    expect(source).not.toContain("modalPalettes");
    expect(source).not.toContain("无纹样");
    expect(source).not.toContain("等高线");
  });
});
