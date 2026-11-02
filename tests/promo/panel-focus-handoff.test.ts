import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {AUDIO} from "../../scripts/promo/audio.mjs";
import {CAPTIONS} from "../../scripts/promo/captions.mjs";
import {OUTRO_TIMELINE} from "../../scripts/promo/outro-timeline.mjs";
import {PANEL_FOCUS_HANDOFFS, SCENES} from "../../scripts/promo/timeline.mjs";

const providerModulePath = "../../scripts/promo/video/ProviderScene";
const subtitleModulePath = "../../scripts/promo/video/SubtitleScene";
const scenesFilePath = "scripts/promo/video/scenes.tsx";

describe("面板失焦接续与叙事动线重排", () => {
  it("按 overview → subtools → websearch → subtitle+chat → providers → outro 排布，subtools→websearch 保留失焦合焦接续", () => {
    expect(SCENES.map((scene) => [scene.id, scene.from, scene.duration])).toEqual([
      ["overview", 0, 330],
      ["subtools", 330, 105],
      ["websearch", 435, 105],
      ["subtitle", 540, 120],
      ["chat", 660, 165],
      ["providers", 825, 75],
      ["outro", 900, 105]
    ]);
    expect(PANEL_FOCUS_HANDOFFS).toEqual([
      {from: "subtools", to: "websearch", at: 435, exitFrames: 6, enterFrames: 7, maxBlur: 12}
    ]);
    for (const handoff of PANEL_FOCUS_HANDOFFS) {
      const outgoing = SCENES.find((scene) => scene.id === handoff.from)!;
      const incoming = SCENES.find((scene) => scene.id === handoff.to)!;
      expect(outgoing.from + outgoing.duration).toBe(handoff.at);
      expect(incoming.from).toBe(handoff.at);
    }
  });

  it("让退场声与合焦声分别落在 subtools→websearch 转场两端", () => {
    const cues = AUDIO.cues.map((cue) => [cue.id, cue.frame, cue.src]);
    for (const handoff of PANEL_FOCUS_HANDOFFS) {
      expect(cues).toContainEqual([`${handoff.from}-defocus`, handoff.at - handoff.exitFrames, "media/sfx/click.wav"]);
      expect(cues).toContainEqual([`${handoff.to}-focus`, handoff.at + handoff.enterFrames, "media/sfx/whoosh.wav"]);
    }
    expect(cues).toContainEqual(["subtools-cut", 330, "media/sfx/whoosh.wav"]);
    expect(cues).not.toContainEqual(["websearch-cut", 435, "media/sfx/whoosh.wav"]);
  });

  it("移除四款主题场景与设置面板，subtitle 与 chat 共用“复习与回溯原话”故事线标题，且文案严格遵循功能边界", async () => {
    const providerMod = await import(providerModulePath);
    const subtitleMod = await import(subtitleModulePath);
    expect(OUTRO_TIMELINE.features).toEqual([]);
    expect(SCENES.some((scene) => scene.id === "appearance")).toBe(false);
    expect(subtitleMod.REVIEW_STORYLINE_TITLE).toBe("复习与回溯原话");

    const captionTexts = CAPTIONS.map((item) => item.text);
    expect(captionTexts).toContain("视频没开字幕？");
    expect(captionTexts).toContain("免费转写，一键复制导出。");
    expect(captionTexts.join(" ")).not.toContain("四款主题");
    expect(captionTexts.join(" ")).not.toContain("双语");
    expect(captionTexts.join(" ")).not.toContain("中英双轨");
    expect(captionTexts.join(" ")).not.toContain("笔记");
    expect(captionTexts).toContain("视频里提的新概念？");
    expect(captionTexts).toContain("AI 联网搜背景，附来源链接。");
    expect(captionTexts.join(" ")).not.toContain("查证属实");
    expect(captionTexts.join(" ")).not.toContain("内置");
    expect(captionTexts.join(" ")).not.toContain("预设");
    expect(captionTexts.join(" ")).not.toContain("自定义端点");

    expect(providerMod.PROVIDER_HEADLINE).toBe("接入你顺手的 AI 大脑");
    expect(providerMod.PROVIDER_SUBHEADLINE).toBe("支持切换 DeepSeek、Kimi、Qwen 等 14+ 平台，亦支持本地模型");
    expect(`${providerMod.PROVIDER_BENEFIT_TAG} ${providerMod.PROVIDER_HEADLINE} ${providerMod.PROVIDER_SUBHEADLINE}`).not.toContain("内置");
    expect(`${providerMod.PROVIDER_BENEFIT_TAG} ${providerMod.PROVIDER_HEADLINE} ${providerMod.PROVIDER_SUBHEADLINE}`).not.toContain("预设");
    expect(`${providerMod.PROVIDER_BENEFIT_TAG} ${providerMod.PROVIDER_HEADLINE} ${providerMod.PROVIDER_SUBHEADLINE}`).not.toContain("自定义端点");

    const scenesSource = readFileSync(scenesFilePath, "utf8");
    expect(scenesSource).toContain("REVIEW_STORYLINE_TITLE");
    expect(scenesSource).not.toContain("AppearanceScene");
    expect(scenesSource).not.toContain("appearance.mp4");
    expect(scenesSource).not.toContain("笔记");
    expect(scenesSource).not.toContain("权威");
    expect(scenesSource).not.toContain("查证属实");
    expect(scenesSource).not.toContain("完全一致");
  });
});
