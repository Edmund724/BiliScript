// ai/platform-identity-vocab.js 词表叶单测（架构评审候选 6）：平台身份键空间的唯一来源。
// 纯叶契约（零 import，SW 静态图安全）与成员判据在这里钉住；「四张平台键表的键集 = 本词表」
// 的编译期判据见 tests/ai/thinking-wire-keys.types.ts（缺一格 / 孤儿键即 tsc 红），运行期的
// 键集语义断言在 tests/ai/thinking-wire-map.test.ts。词表内容本身不再有第二份拷贝：
// 真表以 `Record<PlatformKey, …>` 索引，任何漏登记都由类型报出。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PLATFORM_IDENTITY_KEYS, isPlatformKey } from "../../extension/ai/platform-identity-vocab.js";

describe("PLATFORM_IDENTITY_KEYS 词表叶", () => {
  it("纯叶：模块源码无 import（零运行时依赖，不拖入思考表与出口表）", () => {
    const source = readFileSync("extension/ai/platform-identity-vocab.ts", "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
  });

  it("isPlatformKey：词表内为真；表外 / 非串 / 原型链上的键为假", () => {
    for (const key of PLATFORM_IDENTITY_KEYS) {
      expect(isPlatformKey(key), key).toBe(true);
    }
    // 原型链上的键不算表内格（与三张出口表的兜底格同款判据）；custom 是 preset 键空间的
    // 成员、不是平台身份（PRESETS ∌ siliconflow / PROVIDERS ∌ custom，三套键空间不合并）。
    for (const value of ["", "custom", "ghost", "constructor", "toString", undefined, null, 42, {}]) {
      expect(isPlatformKey(value), String(value)).toBe(false);
    }
  });
});
