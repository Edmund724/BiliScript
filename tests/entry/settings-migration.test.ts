import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import {
  applyPlayerAiQuickActionDefaultOnMigration,
  applySubtitleTranslateDefaultMigration
} from "../../extension/entry/settings-migration.js";

describe("AI 键默认开一次性迁移", () => {
  it("存量显式 false + 旗标未置位 → 改写回 true + 旗标置位", () => {
    const merged = { ...DEFAULT_SETTINGS, enablePlayerAiQuickAction: false };

    const result = applyPlayerAiQuickActionDefaultOnMigration(merged);

    expect(result).toBe(merged);
    expect(result.enablePlayerAiQuickAction).toBe(true);
    expect(result.aiBtnDefaultOnMigrated).toBe(true);
  });

  it("旗标已置位 → 原样返回：用户显式关闭的值不被翻转", () => {
    const merged = {
      ...DEFAULT_SETTINGS,
      enablePlayerAiQuickAction: false,
      aiBtnDefaultOnMigrated: true
    };

    const result = applyPlayerAiQuickActionDefaultOnMigration(merged);

    expect(result.enablePlayerAiQuickAction).toBe(false);
    expect(result.aiBtnDefaultOnMigrated).toBe(true);
  });

  it("存量 true 或键缺失（默认值兜底）→ 值不动，旗标无条件置位（r1/P1-1）", () => {
    for (const syncValue of [{ enablePlayerAiQuickAction: true }, {}]) {
      const merged = { ...DEFAULT_SETTINGS, ...syncValue };

      const result = applyPlayerAiQuickActionDefaultOnMigration(merged);

      expect(result).toBe(merged);
      expect(result.aiBtnDefaultOnMigrated).toBe(true);
      expect(result.enablePlayerAiQuickAction).toBe(
        syncValue.enablePlayerAiQuickAction ?? DEFAULT_SETTINGS.enablePlayerAiQuickAction
      );
    }
  });

  it("新装队列端到端：迁移后旗标已置位，此后显式关闭不再被更新翻转", () => {
    const freshInstall = applyPlayerAiQuickActionDefaultOnMigration({ ...DEFAULT_SETTINGS });
    expect(freshInstall.aiBtnDefaultOnMigrated).toBe(true);

    const afterUserTurnsOff = { ...freshInstall, enablePlayerAiQuickAction: false };
    const rerun = applyPlayerAiQuickActionDefaultOnMigration(afterUserTurnsOff);
    expect(rerun.enablePlayerAiQuickAction).toBe(false);
  });
});

describe("字幕翻译默认源迁移（applySubtitleTranslateDefaultMigration）", () => {
  it("存量空配置/缺键时迁移到免 Key Index-Translate 35B-A3B，且不改动通用 AI 默认配置", () => {
    const syncCurrent = {
      ...DEFAULT_SETTINGS,
      defaultModel: "deepseek-1",
      defaultAiModel: "deepseek-chat",
      subtitleTranslateProviderId: "",
      subtitleTranslateModel: ""
    };

    const result = applySubtitleTranslateDefaultMigration(syncCurrent);

    expect(result).toBe(syncCurrent);
    expect(result.subtitleTranslateProviderId).toBe("bilibili-index-translate");
    expect(result.subtitleTranslateModel).toBe("Index-Translate-35B-A3B");
    expect(result.defaultModel).toBe("deepseek-1");
    expect(result.defaultAiModel).toBe("deepseek-chat");
  });

  it("已选 Index-Translate 档位时按规范归一化（如 9B/2B 保留，未知模型回落 35B-A3B）", () => {
    const nineB = applySubtitleTranslateDefaultMigration({
      subtitleTranslateProviderId: "bilibili-index-translate",
      subtitleTranslateModel: "index-translate-9b"
    });
    expect(nineB.subtitleTranslateModel).toBe("Index-Translate-9B");

    const unknown = applySubtitleTranslateDefaultMigration({
      subtitleTranslateProviderId: "bilibili-index-translate",
      subtitleTranslateModel: "legacy-model"
    });
    expect(unknown.subtitleTranslateModel).toBe("Index-Translate-35B-A3B");
  });

  it("用户已显式配置自定义翻译平台时原样保留，不被 Index-Translate 覆盖", () => {
    const custom = {
      subtitleTranslateProviderId: "openai-custom",
      subtitleTranslateModel: "gpt-4o-mini"
    };

    const result = applySubtitleTranslateDefaultMigration(custom);

    expect(result.subtitleTranslateProviderId).toBe("openai-custom");
    expect(result.subtitleTranslateModel).toBe("gpt-4o-mini");
  });
});
