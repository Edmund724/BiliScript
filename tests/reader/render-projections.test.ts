// tests/reader/render-projections.test.ts
// 一次渲染的投影次序锁：reader/lifecycle.ts 的 READER_VIEW_PROJECTIONS 是装配后的
// 完整投影表（base 投影在 view-render.ts，会话态投影在 lifecycle 装配点注入），
// renderReadingView 按它驱动。次序即渲染次序——改动必须显式落在这张表上。
//
// 系统可能怎么坏：次序被悄悄调整（搜索重放跑到列表重建之前、选轨投影跑到呈现之前）；
// 表里两项被写成同一个身份（id 重复）；project 位被塞进非函数。

import { beforeEach, describe, expect, it } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";

beforeEach(() => {
  resetModuleState();
  setLocationUrl(READER_MODE_URL);
});

describe("一次渲染的投影次序", () => {
  it("id 序列等于冻结的 8 项次序、id 唯一、每项 project 是函数", async () => {
    const { READER_VIEW_PROJECTIONS } = await import("../../extension/reader/lifecycle.js");
    const idsInOrder = READER_VIEW_PROJECTIONS.map((projection) => projection.id);

    expect(idsInOrder).toEqual([
      "meta-line",
      "subtitle-list",
      "reader-panels",
      "presentation",
      "subtitle-search",
      "transcribe-banner",
      "overview",
      "subtitle-toolbar"
    ]);
    expect(new Set(idsInOrder).size).toBe(idsInOrder.length);
    expect(READER_VIEW_PROJECTIONS.every((projection) => typeof projection.project === "function")).toBe(true);
  });
});
