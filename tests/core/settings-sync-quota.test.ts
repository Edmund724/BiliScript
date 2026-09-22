// chrome.storage.sync 单键 8KB（QUOTA_BYTES_PER_ITEM，按字节计）守卫：
// initializeSettingsStorage（entry/background.ts）安装/更新时对 DEFAULT_SETTINGS
// 键面做全量写回，归一化会把空占位的 prompt 字段填成 default-prompts.ts 的完整
// 默认文本——任一键超过 8KB 时 sync.set 会抛错并中断迁移。first-button-ux/03 已把
// prompt 文本拆出 DEFAULT_SETTINGS 字面量（键面压力缓解），但归一化写回路径仍携带
// 默认全文，本测试守住该路径的最终落盘体积；后续若默认 prompt 加长或新增大字段，
// 这里会先于用户浏览器报警。

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import { normalizeSettings } from "../../extension/core/settings-store.js";
import { applyPlayerAiQuickActionDefaultOnMigration } from "../../extension/entry/settings-migration.js";

// chrome.storage.sync：QUOTA_BYTES_PER_ITEM = 8192，键名与 JSON 序列化值均按
// UTF-8 字节计入单键体积（prompt 默认文本含 CJK，码元计数会低估约 3 倍）。
const SYNC_QUOTA_BYTES_PER_ITEM = 8192;
const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

describe("settings sync 单键 8KB 守卫", () => {
  it("initializeSettingsStorage 全量写回键面：每键序列化体积低于 sync 单键上限", () => {
    // 镜像 background.ts initializeSettingsStorage 的写表达式：迁移决策（存量
    // 显式 false 清位 + 旗标置位）作用于 storage 现状，再与 DEFAULT_SETTINGS 合并
    // 归一化后全量落盘。输入取全默认现状（新装/缺键）——默认文本增长是本守卫
    // 针对的溢出来源；用户自填大文本属用户行为，不在此处断言。
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
});
