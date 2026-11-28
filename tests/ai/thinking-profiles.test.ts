import { describe, expect, it } from "vitest";
import {
  CLASSES,
  TAXONOMY,
  EXCEPTIONS,
  PROVIDERS,
  UNKNOWN_VOCABULARY,
  reasoningEffort,
  resolveThinkingProfile,
  validateThinkingTables,
  type ResolveThinkingInput
} from "../../extension/ai/thinking-profiles.js";
import { openaiVocabularyFields } from "../../extension/ai/thinking-wire-map.js";

const OPENAI_URL = "https://api.openai.com/v1";
const DEEPSEEK_URL = "https://api.deepseek.com/v1";
const QWEN_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const ZHIPU_URL = "https://open.bigmodel.cn/api/paas/v4";
const KIMI_URL = "https://api.kimi.com/coding/v1";
const MIMO_URL = "https://api.xiaomimimo.com/v1";
const OPENROUTER_URL = "https://openrouter.ai/api/v1";
const MODELSCOPE_URL = "https://api-inference.modelscope.cn/v1";
const OLLAMA_URL = "http://localhost:11434/v1";
const SILICONFLOW_URL = "https://api.siliconflow.cn/v1";
const AMD_URL = "https://developer.amd.com.cn/radeon/api/v1";
const SENSENOVA_URL = "https://token.sensenova.cn/v1";

const resolve = (overrides: Partial<ResolveThinkingInput>) => resolveThinkingProfile({ model: "m", level: "off", stream: false, ...overrides });

