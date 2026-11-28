import { describe, expect, it } from "vitest";
import { channelHarness, type ByClassCase } from "./thinking-golden-classes.js";
import { registerByClassDefenses, registerByClassGolden } from "./thinking-golden-defenses.js";

const HARNESS = channelHarness("openai");

const CASES: readonly ByClassCase[] = [
  { valuesetId: "b", presetId: "qwen", model: "kimi-k2-thinking", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "b:128-32768", presetId: "gemini", model: "gemini-2.5-pro", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "high", presetId: "openrouter", model: "openai/gpt-5-pro", available: ["high"], fields: [{"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}] },
  { valuesetId: "high-xhigh", presetId: "openrouter", model: "sakana/fugu-ultra", available: ["high", "xhigh"], fields: [{"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"xhigh"}] },
  { valuesetId: "high-xhigh-max", presetId: "openrouter", model: "sakana/fugu-max", available: ["high", "xhigh", "max"], fields: [{"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"max"}] },
  { valuesetId: "low-high", presetId: "gemini", model: "gemini-3-pro-image", available: ["low", "high"], fields: [{"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}] },
  { valuesetId: "low-high-max", presetId: "amd", model: "GLM-5.3-Flash", available: ["low", "high", "max"], fields: [{"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"max"}] },
  { valuesetId: "low-medium", presetId: "amd", model: "Qwen3.8-27B", available: ["low", "medium"], fields: [{"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}] },
  { valuesetId: "low-medium-high", presetId: "gemini", model: "gemini-3.1-pro-preview", available: ["low", "medium", "high"], fields: [{"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}] },
  { valuesetId: "low-medium-high-xhigh", presetId: "gemini", model: "gemini-4-hydrogen", available: ["low", "medium", "high", "xhigh"], fields: [{"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"xhigh"}] },
  { valuesetId: "low-medium-high-xhigh-max", presetId: "minimax", model: "MiniMax-M3.1-Flash", available: ["low", "medium", "high", "xhigh", "max"], fields: [{"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"max"}] },
  { valuesetId: "low-medium-xhigh", presetId: "amd", model: "Qwen3.8-Flash-Next", available: ["low", "medium", "xhigh"], fields: [{"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"xhigh"}] },
  { valuesetId: "medium-high", presetId: "openrouter", model: "nex-agi/nex-n2.6", available: ["medium", "high"], fields: [{"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}] },
  { valuesetId: "medium-high-xhigh", presetId: "openrouter", model: "openai/gpt-5.2-pro", available: ["medium", "high", "xhigh"], fields: [{"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"xhigh"}] },
  { valuesetId: "minimal-high", presetId: "gemini", model: "gemini-3.1-flash-image", available: ["minimal", "high"], fields: [{"reasoning_effort":"minimal"}, {"reasoning_effort":"minimal"}, {"reasoning_effort":"minimal"}, {"reasoning_effort":"minimal"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}] },
  { valuesetId: "minimal-low-medium-high", presetId: "gemini", model: "gemini-3-flash-preview", available: ["minimal", "low", "medium", "high"], fields: [{"reasoning_effort":"minimal"}, {"reasoning_effort":"minimal"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}] },
  { valuesetId: "minimal-low-medium-high-max", presetId: "openrouter", model: "thinkingmachines/inkling-2-small", available: ["minimal", "low", "medium", "high", "max"], fields: [{"reasoning_effort":"minimal"}, {"reasoning_effort":"minimal"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"max"}] },
  { valuesetId: "minimal-low-medium-high-xhigh", presetId: "opencodego", model: "muse-spark-1.2-contributor", available: ["minimal", "low", "medium", "high", "xhigh"], fields: [{"reasoning_effort":"minimal"}, {"reasoning_effort":"minimal"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"xhigh"}] },
  { valuesetId: "minimal-low-medium-high-xhigh-max", presetId: "opencodego", model: "crouton-alpha-free", available: ["minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"reasoning_effort":"minimal"}, {"reasoning_effort":"minimal"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"max"}] },
  { valuesetId: "none-high", presetId: "opencodego", model: "hy4", available: ["off", "high"], fields: [{"reasoning_effort":"none"}, {"reasoning_effort":"none"}, {"reasoning_effort":"none"}, {"reasoning_effort":"none"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}] },
  { valuesetId: "none-low-high", presetId: "opencodego", model: "hy3", available: ["off", "low", "high"], fields: [{"reasoning_effort":"none"}, {"reasoning_effort":"none"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}] },
  { valuesetId: "none-low-high-max", presetId: "moonshot", model: "kimi-for-coding", available: ["off", "low", "high", "max"], fields: [{"reasoning_effort":"none"}, {"reasoning_effort":"none"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"max"}] },
  { valuesetId: "none-low-high-xhigh+b:1-262144", presetId: "opencodego", model: "qwen4-max", available: ["off", "low", "high", "xhigh"], fields: [{"reasoning_effort":"none"}, {"reasoning_effort":"none"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"high"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"xhigh"}] },
  { valuesetId: "none-low-medium+b", presetId: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b", available: ["off", "low", "medium"], fields: [{"reasoning_effort":"none"}, {"reasoning_effort":"none"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}] },
  { valuesetId: "none-low-medium-high", presetId: "openrouter", model: "baidu/ernie-5.5-flash-preview:free", available: ["off", "low", "medium", "high"], fields: [{"reasoning_effort":"none"}, {"reasoning_effort":"none"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}] },
  { valuesetId: "none-low-medium-high-xhigh", presetId: "openrouter", model: "openai/gpt-5.2", available: ["off", "low", "medium", "high", "xhigh"], fields: [{"reasoning_effort":"none"}, {"reasoning_effort":"none"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"xhigh"}] },
  { valuesetId: "none-low-medium-high-xhigh-max", presetId: "opencodego", model: "gpt-5.6-luna", available: ["off", "low", "medium", "high", "xhigh", "max"], fields: [{"reasoning_effort":"none"}, {"reasoning_effort":"none"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"max"}] },
  { valuesetId: "none-low-medium-xhigh", presetId: "openrouter", model: "qwen/qwen3.8-27b", available: ["off", "low", "medium", "xhigh"], fields: [{"reasoning_effort":"none"}, {"reasoning_effort":"none"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"xhigh"}] },
  { valuesetId: "none-medium-high", presetId: "openrouter", model: "nex-agi/nex-n2.5-mini", available: ["off", "medium", "high"], fields: [{"reasoning_effort":"none"}, {"reasoning_effort":"none"}, {"reasoning_effort":"none"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}] },
  { valuesetId: "none-medium-high+b", presetId: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b", available: ["off", "medium", "high"], fields: [{"reasoning_effort":"none"}, {"reasoning_effort":"none"}, {"reasoning_effort":"none"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}] },
  { valuesetId: "none-medium-xhigh", presetId: "openrouter", model: "prism-ml/ternary-bonsai-2-27b", available: ["off", "medium", "xhigh"], fields: [{"reasoning_effort":"none"}, {"reasoning_effort":"none"}, {"reasoning_effort":"none"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"xhigh"}] },
  { valuesetId: "none-minimal-high", presetId: "openrouter", model: "google/gemini-3.1-flash-image-preview", available: ["off", "minimal", "high"], fields: [{"reasoning_effort":"none"}, {"reasoning_effort":"minimal"}, {"reasoning_effort":"minimal"}, {"reasoning_effort":"minimal"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}] },
  { valuesetId: "none-minimal-low-medium-high", presetId: "openrouter", model: "bytedance-seed/seed-2.0-lite", available: ["off", "minimal", "low", "medium", "high"], fields: [{"reasoning_effort":"none"}, {"reasoning_effort":"minimal"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}] },
  { valuesetId: "none-minimal-low-medium-high-max", presetId: "openrouter", model: "thinkingmachines/inkling", available: ["off", "minimal", "low", "medium", "high", "max"], fields: [{"reasoning_effort":"none"}, {"reasoning_effort":"minimal"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"max"}] },
  { valuesetId: "none-minimal-low-medium-high-xhigh-max", presetId: "openrouter", model: "particle-ai/particle-1", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"reasoning_effort":"none"}, {"reasoning_effort":"minimal"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"max"}] },
  { valuesetId: "toggle", presetId: "amd", model: "Gemma-4-31B-IT", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "toggle", presetId: "mimo", model: "mimo-v2.6-flash", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"enable_thinking":false}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}] },
  { valuesetId: "toggle", presetId: "minimax", model: "MiniMax-M3", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"adaptive"}}, {"thinking":{"type":"adaptive"}}, {"thinking":{"type":"adaptive"}}, {"thinking":{"type":"adaptive"}}, {"thinking":{"type":"adaptive"}}, {"thinking":{"type":"adaptive"}}] },
  { valuesetId: "toggle", presetId: "moonshot", model: "kimi-k2.6", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}] },
  { valuesetId: "toggle+b", presetId: "opencodego", model: "qwen3.7-plus", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "toggle+b", presetId: "qwen", model: "qwen3.5-122b-a10b", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"enable_thinking":false}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}] },
  { valuesetId: "toggle+b:-131072", presetId: "qwen", model: "glm-5.1", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"enable_thinking":false}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}] },
  { valuesetId: "toggle+b:-262144", presetId: "openrouter", model: "qwen/qwen3.7-flash", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "toggle+b:-262144", presetId: "qwen", model: "qwen3.7-flash", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"enable_thinking":false}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}] },
  { valuesetId: "toggle+b:-32768", presetId: "qwen", model: "glm-5", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"enable_thinking":false}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}] },
  { valuesetId: "toggle+b:-81920", presetId: "qwen", model: "kimi-k2.5", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"enable_thinking":false}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}, {"enable_thinking":true}] },
  { valuesetId: "toggle+b:0-24576", presetId: "gemini", model: "gemini-2.5-flash", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "toggle+b:1-", presetId: "openrouter", model: "cohere/command-a-plus", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "toggle+b:1024-", presetId: "openrouter", model: "anthropic/claude-haiku-4.5", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "toggle+b:512-24576", presetId: "gemini", model: "gemini-2.5-flash-lite", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "toggle+high-max", presetId: "opencodego", model: "glm-5.2", available: ["high", "max"], fields: [{"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"max"}] },
  { valuesetId: "toggle+high-max", presetId: "qwen", model: "glm-5.2", available: ["off", "high", "max"], fields: [{"enable_thinking":false}, {"enable_thinking":false}, {"enable_thinking":false}, {"enable_thinking":false}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"max"}] },
  { valuesetId: "toggle+high-max", presetId: "zhipu", model: "glm-5.2", available: ["off", "high", "max"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"max"}] },
  { valuesetId: "toggle+low-high-max", presetId: "amd", model: "DeepSeek-V4-Flash", available: ["low", "high", "max"], fields: [{"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"max"}] },
  { valuesetId: "toggle+low-high-max", presetId: "deepseek", model: "deepseek-flash", available: ["off", "low", "high", "max"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"max"}] },
  { valuesetId: "toggle+low-high-max", presetId: "qwen", model: "deepseek-v4-flash", available: ["off", "low", "high", "max"], fields: [{"enable_thinking":false}, {"enable_thinking":false}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"max"}] },
  { valuesetId: "toggle+low-medium-high+b:1024-", presetId: "openrouter", model: "anthropic/claude-opus-4.5", available: ["low", "medium", "high"], fields: [{"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}] },
  { valuesetId: "toggle+low-medium-high-max+b:1024-", presetId: "openrouter", model: "anthropic/claude-opus-4.6", available: ["low", "medium", "high", "max"], fields: [{"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"max"}] },
  { valuesetId: "toggle+low-medium-high-xhigh-max", presetId: "opencodego", model: "claude-haiku-5-5", available: ["low", "medium", "high", "xhigh", "max"], fields: [{"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"high"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"max"}] },
  { valuesetId: "toggle+low-medium-xhigh+b:-262144", presetId: "opencodego", model: "qwen3.8-flash", available: ["low", "medium", "xhigh"], fields: [{"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"xhigh"}] },
  { valuesetId: "toggle+low-medium-xhigh+b:-262144", presetId: "qwen", model: "qwen3.8-flash", available: ["off", "low", "medium", "xhigh"], fields: [{"enable_thinking":false}, {"enable_thinking":false}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"xhigh"}] },
  { valuesetId: "toggle+low-medium-xhigh+b:0-262144", presetId: "opencodego", model: "qwen3.8-max", available: ["low", "medium", "xhigh"], fields: [{"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"xhigh"}] },
  { valuesetId: "toggle+low-medium-xhigh+b:0-262144", presetId: "qwen", model: "qwen3.8-max", available: ["off", "low", "medium", "xhigh"], fields: [{"enable_thinking":false}, {"enable_thinking":false}, {"reasoning_effort":"low"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"medium"}, {"reasoning_effort":"xhigh"}, {"reasoning_effort":"xhigh"}] },
];

registerByClassGolden(HARNESS, CASES);
registerByClassDefenses(HARNESS, CASES);

describe("golden：每方言一条精确 body（openai 通道）", () => {
  it("(1) api.openai.com + gpt-5.1：top-level reasoning_effort（off 用 none 实现关思考）", () => {
    const baseUrl = "https://api.openai.com/v1";
    expect(HARNESS.bodyAt({ baseUrl, model: "gpt-5.1", level: "off" })).toEqual(HARNESS.expectedBody("gpt-5.1", { reasoning_effort: "none" }));
    expect(HARNESS.bodyAt({ baseUrl, model: "gpt-5.1", level: "low" })).toEqual(HARNESS.expectedBody("gpt-5.1", { reasoning_effort: "low" }));
  });

  it("(2) api.siliconflow.cn + qwen3-max：enable_thinking 开关词汇（裸 id 命中模式表）", () => {
    const baseUrl = "https://api.siliconflow.cn/v1";
    expect(HARNESS.bodyAt({ baseUrl, model: "qwen3-max", level: "off" })).toEqual(HARNESS.expectedBody("qwen3-max", { enable_thinking: false }));
    for (const level of ["low", "high"] as const) {
      expect(HARNESS.bodyAt({ baseUrl, model: "qwen3-max", level }), level).toEqual(HARNESS.expectedBody("qwen3-max", { enable_thinking: true }));
    }
    expect(HARNESS.bodyAt({ baseUrl, model: "qwen3-max", level: "low" })).toEqual(HARNESS.bodyAt({ baseUrl, model: "qwen3-max", level: "high" }));
  });

  it("(3) api.doubao.com + doubao-seed-1.6：thinking:{type} 开关词汇（域名已死，血统仍识别）", () => {
    const baseUrl = "https://api.doubao.com/v1";
    expect(HARNESS.bodyAt({ baseUrl, model: "doubao-seed-1.6", level: "off" })).toEqual(
      HARNESS.expectedBody("doubao-seed-1.6", { thinking: { type: "disabled" } })
    );
    expect(HARNESS.bodyAt({ baseUrl, model: "doubao-seed-1.6", level: "low" })).toEqual(
      HARNESS.expectedBody("doubao-seed-1.6", { thinking: { type: "enabled" } })
    );
  });

  it("(4) ollama + llama3.2：无上游 preset，unknownClass 兜底发 effort 词汇（off=none）", () => {
    expect(HARNESS.bodyAt({ presetId: "ollama", model: "llama3.2", level: "off" })).toEqual(HARNESS.expectedBody("llama3.2", { reasoning_effort: "none" }));
    expect(HARNESS.bodyAt({ presetId: "ollama", model: "llama3.2", level: "low" })).toEqual(HARNESS.expectedBody("llama3.2", { reasoning_effort: "low" }));
  });

  it("(5) unknown 哨兵：未列模型（自填端点 / openai host 的 gpt-4o）三档都不发思考字段", () => {
    for (const level of ["off", "low", "high"] as const) {
      expect(HARNESS.bodyAt({ baseUrl: "https://api.example.com/v1", model: "vendor-future-1", level }), level).toEqual(
        HARNESS.expectedBody("vendor-future-1", {})
      );
      expect(HARNESS.bodyAt({ baseUrl: "https://api.openai.com/v1", model: "gpt-4o", level }), level).toEqual(HARNESS.expectedBody("gpt-4o", {}));
    }
  });
});

describe("golden（openai）：ModelScope qwen3-32b 关思考仅流式（stream 维度）", () => {
  it("非流式 off → 级联落 enable_thinking:true", () => {
    expect(HARNESS.bodyAt({ presetId: "modelscope", model: "qwen3-32b", level: "off" })).toEqual(
      HARNESS.expectedBody("qwen3-32b", { enable_thinking: true })
    );
  });

  it("流式 off → 真发 enable_thinking:false", () => {
    expect(HARNESS.bodyAt({ presetId: "modelscope", model: "qwen3-32b", level: "off", stream: true })).toEqual({
      model: "qwen3-32b",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      enable_thinking: false
    });
  });
});

describe("golden：token 参数名映射（maxTokens 按类换名，04 号票）", () => {
  const OPENAI = "https://api.openai.com/v1";
  const DEEPSEEK = "https://api.deepseek.com/v1";
  const QWEN = "https://dashscope.aliyuncs.com/compatible-mode/v1";
  const OPENROUTER = "https://openrouter.ai/api/v1";

  it("openai-reasoning（gpt-5.1）+ maxTokens → max_completion_tokens，无 max_tokens", () => {
    const body = HARNESS.bodyAt({ baseUrl: OPENAI, model: "gpt-5.1", level: "low", maxTokens: 2048 });
    expect(body).toEqual({
      model: "gpt-5.1",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      reasoning_effort: "low",
      max_completion_tokens: 2048
    });
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("openai-reasoning always 系（o3）+ maxTokens → max_completion_tokens（off 级联 low 同换名）", () => {
    const body = HARNESS.bodyAt({ baseUrl: OPENAI, model: "o3", level: "off", maxTokens: 1 });
    expect(body).toEqual({
      model: "o3",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      reasoning_effort: "low",
      max_completion_tokens: 1
    });
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("qwen 混合（qwen3-max）+ maxTokens → 仍 max_tokens（现状不变）", () => {
    const body = HARNESS.bodyAt({ baseUrl: QWEN, model: "qwen3-max", level: "low", maxTokens: 2048 });
    expect(body).toEqual({
      model: "qwen3-max",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      enable_thinking: true,
      max_tokens: 2048
    });
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it("deepseek v4（deepseek-v4-pro）+ maxTokens → 仍 max_tokens", () => {
    const body = HARNESS.bodyAt({ baseUrl: DEEPSEEK, model: "deepseek-v4-pro", level: "off", maxTokens: 4096 });
    expect(body).toEqual({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      thinking: { type: "disabled" },
      max_tokens: 4096
    });
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it("unknown 模型 + maxTokens → max_tokens（默认参数名）", () => {
    const body = HARNESS.bodyAt({ baseUrl: "https://api.example.com/v1", model: "vendor-future-1", level: "low", maxTokens: 2048 });
    expect(body).toEqual({
      model: "vendor-future-1",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      max_tokens: 2048
    });
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it("OpenRouter（18 号票起走上游词表投影）+ maxTokens → 仍 max_tokens（spec token 维度）", () => {
    const body = HARNESS.bodyAt({ baseUrl: OPENROUTER, model: "deepseek-v4-pro", level: "low", maxTokens: 2048 });
    expect(body).toEqual({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      reasoning_effort: "low",
      max_tokens: 2048
    });
    expect(body).not.toHaveProperty("max_completion_tokens");
  });
});
