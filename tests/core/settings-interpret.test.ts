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

  it("字幕翻译平台与模型偏好缺省为空串，非法值自动归一化", () => {
    expect(DEFAULT_SETTINGS.subtitleTranslateProviderId).toBe("");
    expect(DEFAULT_SETTINGS.subtitleTranslateModel).toBe("");

    expect(normalizeSettings({}).subtitleTranslateProviderId).toBe("");
    expect(normalizeSettings({}).subtitleTranslateModel).toBe("");

    const custom = normalizeSettings({
      subtitleTranslateProviderId: "  provider-custom  ",
      subtitleTranslateModel: "  gpt-4o-mini  "
    });
    expect(custom.subtitleTranslateProviderId).toBe("provider-custom");
    expect(custom.subtitleTranslateModel).toBe("gpt-4o-mini");

    const fallback = normalizeSettings({
      subtitleTranslateProviderId: 12345,
      subtitleTranslateModel: null
    });
    expect(fallback.subtitleTranslateProviderId).toBe("");
    expect(fallback.subtitleTranslateModel).toBe("");
  });
});