describe("识别优先级：例外表 >> 模式表 >> unknownClass >> UNKNOWN", () => {
  it("例外表压过模式表：qwen3.8-max 走上游值集（effort 档，偏好 high 由 clamp 向下取到 medium），qwen3.8- 前缀其余模型走模式表开关", () => {
    expect(openaiVocabularyFields(resolve({ baseUrl: QWEN_URL, model: "qwen3.8-max", level: "high" }).vocabulary)).toEqual({
      reasoning_effort: "medium"
    });
    expect(openaiVocabularyFields(resolve({ baseUrl: QWEN_URL, model: "qwen3.8-plus", level: "high" }).vocabulary)).toEqual({
      enable_thinking: true
    });
  });

  it("模式表数组序=优先级：step-3.7 条目先于 step-3 前缀命中（effort 而非无档位）", () => {
    expect(openaiVocabularyFields(resolve({ baseUrl: "https://api.example.com/v1", model: "step-3.7-flash", level: "high" }).vocabulary)).toEqual({
      reasoning_effort: "high"
    });
    expect(resolve({ baseUrl: "https://api.example.com/v1", model: "step-3", level: "high" }).thinkingClass).toBe("always");
  });

  it("模式为前缀匹配：日期快照/变体后缀自然命中（gpt-5.1-2025-11-13 off → effort none）", () => {
    expect(openaiVocabularyFields(resolve({ baseUrl: OPENAI_URL, model: "gpt-5.1-2025-11-13", level: "off" }).vocabulary)).toEqual({
      reasoning_effort: "none"
    });
  });

  it("模式内嵌 * 为两端锚定通配：qwen3-next-80b-a3b-thinking → 永远思考", () => {
    expect(resolve({ baseUrl: QWEN_URL, model: "qwen3-next-80b-a3b-thinking", level: "off" }).thinkingClass).toBe("always");
  });

  it("模型名大小写归一：MiniMax-M2 命中 minimax 模式表", () => {
    expect(resolve({ baseUrl: "https://api.minimaxi.com/v1", model: "MiniMax-M2", level: "off" }).thinkingClass).toBe("always");
  });

  it("模式表压过 unknownClass：Ollama 上的 deepseek-r1:8b 按血统落永远思考，不吃平台 effort 兜底", () => {
    const r = resolve({ baseUrl: OLLAMA_URL, model: "deepseek-r1:8b", level: "off" });
    expect(r.thinkingClass).toBe("always");
    expect(openaiVocabularyFields(r.vocabulary)).toEqual({});
  });

  it("unknownClass 兜底平台无关词汇：Ollama 未列模型走 effort 词汇（off=none）", () => {
    const r = resolve({ baseUrl: OLLAMA_URL, model: "llama3.2", level: "off" });
    expect(openaiVocabularyFields(r.vocabulary)).toEqual({ reasoning_effort: "none" });
    expect(r.thinkingClass).toBe("hybrid");
  });

  it("剥 org 前缀只用于模式表：命名空间 id 命中血统方言（modelscope + deepseek-ai/DeepSeek-V4.1-Flash 不再塌成开关）", () => {
    const model = "deepseek-ai/DeepSeek-V4.1-Flash";
    expect(resolve({ baseUrl: MODELSCOPE_URL, model, level: "off" }).thinkingClass).toBe("hybrid");
    expect(openaiVocabularyFields(resolve({ baseUrl: MODELSCOPE_URL, model, level: "off" }).vocabulary)).toEqual({
      thinking: { type: "disabled" }
    });
    expect(openaiVocabularyFields(resolve({ baseUrl: MODELSCOPE_URL, model, level: "high" }).vocabulary)).toEqual({
      reasoning_effort: "high"
    });
  });

  it("剥 org 前缀不动例外表：百炼的 streamOnly 平台事实不随命名空间 id 搬到 ModelScope（Qwen/Qwen3-32B 非流式 off 照发平台开关）", () => {
    const r = resolve({ baseUrl: MODELSCOPE_URL, model: "Qwen/Qwen3-32B", level: "off" });
    expect(r.thinkingClass).toBe("hybrid");
    expect(r.offUnavailable).toBe(false);
    expect(openaiVocabularyFields(r.vocabulary)).toEqual({ enable_thinking: false });
  });

  it("剥前缀取最后一段斜杠后的裸名", () => {
    expect(openaiVocabularyFields(resolve({ baseUrl: MODELSCOPE_URL, model: "Qwen/deepseek-ai/DeepSeek-V4", level: "high" }).vocabulary)).toEqual({
      reasoning_effort: "high"
    });
  });

  it("无任何事实 → 显式 UNKNOWN 哨兵：三档均不发、offUnavailable=false（UI 无提示）", () => {
    for (const level of ["off", "low", "high"]) {
      expect(resolve({ baseUrl: "https://api.example.com/v1", model: "totally-unknown", level })).toEqual({
        vocabulary: UNKNOWN_VOCABULARY,
        requestedLevel: level,
        effectiveLevel: null,
        offUnavailable: false,
        offFallback: null,
        thinkingClass: "unknown"
      });
    }
  });

  it("模型名空串 → unknown（不发任何字段）", () => {
    expect(resolve({ baseUrl: DEEPSEEK_URL, model: "" })).toEqual({
      vocabulary: UNKNOWN_VOCABULARY,
      requestedLevel: "off",
      effectiveLevel: null,
      offUnavailable: false,
      offFallback: null,
      thinkingClass: "unknown"
    });
  });
});

describe("off 级联（spec 最终版）", () => {
  it("never：off 不发且静默（offUnavailable=false，关思考已天然成立）", () => {
    const r = resolve({ baseUrl: DEEPSEEK_URL, model: "deepseek-chat", level: "off" });
    expect(openaiVocabularyFields(r.vocabulary)).toEqual({});
    expect(r.offUnavailable).toBe(false);
    expect(r.thinkingClass).toBe("never");
  });

  it("always 无 low 档：off 不发但标记 offUnavailable（目录外的 minimax-m2 落手写 minimax-always；M2.x 官方文档：思考不可关闭）", () => {
    const r = resolve({ baseUrl: "https://api.minimaxi.com/v1", model: "minimax-m2", level: "off" });
    expect(openaiVocabularyFields(r.vocabulary)).toEqual({});
    expect(r.offUnavailable).toBe(true);
    expect(r.thinkingClass).toBe("always");
  });

  it("always 有 low 档：off 落 low patch + offUnavailable（glm-5.3 → effort low）", () => {
    const r = resolve({ baseUrl: ZHIPU_URL, model: "glm-5.3", level: "off" });
    expect(openaiVocabularyFields(r.vocabulary)).toEqual({ reasoning_effort: "low" });
    expect(r.offUnavailable).toBe(true);
    expect(r.thinkingClass).toBe("always");
  });

  it("13 号票 canonical 优先：kimi-k3 的模型侧词表不再有 toggle → off 关不掉，级联落 low", () => {
    const r = resolve({ baseUrl: KIMI_URL, model: "kimi-k3", level: "off" });
    expect(openaiVocabularyFields(r.vocabulary)).toEqual({ reasoning_effort: "low" });
    expect(r.offUnavailable).toBe(true);
    expect(r.offFallback).toBe("low");
    expect(r.thinkingClass).toBe("always");
  });

  it("hybrid off 声明存在时直接发（无级联、无标记）", () => {
    const r = resolve({ baseUrl: QWEN_URL, model: "qwen3-max", level: "off" });
    expect(openaiVocabularyFields(r.vocabulary)).toEqual({ enable_thinking: false });
    expect(r.offUnavailable).toBe(false);
  });

  it("Q12C：low/high 缺档不 clamp、不发（kimi-k2.7-code 无档位）", () => {
    expect(openaiVocabularyFields(resolve({ baseUrl: KIMI_URL, model: "kimi-k2.7-code", level: "low" }).vocabulary)).toEqual({});
    expect(openaiVocabularyFields(resolve({ baseUrl: KIMI_URL, model: "kimi-k2.7-code", level: "high" }).vocabulary)).toEqual({});
  });
});

