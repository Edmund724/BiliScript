// 默认提示词及其各代 legacy 迁移断言与归一化测试
// 确保：
// 1. 导出键面完整；
// 2. legacy 到当前默认的迁移映射与自定义提示词保持原样；
// 3. 快捷提示词归一化与条数限制正确生效。

import { describe, expect, it } from "vitest";
import * as defaultPrompts from "../../extension/core/default-prompts.js";
import {
  DEFAULT_AI_SYSTEM_PROMPT,
  DEFAULT_PLAYER_AI_QUICK_PROMPT,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V2,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V3,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V4,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V5,
  LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT,
  LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT_V2,
  LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT_V3
} from "../../extension/core/default-prompts.js";
import {
  normalizeAiInitialQuickPrompts,
  normalizeAiSystemPrompt,
  normalizePlayerAiQuickPrompt
} from "../../extension/core/validators.js";

describe("default-prompts 键面契约", () => {
  it("导出的键面完整且未增减", () => {
    const expectedKeys = [
      "DEFAULT_AI_SYSTEM_PROMPT",
      "DEFAULT_INITIAL_QUICK_PROMPTS",
      "DEFAULT_PLAYER_AI_QUICK_PROMPT",
      "LEGACY_DEFAULT_AI_SYSTEM_PROMPT",
      "LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V2",
      "LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V3",
      "LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V4",
      "LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V5",
      "LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT",
      "LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT_V2",
      "LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT_V3",
      "MAX_INITIAL_QUICK_PROMPTS"
    ].sort();
    const actualKeys = Object.keys(defaultPrompts).sort();
    expect(actualKeys).toEqual(expectedKeys);
  });
});

describe("提示词迁移映射与归一化断言", () => {
  it("normalizePlayerAiQuickPrompt 迁移与回落", () => {
    expect(normalizePlayerAiQuickPrompt(LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT)).toBe(DEFAULT_PLAYER_AI_QUICK_PROMPT);
    expect(normalizePlayerAiQuickPrompt(LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT_V2)).toBe(DEFAULT_PLAYER_AI_QUICK_PROMPT);
    expect(normalizePlayerAiQuickPrompt(LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT_V3)).toBe(DEFAULT_PLAYER_AI_QUICK_PROMPT);
    expect(normalizePlayerAiQuickPrompt("")).toBe(DEFAULT_PLAYER_AI_QUICK_PROMPT);
    expect(normalizePlayerAiQuickPrompt("   ")).toBe(DEFAULT_PLAYER_AI_QUICK_PROMPT);
    expect(normalizePlayerAiQuickPrompt(null)).toBe(DEFAULT_PLAYER_AI_QUICK_PROMPT);
    expect(normalizePlayerAiQuickPrompt(undefined)).toBe(DEFAULT_PLAYER_AI_QUICK_PROMPT);
    expect(normalizePlayerAiQuickPrompt("用户自定义快捷提示词")).toBe("用户自定义快捷提示词");
  });

  it("normalizeAiSystemPrompt 迁移与回落", () => {
    expect(normalizeAiSystemPrompt(LEGACY_DEFAULT_AI_SYSTEM_PROMPT)).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(normalizeAiSystemPrompt(LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V2)).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(normalizeAiSystemPrompt(LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V3)).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(normalizeAiSystemPrompt(LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V4)).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(normalizeAiSystemPrompt(LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V5)).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(normalizeAiSystemPrompt("")).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(normalizeAiSystemPrompt("   ")).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(normalizeAiSystemPrompt(null)).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(normalizeAiSystemPrompt(undefined)).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(normalizeAiSystemPrompt("自定义系统提示词")).toBe("自定义系统提示词");
  });

  it("normalizeAiInitialQuickPrompts 归一化与条数限制", () => {
    expect(normalizeAiInitialQuickPrompts([])).toEqual([]);
    expect(normalizeAiInitialQuickPrompts(null)).toEqual([]);
    expect(normalizeAiInitialQuickPrompts([" 问题1 ", "", "  问题2  ", "问题3", "问题4"])).toEqual([
      "问题1",
      "问题2",
      "问题3"
    ]);
  });
});
