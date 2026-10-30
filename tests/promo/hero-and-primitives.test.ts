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

  it("hero 字幕按两行大字 + 一行小字重切，时间码落在 0–5 秒内", async () => {
    const {CAPTIONS} = await import("../../scripts/promo/captions.mjs");
    expect(CAPTIONS.filter((caption: {sceneId: string}) => caption.sceneId === "hero")).toEqual([
      {sceneId: "hero", text: "点一下播放器，", startMs: 0, endMs: 1000, timestampMs: null, confidence: null},
      {sceneId: "hero", text: "整期视频自动读完。", startMs: 1000, endMs: 2100, timestampMs: null, confidence: null},
      {sceneId: "hero", text: "TL;DR · 分节要点 · 时间戳", startMs: 2100, endMs: 5000, timestampMs: null, confidence: null}
    ]);
  });

  it("整条字幕轨与九镜画面文案逐条一致，镜内不重叠、镜界首条对齐、非原声条目不超过 10 字/秒（品牌专名除外）", async () => {
    const {CAPTIONS} = await import("../../scripts/promo/captions.mjs");
    const {AUDIO} = await import("../../scripts/promo/audio.mjs");
    const {PROMO_FPS, SCENES} = await import("../../scripts/promo/timeline.mjs");

    const toMs = (frame: number) => Math.round((frame / PROMO_FPS) * 1000);
    const voiceWindows = AUDIO.voices.map((voice: {frame: number; durationFrames?: number}) => ({
      startMs: toMs(voice.frame),
      endMs: toMs(voice.frame + (voice.durationFrames ?? 40))
    }));
    const isVoice = (caption: {startMs: number; endMs: number}) =>
      voiceWindows.some((window: {startMs: number; endMs: number}) => window.startMs === caption.startMs && window.endMs === caption.endMs);
    const isBrandName = (caption: {text: string}) => caption.text === "BiliScript";
    const visibleChars = (text: string) => [...text.matchAll(/[\p{L}\p{N}]/gu)].length;
    const charsPerSecond = (caption: {text: string; startMs: number; endMs: number}) =>
      visibleChars(caption.text) / ((caption.endMs - caption.startMs) / 1000);

    expect(CAPTIONS.map((caption: {text: string}) => caption.text)).toEqual([
      "点一下播放器，",
      "整期视频自动读完。",
      "TL;DR · 分节要点 · 时间戳",
      "记得 UP 主提过那句话？搜词秒跳那一秒。",
      "……也很难避免幻觉。",
      "48 分钟长视频，",
      "3 秒提炼章节脉络与金句。",
      "如果他不答，一定是零分！",
      "带着问题追问视频，",
      "点按时间戳让 UP 主亲自举证。",
      "这里有一个研究……",
      "没字幕的视频，",
      "整段转成文字。",
      "中英双轨，",
      "逐句对照着看。",
      "UP 主说得对不对？",
      "AI 联网检索辅助核对。",
      "蓝雾玻璃或纸质刊物，四款主题日夜皆宜。",
      "接入你顺手的 AI 大脑",
      "BiliScript",
      "在 B 站，读下一条视频。",
      "搜原话 · 读章节 · 问依据"
    ]);

    let previousEnd = 0;
    for (const caption of CAPTIONS) {
      const scene = SCENES.find((candidate) => candidate.id === caption.sceneId);
      if (!scene) throw new Error(`未知镜头：${caption.sceneId}`);
      expect(caption.startMs).toBeGreaterThanOrEqual(toMs(scene.from));
      expect(caption.endMs).toBeLessThanOrEqual(toMs(scene.from + scene.duration));
      expect(caption.startMs).toBeGreaterThanOrEqual(previousEnd);
      expect(charsPerSecond(caption)).toBeLessThanOrEqual(isBrandName(caption) ? 20 : 10);
      previousEnd = caption.endMs;
    }

    for (const scene of SCENES) {
      const inScene = CAPTIONS.filter((caption) => caption.sceneId === scene.id);
      expect(inScene.length).toBeGreaterThan(0);
      expect(inScene[0].startMs).toBe(toMs(scene.from));
      const last = inScene[inScene.length - 1];
      if (!isVoice(last)) expect(last.endMs).toBe(toMs(scene.from + scene.duration));
    }

    for (const window of voiceWindows) {
      expect(CAPTIONS.some((caption) => caption.startMs === window.startMs && caption.endMs === window.endMs)).toBe(true);
    }

    const voiceTailScenes = SCENES.filter((scene) => {
      const inScene = CAPTIONS.filter((caption) => caption.sceneId === scene.id);
      const last = inScene[inScene.length - 1];
      return isVoice(last) && last.endMs < toMs(scene.from + scene.duration);
    });
    expect(voiceTailScenes.map((scene) => scene.id)).toEqual(["subtitle", "overview", "chat"]);

    expect(CAPTIONS.filter((caption) => !isVoice(caption) && !isBrandName(caption) && charsPerSecond(caption) > 8).map((caption) => caption.text)).toEqual([
      "记得 UP 主提过那句话？搜词秒跳那一秒。",
      "蓝雾玻璃或纸质刊物，四款主题日夜皆宜。"
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
