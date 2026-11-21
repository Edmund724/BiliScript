import type { AiProtocol } from "../ai/protocol-adapter.js";

export interface AsrProviderPreset {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  model: string;
  supportsTimestamps: boolean;
  note?: string;
  language?: string;
  requiresKey?: boolean;
}

export const ASR_PROVIDER_PRESETS: readonly AsrProviderPreset[] = [
  {
    id: "siliconflow-sensevoice",
    name: "SiliconFlow 硅基流动",
    type: "openai-transcriptions",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "XingChenAGI/XingChenASR-V3.2",
    supportsTimestamps: true,
    note: "推荐免费模型 XingChenAGI/XingChenASR-V3.2，需先填写硅基流动 API Key，点右侧箭头可拉取可选模型。英文视频请在插件页顶部切换为 English 后刷新。"
  },
  {
    id: "local-whisper",
    name: "本地 Whisper 服务",
    type: "openai-transcriptions",
    baseUrl: "http://localhost:8000/v1",
    model: "whisper-large-v3",
    supportsTimestamps: true,
    requiresKey: false,
    note: "本地部署，音频不上传任何外部服务。model 可按本地部署情况修改。"
  },
  {
    id: "custom",
    name: "自定义",
    type: "openai-transcriptions",
    baseUrl: "",
    model: "",
    supportsTimestamps: true,
    language: "auto",
    note: "兼容 OpenAI transcriptions 协议的自定义端点。"
  }
];

export interface AiProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  requiresKey: boolean;
  protocol?: AiProtocol;
  protocolBaseUrls?: Partial<Record<AiProtocol, string>>;
  catalogProvider?: string;
}

