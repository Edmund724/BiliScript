// @vitest-environment node
// 回归测试：中止判定的形状谓词三件套（工单 01）。
// 谓词只负责「单一形状识别」，接受集由各调用点自己的 OR 组合表达；判据统一严格
// （=== true / name === "AbortError"）。本文件是谓词的唯一 seam，逐格子钉住真值表，
// 并确认三谓词互不串味——不新增任何跨形状（放宽接受集）断言。

import { describe, expect, it } from "vitest";

import {
  isAbortedMarkerError,
  isAbortNamedError,
  isCancelledError
} from "../../extension/shared/error-helpers.js";

describe("isAbortedMarkerError：只认 aborted === true", () => {
  it("aborted === true 命中", () => {
    expect(isAbortedMarkerError({ aborted: true })).toBe(true);
    expect(isAbortedMarkerError(Object.assign(new Error("已停止生成"), { aborted: true }))).toBe(true);
  });

  it("aborted 为 false / undefined / 缺失均不命中", () => {
    expect(isAbortedMarkerError({ aborted: false })).toBe(false);
    expect(isAbortedMarkerError({ aborted: undefined })).toBe(false);
    expect(isAbortedMarkerError(new Error("普通失败"))).toBe(false);
    expect(isAbortedMarkerError({})).toBe(false);
  });

  it("非布尔真值不命中（严格 === true，不是真值性读取）", () => {
    expect(isAbortedMarkerError({ aborted: 1 })).toBe(false);
    expect(isAbortedMarkerError({ aborted: "true" })).toBe(false);
    expect(isAbortedMarkerError({ aborted: {} })).toBe(false);
  });

  it("不认 name 形状与 cancelled 标记", () => {
    expect(isAbortedMarkerError({ name: "AbortError" })).toBe(false);
    expect(isAbortedMarkerError({ cancelled: true })).toBe(false);
  });

  it("非对象（null / undefined / 原始值）不命中且不抛", () => {
    expect(isAbortedMarkerError(null)).toBe(false);
    expect(isAbortedMarkerError(undefined)).toBe(false);
    expect(isAbortedMarkerError("aborted")).toBe(false);
    expect(isAbortedMarkerError(0)).toBe(false);
    expect(isAbortedMarkerError(true)).toBe(false);
  });
});

describe('isAbortNamedError：只认 name === "AbortError"', () => {
  it("普通 Error 与浏览器原生 DOMException 的 AbortError 名命中", () => {
    const error = new Error("请求已中止");
    error.name = "AbortError";
    expect(isAbortNamedError(error)).toBe(true);
    expect(isAbortNamedError(new DOMException("aborted", "AbortError"))).toBe(true);
  });

  it("其它 name / 缺失 / 非字符串不命中", () => {
    expect(isAbortNamedError(new Error("普通失败"))).toBe(false);
    expect(isAbortNamedError({ name: "TypeError" })).toBe(false);
    expect(isAbortNamedError({ name: "aborterror" })).toBe(false);
    expect(isAbortNamedError({ name: undefined })).toBe(false);
  });

  it("不认 aborted 标记与 cancelled 标记", () => {
    expect(isAbortNamedError({ aborted: true })).toBe(false);
    expect(isAbortNamedError({ cancelled: true })).toBe(false);
  });

  it("非对象（null / undefined / 原始值）不命中且不抛", () => {
    expect(isAbortNamedError(null)).toBe(false);
    expect(isAbortNamedError(undefined)).toBe(false);
    expect(isAbortNamedError("AbortError")).toBe(false);
    expect(isAbortNamedError(0)).toBe(false);
  });
});

describe("isCancelledError：只认 cancelled === true", () => {
  it("cancelled === true 命中", () => {
    expect(isCancelledError({ cancelled: true })).toBe(true);
    expect(isCancelledError(Object.assign(new Error("用户取消"), { cancelled: true }))).toBe(true);
  });

  it("cancelled 为 false / undefined / 缺失 / 非布尔真值不命中", () => {
    expect(isCancelledError({ cancelled: false })).toBe(false);
    expect(isCancelledError({ cancelled: undefined })).toBe(false);
    expect(isCancelledError({ cancelled: 1 })).toBe(false);
    expect(isCancelledError({ cancelled: "true" })).toBe(false);
    expect(isCancelledError(new Error("普通失败"))).toBe(false);
  });

  it("不认 aborted 标记与 name 形状", () => {
    expect(isCancelledError({ aborted: true })).toBe(false);
    expect(isCancelledError({ name: "AbortError" })).toBe(false);
  });

  it("非对象（null / undefined / 原始值）不命中且不抛", () => {
    expect(isCancelledError(null)).toBe(false);
    expect(isCancelledError(undefined)).toBe(false);
    expect(isCancelledError("cancelled")).toBe(false);
    expect(isCancelledError(0)).toBe(false);
  });
});
