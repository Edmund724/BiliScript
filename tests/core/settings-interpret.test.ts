import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import { normalizeSettings } from "../../extension/core/settings-store.js";

describe("同声传译字幕设置归一化", () => {
  it("默认中文自动模式，仅接受 14 种目标语言与三种显示模式", () => {
    expect(DEFAULT_SETTINGS.liveInterpretTargetLang).toBe("zh");
    expect(DEFAULT_SETTINGS.liveInterpretDisplayMode).toBe("auto");
    expect(normalizeSettings({}).liveInterpretTargetLang).toBe("zh");
    expect(normalizeSettings({}).liveInterpretDisplayMode).toBe("auto");

    for (const lang of ["zh", "en", "ja", "ko", "de", "fr", "es", "ru", "it", "pt", "tr", "el", "id", "ms"]) {
      expect(normalizeSettings({ liveInterpretTargetLang: lang }).liveInterpretTargetLang).toBe(lang);
    }
    for (const mode of ["auto", "translation", "bilingual"]) {
      expect(normalizeSettings({ liveInterpretDisplayMode: mode }).liveInterpretDisplayMode).toBe(mode);
    }

    expect(normalizeSettings({ liveInterpretTargetLang: "en-US" }).liveInterpretTargetLang).toBe("zh");
    expect(normalizeSettings({ liveInterpretDisplayMode: "original" }).liveInterpretDisplayMode).toBe("auto");
  });

  it("字幕翻译平台与模型默认内置免 Key Index-Translate，自定义与非法值按规归一化", () => {
    expect(DEFAULT_SETTINGS.subtitleTranslateProviderId).toBe("bilibili-index-translate");
    expect(DEFAULT_SETTINGS.subtitleTranslateModel).toBe("Index-Translate-35B-A3B");

    expect(normalizeSettings({}).subtitleTranslateProviderId).toBe("bilibili-index-translate");
    expect(normalizeSettings({}).subtitleTranslateModel).toBe("Index-Translate-35B-A3B");

    const indexCustomTier = normalizeSettings({
      subtitleTranslateProviderId: "bilibili-index-translate",
      subtitleTranslateModel: "index-translate-9b"
    });
    expect(indexCustomTier.subtitleTranslateProviderId).toBe("bilibili-index-translate");
    expect(indexCustomTier.subtitleTranslateModel).toBe("Index-Translate-9B");

    const indexUnknownModel = normalizeSettings({
      subtitleTranslateProviderId: "bilibili-index-translate",
      subtitleTranslateModel: "gpt-4o-mini"
    });
    expect(indexUnknownModel.subtitleTranslateModel).toBe("Index-Translate-35B-A3B");

    const custom = normalizeSettings({
      subtitleTranslateProviderId: "  provider-custom  ",
      subtitleTranslateModel: "  gpt-4o-mini  "
    });
    expect(custom.subtitleTranslateProviderId).toBe("provider-custom");
    expect(custom.subtitleTranslateModel).toBe("gpt-4o-mini");

    const customEmptyModel = normalizeSettings({
      subtitleTranslateProviderId: "provider-custom",
      subtitleTranslateModel: ""
    });
    expect(customEmptyModel.subtitleTranslateProviderId).toBe("provider-custom");
    expect(customEmptyModel.subtitleTranslateModel).toBe("");

    const fallback = normalizeSettings({
      subtitleTranslateProviderId: 12345,
      subtitleTranslateModel: null
    });
    expect(fallback.subtitleTranslateProviderId).toBe("bilibili-index-translate");
    expect(fallback.subtitleTranslateModel).toBe("Index-Translate-35B-A3B");
  });
});