describe("offFallback：off 级联去向的显式字段（03 号票 UI 长短版文案区分）", () => {
  it("级联落 low：offFallback=\"low\"（glm-5.3 → effort low，UI 长版提示）", () => {
    expect(resolve({ baseUrl: ZHIPU_URL, model: "glm-5.3", level: "off" }).offFallback).toBe("low");
  });

  it("无 low 可落：offFallback=null 且 offUnavailable=true（目录外的 minimax-m2 落手写 minimax-always；M2.x 关不掉；UI 短版提示）", () => {
    const r = resolve({ baseUrl: "https://api.minimaxi.com/v1", model: "minimax-m2", level: "off" });
    expect(r.offUnavailable).toBe(true);
    expect(r.offFallback).toBe(null);
  });

  it("off 正常可用 / never 静默 / unknown：恒为 null（UI 均无提示）", () => {
    expect(resolve({ baseUrl: QWEN_URL, model: "qwen3-max", level: "off" }).offFallback).toBe(null);
    expect(resolve({ baseUrl: DEEPSEEK_URL, model: "deepseek-chat", level: "off" }).offFallback).toBe(null);
    expect(resolve({ baseUrl: "https://api.example.com/v1", model: "totally-unknown", level: "off" }).offFallback).toBe(null);
  });

  it("streamOnly 流式放行时无级联：offFallback=null（对话流式判定不误报，如 qwen3-235b）", () => {
    const r = resolve({ baseUrl: QWEN_URL, model: "qwen3-235b", level: "off", stream: true });
    expect(openaiVocabularyFields(r.vocabulary)).toEqual({ enable_thinking: false });
    expect(r.offUnavailable).toBe(false);
    expect(r.offFallback).toBe(null);
  });
});

describe("streamOnly（Q14A：流式限制规则遇非流式按无事实处理）", () => {
  it("目录内上游 toggle 行（qwen3.7-plus）：off 走上游 toggle，流式与非流式同结论（无 streamOnly 阻断）", () => {
    for (const stream of [true, false]) {
      const r = resolve({ baseUrl: QWEN_URL, model: "qwen3.7-plus", level: "off", stream });
      expect(openaiVocabularyFields(r.vocabulary), `stream=${stream}`).toEqual({ enable_thinking: false });
      expect(r.offUnavailable, `stream=${stream}`).toBe(false);
      expect(r.offFallback, `stream=${stream}`).toBe(null);
    }
  });

  it("流式：off 照发 enable_thinking:false（手写兜底路径 qwen3-32b-air）", () => {
    const r = resolve({ baseUrl: QWEN_URL, model: "qwen3-32b-air", level: "off", stream: true });
    expect(openaiVocabularyFields(r.vocabulary)).toEqual({ enable_thinking: false });
    expect(r.offUnavailable).toBe(false);
  });

  it("非流式：off 被阻断 → 级联落 low（开关型=on 写点）+ offUnavailable", () => {
    const r = resolve({ baseUrl: QWEN_URL, model: "qwen3-32b-air", level: "off", stream: false });
    expect(openaiVocabularyFields(r.vocabulary)).toEqual({ enable_thinking: true });
    expect(r.offUnavailable).toBe(true);
    expect(r.thinkingClass).toBe("hybrid");
  });

  it("thinking-2507 变体不吃 streamOnly 前缀例外：qwen3-235b-a22b-thinking-2507 是永远思考（off 级联无 low 可落）", () => {
    const r = resolve({ baseUrl: QWEN_URL, model: "qwen3-235b-a22b-thinking-2507", level: "off", stream: false });
    expect(r.thinkingClass).toBe("always");
    expect(openaiVocabularyFields(r.vocabulary)).toEqual({});
    expect(r.offUnavailable).toBe(true);
  });
});

