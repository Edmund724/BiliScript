import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import { normalizeSettings } from "../../extension/core/settings-store.js";
import { applyPlayerAiQuickActionDefaultOnMigration } from "../../extension/entry/settings-migration.js";

const SYNC_QUOTA_BYTES_PER_ITEM = 8192;
const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

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
});
