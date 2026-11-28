import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import { normalizeSettings, normalizeSettingsPatch } from "../../extension/core/settings-store.js";
import {
  MAX_AI_SYSTEM_PROMPT_BYTES,
  MAX_SUBTITLE_TRANSLATE_GLOSSARY_BYTES,
  normalizeAiSystemPrompt,
  normalizeSubtitleTranslateGlossary
} from "../../extension/core/validators.js";
import { applyPlayerAiQuickActionDefaultOnMigration } from "../../extension/entry/settings-migration.js";

const SYNC_QUOTA_BYTES_PER_ITEM = 8192;
const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

function assertValidUtf8Boundary(text: string): void {
  const bytes = new TextEncoder().encode(text);
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  expect(decoded).toBe(text);
  expect(text).not.toContain("\uFFFD");
  expect(/[\uD800-\uDFFF]/.test(text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""))).toBe(false);
}

describe("settings sync 单键 8KB 守卫", () => {
  it("initializeSettingsStorage 全量写回键面：每键序列化体积低于 sync 单键上限", () => {
    const syncCurrent = { ...DEFAULT_SETTINGS };
    applyPlayerAiQuickActionDefaultOnMigration(syncCurrent);
    const payload = normalizeSettings({ ...DEFAULT_SETTINGS, ...syncCurrent });

    for (const [key, value] of Object.entries(payload)) {
      const size = utf8Bytes(key) + utf8Bytes(JSON.stringify(value));
      expect(size, `sync 键 ${key} 序列化体积 ${size}B 超过 8KB 上限`).toBeLessThanOrEqual(
        SYNC_QUOTA_BYTES_PER_ITEM
      );
    }
  });

  it("aiSystemPrompt 与 subtitleTranslateGlossary 超长中文与 Emoji 输入截断至 <= 4096 UTF-8 字节且无半字符乱码", () => {
    const mixedInput = "中文提示词🚀字幕术语😀".repeat(600);
    expect(utf8Bytes(mixedInput)).toBeGreaterThan(MAX_AI_SYSTEM_PROMPT_BYTES * 2);

    const validatedPrompt = normalizeAiSystemPrompt(mixedInput);
    expect(utf8Bytes(validatedPrompt)).toBeLessThanOrEqual(MAX_AI_SYSTEM_PROMPT_BYTES);
    expect(utf8Bytes(validatedPrompt)).toBeGreaterThan(MAX_AI_SYSTEM_PROMPT_BYTES - 8);
    assertValidUtf8Boundary(validatedPrompt);

    const validatedGlossary = normalizeSubtitleTranslateGlossary(mixedInput);
    expect(utf8Bytes(validatedGlossary)).toBeLessThanOrEqual(MAX_SUBTITLE_TRANSLATE_GLOSSARY_BYTES);
    expect(utf8Bytes(validatedGlossary)).toBeGreaterThan(MAX_SUBTITLE_TRANSLATE_GLOSSARY_BYTES - 8);
    assertValidUtf8Boundary(validatedGlossary);

    const stored = normalizeSettings({
      ...DEFAULT_SETTINGS,
      aiSystemPrompt: mixedInput,
      subtitleTranslateGlossary: mixedInput
    });
    expect(utf8Bytes(stored.aiSystemPrompt)).toBeLessThanOrEqual(MAX_AI_SYSTEM_PROMPT_BYTES);
    expect(utf8Bytes(stored.subtitleTranslateGlossary)).toBeLessThanOrEqual(MAX_SUBTITLE_TRANSLATE_GLOSSARY_BYTES);
    assertValidUtf8Boundary(stored.aiSystemPrompt);
    assertValidUtf8Boundary(stored.subtitleTranslateGlossary);

    const patched = normalizeSettingsPatch({
      aiSystemPrompt: mixedInput,
      subtitleTranslateGlossary: mixedInput
    });
    expect(utf8Bytes(patched.aiSystemPrompt!)).toBeLessThanOrEqual(MAX_AI_SYSTEM_PROMPT_BYTES);
    expect(utf8Bytes(patched.subtitleTranslateGlossary!)).toBeLessThanOrEqual(MAX_SUBTITLE_TRANSLATE_GLOSSARY_BYTES);
    expect(
      utf8Bytes("aiSystemPrompt") + utf8Bytes(JSON.stringify(patched.aiSystemPrompt))
    ).toBeLessThan(SYNC_QUOTA_BYTES_PER_ITEM);
    expect(
      utf8Bytes("subtitleTranslateGlossary") + utf8Bytes(JSON.stringify(patched.subtitleTranslateGlossary))
    ).toBeLessThan(SYNC_QUOTA_BYTES_PER_ITEM);
  });
});