describe("baseUrl host 推断（本票生效的 provider 识别路径）", () => {
  it("host 命中 AI preset → 平台词汇生效（mimo enable_thinking）", () => {
    expect(openaiVocabularyFields(resolve({ baseUrl: MIMO_URL, model: "mimo-v2.5-pro", level: "off" }).vocabulary)).toEqual({
      enable_thinking: false
    });
  });

  it("SiliconFlow 无 AI preset（仅 ASR 登记同域名）→ host 别名命中 enable_thinking 词汇", () => {
    const r = resolve({ baseUrl: SILICONFLOW_URL, model: "deepseek-ai/DeepSeek-V3", level: "off" });
    expect(openaiVocabularyFields(r.vocabulary)).toEqual({ enable_thinking: false });
    expect(r.thinkingClass).toBe("hybrid");
  });

  it("已死的 api.doubao.com 不是现 preset 的 host（现 baseUrl 是 opencode.ai）→ 该域名仍落 unknown", () => {
    expect(resolve({ baseUrl: "https://api.doubao.com/v1", model: "skylark-2-pro", level: "off" })).toEqual({
      vocabulary: UNKNOWN_VOCABULARY,
      requestedLevel: "off",
      effectiveLevel: null,
      offUnavailable: false,
      offFallback: null,
      thinkingClass: "unknown"
    });
  });

  it("未知 host 等价于无 provider 规则（custom 平台指向陌生网关）", () => {
    expect(resolve({ baseUrl: "https://gateway.internal.example/v1", model: "vendor-model", level: "low" })).toEqual({
      vocabulary: UNKNOWN_VOCABULARY,
      requestedLevel: "low",
      effectiveLevel: null,
      offUnavailable: false,
      offFallback: null,
      thinkingClass: "unknown"
    });
  });

  it("host 推断只看 hostname、不看路径与 scheme 大小写", () => {
    expect(openaiVocabularyFields(resolve({ baseUrl: "HTTPS://API.DEEPSEEK.COM/v1", model: "deepseek-v4-pro", level: "off" }).vocabulary)).toEqual({
      thinking: { type: "disabled" }
    });
  });
});

describe("presetId 参数位（02 票穿线预留，本票仅 resolver 侧可用）", () => {
  it("presetId 命中 PROVIDERS：presetId 识别优先于 host", () => {
    const r = resolve({ presetId: "deepseek", baseUrl: "https://mirror.example.com/v1", model: "deepseek-v4-pro", level: "off" });
    expect(openaiVocabularyFields(r.vocabulary)).toEqual({ thinking: { type: "disabled" } });
  });

  it("presetId 未命中（如 provider store 的记录 id）→ 回落 host 推断", () => {
    const r = resolve({ presetId: "rec_abc123", baseUrl: DEEPSEEK_URL, model: "deepseek-v4-pro", level: "off" });
    expect(openaiVocabularyFields(r.vocabulary)).toEqual({ thinking: { type: "disabled" } });
  });
});

