import { describe, expect, it } from "vitest";
import { resolveInterpretSubtitleLines } from "../../extension/live/interpret-subtitle-lines.js";

describe("同声传译字幕分行", () => {
  it("自动模式按原文主要文字类别与目标语言决定行数，拉丁目标始终双语", () => {
    expect(resolveInterpretSubtitleLines("Hello world", "zh", "auto")).toEqual({
      showOriginal: true,
      showTranslation: true
    });
    expect(resolveInterpretSubtitleLines("你好，世界", "zh", "auto")).toEqual({
      showOriginal: false,
      showTranslation: true
    });
    expect(resolveInterpretSubtitleLines("こんにちは", "en", "auto")).toEqual({
      showOriginal: true,
      showTranslation: true
    });
    expect(resolveInterpretSubtitleLines("你好", "en", "auto")).toEqual({
      showOriginal: true,
      showTranslation: true
    });

    for (const [text, target] of [
      ["こんにちは", "ja"],
      ["안녕하세요", "ko"],
      ["Привет", "ru"],
      ["Γειά σου", "el"]
    ] as const) {
      expect(resolveInterpretSubtitleLines(text, target, "auto")).toEqual({
        showOriginal: false,
        showTranslation: true
      });
    }
    expect(resolveInterpretSubtitleLines("Hello", "ru", "auto").showOriginal).toBe(true);
    expect(resolveInterpretSubtitleLines("Привет", "el", "auto").showOriginal).toBe(true);
    expect(resolveInterpretSubtitleLines("日本語字幕です", "ja", "auto")).toEqual({
      showOriginal: false,
      showTranslation: true
    });
  });

  it("仅译文始终一行，双语始终两行", () => {
    for (const [text, target] of [["你好", "zh"], ["Hello", "en"]] as const) {
      expect(resolveInterpretSubtitleLines(text, target, "translation")).toEqual({
        showOriginal: false,
        showTranslation: true
      });
      expect(resolveInterpretSubtitleLines(text, target, "bilingual")).toEqual({
        showOriginal: true,
        showTranslation: true
      });
    }
  });
});
