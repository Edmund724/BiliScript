import { describe, expect, it } from "vitest";
import { PRESETS } from "../../extension/core/presets.js";
import { anthropicAdapter } from "../../extension/ai/adapters/anthropic.js";

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
  "sensenova",
  "ollama"
];

const anthropicEndpointOf = (presetId: string): string => {
  const preset = PRESETS.find((p) => p.id === presetId)!;
  return anthropicAdapter.endpoint(preset.protocolBaseUrls?.anthropic ?? preset.baseUrl);
};

describe("PRESETS 的 Anthropic 端点组装", () => {
  it("登记 protocolBaseUrls.anthropic 的预设 = 审计表的 13 家（不重不漏）", () => {
    const registered = PRESETS.filter((p) => p.protocolBaseUrls?.anthropic).map((p) => p.id);
    expect(registered).toEqual(ANTHROPIC_PRESET_IDS);
  });

  it("13 家组装结果都只有一个 /v1/（无 /v1/v1 重复）", () => {
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
    expect(anthropicEndpointOf("ollama")).toBe("http://localhost:11434/v1/messages");
  });
});
