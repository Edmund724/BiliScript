import {describe, expect, it} from "vitest";

const designModulePath = "../../scripts/promo/video/design";
const heroModulePath = "../../scripts/promo/video/HeroScene";

describe("宣传片公共原语与开场槽位快切钩子 (Ticket 01)", () => {
  it("导出浅色全屏章节转场与原片底栏大号讲课字幕原语，并保留 VoiceWaveBar 兼容导出", async () => {
    const {
      ChapterInterstitial,
      ChapterTitleCard,
      LectureBottomCaption,
      LectureSubtitleBar,
      VoiceWaveBar
    } = await import(designModulePath);
    expect(typeof ChapterInterstitial).toBe("function");
    expect(ChapterTitleCard).toBe(ChapterInterstitial);
    expect(typeof LectureBottomCaption).toBe("function");
    expect(LectureSubtitleBar).toBe(LectureBottomCaption);
    expect(typeof VoiceWaveBar).toBe("function");
  });

  it("开场前 1.4 秒采用居中固定主干 + 三拍槽位快切，且第 0 帧即完整不透明", async () => {
    const {
      HERO_SLOT_BEATS,
      HERO_STEM,
      heroBeatIndexAtFrame,
      heroSlotOpacityAtFrame
    } = await import(heroModulePath);
    expect(HERO_STEM).toBe("看 B 站长视频 ——");
    expect(
      HERO_SLOT_BEATS.map((beat: {text: string; from: number; to: number}) => [beat.text, beat.from, beat.to])
    ).toEqual([
      ["收藏夹吃灰？", 0, 14],
      ["死活拖不到那秒？", 14, 28],
      ["想追问没人答？", 28, 42]
    ]);
    expect(heroBeatIndexAtFrame(0)).toBe(0);
    expect(heroBeatIndexAtFrame(6)).toBe(0);
    expect(heroBeatIndexAtFrame(18)).toBe(1);
    expect(heroBeatIndexAtFrame(36)).toBe(2);
    expect(heroSlotOpacityAtFrame(0)).toBe(1);
  });

  it("拉远展开文摘面板后呈现极简品牌主标 BiliScript · 直接「读」视频", async () => {
    const {HERO_HEADLINE} = await import(heroModulePath);
    expect(HERO_HEADLINE).toBe("BiliScript · 直接「读」视频");
  });
});
