// PRESETS 的 Anthropic 端点组装回归。
//
// anthropicAdapter.endpoint() = `${baseUrl}/v1/messages`，所以 protocolBaseUrls
// 里登记的 anthropic 值**不得再以 /v1 结尾**，否则拼成 /v1/v1/messages。
// moonshot / opencodego 曾因缺 protocolBaseUrls.anthropic 而回落以 /v1 结尾的
// openai baseUrl，正是这个重复。修复依据：
// - moonshot：官方文档登记 Anthropic Base URL = https://api.kimi.com/coding/，
//   endpoint 示例 https://api.kimi.com/coding/v1/messages
//   （https://www.kimi.com/code/docs/en/，2026-09-23 实测 /coding/v1/messages
//   路由存在：无 key 返回 401 而非 404）。
// - opencodego：pi-ai 目录中 anthropic-messages 组 baseUrl =
//   https://opencode.ai/zen/go，openai-completions / responses 组才是 /zen/go/v1。

import { describe, expect, it } from "vitest";
import { PRESETS } from "../../extension/core/presets.js";
import { anthropicAdapter } from "../../extension/ai/adapters/anthropic.js";

// preset-protocol-audit（multi-protocol-ai/01）登记的原生 Anthropic 端点平台
const ANTHROPIC_PRESET_IDS = ["deepseek", "qwen", "zhipu", "moonshot", "minimax", "mimo", "opencodego"];

const anthropicEndpointOf = (presetId: string): string => {
  const preset = PRESETS.find((p) => p.id === presetId)!;
  return anthropicAdapter.endpoint(preset.protocolBaseUrls?.anthropic ?? preset.baseUrl);
};

describe("PRESETS 的 Anthropic 端点组装", () => {
  it("登记 protocolBaseUrls.anthropic 的预设 = 审计表的 7 家（不重不漏）", () => {
    const registered = PRESETS.filter((p) => p.protocolBaseUrls?.anthropic).map((p) => p.id);
    expect(registered).toEqual(ANTHROPIC_PRESET_IDS);
  });

  it("7 家组装结果都只有一个 /v1/（无 /v1/v1 重复）", () => {
    for (const id of ANTHROPIC_PRESET_IDS) {
      expect(anthropicEndpointOf(id).match(/\/v1\//g) ?? [], id).toHaveLength(1);
    }
  });

  it("moonshot / opencodego：openai baseUrl 带 /v1 的平台另登记去尾的 anthropic 端点", () => {
    expect(anthropicEndpointOf("moonshot")).toBe("https://api.kimi.com/coding/v1/messages");
    expect(anthropicEndpointOf("opencodego")).toBe("https://opencode.ai/zen/go/v1/messages");
  });
});
