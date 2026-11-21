import { describe, expect, it } from "vitest";

describe("tests/setup 缺省桩：storage 契约与宿主一致", () => {
  it("三形状（单键 / 键数组 / null ⇒ 全量快照）与 remove；写入真实落内存", async () => {
    const area = globalThis.chrome.storage.local;
    await area.set({ a: 1, b: 2 });

    expect(await area.get("a")).toEqual({ a: 1 });
    expect(await area.get(["a", "missing"])).toEqual({ a: 1 });
    expect(await area.get(null)).toEqual({ a: 1, b: 2 });

    await area.remove("a");
    expect(await area.get(null)).toEqual({ b: 2 });
  });
});
