import { describe, expect, it } from "vitest";
import { channelHarness, type BodyRequest, type ByClassCase } from "./thinking-golden-classes.js";
import { registerByClassDefenses, registerByClassGolden } from "./thinking-golden-defenses.js";
import { MESSAGES_OFF_EXIT, MESSAGES_TIER_EXIT } from "../../extension/ai/thinking-wire-map.js";

const HARNESS = channelHarness("anthropic");

const CASES: readonly ByClassCase[] = [
  { valuesetId: "b", presetId: "qwen", model: "kimi-k2-thinking", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "b:1024-", presetId: "openrouter", model: "anthropic/claude-haiku-4.5", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "b:128-32768", presetId: "gemini", model: "gemini-2.5-pro", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "high", presetId: "openrouter", model: "openai/gpt-5-pro", available: ["high"], fields: [{"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}] },
  { valuesetId: "high-xhigh", presetId: "openrouter", model: "sakana/fugu-ultra", available: ["high", "xhigh"], fields: [{"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"xhigh"}}] },
  { valuesetId: "high-xhigh-max", presetId: "openrouter", model: "sakana/fugu-max", available: ["high", "xhigh", "max"], fields: [{"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"max"}}] },
  { valuesetId: "low-high", presetId: "gemini", model: "gemini-3-pro-image", available: ["low", "high"], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "low-high", presetId: "openrouter", model: "google/gemini-3-pro-image", available: ["low", "high"], fields: [{"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}] },
  { valuesetId: "low-high-max", presetId: "amd", model: "GLM-5.3-Flash", available: ["low", "high", "max"], fields: [{"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"max"}}] },
  { valuesetId: "low-high-max", presetId: "moonshot", model: "k3-256k", available: ["low", "high", "max"], fields: [{"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"max"}] },
  { valuesetId: "low-high-max", presetId: "qwen", model: "glm-5.3", available: ["low", "high", "max"], fields: [{"output_config":{"effort":"low"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"low"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"low"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"low"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"max"},"thinking":{"type":"enabled"}}] },
  { valuesetId: "low-medium", presetId: "amd", model: "Qwen3.8-27B", available: ["low", "medium"], fields: [{"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}] },
  { valuesetId: "low-medium-high", presetId: "gemini", model: "gemini-3.1-pro-preview", available: ["low", "medium", "high"], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "low-medium-high", presetId: "opencodego", model: "gemini-4-argon", available: ["low", "medium", "high"], fields: [{"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}] },
  { valuesetId: "low-medium-high+b:1024-", presetId: "openrouter", model: "anthropic/claude-opus-4.5", available: ["low", "medium", "high"], fields: [{"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}] },
  { valuesetId: "low-medium-high-max+b:1024-", presetId: "openrouter", model: "anthropic/claude-opus-4.6", available: ["low", "medium", "high", "max"], fields: [{"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"max"}}] },
  { valuesetId: "low-medium-high-xhigh", presetId: "opencodego", model: "grok-4.7", available: ["low", "medium", "high", "xhigh"], fields: [{"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"xhigh"}}] },
  { valuesetId: "low-medium-high-xhigh-max", presetId: "minimax", model: "MiniMax-M3.1-Flash", available: ["low", "medium", "high", "xhigh", "max"], fields: [{"output_config":{"effort":"low"},"thinking":{"type":"adaptive"}}, {"output_config":{"effort":"low"},"thinking":{"type":"adaptive"}}, {"output_config":{"effort":"low"},"thinking":{"type":"adaptive"}}, {"output_config":{"effort":"medium"},"thinking":{"type":"adaptive"}}, {"output_config":{"effort":"high"},"thinking":{"type":"adaptive"}}, {"output_config":{"effort":"xhigh"},"thinking":{"type":"adaptive"}}, {"output_config":{"effort":"max"},"thinking":{"type":"adaptive"}}] },
  { valuesetId: "low-medium-high-xhigh-max", presetId: "opencodego", model: "beam-free", available: ["low", "medium", "high", "xhigh", "max"], fields: [{"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"max"}}] },
  { valuesetId: "low-medium-xhigh", presetId: "amd", model: "Qwen3.8-Flash-Next", available: ["low", "medium", "xhigh"], fields: [{"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"xhigh"}}] },
  { valuesetId: "medium-high-xhigh", presetId: "openrouter", model: "openai/gpt-5.2-pro", available: ["medium", "high", "xhigh"], fields: [{"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"xhigh"}}] },
  { valuesetId: "minimal-high", presetId: "gemini", model: "gemini-3.1-flash-image", available: ["minimal", "high"], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "minimal-high", presetId: "openrouter", model: "google/gemini-3.1-flash-image", available: ["minimal", "high"], fields: [{"output_config":{"effort":"minimal"}}, {"output_config":{"effort":"minimal"}}, {"output_config":{"effort":"minimal"}}, {"output_config":{"effort":"minimal"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}] },
  { valuesetId: "minimal-low-medium-high", presetId: "gemini", model: "gemini-3-flash-preview", available: ["minimal", "low", "medium", "high"], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "minimal-low-medium-high", presetId: "openrouter", model: "google/gemini-3-flash-preview", available: ["minimal", "low", "medium", "high"], fields: [{"output_config":{"effort":"minimal"}}, {"output_config":{"effort":"minimal"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}] },
  { valuesetId: "minimal-low-medium-high-xhigh", presetId: "opencodego", model: "muse-spark-1.2-contributor", available: ["minimal", "low", "medium", "high", "xhigh"], fields: [{"output_config":{"effort":"minimal"}}, {"output_config":{"effort":"minimal"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"xhigh"}}] },
  { valuesetId: "minimal-low-medium-high-xhigh-max", presetId: "opencodego", model: "crouton-alpha-free", available: ["minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"output_config":{"effort":"minimal"}}, {"output_config":{"effort":"minimal"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"max"}}] },
  { valuesetId: "none-high", presetId: "opencodego", model: "hy4", available: ["off", "high"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}] },
  { valuesetId: "none-low-high", presetId: "opencodego", model: "hy3", available: ["off", "low", "high"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}] },
  { valuesetId: "none-low-high-max", presetId: "moonshot", model: "kimi-for-coding", available: ["off", "low", "high", "max"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"reasoning_effort":"low"}, {"reasoning_effort":"low"}, {"reasoning_effort":"high"}, {"reasoning_effort":"high"}, {"reasoning_effort":"max"}] },
  { valuesetId: "none-low-high-max", presetId: "openrouter", model: "fireworks/ember-1", available: ["off", "low", "high", "max"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"max"}}] },
  { valuesetId: "none-low-medium+b", presetId: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b", available: ["off", "low", "medium"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}] },
  { valuesetId: "none-low-medium-high", presetId: "openrouter", model: "bytedance-seed/seed-2.0-code", available: ["off", "low", "medium", "high"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}] },
  { valuesetId: "none-low-medium-high", presetId: "sensenova", model: "sensenova-6.8-flash-lite", available: ["off", "low", "medium", "high"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"output_config":{"effort":"low"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"medium"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}] },
  { valuesetId: "none-low-medium-high-xhigh", presetId: "openrouter", model: "openai/gpt-5.2", available: ["off", "low", "medium", "high", "xhigh"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"xhigh"}}] },
  { valuesetId: "none-low-medium-high-xhigh-max", presetId: "opencodego", model: "gpt-5.6-luna", available: ["off", "low", "medium", "high", "xhigh", "max"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"max"}}] },
  { valuesetId: "none-low-medium-xhigh", presetId: "openrouter", model: "qwen/qwen3.8-27b", available: ["off", "low", "medium", "xhigh"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"xhigh"}}] },
  { valuesetId: "none-low-medium-xhigh", presetId: "qwen", model: "qwen3.8-omni-flash", available: ["off", "low", "medium", "xhigh"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"output_config":{"effort":"low"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"medium"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"medium"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"xhigh"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"xhigh"},"thinking":{"type":"enabled"}}] },
  { valuesetId: "none-medium-high", presetId: "openrouter", model: "nex-agi/nex-n2.5-mini", available: ["off", "medium", "high"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}] },
  { valuesetId: "none-medium-high+b", presetId: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b", available: ["off", "medium", "high"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}] },
  { valuesetId: "none-medium-xhigh", presetId: "openrouter", model: "prism-ml/ternary-bonsai-2-27b", available: ["off", "medium", "xhigh"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"xhigh"}}] },
  { valuesetId: "none-minimal-high", presetId: "openrouter", model: "google/gemini-3.1-flash-image-preview", available: ["off", "minimal", "high"], fields: [{"thinking":{"type":"disabled"}}, {"output_config":{"effort":"minimal"}}, {"output_config":{"effort":"minimal"}}, {"output_config":{"effort":"minimal"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}] },
  { valuesetId: "none-minimal-low-medium-high", presetId: "openrouter", model: "bytedance-seed/seed-2.0-lite", available: ["off", "minimal", "low", "medium", "high"], fields: [{"thinking":{"type":"disabled"}}, {"output_config":{"effort":"minimal"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}] },
  { valuesetId: "none-minimal-low-medium-high-max", presetId: "openrouter", model: "thinkingmachines/inkling", available: ["off", "minimal", "low", "medium", "high", "max"], fields: [{"thinking":{"type":"disabled"}}, {"output_config":{"effort":"minimal"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"max"}}] },
  { valuesetId: "none-minimal-low-medium-high-xhigh-max", presetId: "openrouter", model: "particle-ai/particle-1", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"thinking":{"type":"disabled"}}, {"output_config":{"effort":"minimal"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"max"}}] },
  { valuesetId: "toggle", presetId: "amd", model: "Gemma-4-31B-IT", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "toggle", presetId: "mimo", model: "mimo-v2.5", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}] },
  { valuesetId: "toggle", presetId: "minimax", model: "MiniMax-M3", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"adaptive"}}, {"thinking":{"type":"adaptive"}}, {"thinking":{"type":"adaptive"}}, {"thinking":{"type":"adaptive"}}, {"thinking":{"type":"adaptive"}}, {"thinking":{"type":"adaptive"}}] },
  { valuesetId: "toggle+b", presetId: "opencodego", model: "qwen3.7-plus", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "toggle+b", presetId: "qwen", model: "qwen3.6-flash", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}] },
  { valuesetId: "toggle+b:-131072", presetId: "qwen", model: "glm-5.1", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}] },
  { valuesetId: "toggle+b:-262144", presetId: "openrouter", model: "qwen/qwen3.7-flash", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "toggle+b:-262144", presetId: "qwen", model: "qwen3.7-flash", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}] },
  { valuesetId: "toggle+b:-32768", presetId: "qwen", model: "glm-5", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}] },
  { valuesetId: "toggle+b:-38912", presetId: "qwen", model: "qwen-turbo", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}] },
  { valuesetId: "toggle+b:-81920", presetId: "qwen", model: "kimi-k2.5", available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}, {"thinking":{"type":"enabled"}}] },
  { valuesetId: "toggle+b:0-24576", presetId: "gemini", model: "gemini-2.5-flash", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "toggle+b:1-", presetId: "openrouter", model: "cohere/command-a-plus", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "toggle+b:512-24576", presetId: "gemini", model: "gemini-2.5-flash-lite", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "toggle+high-max", presetId: "opencodego", model: "glm-5.2", available: ["high", "max"], fields: [{"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"max"}}] },
  { valuesetId: "toggle+high-max", presetId: "qwen", model: "glm-5.2", available: ["off", "high", "max"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"max"},"thinking":{"type":"enabled"}}] },
  { valuesetId: "toggle+high-max", presetId: "sensenova", model: "glm-5.2", available: ["high", "max"], fields: [{"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"max"},"thinking":{"type":"enabled"}}] },
  { valuesetId: "toggle+low-high-max", presetId: "amd", model: "DeepSeek-V4-Flash", available: ["low", "high", "max"], fields: [{"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"max"}}] },
  { valuesetId: "toggle+low-high-max", presetId: "deepseek", model: "deepseek-flash", available: ["off", "low", "high", "max"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"output_config":{"effort":"low"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"low"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"max"},"thinking":{"type":"enabled"}}] },
  { valuesetId: "toggle+low-high-max", presetId: "sensenova", model: "deepseek-v4-flash", available: ["low", "high", "max"], fields: [{"output_config":{"effort":"low"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"low"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"low"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"low"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"high"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"max"},"thinking":{"type":"enabled"}}] },
  { valuesetId: "toggle+low-medium-high-xhigh-max", presetId: "opencodego", model: "claude-haiku-5-5", available: ["low", "medium", "high", "xhigh", "max"], fields: [{"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"high"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"max"}}] },
  { valuesetId: "toggle+low-medium-xhigh+b:-262144", presetId: "opencodego", model: "qwen3.8-flash", available: ["low", "medium", "xhigh"], fields: [{"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"xhigh"}}] },
  { valuesetId: "toggle+low-medium-xhigh+b:-262144", presetId: "qwen", model: "qwen3.8-flash", available: ["off", "low", "medium", "xhigh"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"output_config":{"effort":"low"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"medium"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"medium"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"xhigh"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"xhigh"},"thinking":{"type":"enabled"}}] },
  { valuesetId: "toggle+low-medium-xhigh+b:0-262144", presetId: "opencodego", model: "qwen3.8-max", available: ["low", "medium", "xhigh"], fields: [{"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"low"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"medium"}}, {"output_config":{"effort":"xhigh"}}, {"output_config":{"effort":"xhigh"}}] },
  { valuesetId: "toggle+low-medium-xhigh+b:0-262144", presetId: "qwen", model: "qwen3.8-max", available: ["off", "low", "medium", "xhigh"], fields: [{"thinking":{"type":"disabled"}}, {"thinking":{"type":"disabled"}}, {"output_config":{"effort":"low"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"medium"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"medium"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"xhigh"},"thinking":{"type":"enabled"}}, {"output_config":{"effort":"xhigh"},"thinking":{"type":"enabled"}}] },
];

registerByClassGolden(HARNESS, CASES);
registerByClassDefenses(HARNESS, CASES);

describe("golden：每方言一条精确 body（Messages 通道）", () => {
  it("(1) deepseek/deepseek-v4-pro：关思考出口 thinking:{type:disabled}", () => {
    expect(HARNESS.bodyAt({ presetId: "deepseek", model: "deepseek-v4-pro", level: "off" })).toEqual(
      HARNESS.expectedBody("deepseek-v4-pro", { thinking: { type: "disabled" } })
    );
  });

  it("(2) qwen/qwen3-max：开关型开档 = 裸 thinking:{type:enabled}（上游 toggle+budget，无 effort → low==high）", () => {
    const low = HARNESS.bodyAt({ presetId: "qwen", model: "qwen3-max", level: "low" });
    const high = HARNESS.bodyAt({ presetId: "qwen", model: "qwen3-max", level: "high" });
    expect(low).toEqual(HARNESS.expectedBody("qwen3-max", { thinking: { type: "enabled" } }));
    expect(high).toEqual(low);
  });

  it("(3) qwen/qwen3.8-max：thinking:{type:enabled} + output_config.effort（high 向下取 medium）", () => {
    expect(HARNESS.bodyAt({ presetId: "qwen", model: "qwen3.8-max", level: "low" })).toEqual(
      HARNESS.expectedBody("qwen3.8-max", { thinking: { type: "enabled" }, output_config: { effort: "low" } })
    );
    expect(HARNESS.bodyAt({ presetId: "qwen", model: "qwen3.8-max", level: "high" })).toEqual(
      HARNESS.expectedBody("qwen3.8-max", { thinking: { type: "enabled" }, output_config: { effort: "medium" } })
    );
  });

  it("(4) opencodego/deepseek-v4-flash：裸 output_config.effort（网关档位词，不带 thinking 对象）", () => {
    expect(HARNESS.bodyAt({ presetId: "opencodego", model: "deepseek-v4-flash", level: "low" })).toEqual(
      HARNESS.expectedBody("deepseek-v4-flash", { output_config: { effort: "low" } })
    );
  });

  it("(5) moonshot/kimi-k3：顶层 reasoning_effort（Kimi Code 端点未登记 thinking 形状）", () => {
    expect(HARNESS.bodyAt({ presetId: "moonshot", model: "kimi-k3", level: "low" })).toEqual(
      HARNESS.expectedBody("kimi-k3", { reasoning_effort: "low" })
    );
  });

  it("(6) qwen/qwen3-next-80b-a3b-thinking：不发任何思考字段（上游只有 budget_tokens，无 toggle 无 effort）", () => {
    for (const level of ["off", "low", "high"] as const) {
      expect(HARNESS.bodyAt({ presetId: "qwen", model: "qwen3-next-80b-a3b-thinking", level }), level).toEqual(
        HARNESS.expectedBody("qwen3-next-80b-a3b-thinking", {})
      );
    }
  });

  it("(7) opencodego/kimi-k3（13 号票 canonical 词表；18 号票起平台不再补档）→ 裸 effort，off 级联落 low", () => {
    expect(HARNESS.bodyAt({ presetId: "opencodego", model: "kimi-k3", level: "max" })).toEqual(
      HARNESS.expectedBody("kimi-k3", { output_config: { effort: "max" } })
    );
    expect(HARNESS.bodyAt({ presetId: "opencodego", model: "kimi-k3", level: "high" })).toEqual(
      HARNESS.expectedBody("kimi-k3", { output_config: { effort: "high" } })
    );
    expect(HARNESS.bodyAt({ presetId: "opencodego", model: "kimi-k3", level: "off" })).toEqual(
      HARNESS.expectedBody("kimi-k3", { output_config: { effort: "low" } })
    );
  });
});

describe("golden：探针变体（probe 不发思考字段）", () => {
  it("deepseek + deepseek-v4-pro + probe + maxTokens:1 + high → 无 thinking", () => {
    expect(HARNESS.bodyAt({ presetId: "deepseek", model: "deepseek-v4-pro", level: "high", probe: true, maxTokens: 1 })).toEqual({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      max_tokens: 1
    });
  });

  it("stepfun + step-3.7-flash + probe + maxTokens:1 + high → 无 output_config", () => {
    expect(HARNESS.bodyAt({ presetId: "stepfun", model: "step-3.7-flash", level: "high", probe: true, maxTokens: 1 })).toEqual({
      model: "step-3.7-flash",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      max_tokens: 1
    });
  });
});

describe("golden：ModelScope qwen3-32b 关思考仅流式（stream 维度）", () => {
  it("stream:true + off → thinking:disabled", () => {
    expect(HARNESS.bodyAt({ presetId: "modelscope", model: "qwen3-32b", level: "off", stream: true })).toEqual({
      model: "qwen3-32b",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      max_tokens: 32768,
      thinking: { type: "disabled" }
    });
  });

  it("stream:false + off → 级联落开档（裸 thinking:enabled，无预算）", () => {
    expect(HARNESS.bodyAt({ presetId: "modelscope", model: "qwen3-32b", level: "off", stream: false })).toEqual({
      model: "qwen3-32b",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      max_tokens: 32768,
      thinking: { type: "enabled" }
    });
  });
});

describe("golden：塌陷正当性（上游事实 vs 缺陷）", () => {
  it("zhipu/glm-5.2：上游 effort[high,max] 无 low/xhigh → low 折 off、xhigh 折 high", () => {
    const low = HARNESS.bodyAt({ presetId: "zhipu", model: "glm-5.2", level: "low" });
    expect(low).toEqual(HARNESS.expectedBody("glm-5.2", { thinking: { type: "disabled" } }));
    const xhigh = HARNESS.bodyAt({ presetId: "zhipu", model: "glm-5.2", level: "xhigh" });
    expect(xhigh).toEqual(HARNESS.bodyAt({ presetId: "zhipu", model: "glm-5.2", level: "high" }));
    expect(xhigh).toEqual(
      HARNESS.expectedBody("glm-5.2", { thinking: { type: "enabled" }, output_config: { effort: "high" } })
    );
  });

  it("qwen/qwen3-max：budget-only（无 effort）→ low==high 同为裸开档（上游唯一形状）", () => {
    expect(HARNESS.bodyAt({ presetId: "qwen", model: "qwen3-max", level: "low" })).toEqual(
      HARNESS.bodyAt({ presetId: "qwen", model: "qwen3-max", level: "high" })
    );
  });

  it("qwen/qwen3-next-80b-a3b-thinking：budget-only → 全档不发（不发预算、不臆造档位）", () => {
    expect(HARNESS.bodyAt({ presetId: "qwen", model: "qwen3-next-80b-a3b-thinking", level: "low" })).toEqual(
      HARNESS.bodyAt({ presetId: "qwen", model: "qwen3-next-80b-a3b-thinking", level: "high" })
    );
  });
});

const OFF_CELL_REPRESENTATIVES: Readonly<
  Record<string, { presetId: string; baseUrl?: string; model: string; expect: Record<string, unknown>; note: string }>
> = {
  deepseek: { presetId: "deepseek", model: "deepseek-v4-pro", expect: { thinking: { type: "disabled" } }, note: "目录行：上游 toggle + 形状登记" },
  qwen: { presetId: "qwen", model: "qwen3.8-max", expect: { thinking: { type: "disabled" } }, note: "目录行：上游 toggle + 形状登记（enable_thinking）" },
  zhipu: { presetId: "zhipu", model: "glm-5.2", expect: { thinking: { type: "disabled" } }, note: "目录行：上游 toggle + 形状登记（thinking.type 原生参数）" },
  moonshot: { presetId: "moonshot", model: "kimi-for-coding", expect: { thinking: { type: "disabled" } }, note: "目录行：上游 toggle + 形状登记" },
  minimax: { presetId: "minimax", model: "MiniMax-M3", expect: { thinking: { type: "disabled" } }, note: "目录行：上游 toggle + 形状登记（thinking.type 枚举 disabled / adaptive，2026-10-05）" },
  mimo: { presetId: "mimo", model: "mimo-v2-flash", expect: { thinking: { type: "disabled" } }, note: "目录行：上游 toggle + 形状登记（enable_thinking）" },
  openrouter: { presetId: "openrouter", model: "openai/gpt-5.2", expect: { thinking: { type: "disabled" } }, note: "目录行：值集自带 effort-none" },
  opencodego: { presetId: "opencodego", model: "hy3", expect: { thinking: { type: "disabled" } }, note: "目录行：值集自带 effort-none" },
  sensenova: { presetId: "sensenova", model: "sensenova-6.8-flash-lite", expect: { thinking: { type: "disabled" } }, note: "目录行：值集自带 effort-none" },
  modelscope: { presetId: "modelscope", model: "ZhipuAI/GLM-4.6", expect: { thinking: { type: "disabled" } }, note: "目录行 + off 专项实测（怪癖 thinkingDisabledMustBeExplicit）" },
  stepfun: { presetId: "stepfun", model: "gpt-5.2", expect: {}, note: "手写兜底行：静默格（怪癖 effortVocabMessages；目录行无 off 写点）" },
  amd: { presetId: "amd", model: "gpt-5.2", expect: {}, note: "手写兜底行：静默格（怪癖 effortVocabMessages；目录行无 off 写点）" },
  ollama: { presetId: "ollama", model: "llama3.2", expect: { thinking: { type: "disabled" } }, note: "手写兜底行：unknownClass ollama-effort 的 off 写点" },
  siliconflow: {
    presetId: "custom",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "llama3",
    expect: { thinking: { type: "disabled" } },
    note: "custom 直填 baseUrl → host 索引命中 siliconflow，unknownClass siliconflow-switch 的 off 写点"
  },
  gemini: {
    presetId: "gemini",
    model: "gemini-2.5-flash",
    expect: {},
    note: "非 Messages 平台（构造性不适用，不发字段）"
  }
};

describe("off 出口逐格 golden（thinking-wire-protocol-split 02）：表键全覆盖", () => {
  it("代表格覆盖表键全集（表新增一格而 golden 没跟 → 红）", () => {
    expect(Object.keys(OFF_CELL_REPRESENTATIVES).sort()).toEqual(Object.keys(MESSAGES_OFF_EXIT).sort());
  });

  for (const [platform, rep] of Object.entries(OFF_CELL_REPRESENTATIVES)) {
    it(`${platform}（${rep.note}）：off → 整 body 逐字节`, () => {
      expect(HARNESS.bodyAt({ presetId: rep.presetId, baseUrl: rep.baseUrl, model: rep.model, level: "off" })).toEqual(
        HARNESS.expectedBody(rep.model, rep.expect)
      );
    });
  }

  it("minimax 目录外 id（M2.x / M3.1，形状是平台级门）：一个思考字段都不发", () => {
    for (const model of ["MiniMax-M2", "MiniMax-M2.7", "MiniMax-M3.1-Flash-Preview"]) {
      expect(HARNESS.bodyAt({ presetId: "minimax", model, level: "off" }), model).toEqual(HARNESS.expectedBody(model, {}));
    }
  });

  it("表外（custom 直填 api.openai.com / gpt-5.2）：未声明 → 原生，逐字节 body", () => {
    expect(
      HARNESS.bodyAt({ presetId: "custom", baseUrl: "https://api.openai.com/v1", model: "gpt-5.2", level: "off" })
    ).toEqual(HARNESS.expectedBody("gpt-5.2", { thinking: { type: "disabled" } }));
  });
});

const TIER_CELL_REPRESENTATIVES: Readonly<
  Record<
    string,
    {
      presetId: string;
      baseUrl?: string;
      model: string;
      level: BodyRequest["level"];
      expect: Record<string, unknown>;
      note: string;
    }
  >
> = {
  deepseek: {
    presetId: "deepseek",
    model: "deepseek-flash",
    level: "low",
    expect: { output_config: { effort: "low" }, thinking: { type: "enabled" } },
    note: "目录行：上游 effort 档位 + 形状登记 → output_config.effort + 开思考开关"
  },
  qwen: {
    presetId: "qwen",
    model: "deepseek-v4-flash",
    level: "low",
    expect: { output_config: { effort: "low" }, thinking: { type: "enabled" } },
    note: "目录行：百炼 Anthropic 兼容页登记 output_config.effort + thinking"
  },
  zhipu: {
    presetId: "zhipu",
    model: "glm-5.2",
    level: "high",
    expect: { output_config: { effort: "high" }, thinking: { type: "enabled" } },
    note: "目录行：GLM-5.2 词表只有 high/max（low/medium 服务端折成 high）"
  },
  moonshot: {
    presetId: "moonshot",
    model: "k3-256k",
    level: "low",
    expect: { reasoning_effort: "low" },
    note: "目录行：Kimi Code 端点登记的档位出口是顶层 reasoning_effort（无 thinking 形状）"
  },
  minimax: {
    presetId: "minimax",
    model: "glm-5.2",
    level: "low",
    expect: { output_config: { effort: "low" }, thinking: { type: "adaptive" } },
    note: "手写兜底行（目录唯一一行是 toggle 型，无 effort 档位）→ 档位出口 output_config.effort + 平台自有开词 adaptive（2026-10-05 登记）"
  },
  mimo: {
    presetId: "mimo",
    model: "glm-5.2",
    level: "low",
    expect: { output_config: { effort: "low" } },
    note: "手写兜底行（目录行是 toggle 型）→ Messages 侧档位出口无文档，裸 effort"
  },
  openrouter: {
    presetId: "openrouter",
    model: "~anthropic/claude-fable-latest",
    level: "low",
    expect: { output_config: { effort: "low" } },
    note: "目录行：/messages 登记 output_config.effort，但 thinking.enabled 必带预算 → 不带 thinking"
  },
  opencodego: {
    presetId: "opencodego",
    model: "deepseek-v4-flash",
    level: "low",
    expect: { output_config: { effort: "low" } },
    note: "目录行：网关未登记思考控制参数，产品裁定发裸 effort"
  },
  sensenova: {
    presetId: "sensenova",
    model: "deepseek-v4-flash",
    level: "low",
    expect: { output_config: { effort: "low" }, thinking: { type: "enabled" } },
    note: "目录行：thinking.type 与 output_config.effort 均登记"
  },
  stepfun: {
    presetId: "stepfun",
    model: "step-3.5-flash",
    level: "low",
    expect: { output_config: { effort: "low" } },
    note: "怪癖托管格（effortVocabMessages）：只发裸 output_config.effort，不发 thinking"
  },
  amd: {
    presetId: "amd",
    model: "DeepSeek-V4-Flash",
    level: "low",
    expect: { output_config: { effort: "low" } },
    note: "怪癖托管格（effortVocabMessages）：网关拒 thinking 形状，只发裸 effort"
  },
  ollama: {
    presetId: "ollama",
    model: "glm-5.2",
    level: "low",
    expect: { output_config: { effort: "low" } },
    note: "手写兜底行（无上游）：Messages 通道无档位字段文档，裸 effort"
  },
  siliconflow: {
    presetId: "custom",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "glm-5.2",
    level: "low",
    expect: { output_config: { effort: "low" } },
    note: "custom 直填 baseUrl → host 索引命中 siliconflow（Messages 侧未登记档位字段）"
  },
  modelscope: {
    presetId: "modelscope",
    model: "glm-5.2",
    level: "low",
    expect: { output_config: { effort: "low" } },
    note: "手写兜底行（目录行是 toggle 型）→ 端点未登记档位字段，产品裁定发裸 effort"
  },
  gemini: {
    presetId: "gemini",
    model: "gemini-2.5-flash",
    level: "low",
    expect: {},
    note: "非 Messages 平台（构造性不适用，不发字段）"
  }
};

describe("档位出口逐格 golden（thinking-wire-protocol-split 01）：表键全覆盖", () => {
  it("代表格覆盖表键全集（表新增一格而 golden 没跟 → 红）", () => {
    expect(Object.keys(TIER_CELL_REPRESENTATIVES).sort()).toEqual(Object.keys(MESSAGES_TIER_EXIT).sort());
  });

  for (const [platform, rep] of Object.entries(TIER_CELL_REPRESENTATIVES)) {
    it(`${platform}（${rep.note}）：${rep.level} → 整 body 逐字节`, () => {
      expect(
        HARNESS.bodyAt({ presetId: rep.presetId, baseUrl: rep.baseUrl, model: rep.model, level: rep.level })
      ).toEqual(HARNESS.expectedBody(rep.model, rep.expect));
    });
  }

  it("表外（custom 直填 api.openai.com / gpt-5.2）：未声明 → 裸 output_config.effort", () => {
    expect(
      HARNESS.bodyAt({ presetId: "custom", baseUrl: "https://api.openai.com/v1", model: "gpt-5.2", level: "low" })
    ).toEqual(HARNESS.expectedBody("gpt-5.2", { output_config: { effort: "low" } }));
  });

  it("同一平台的 off 与档位落在两处不同的写法（两表各自表态；01 号票点名的 moonshot 擦边格）", () => {
    expect(HARNESS.bodyAt({ presetId: "moonshot", model: "kimi-for-coding", level: "off" })).toEqual(
      HARNESS.expectedBody("kimi-for-coding", { thinking: { type: "disabled" } })
    );
    expect(HARNESS.bodyAt({ presetId: "moonshot", model: "kimi-for-coding", level: "low" })).toEqual(
      HARNESS.expectedBody("kimi-for-coding", { reasoning_effort: "low" })
    );
    expect(HARNESS.bodyAt({ presetId: "deepseek", model: "deepseek-flash", level: "off" })).toEqual(
      HARNESS.expectedBody("deepseek-flash", { thinking: { type: "disabled" } })
    );
  });
});
