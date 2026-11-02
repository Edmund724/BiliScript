import {describe, expect, it} from "vitest";

const designModulePath = "../../scripts/promo/video/design";

describe("宣传片公共原语与字幕轨", () => {
  it("导出当前 B 站视频参照窗/标题条与原片底部大号讲课字幕原语", async () => {
    const {VideoReferenceCard, BottomLectureCaption} = await import(designModulePath);
    expect(typeof VideoReferenceCard).toBe("function");
    expect(typeof BottomLectureCaption).toBe("function");
  });

  it("整条字幕轨与八镜画面文案逐条一致，镜内不重叠、镜界首条对齐、非原声条目不超过 10 字/秒（品牌专名除外）", async () => {
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
      "48 分钟公开课，",
      "3 秒提炼脉络与结论。",
      "点章节，直接跳播。",
      "点金句，生成分享卡。",
      "如果他不答，一定是零分！",
      "记得 UP 主提过那句话？搜词秒跳那一秒。",
      "……也很难避免幻觉。",
      "有疑问直接问视频，",
      "点时间戳直达原话。",
      "这里有一个研究……",
      "视频没开字幕？",
      "免费转写，一键复制导出。",
      "视频里提的新概念？",
      "AI 联网搜背景，附来源链接。",
      "蓝雾玻璃或纸质刊物，四款主题日夜皆宜。",
      "接入你顺手的 AI 大脑",
      "BiliScript",
      "在 B 站，读下一条视频。",
      "字幕转写 · 章节速览 · 溯源追问"
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
    expect(voiceTailScenes.map((scene) => scene.id)).toEqual(["overview", "subtitle", "chat"]);

    expect(CAPTIONS.filter((caption) => !isVoice(caption) && !isBrandName(caption) && charsPerSecond(caption) > 8).map((caption) => caption.text)).toEqual([
      "记得 UP 主提过那句话？搜词秒跳那一秒。",
      "蓝雾玻璃或纸质刊物，四款主题日夜皆宜。"
    ]);
  });
});
