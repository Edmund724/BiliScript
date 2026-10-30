import {describe, expect, it} from "vitest";

const designModulePath = "../../scripts/promo/video/design";
const heroModulePath = "../../scripts/promo/video/HeroScene";
const timelineModulePath = "../../scripts/promo/timeline.mjs";

describe("宣传片公共原语与开场一键总结", () => {
  it("导出当前 B 站视频参照窗/标题条与原片底部大号讲课字幕原语", async () => {
    const {VideoReferenceCard, BottomLectureCaption} = await import(designModulePath);
    expect(typeof VideoReferenceCard).toBe("function");
    expect(typeof BottomLectureCaption).toBe("function");
  });

  it("开场五拍落在 0–150 帧：鼠标进入、图标、点击、翻页、答案与推近", async () => {
    const {HERO_TIMELINE, SCENES} = await import(timelineModulePath);
    const hero = SCENES.find((scene: {id: string}) => scene.id === "hero");
    expect(hero).toMatchObject({from: 0, duration: 150});
    expect(HERO_TIMELINE).toEqual({
      firstLineAt: 2,
      iconAt: 24,
      clickAt: 41,
      pageTurnAt: 48,
      answerAt: 66,
      pushInFrom: 80,
      pushInTo: 116,
      holdAt: 132
    });
  });

  it("左栏两行大字与一行功能小字与 spec 文案一致", async () => {
    const {HERO_FIRST_LINE, HERO_SECOND_LINE, HERO_FEATURE_LINE} = await import(heroModulePath);
    expect(HERO_FIRST_LINE).toBe("点一下播放器，");
    expect(HERO_SECOND_LINE).toBe("整期视频自动读完。");
    expect(HERO_FEATURE_LINE).toBe("TL;DR · 分节要点 · 时间戳");
  });

  it("真实录屏的答案跳切点与素材源帧一一对应", async () => {
    const {HERO_SOURCE} = await import(heroModulePath);
    expect(HERO_SOURCE).toEqual({
      recording: "media/hero-hook.mp4",
      panelFrame: 43,
      promptFrame: 60,
      answerFrame: 309,
      answerPlaybackRate: 0.7
    });
  });

  it("hero 字幕按两行大字合并 + 一行小字重切，时间码落在 0–5 秒内", async () => {
    const {CAPTIONS} = await import("../../scripts/promo/captions.mjs");
    expect(CAPTIONS.filter((caption: {sceneId: string}) => caption.sceneId === "hero")).toEqual([
      {sceneId: "hero", text: "点一下播放器，整期视频自动读完。", startMs: 100, endMs: 2100, timestampMs: null, confidence: null},
      {sceneId: "hero", text: "TL;DR · 分节要点 · 时间戳", startMs: 2100, endMs: 5000, timestampMs: null, confidence: null}
    ]);
  });

  it("不再暴露旧痛点卡、品牌横幅与拉远节拍", async () => {
    const hero = await import(heroModulePath);
    for (const legacy of [
      "HERO_PAIN_POINT",
      "HERO_STEM",
      "HERO_HEADLINE",
      "HERO_SLOT_BEATS",
      "heroBeatIndexAtFrame",
      "heroHookOpacityAtFrame",
      "heroSlotOpacityAtFrame",
      "HERO_HOOK_HOLD_UNTIL_FRAME",
      "HERO_PULLBACK_START",
      "HERO_PULLBACK_END"
    ]) {
      expect(legacy in hero, legacy).toBe(false);
    }
  });
});
