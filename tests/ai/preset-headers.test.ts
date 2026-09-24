// ai/preset-headers.ts：平台预设额外请求头的查表与会话 id 取值。
// Opencode Go 要求每个对话带一个稳定的 x-opencode-session（官方文档「Where can
// I use it?」），取值由会话身份确定性派生——同一会话跨轮/跨重载恒同值。

import { describe, expect, it } from "vitest";
import { presetRequestHeaders, sessionIdFor } from "../../extension/ai/preset-headers.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("presetRequestHeaders", () => {
  it("Opencode Go：补 x-opencode-session，值 = 会话身份的确定性派生", () => {
    const headers = presetRequestHeaders({ presetId: "opencodego", sessionId: "conv_a1" });
    expect(Object.keys(headers)).toEqual(["x-opencode-session"]);
    expect(headers["x-opencode-session"]).toBe(sessionIdFor("conv_a1"));
    expect(headers["x-opencode-session"]).toMatch(UUID_V4);
  });

  it("同一会话恒同值、不同会话不同值（跨轮/跨重载稳定，新会话新标识）", () => {
    const send = (sessionId: string) => presetRequestHeaders({ presetId: "opencodego", sessionId })["x-opencode-session"];
    expect(send("conv_a1")).toBe(send("conv_a1"));
    expect(send("conv_a1")).not.toBe(send("conv_b2"));
  });

  it("无会话身份（选区解释/连通性探针/旧宿主）：造随机 UUID，两次调用不同", () => {
    const first = presetRequestHeaders({ presetId: "opencodego" })["x-opencode-session"];
    const second = presetRequestHeaders({ presetId: "opencodego", sessionId: "  " })["x-opencode-session"];
    expect(first).toMatch(UUID_V4);
    expect(second).toMatch(UUID_V4);
    expect(first).not.toBe(second);
  });

  it("其余预设（含无预设/未知值）不补任何头", () => {
    expect(presetRequestHeaders({ presetId: "deepseek", sessionId: "conv_a1" })).toEqual({});
    expect(presetRequestHeaders({ presetId: "custom" })).toEqual({});
    expect(presetRequestHeaders({})).toEqual({});
    expect(presetRequestHeaders(undefined)).toEqual({});
    expect(presetRequestHeaders(null)).toEqual({});
  });
});

describe("sessionIdFor", () => {
  it("身份归一（去首尾空白）后再派生：带空白与不带空白同值", () => {
    expect(sessionIdFor(" conv_a1 ")).toBe(sessionIdFor("conv_a1"));
  });

  it("派生是纯函数：不同身份的取值不同且恒为 UUIDv4 形状", () => {
    const ids = ["conv_1", "conv_2", "conv_3", "视频上下文", "conv_" + "x".repeat(64)].map((identity) => sessionIdFor(identity));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(UUID_V4);
    }
  });
});
