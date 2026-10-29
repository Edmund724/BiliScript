import {describe, expect, it} from "vitest";

const designModulePath = "../../scripts/promo/video/design";
const heroModulePath = "../../scripts/promo/video/HeroScene";

describe("宣传片公共原语与开场单句痛点钩子 (Ticket 01)", () => {
  it("导出当前 B 站视频参照窗/标题条与原片底部大号讲课字幕原语", async () => {
    const {VideoReferenceCard, BottomLectureCaption} = await import(designModulePath);
    expect(typeof VideoReferenceCard).toBe("function");
    expect(typeof BottomLectureCaption).toBe("function");
  });

  it("开场前 1.6–1.8 秒全屏居中仅展示 1 句核心痛点，且第 0 帧即 100% 不透明", async () => {
    const {
      HERO_PAIN_POINT,
      HERO_HOOK_HOLD_UNTIL_FRAME,
      HERO_PULLBACK_START,
      HERO_PULLBACK_END,
      HERO_CLICK_AT,
      HERO_SLOT_BEATS,
      heroBeatIndexAtFrame,
      heroHookOpacityAtFrame,
      heroSlotOpacityAtFrame
    } = await import(heroModulePath);
    expect(HERO_PAIN_POINT).toBe("1 小时干货长视频，还在收藏夹吃灰？");
    expect(HERO_HOOK_HOLD_UNTIL_FRAME).toBeGreaterThanOrEqual(48);
    expect(HERO_HOOK_HOLD_UNTIL_FRAME).toBeLessThanOrEqual(54);
    expect(HERO_PULLBACK_START).toBe(HERO_HOOK_HOLD_UNTIL_FRAME);
    expect(HERO_PULLBACK_END).toBeGreaterThan(HERO_PULLBACK_START);
    expect(HERO_CLICK_AT).toBeGreaterThanOrEqual(HERO_PULLBACK_START);

    expect(HERO_SLOT_BEATS).toHaveLength(1);
    expect(HERO_SLOT_BEATS[0].text).toBe("1 小时干货长视频，还在收藏夹吃灰？");
    expect(heroBeatIndexAtFrame(0)).toBe(0);
    expect(heroBeatIndexAtFrame(24)).toBe(0);
    expect(heroBeatIndexAtFrame(48)).toBe(0);

    expect(heroHookOpacityAtFrame(0)).toBe(1);
    expect(heroHookOpacityAtFrame(24)).toBe(1);
    expect(heroHookOpacityAtFrame(48)).toBe(1);
    expect(heroHookOpacityAtFrame(HERO_PULLBACK_END)).toBe(0);
    expect(heroSlotOpacityAtFrame(0)).toBe(1);
  });

  it("拉远展开文摘面板后呈现品牌结论 BiliScript · 在 B 站直接「读」视频", async () => {
    const {HERO_HEADLINE} = await import(heroModulePath);
    expect(HERO_HEADLINE).toBe("BiliScript · 在 B 站直接「读」视频");
  });
});