export const PRESETS: readonly AiProviderPreset[] = [
  { id: "deepseek",      name: "DeepSeek",    baseUrl: "https://api.deepseek.com/v1", requiresKey: true, catalogProvider: "deepseek", protocol: "anthropic", protocolBaseUrls: { anthropic: "https://api.deepseek.com/anthropic" } },
  { id: "qwen",          name: "Qwen",        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", requiresKey: true, catalogProvider: "alibaba-cn", protocolBaseUrls: { anthropic: "https://dashscope.aliyuncs.com/apps/anthropic" } },
  { id: "zhipu",         name: "GLM",         baseUrl: "https://open.bigmodel.cn/api/paas/v4", requiresKey: true, catalogProvider: "zhipuai", protocolBaseUrls: { anthropic: "https://open.bigmodel.cn/api/anthropic" } },
  { id: "moonshot",      name: "Kimi",        baseUrl: "https://api.kimi.com/coding/v1", requiresKey: true, catalogProvider: "kimi-code-plan-cn", protocolBaseUrls: { anthropic: "https://api.kimi.com/coding" } },
  { id: "minimax",       name: "MiniMax",     baseUrl: "https://api.minimaxi.com/v1", requiresKey: true, catalogProvider: "minimax-cn", protocol: "anthropic", protocolBaseUrls: { anthropic: "https://api.minimaxi.com/anthropic" } },
  { id: "mimo",          name: "Mimo",        baseUrl: "https://api.xiaomimimo.com/v1", requiresKey: true, catalogProvider: "xiaomi", protocolBaseUrls: { anthropic: "https://api.xiaomimimo.com/anthropic" } },
  { id: "opencodego",    name: "Opencode Go", baseUrl: "https://opencode.ai/zen/go/v1", requiresKey: true, catalogProvider: "opencode-go", protocolBaseUrls: { anthropic: "https://opencode.ai/zen/go" } },
  { id: "openrouter",    name: "OpenRouter",  baseUrl: "https://openrouter.ai/api/v1", requiresKey: true, catalogProvider: "openrouter", protocolBaseUrls: { anthropic: "https://openrouter.ai/api" } },
  { id: "stepfun",       name: "Stepfun",     baseUrl: "https://api.stepfun.com/step_plan/v1", requiresKey: true, catalogProvider: "stepfun-step-plan", protocolBaseUrls: { anthropic: "https://api.stepfun.com/step_plan" } },
  { id: "modelscope",    name: "ModelScope",  baseUrl: "https://api-inference.modelscope.cn/v1", requiresKey: true, catalogProvider: "modelscope", protocolBaseUrls: { anthropic: "https://api-inference.modelscope.cn" } },
  { id: "amd",           name: "AMD Radeon Cloud（免费）", baseUrl: "https://developer.amd.com.cn/radeon/api/v1", requiresKey: true, catalogProvider: "amd", protocolBaseUrls: { anthropic: "https://developer.amd.com.cn/radeon/api" } },
  { id: "sensenova",     name: "SenseNova 商汤（免费）", baseUrl: "https://token.sensenova.cn/v1", requiresKey: true, catalogProvider: "sensenova", protocolBaseUrls: { anthropic: "https://token.sensenova.cn" } },
  { id: "ollama",        name: "Ollama (本地)", baseUrl: "http://localhost:11434/v1", requiresKey: false, protocolBaseUrls: { anthropic: "http://localhost:11434" } },
  { id: "gemini",        name: "Gemini",      baseUrl: "https://generativelanguage.googleapis.com", requiresKey: true, catalogProvider: "google", protocol: "gemini", protocolBaseUrls: { openai: "https://generativelanguage.googleapis.com/v1beta/openai" } },
  { id: "custom",        name: "自定义",      baseUrl: "", requiresKey: true }
];

export const NO_CATALOG_PRESETS = ["ollama", "custom"] as const;

export type SearchProviderAccess = "keyless" | "free-quota" | "paid";

export type SearchProviderType = "firecrawl" | "tavily" | "doubao" | "anysearch" | "parallel" | "exa" | "deepseek";

export interface SearchProviderPreset {
  id: string;
  name: string;
  type: SearchProviderType;
  baseUrl: string;
  access: SearchProviderAccess;
  note?: string;
}

export const DEFAULT_SEARCH_PROVIDER_PRESET: SearchProviderPreset = {
  id: "firecrawl",
  name: "Firecrawl",
  type: "firecrawl",
  baseUrl: "https://api.firecrawl.dev",
  access: "keyless"
};

export const SEARCH_PROVIDER_PRESETS: readonly SearchProviderPreset[] = [
  DEFAULT_SEARCH_PROVIDER_PRESET,
  {
    id: "tavily",
    name: "Tavily",
    type: "tavily",
    baseUrl: "https://api.tavily.com",
    access: "keyless"
  },
  {
    id: "doubao",
    name: "豆包",
    type: "doubao",
    baseUrl: "https://open.feedcoopapi.com",
    access: "free-quota",
    note: "每月 500 次免费（需在火山控制台申请 Key）"
  },
  {
    id: "anysearch",
    name: "AnySearch",
    type: "anysearch",
    baseUrl: "https://api.anysearch.com",
    access: "keyless"
  },
  {
    id: "parallel",
    name: "Parallel",
    type: "parallel",
    baseUrl: "https://search.parallel.ai",
    access: "keyless"
  },
  {
    id: "exa",
    name: "Exa",
    type: "exa",
    baseUrl: "https://api.exa.ai",
    access: "free-quota",
    note: "每月 $10 赠送额度（新账户另赠 $10）"
  },
  {
    id: "deepseek",
    name: "DeepSeek Search",
    type: "deepseek",
    baseUrl: "https://api.deepseek.com",
    access: "paid",
    note: "按次计费（¥5/1000 次成功请求），复用 AI 平台 DeepSeek 的 Key"
  }
];

export const DEFAULT_SEARCH_PROVIDER_ORDER: readonly string[] = [
  "exa",
  "doubao",
  "tavily",
  "firecrawl",
  "anysearch",
  "parallel",
  "deepseek"
];

export function normalizeBaseUrl(value: unknown): string {
  return String(value || "").trim().replace(/\/+$/, "");
}

export function presetBaseUrlForProtocol(
  preset: { baseUrl?: string; protocolBaseUrls?: Partial<Record<string, string>> } | null | undefined,
  protocol: unknown
): string {
  const key = typeof protocol === "string" ? protocol : "";
  return preset?.protocolBaseUrls?.[key] ?? preset?.baseUrl ?? "";
}

export interface EffectivePresetRecordLike {
  baseUrl?: unknown;
  protocol?: unknown;
}

export function effectivePresetBaseUrl(
  record: EffectivePresetRecordLike | null | undefined,
  preset: { baseUrl?: string; protocol?: unknown; protocolBaseUrls?: Partial<Record<string, string>> } | null | undefined
): string {
  const own = String(record?.baseUrl || "").trim();
  if (own) return own;
  const protocol = typeof record?.protocol === "string" && record.protocol ? record.protocol : (preset?.protocol ?? "openai");
  return presetBaseUrlForProtocol(preset, protocol);
}

export function normalizeAsrLanguage(value: unknown): "auto" | "zh" | "en" {
  const lang = String(value || "").trim().toLowerCase();
  return lang === "zh" || lang === "en" ? lang : "auto";
}
