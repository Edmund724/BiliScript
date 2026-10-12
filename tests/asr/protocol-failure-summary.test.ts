// asr/protocol.ts 的片级失败摘要（判定 + 投影）——本域跨 port 事实的唯一 seam。
//
// 判据（票 01 决策 2）：**类别是唯一存在判据**——类别缺失 / 非字符串 / 空串 ⇒
// 整条摘要缺席（null）；状态码与报文用 !== undefined 携带（0 与空串都算携带），
// 且不得脱离类别单独存在。这条取代此前并存的真值性与 Number.isFinite(status)。
// 投影（决策 6）：wire 上「有则带键」——缺席字段的键绝不出现（旧宿主不认得新
// 字段，凭空多出 undefined 键会破坏跨 port 形状兼容）。
//
// 期望值全部是手写字面量（真值表来自 spec §#4 与票 01 的测试接缝），不由被测
// 函数反推；对拍用例额外钉住「两侧走不同输入路径、产出同一 wire 形状」。

import { describe, expect, it } from "vitest";
import { projectAsrFailureSummary, readAsrFailureSummary } from "../../extension/asr/protocol.js";

describe("readAsrFailureSummary：类别是唯一存在判据", () => {
  it("类别缺失 / 非字符串 / 空串 → 整条摘要缺席", () => {
    expect(readAsrFailureSummary({})).toBeNull();
    expect(readAsrFailureSummary({ failedKind: undefined })).toBeNull();
    expect(readAsrFailureSummary({ failedKind: null })).toBeNull();
    expect(readAsrFailureSummary({ failedKind: 401 })).toBeNull();
    expect(readAsrFailureSummary({ failedKind: "" })).toBeNull();
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

  it("状态码 0 与报文空串都算携带（判据是 !== undefined，不是真值性）", () => {
    expect(readAsrFailureSummary({ failedKind: "asr-server", failedStatus: 0 })).toEqual({
      kind: "asr-server",
      status: 0
    });
    expect(readAsrFailureSummary({ failedKind: "asr-unknown", failedDetail: "" })).toEqual({
      kind: "asr-unknown",
      detail: ""
    });
  });

  it("非数值状态码 / 非字符串报文 → 该字段不携带，类别照收", () => {
    expect(readAsrFailureSummary({ failedKind: "asr-auth", failedStatus: "401" })).toEqual({ kind: "asr-auth" });
    expect(readAsrFailureSummary({ failedKind: "asr-auth", failedStatus: null })).toEqual({ kind: "asr-auth" });
    expect(readAsrFailureSummary({ failedKind: "asr-auth", failedDetail: 42 })).toEqual({ kind: "asr-auth" });
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
  // offscreen 侧：域摘要（summarizeFailure 的产物）→ 投影，随 DONE 过界；
  // 页面侧：收到的 wire 原文 → 判定 → 投影，进页面侧宿主结果。
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

  it("状态码 0 与报文空串在对拍中不丢键（真值性判据会丢）", () => {
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