describe("18 号票：OpenRouter 走上游词表投影（平台 override 已删）", () => {
  it("上游目录内 id 走投影：值集 toggle+low-high-max 且平台未登记开关形状 → off 关不掉、级联 low", () => {
    const r = resolve({ baseUrl: OPENROUTER_URL, model: "deepseek/deepseek-v4-pro", level: "off" });
    expect(openaiVocabularyFields(r.vocabulary)).toEqual({ reasoning_effort: "low" });
    expect(r.offUnavailable).toBe(true);
    expect(r.thinkingClass).toBe("always");
  });

  it("上游目录外 id 回落手写表；手写侧也无结论 → UNKNOWN 哨兵（不再有平台声明兜底）", () => {
    expect(openaiVocabularyFields(resolve({ baseUrl: OPENROUTER_URL, model: "deepseek-v4-pro", level: "off" }).vocabulary)).toEqual({
      thinking: { type: "disabled" }
    });
    const unknown = resolve({ baseUrl: OPENROUTER_URL, model: "vendor/some-future-model", level: "low" });
    expect(openaiVocabularyFields(unknown.vocabulary)).toEqual({});
    expect(unknown.thinkingClass).toBe("unknown");
  });

  it("永不思考模型不再被平台声明覆盖：手写 never 静默不发（关思考天然成立）", () => {
    const r = resolve({ baseUrl: OPENROUTER_URL, model: "kimi-k2-instruct", level: "off" });
    expect(openaiVocabularyFields(r.vocabulary)).toEqual({});
    expect(r.thinkingClass).toBe("never");
  });
});

describe("18 号票：AMD Radeon Cloud 走上游词表投影", () => {
  it("上游目录内 id 按自己的值集：DeepSeek-V4.1-Flash（toggle+low-high-max）off 关不掉、级联 low", () => {
    const r = resolve({ presetId: "amd", model: "DeepSeek-V4.1-Flash", level: "off" });
    expect(openaiVocabularyFields(r.vocabulary)).toEqual({ reasoning_effort: "low" });
    expect(r.offUnavailable).toBe(true);
    expect(r.thinkingClass).toBe("always");
  });

  it("19 号票：三个 DeepSeek 兄弟同形 —— DeepSeek-V4-Flash 跟另外两个一样收窄到 low/high/max", () => {
    for (const model of ["DeepSeek-V4.1-Flash", "DeepSeek-V4-Flash", "DeepSeek-V4-Flash-Vision-Exp"]) {
      const r = resolve({ presetId: "amd", model, level: "off" });
      expect(openaiVocabularyFields(r.vocabulary), model).toEqual({ reasoning_effort: "low" });
      expect(r.offUnavailable, model).toBe(true);
      expect(r.thinkingClass, model).toBe("always");
    }
  });

  it("presetId='custom' 未命中 PROVIDERS → 回落 host 索引仍命中 amd 的上游投影", () => {
    const r = resolve({ presetId: "custom", baseUrl: AMD_URL, model: "DeepSeek-V4-Flash", level: "high" });
    expect(openaiVocabularyFields(r.vocabulary)).toEqual({ reasoning_effort: "high" });
  });
});

describe("18 号票：SenseNova 商汤走上游词表投影", () => {
  it("上游目录内 id（glm-5.2 值集 toggle+high-max）：sensenova 未登记开关形状 → off 关不掉、级联到最小非 off 档 high", () => {
    const r = resolve({ presetId: "sensenova", model: "glm-5.2", level: "off" });
    expect(openaiVocabularyFields(r.vocabulary)).toEqual({ reasoning_effort: "high" });
    expect(r.offUnavailable).toBe(true);
    expect(r.thinkingClass).toBe("always");
  });

  it("目录外的原生 id（sensenova-6.7-flash-lite）无词表也无手写结论 → UNKNOWN 不发参", () => {
    const r = resolve({ baseUrl: SENSENOVA_URL, model: "sensenova-6.7-flash-lite", level: "high" });
    expect(openaiVocabularyFields(r.vocabulary)).toEqual({});
    expect(r.thinkingClass).toBe("unknown");
  });
});

