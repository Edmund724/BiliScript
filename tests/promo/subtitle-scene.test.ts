import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {SUBTITLE_DURATION, SUBTITLE_MATCH_FRAME} from "../../scripts/promo/subtitle-timeline.mjs";

const subtitleModulePath = "../../scripts/promo/video/SubtitleScene";
// jsdom 环境里 new URL(相对, import.meta.url) 会按文档地址解析，这里用 dirname 定位源文件
const subtitleSourcePath = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/promo/video/SubtitleScene.tsx");

describe("字幕镜头「搜词秒跳那一秒」场景大标题与底部原声字幕 (Ticket 02)", () => {
  it("顶部大标题直接点明用户场景与功能，不再使用课程内容提问", async () => {
    const {SUBTITLE_HEADLINE, subtitleHeadlineOpacityAtFrame} = await import(subtitleModulePath);
    expect(SUBTITLE_HEADLINE).toBe("记得 UP 主提过那句话？搜词秒跳那一秒。");
    expect(SUBTITLE_HEADLINE).not.toContain("记得老师提过");
    expect(subtitleHeadlineOpacityAtFrame(6)).toBe(1);
    expect(subtitleHeadlineOpacityAtFrame(45)).toBe(1);
    expect(subtitleHeadlineOpacityAtFrame(60)).toBe(1);
  });

  it("检索微距阶段仅聚焦搜索框输入「幻觉」与唯一 04:07 命中字幕行，移除无关上下文行与多余标签", async () => {
    const {
      SUBTITLE_SEARCH_QUERY,
      SUBTITLE_MATCHED_ROWS,
      subtitleTypedQueryAtFrame
    } = await import(subtitleModulePath);

    expect(SUBTITLE_SEARCH_QUERY).toBe("幻觉");
    expect(subtitleTypedQueryAtFrame(6)).toBe("");
    expect(subtitleTypedQueryAtFrame(14)).toBe("幻");
    expect(subtitleTypedQueryAtFrame(20)).toBe("幻觉");
    expect(subtitleTypedQueryAtFrame(60)).toBe("幻觉");

    expect(SUBTITLE_MATCHED_ROWS).toEqual([
      {
        timestamp: "04:07",
        prefix: "……也很难避免",
        keyword: "幻觉"
      }
    ]);

    const source = readFileSync(subtitleSourcePath, "utf8");
    expect(source).not.toContain("02:32");
    expect(source).not.toContain("04:28");
    expect(source).not.toContain("回车跳播");
    expect(source).not.toContain("点击时间戳跳播");
  });

  it("点击 04:07 后切入原片讲课画面并展示底部居中大号原片字幕，移除左上角悬浮声波条", async () => {
    const {
      SUBTITLE_BOTTOM_CAPTION,
      subtitleBottomCaptionOpacityAtFrame
    } = await import(subtitleModulePath);

    expect(SUBTITLE_BOTTOM_CAPTION).toEqual({
      timestamp: "04:07",
      speaker: "赵老师原声",
      quote: "“……也很难避免幻觉。”"
    });

    expect(subtitleBottomCaptionOpacityAtFrame(0, SUBTITLE_DURATION)).toBe(0);
    expect(subtitleBottomCaptionOpacityAtFrame(SUBTITLE_MATCH_FRAME, SUBTITLE_DURATION)).toBe(0);
    expect(subtitleBottomCaptionOpacityAtFrame(72, SUBTITLE_DURATION)).toBe(1);
    expect(subtitleBottomCaptionOpacityAtFrame(114, SUBTITLE_DURATION)).toBe(1);

    const source = readFileSync(subtitleSourcePath, "utf8");
    expect(source).toContain("BottomLectureCaption");
    expect(source).not.toContain("VoiceWaveBar");
  });
});
