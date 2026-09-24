// shouldCloseAfterAsrTask（offscreen 文档 asr-decode 终态自关判定）纯函数测试：
// - 聊天端口数为 0 且无在飞代发请求 → 关（自关，释放渲染进程）
// - 还有聊天端口 / 还有在飞代发请求（概览链，overview-offscreen-transport）
//   → 保留
// - 计数异常（NaN/undefined）→ 保守保留

import { describe, expect, it } from "vitest";
import { shouldCloseAfterAsrTask } from "../../extension/entry/offscreen-lifecycle.js";

describe("shouldCloseAfterAsrTask", () => {
  it("聊天端口数为 0 且无在飞代发 → 关", () => {
    expect(shouldCloseAfterAsrTask(0, 0)).toBe(true);
  });

  it("还有存活聊天端口 → 保留", () => {
    expect(shouldCloseAfterAsrTask(1, 0)).toBe(false);
    expect(shouldCloseAfterAsrTask(3, 0)).toBe(false);
  });

  it("还有在飞代发请求（概览生成中）→ 保留", () => {
    expect(shouldCloseAfterAsrTask(0, 1)).toBe(false);
    expect(shouldCloseAfterAsrTask(0, 2)).toBe(false);
  });

  it("计数异常（NaN/undefined）→ 保守保留文档", () => {
    expect(shouldCloseAfterAsrTask(NaN, 0)).toBe(false);
    expect(shouldCloseAfterAsrTask(undefined, 0)).toBe(false);
    expect(shouldCloseAfterAsrTask(0, NaN)).toBe(false);
    expect(shouldCloseAfterAsrTask(0, undefined)).toBe(false);
  });
});
