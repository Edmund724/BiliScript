import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";

const PASSTHROUGH_LITERAL = [
  "includeDateInFilename",
  "includeTimestampInBody",
  "enableDebugLogs",
  "aiBtnDefaultOnMigrated"
];

function sortedKeys(keys: readonly unknown[]): string[] {
  return [...keys].map(String).sort();
}

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
