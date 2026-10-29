import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {AUDIO} from "../../scripts/promo/audio.mjs";
import {CAPTIONS} from "../../scripts/promo/captions.mjs";
import {OUTRO_TIMELINE} from "../../scripts/promo/outro-timeline.mjs";
import {APPEARANCE_SHOTS, PANEL_FOCUS_HANDOFFS, SCENES} from "../../scripts/promo/timeline.mjs";

const providerModulePath = "../../scripts/promo/video/ProviderScene";
const scenesFilePath = "scripts/promo/video/scenes.tsx";

describe("面板失焦接续与后半程真实痛点镜头", () => {
  it("在金句→对话→无字幕与导出→联网搜索→四主题阅读之间保留六帧退场、干净切点和七帧合焦", () => {
    expect(PANEL_FOCUS_HANDOFFS).toEqual([
      {from: "overview", to: "chat", at: 390, exitFrames: 6, enterFrames: 7, maxBlur: 12},
      {from: "chat", to: "subtools", at: 570, exitFrames: 6, enterFrames: 7, maxBlur: 12},
      {from: "subtools", to: "websearch", at: 675, exitFrames: 6, enterFrames: 7, maxBlur: 12},
      {from: "websearch", to: "appearance", at: 750, exitFrames: 6, enterFrames: 7, maxBlur: 12}
    ]);
    for (const handoff of PANEL_FOCUS_HANDOFFS) {
      const outgoing = SCENES.find((scene) => scene.id === handoff.from)!;
      const incoming = SCENES.find((scene) => scene.id === handoff.to)!;
      expect(outgoing.from + outgoing.duration).toBe(handoff.at);
      expect(incoming.from).toBe(handoff.at);
    }
  });

  it("让退场声与合焦声分别落在转场两端", () => {
    const cues = AUDIO.cues.map((cue) => [cue.id, cue.frame, cue.src]);
    for (const handoff of PANEL_FOCUS_HANDOFFS) {
      expect(cues).toContainEqual([`${handoff.from}-defocus`, handoff.at - handoff.exitFrames, "media/sfx/click.wav"]);
      expect(cues).toContainEqual([`${handoff.to}-focus`, handoff.at + handoff.enterFrames, "media/sfx/whoosh.wav"]);
    }
    expect(cues).not.toContainEqual(["chat-cut", 390, "media/sfx/whoosh.wav"]);
    expect(cues).not.toContainEqual(["subtools-cut", 570, "media/sfx/whoosh.wav"]);
    expect(cues).not.toContainEqual(["websearch-cut", 675, "media/sfx/whoosh.wav"]);
    expect(cues).not.toContainEqual(["appearance-cut", 750, "media/sfx/whoosh.wav"]);
  });

  it("把真痛点功能配真实画面提至 19s 后，移除设置面板与片尾纯文字闪卡，且文案严格遵循功能边界", async () => {
    const providerMod = await import(providerModulePath);
    expect(OUTRO_TIMELINE.features).toEqual([]);
    expect(APPEARANCE_SHOTS.map((shot) => shot.id)).toEqual([
      "flyme-light",
      "flyme-dark",
      "editorial-light",
      "editorial-dark"
    ]);
    const allCaptionTexts = CAPTIONS.map((item) => item.text).join(" ");
    expect(allCaptionTexts).toContain("免费语音转写");
    expect(allCaptionTexts).toContain("双语对照");
    expect(allCaptionTexts).toContain("复制 Markdown");
    expect(allCaptionTexts).not.toContain("笔记");
    expect(allCaptionTexts).toContain("UP 主说得对不对？AI 联网检索辅助核对");
    expect(allCaptionTexts).toContain("超纲概念背景补充");
    expect(allCaptionTexts).not.toContain("内置");
    expect(allCaptionTexts).not.toContain("预设");
    expect(allCaptionTexts).not.toContain("自定义端点");

    expect(providerMod.PROVIDER_HEADLINE).toBe("接入你顺手的 AI 大脑");
    expect(providerMod.PROVIDER_SUBHEADLINE).toBe("支持切换 DeepSeek、Kimi、Qwen 等 14+ 平台，亦支持本地模型");
    expect(`${providerMod.PROVIDER_BENEFIT_TAG} ${providerMod.PROVIDER_HEADLINE} ${providerMod.PROVIDER_SUBHEADLINE}`).not.toContain("内置");
    expect(`${providerMod.PROVIDER_BENEFIT_TAG} ${providerMod.PROVIDER_HEADLINE} ${providerMod.PROVIDER_SUBHEADLINE}`).not.toContain("预设");
    expect(`${providerMod.PROVIDER_BENEFIT_TAG} ${providerMod.PROVIDER_HEADLINE} ${providerMod.PROVIDER_SUBHEADLINE}`).not.toContain("自定义端点");

    const scenesSource = readFileSync(scenesFilePath, "utf8");
    expect(scenesSource).not.toContain("appearance.mp4");
    expect(scenesSource).not.toContain("笔记");
    expect(scenesSource).not.toContain("权威");
    expect(scenesSource).not.toContain("查证属实");
    expect(scenesSource).not.toContain("完全一致");
  });
});
