// tests/setup.ts 缺省全局桩的契约用例：缺省 storage 面与 tests/helpers/chrome-host.ts
// 的宿主是同一份语义（键三形状 + get(null) 全量快照 + 真实内存）。本文件不装任何宿主，
// 直接驱动 setup 装的桩自身。

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