describe("18 号票：Opencode Go 走上游词表投影", () => {
  it("19 号票值集覆盖：deepseek-v4-pro 借 deepseek/deepseek-v4-pro 的词表，low 拿回", () => {
    expect(resolve({ presetId: "opencodego", model: "deepseek-v4-pro", level: "off" })).toEqual({
      vocabulary: reasoningEffort("low"),
      requestedLevel: "off",
      effectiveLevel: "low",
      offUnavailable: true,
      offFallback: "low",
      thinkingClass: "always"
    });
    expect(openaiVocabularyFields(resolve({ presetId: "opencodego", model: "deepseek-v4-pro", level: "low" }).vocabulary)).toEqual({
      reasoning_effort: "low"
    });
  });

  it("值集含 effort none 的模型仍可关思考：hy3（none+low/high）off → reasoning_effort none", () => {
    const r = resolve({ presetId: "opencodego", model: "hy3", level: "off" });
    expect(openaiVocabularyFields(r.vocabulary)).toEqual({ reasoning_effort: "none" });
    expect(r.offUnavailable).toBe(false);
    expect(r.thinkingClass).toBe("hybrid");
  });

  it("13 号票对齐的 kimi-k3 逐字节不变：low/high/max 直传 effort，不发 thinking 开关", () => {
    const low = resolve({ presetId: "opencodego", model: "kimi-k3", level: "low" });
    expect(openaiVocabularyFields(low.vocabulary)).toEqual({ reasoning_effort: "low" });
    expect(openaiVocabularyFields(low.vocabulary)).not.toHaveProperty("thinking");
    expect(openaiVocabularyFields(resolve({ presetId: "opencodego", model: "kimi-k3", level: "max" }).vocabulary)).toEqual({
      reasoning_effort: "max"
    });
  });

  it("值集只有 toggle 的模型（kimi-k2.6）平台未登记开关形状 → 任何档都不发明写点", () => {
    const r = resolve({ presetId: "opencodego", model: "kimi-k2.6", level: "low" });
    expect(openaiVocabularyFields(r.vocabulary)).toEqual({});
    expect(r.thinkingClass).toBe("always");
  });

  it("目录外 id 不再有一刀切 effort：手写侧无命中的 id 落 UNKNOWN", () => {
    expect(openaiVocabularyFields(resolve({ baseUrl: "https://opencode.ai/zen/go/v1", model: "whatever", level: "off" }).vocabulary)).toEqual({});
  });
});

describe("tokenParam 随表返回（04 票消费；本票请求体仍用 max_tokens）", () => {
  it("openai-reasoning 系 → max_completion_tokens", () => {
    expect(resolve({ baseUrl: OPENAI_URL, model: "gpt-5.1", level: "low" }).tokenParam).toBe("max_completion_tokens");
    expect(resolve({ baseUrl: OPENAI_URL, model: "o3", level: "low" }).tokenParam).toBe("max_completion_tokens");
  });

  it("上游命中的四家托管平台也不返回 tokenParam（默认 max_tokens 现状；18 号票删 override 后不变）", () => {
    expect(resolve({ baseUrl: OPENROUTER_URL, model: "m", level: "low" }).tokenParam).toBeUndefined();
    expect(resolve({ presetId: "opencodego", model: "deepseek-v4-pro", level: "low" }).tokenParam).toBeUndefined();
    expect(resolve({ baseUrl: "https://api.example.com/v1", model: "m", level: "low" }).tokenParam).toBeUndefined();
  });

  it("上游命中的 OpenAI 血统托管行恒 max_tokens（fields 仍照发，避免落 UNKNOWN 空跑）", () => {
    const viaOpenRouter = resolve({ baseUrl: OPENROUTER_URL, model: "openai/gpt-5.4", level: "low" });
    expect(openaiVocabularyFields(viaOpenRouter.vocabulary)).toEqual({ reasoning_effort: "low" });
    expect(viaOpenRouter.tokenParam).toBeUndefined();

    const viaOpencodeGo = resolve({ presetId: "opencodego", model: "gpt-5.6-luna", level: "low" });
    expect(openaiVocabularyFields(viaOpencodeGo.vocabulary)).toEqual({ reasoning_effort: "low" });
    expect(viaOpencodeGo.tokenParam).toBeUndefined();
  });
});

function tablesWith() {
  return {
    classes: JSON.parse(JSON.stringify(CLASSES)),
    taxonomy: JSON.parse(JSON.stringify(TAXONOMY)),
    exceptions: JSON.parse(JSON.stringify(EXCEPTIONS)),
    providers: JSON.parse(JSON.stringify(PROVIDERS))
  };
}

