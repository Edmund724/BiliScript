// C5「设置项声明对账」：settings 域键面（DEFAULT_SETTINGS）与两张名单的对账。
//
// 键面 = 归一步骤表键（SETTINGS_NORMALIZER_KEYS）× 透传名单（SETTINGS_PASSTHROUGH_KEYS）
// 的不相交并集；saveSettings 的写入白名单取键面全集，故本对账同时钉住白名单的
// 静默缺口：
//   - 新增 settings 键忘写归一化步骤、也没列进透传名单 → missing 非空 → 红
//     （该键会经白名单落盘但从不归一化，脏值原样进存储）；
//   - 同一键同时出现在两张名单 → overlap 非空 → 红（归一步骤被透传"接管"后
//     归一化静默失效）；
//   - 名单里有键面外的键 → extra 非空 → 红（名单漂移，白名单其实不落盘它）。
// 判定的有效性由合成漂移夹具自证（三个方向各一条），不依赖变异测试。

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";

// 透传四键的字面量锚：白名单 = 键面全集，所以「键在键面内」不足以证明它还是
// 透传的——把某个归一化键悄悄挪进透传名单（同时删掉它的步骤）并集仍然自洽，
// 只有这里的字面量会抓住这种语义漂移（手法同 tests/core/provider-storage-keys.test.ts
// 对存储键常量的锚定）。
const PASSTHROUGH_LITERAL = [
  "includeDateInFilename",
  "includeTimestampInBody",
  "enableDebugLogs",
  "aiBtnDefaultOnMigrated"
];

function sortedKeys(keys: readonly unknown[]): string[] {
  return [...keys].map(String).sort();
}

// 对账判定：missing = 键面有、两张名单都没有；overlap = 同时进两张名单；
// extra = 名单有、键面没有。
function audit(stepsKeys: readonly string[], passthroughKeys: readonly string[], keyFace: readonly string[]) {
  const face = new Set(keyFace);
  const steps = new Set(stepsKeys);
  const passthrough = new Set(passthroughKeys);
  return {
    missing: keyFace.filter((key) => !steps.has(key) && !passthrough.has(key)),
    extra: [...stepsKeys, ...passthroughKeys].filter((key) => !face.has(key)),
    overlap: stepsKeys.filter((key) => passthrough.has(key))
  };
}

// 名单读面：导出缺失时读到 undefined，在断言处红（不在 import 期炸）。
async function readKeyList(name: string): Promise<string[]> {
  const store = (await import("../../extension/core/settings-store.js")) as unknown as Record<string, unknown>;
  const value = store[name];
  expect(Array.isArray(value), `${name} 应从 settings-store 导出为数组`).toBe(true);
  return value as string[];
}

describe("settings 键面对账：归一步骤表键 ∪ 透传名单 = DEFAULT_SETTINGS 键集", () => {
  it("并集排序后 = Object.keys(DEFAULT_SETTINGS) 排序后（缺项 / 漂移 / 重叠全查）", async () => {
    const stepsKeys = await readKeyList("SETTINGS_NORMALIZER_KEYS");
    const passthroughKeys = await readKeyList("SETTINGS_PASSTHROUGH_KEYS");
    const keyFace = Object.keys(DEFAULT_SETTINGS);

    expect(audit(stepsKeys, passthroughKeys, keyFace)).toEqual({ missing: [], extra: [], overlap: [] });
    expect(sortedKeys([...stepsKeys, ...passthroughKeys])).toEqual(sortedKeys(keyFace));
  });

  it("透传名单 = 既有透传四键（值锚定，挡住「归一键挪进透传」的语义漂移）", async () => {
    expect(sortedKeys(await readKeyList("SETTINGS_PASSTHROUGH_KEYS"))).toEqual(sortedKeys(PASSTHROUGH_LITERAL));
  });

  it("步骤表键与透传名单无交集（双向漂移防护）", async () => {
    const stepsKeys = await readKeyList("SETTINGS_NORMALIZER_KEYS");
    const passthroughKeys = await readKeyList("SETTINGS_PASSTHROUGH_KEYS");

    expect(audit(stepsKeys, passthroughKeys, Object.keys(DEFAULT_SETTINGS)).overlap).toEqual([]);
  });
});

describe("对账判定自证：合成漂移夹具", () => {
  it("加键忘写归一（missing）/ 双名单重叠（overlap）/ 名单越权（extra）各被捕获", () => {
    expect(audit(["a"], ["b"], ["a", "b", "c"]).missing).toEqual(["c"]);
    expect(audit(["a"], ["a"], ["a"]).overlap).toEqual(["a"]);
    expect(audit(["a", "ghost"], [], ["a"]).extra).toEqual(["ghost"]);
  });
});
