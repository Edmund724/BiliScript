import { describe, expect, it } from "vitest";
import { projectAsrFailureSummary, readAsrFailureSummary } from "../../extension/asr/protocol.js";

describe("readAsrFailureSummary：类别是唯一存在判据", () => {
  it("类别缺失 / 非字符串 / 空串 → 整条摘要缺席", () => {
    expect(readAsrFailureSummary({})).toBeNull();
    expect(readAsrFailureSummary({ failedKind: undefined })).toBeNull();
    expect(readAsrFailureSummary({ failedKind: null })).toBeNull();
    expect(readAsrFailureSummary({ failedKind: 401 })).toBeNull();
    expect(readAsrFailureSummary({ failedKind: "" })).toBeNull();
    expect(readAsrFailureSummary({ failedKind: "", failedStatus: 401, failedDetail: "x" })).toBeNull();
  });

  it("无类别时状态码与报文单独存在也不算失败信号", () => {
    expect(readAsrFailureSummary({ failedStatus: 401 })).toBeNull();
    expect(readAsrFailureSummary({ failedDetail: "invalid api key" })).toBeNull();
    expect(readAsrFailureSummary({ failedStatus: 401, failedDetail: "x" })).toBeNull();
  });

  it("非对象原文 → 缺席", () => {
    expect(readAsrFailureSummary(null)).toBeNull();
    expect(readAsrFailureSummary(undefined)).toBeNull();
    expect(readAsrFailureSummary("asr-auth")).toBeNull();
    expect(readAsrFailureSummary(401)).toBeNull();
  });

  it("只有类别 → 摘要只含类别（status/detail 的键不存在）", () => {
    const summary = readAsrFailureSummary({ failedKind: "asr-auth" });

    expect(summary).toEqual({ kind: "asr-auth" });
    expect("status" in (summary as object)).toBe(false);
    expect("detail" in (summary as object)).toBe(false);
  });

  it("状态码 0 与报文空串都算携带（键在且不是 undefined）", () => {
    expect(readAsrFailureSummary({ failedKind: "asr-server", failedStatus: 0 })).toEqual({
      kind: "asr-server",
      status: 0
    });
    expect(readAsrFailureSummary({ failedKind: "asr-unknown", failedDetail: "" })).toEqual({
      kind: "asr-unknown",
      detail: ""
    });
  });

  it("字段只在缺席（undefined）时不携带：null / 数字串 / 非字符串报文都照收", () => {
    expect(readAsrFailureSummary({ failedKind: "asr-auth", failedStatus: "401" })).toEqual({
      kind: "asr-auth",
      status: "401"
    });
    expect(readAsrFailureSummary({ failedKind: "asr-auth", failedStatus: null })).toEqual({
      kind: "asr-auth",
      status: null
    });
    expect(readAsrFailureSummary({ failedKind: "asr-auth", failedStatus: undefined })).toEqual({ kind: "asr-auth" });
    expect(readAsrFailureSummary({ failedKind: "asr-auth", failedDetail: 42 })).toEqual({ kind: "asr-auth", detail: 42 });
    expect(readAsrFailureSummary({ failedKind: "asr-auth", failedDetail: undefined })).toEqual({ kind: "asr-auth" });
  });

  it("三字段全有 → 逐字段照收（状态码 -1 哨兵也照收，判定层不改值）", () => {
    expect(
      readAsrFailureSummary({ failedKind: "asr-auth", failedStatus: 401, failedDetail: "invalid api key" })
    ).toEqual({ kind: "asr-auth", status: 401, detail: "invalid api key" });
    expect(readAsrFailureSummary({ failedKind: "asr-unknown", failedStatus: -1, failedDetail: "响应体不是合法 JSON" })).toEqual({
      kind: "asr-unknown",
      status: -1,
      detail: "响应体不是合法 JSON"
    });
  });

  it("域形态原文（kind/status/detail）同样认得", () => {
    expect(readAsrFailureSummary({ kind: "asr-quota", status: 402, detail: "余额不足" })).toEqual({
      kind: "asr-quota",
      status: 402,
      detail: "余额不足"
    });
  });
});

describe("projectAsrFailureSummary：缺席字段的键不出现", () => {
  it("null / undefined 摘要 → 空片段", () => {
    expect(projectAsrFailureSummary(null)).toEqual({});
    expect(projectAsrFailureSummary(undefined)).toEqual({});
  });

  it("只有类别 → 只写 failedKind 一个键", () => {
    const fields = projectAsrFailureSummary({ kind: "asr-auth" });

    expect(fields).toEqual({ failedKind: "asr-auth" });
    expect("failedStatus" in fields).toBe(false);
    expect("failedDetail" in fields).toBe(false);
  });

  it("状态码 0 与报文空串都携带（键存在、值为 0 / 空串）", () => {
    expect(projectAsrFailureSummary({ kind: "asr-server", status: 0 })).toEqual({
      failedKind: "asr-server",
      failedStatus: 0
    });
    expect(projectAsrFailureSummary({ kind: "asr-unknown", detail: "" })).toEqual({
      failedKind: "asr-unknown",
      failedDetail: ""
    });
  });

  it("三字段全有 → 三键齐全", () => {
    expect(projectAsrFailureSummary({ kind: "asr-auth", status: 401, detail: "invalid api key" })).toEqual({
      failedKind: "asr-auth",
      failedStatus: 401,
      failedDetail: "invalid api key"
    });
  });
});

describe("对拍：offscreen 侧与页面侧产出同一 wire 形状", () => {
  it("同一失败信号两侧逐字同形，且与手写字面量相符", () => {
    const offscreen = projectAsrFailureSummary({
      kind: "asr-auth",
      status: 401,
      detail: "invalid api key"
    });
    const page = projectAsrFailureSummary(
      readAsrFailureSummary({ failedKind: "asr-auth", failedStatus: 401, failedDetail: "invalid api key" })
    );

    expect(offscreen).toEqual({ failedKind: "asr-auth", failedStatus: 401, failedDetail: "invalid api key" });
    expect(page).toEqual(offscreen);
  });

  it("状态码 0 与报文空串在对拍中不丢键（键在且不是 undefined）", () => {
    const offscreen = projectAsrFailureSummary({ kind: "asr-server", status: 0, detail: "" });
    const page = projectAsrFailureSummary(readAsrFailureSummary(offscreen));

    expect(offscreen).toEqual({ failedKind: "asr-server", failedStatus: 0, failedDetail: "" });
    expect(page).toEqual(offscreen);
  });

  it("无失败信号：页面侧收一条不带失败字段的终态消息 → 片段为空、不多出任何键", () => {
    const page = projectAsrFailureSummary(readAsrFailureSummary({ totalChunks: 3, failedChunks: 0 }));

    expect(page).toEqual({});
    expect("failedKind" in page).toBe(false);
    expect("failedStatus" in page).toBe(false);
    expect("failedDetail" in page).toBe(false);
  });
});
