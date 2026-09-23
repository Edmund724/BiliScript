// PRESETS 的 Anthropic 端点组装回归。
//
// anthropicAdapter.endpoint() = `${baseUrl}/v1/messages`，所以 protocolBaseUrls
// 里登记的 anthropic 值**不得再以 /v1 结尾**，否则拼成 /v1/v1/messages。
// moonshot / opencodego / stepfun 曾因缺 protocolBaseUrls.anthropic 而回落以
// /v1 结尾的 openai baseUrl，正是这个重复。12 家登记的依据（2026-09-23 核实）：
// - deepseek / qwen / zhipu / minimax / mimo：原审计表既有登记，实测 /v1/messages
//   非 404 且同前缀对照 404（deepseek 该前缀整体先鉴权，另有一手文档）。
// - moonshot：官方文档 Anthropic Base URL = https://api.kimi.com/coding/，
//   endpoint 示例 https://api.kimi.com/coding/v1/messages
//   （https://www.kimi.com/code/docs/en/）。
// - opencodego：pi-ai 目录中 anthropic-messages 组 baseUrl =
//   https://opencode.ai/zen/go，openai-completions / responses 组才是 /zen/go/v1。
// - stepfun：官方「推理模型接入」明示路径 https://api.stepfun.com/step_plan/v1/messages，
//   并警告 Anthropic SDK 的 base_url 不带 /v1（与 adapter 约定一致）。
// - openrouter：官方 OpenAPI（tag「Anthropic Messages」）路径 /messages、server
//   https://openrouter.ai/api/v1（https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message.md）。
// - modelscope：官方（Beta）Anthropic 兼容 base_url 固定为
//   https://api-inference.modelscope.cn 且「不带 /v1/ 后缀」。
// - amd：官方 API 概览列出 `POST /v1/messages`「兼容 Anthropic，供 Claude Code
//   这类客户端使用」，Public Free Model APIs base =
//   https://developer.amd.com.cn/radeon/api/v1。
// - sensenova：实测 /v1/messages 401 且同前缀对照 404；sensenova-proxy 的兼容性
//   研究亦称其 /v1/messages 原生实现 Anthropic Messages 协议（无一手文档，见
//   research/preset-protocol-audit.md 的证据分级）。

import { describe, expect, it } from "vitest";
import { PRESETS } from "../../extension/core/presets.js";
import { anthropicAdapter } from "../../extension/ai/adapters/anthropic.js";

// preset-protocol-audit（multi-protocol-ai/01）登记的 Anthropic 端点平台（按 PRESETS 顺序）
const ANTHROPIC_PRESET_IDS = [
  "deepseek",
  "qwen",
  "zhipu",
  "moonshot",
  "minimax",
  "mimo",
  "opencodego",
  "openrouter",
  "stepfun",
  "modelscope",
  "amd",
  "sensenova"
];

const anthropicEndpointOf = (presetId: string): string => {
  const preset = PRESETS.find((p) => p.id === presetId)!;
  return anthropicAdapter.endpoint(preset.protocolBaseUrls?.anthropic ?? preset.baseUrl);
};

describe("PRESETS 的 Anthropic 端点组装", () => {
  it("登记 protocolBaseUrls.anthropic 的预设 = 审计表的 12 家（不重不漏）", () => {
    const registered = PRESETS.filter((p) => p.protocolBaseUrls?.anthropic).map((p) => p.id);
    expect(registered).toEqual(ANTHROPIC_PRESET_IDS);
  });

  it("12 家组装结果都只有一个 /v1/（无 /v1/v1 重复）", () => {
    for (const id of ANTHROPIC_PRESET_IDS) {
      expect(anthropicEndpointOf(id).match(/\/v1\//g) ?? [], id).toHaveLength(1);
    }
  });

  it("openai baseUrl 带 /v1 的平台另登记去尾的 anthropic 端点", () => {
    expect(anthropicEndpointOf("moonshot")).toBe("https://api.kimi.com/coding/v1/messages");
    expect(anthropicEndpointOf("opencodego")).toBe("https://opencode.ai/zen/go/v1/messages");
    expect(anthropicEndpointOf("stepfun")).toBe("https://api.stepfun.com/step_plan/v1/messages");
    expect(anthropicEndpointOf("openrouter")).toBe("https://openrouter.ai/api/v1/messages");
    expect(anthropicEndpointOf("modelscope")).toBe("https://api-inference.modelscope.cn/v1/messages");
    expect(anthropicEndpointOf("amd")).toBe("https://developer.amd.com.cn/radeon/api/v1/messages");
    expect(anthropicEndpointOf("sensenova")).toBe("https://token.sensenova.cn/v1/messages");
  });
});