describe("表校验器（工单 AC 第 6 条）", () => {
  it("真实表自检通过（空错误列表）", () => {
    expect(validateThinkingTables()).toEqual([]);
  });

  it("词汇白名单由联合派生：联合外的脏 kind 报错，哨兵 kind（无载荷）也报错，载荷 kind 放行", () => {
    const tables = tablesWith();
    tables.classes["deepseek-hybrid-effort"].off.vocabulary = { kind: "temperature", value: 0.6 };
    const errors = validateThinkingTables(tables);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("temperature");
    expect(errors[0]).toContain("白名单");

    const sentinel = tablesWith();
    sentinel.classes["deepseek-hybrid-effort"].off.vocabulary = { kind: "noFields" };
    const sentinelErrors = validateThinkingTables(sentinel);
    expect(sentinelErrors).toHaveLength(1);
    expect(sentinelErrors[0]).toContain("哨兵");

    const ok = tablesWith();
    ok.classes["deepseek-hybrid-effort"].off.vocabulary = { kind: "thinkingType", type: "disabled" };
    expect(validateThinkingTables(ok)).toEqual([]);
  });

  it("thinkingClass 三态必填：缺失或非法值都报错", () => {
    const missing = tablesWith();
    delete missing.classes["minimax-always"].thinkingClass;
    expect(validateThinkingTables(missing)[0]).toContain("thinkingClass");

    const badValue = tablesWith();
    badValue.classes["minimax-always"].thinkingClass = "sometimes";
    expect(validateThinkingTables(badValue)[0]).toContain("thinkingClass");
  });

  it("hybrid 必有 off 声明", () => {
    const tables = tablesWith();
    delete tables.classes["qwen-hybrid-switch"].off;
    const errors = validateThinkingTables(tables);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("off");
  });

  it("always / never 不得有 off", () => {
    const always = tablesWith();
    always.classes["minimax-always"].off = { fields: { enable_thinking: false } };
    const errorsAlways = validateThinkingTables(always);
    expect(errorsAlways).toHaveLength(1);
    expect(errorsAlways[0]).toContain("off");

    const never = tablesWith();
    never.classes["deepseek-chat-never"].off = { fields: { enable_thinking: false } };
    expect(validateThinkingTables(never)).toHaveLength(1);
  });

  it("never 无任何档位（on/low/high 都不得有）", () => {
    const tables = tablesWith();
    tables.classes["deepseek-chat-never"].low = { fields: { reasoning_effort: "low" } };
    const errors = validateThinkingTables(tables);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("never");
  });

  it("never 不得带 tokenParam（关不掉思考的模型没有档位事实可随）", () => {
    const tables = tablesWith();
    tables.classes["deepseek-chat-never"].tokenParam = "max_completion_tokens";
    const errors = validateThinkingTables(tables);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("never");
  });

  it("taxonomy / 例外引用的 class 必须存在", () => {
    const taxonomy = tablesWith();
    taxonomy.taxonomy[0].class = "no-such-class";
    const errorsTaxonomy = validateThinkingTables(taxonomy);
    expect(errorsTaxonomy).toHaveLength(1);
    expect(errorsTaxonomy[0]).toContain("TAXONOMY");

    const exceptions = tablesWith();
    exceptions.exceptions[0].class = "no-such-class";
    const errorsExceptions = validateThinkingTables(exceptions);
    expect(errorsExceptions).toHaveLength(1);
    expect(errorsExceptions[0]).toContain("EXCEPTIONS");
  });

  it("同级冲突：on 与 low/high 同存报错（开关型 low/high 的写点歧义）", () => {
    const tables = tablesWith();
    tables.classes["qwen-hybrid-switch"].low = { fields: { reasoning_effort: "low" } };
    const errors = validateThinkingTables(tables);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("冲突");
  });

  it("provider.unknownClass 引用不存在的 class 报错", () => {
    const tables = tablesWith();
    tables.providers.ollama.unknownClass = "no-such-class";
    const errors = validateThinkingTables(tables);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("ollama");
  });

  it("tokenParam 只允许 max_tokens / max_completion_tokens", () => {
    const tables = tablesWith();
    tables.classes["openai-reasoning"].tokenParam = "completion_tokens";
    const errors = validateThinkingTables(tables);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("tokenParam");
  });
});
