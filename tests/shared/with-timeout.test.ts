// @vitest-environment node

import { describe, expect, it } from "vitest";

import { withTimeout } from "../../extension/shared/error-helpers.js";

describe("withTimeout（无 window 的 SW 环境）", () => {
  it("软超时：到点未完成则兑现 undefined", async () => {
    const pending = new Promise(() => {});
    await expect(withTimeout(pending, 20)).resolves.toBeUndefined();
  });

  it("硬超时：到点未完成则以 timeoutError 拒绝", async () => {
    const pending = new Promise(() => {});
    await expect(withTimeout(pending, 20, new Error("超时"))).rejects.toThrow("超时");
  });

  it("promise 先于超时完成则透传结果", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1000)).resolves.toBe("ok");
  });

  it("promise 先于超时拒绝则透传异常", async () => {
    await expect(withTimeout(Promise.reject(new Error("失败")), 1000)).rejects.toThrow("失败");
  });
});
