// extension/core/presets.ts
// AI / ASR platform presets plus the provider normalizers built on them.
// Pure data + pure functions; no Chrome APIs, no DOM.
// （arch-slim-2/09：ASR 域类型 AsrProvider 与 normalizeAsrProvider 已搬
// asr/asr-provider-normalize.ts；本文件保留跨 context 的预设数据与通用归一化。）

import type { AiProtocol } from "../ai/protocol-adapter.js";

// ===== ASR（语音转写）平台预设 =====
// 字段含义见 spec.md 第 4 节。type 决定走哪个适配器，共一种：
//   openai-transcriptions：OpenAI 兼容 multipart 端点（SiliconFlow / 本地 Whisper / 自定义）
// supportsTimestamps 决定时间戳合成方式。

export interface AsrProviderPreset {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  model: string;
  supportsTimestamps: boolean;
  note?: string;
  language?: string;
}

export const ASR_PROVIDER_PRESETS: readonly AsrProviderPreset[] = [
  {
    id: "siliconflow-sensevoice",
    name: "SiliconFlow 硅基流动（免费）",
    type: "openai-transcriptions",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "XingChenAGI/XingChenASR-V3.2-Ultra",
    supportsTimestamps: true,
    note: "推荐模型 XingChenAGI/XingChenASR-V3.2-Ultra，点模型名右侧箭头可拉取全部可选模型。英文视频请在插件页顶部切换为 English 后重新刷新。"
  },
  {
    id: "local-whisper",
    name: "本地 Whisper 服务",
    type: "openai-transcriptions",
    baseUrl: "http://localhost:8000/v1",
    model: "whisper-large-v3",
    supportsTimestamps: true, // verbose_json segments
    note: "本地部署，音频不上传任何外部服务。model 可按本地部署情况修改。"
  },
  {
    id: "custom",
    name: "自定义",
    type: "openai-transcriptions",
    baseUrl: "",
    model: "",
    supportsTimestamps: true, // 自动探测
    language: "auto",
    note: "兼容 OpenAI transcriptions 协议的自定义端点。"
  }
];

// ===== AI platform presets =====
export interface AiProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  requiresKey: boolean;
  // 协议默认归属（multi-protocol-ai）：选中预设时编辑 Modal 协议下拉的联动默认值。
  // 缺省即 openai；逐平台多协议归属实测后逐个显式填写（preset-protocol-audit），
  // 目前显式填写的只有 DeepSeek（官方 Anthropic 端点）。
  protocol?: AiProtocol;
  // 个别协议的差异化端点（multi-protocol-ai）：协议与默认端点不同域/路径时
  // 显式登记（preset-protocol-audit「Anthropic 兼容 Base URL」表）；编辑 Modal
  // 切协议时 baseUrl 未改过即跟随对应协议的端点。缺省回落 baseUrl（含同址
  // 多协议平台：Kimi Code、Opencode Go 无需登记）。
  protocolBaseUrls?: Partial<Record<AiProtocol, string>>;
}

export const PRESETS: readonly AiProviderPreset[] = [
  { id: "openai_compat", name: "OpenAI 兼容", baseUrl: "https://api.openai.com/v1", requiresKey: true },
  { id: "deepseek",      name: "DeepSeek",    baseUrl: "https://api.deepseek.com/v1", requiresKey: true, protocol: "anthropic", protocolBaseUrls: { anthropic: "https://api.deepseek.com/anthropic" } },
  { id: "qwen",          name: "Qwen",        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", requiresKey: true, protocolBaseUrls: { anthropic: "https://dashscope.aliyuncs.com/apps/anthropic" } },
  { id: "zhipu",         name: "GLM",         baseUrl: "https://open.bigmodel.cn/api/paas/v4", requiresKey: true, protocolBaseUrls: { anthropic: "https://open.bigmodel.cn/api/anthropic" } },
  { id: "moonshot",      name: "Kimi",        baseUrl: "https://api.kimi.com/coding/v1", requiresKey: true, protocolBaseUrls: { anthropic: "https://api.kimi.com/coding" } },
  { id: "minimax",       name: "MiniMax",     baseUrl: "https://api.minimaxi.com/v1", requiresKey: true, protocolBaseUrls: { anthropic: "https://api.minimaxi.com/anthropic" } },
  { id: "mimo",          name: "Mimo",        baseUrl: "https://api.xiaomimimo.com/v1", requiresKey: true, protocolBaseUrls: { anthropic: "https://api.xiaomimimo.com/anthropic" } },
  { id: "opencodego",    name: "Opencode Go", baseUrl: "https://opencode.ai/zen/go/v1", requiresKey: true, protocolBaseUrls: { anthropic: "https://opencode.ai/zen/go" } },
  { id: "openrouter",    name: "OpenRouter",  baseUrl: "https://openrouter.ai/api/v1", requiresKey: true },
  { id: "stepfun",       name: "Stepfun",     baseUrl: "https://api.stepfun.com/step_plan/v1", requiresKey: true },
  { id: "modelscope",    name: "ModelScope",  baseUrl: "https://api-inference.modelscope.cn/v1", requiresKey: true },
  { id: "amd",           name: "AMD Radeon Cloud（免费）", baseUrl: "https://developer.amd.com.cn/radeon/api/v1", requiresKey: true },
  { id: "sensenova",     name: "SenseNova 商汤（免费）", baseUrl: "https://token.sensenova.cn/v1", requiresKey: true },
  { id: "ollama",        name: "Ollama (本地)", baseUrl: "http://localhost:11434/v1", requiresKey: false },
  { id: "custom",        name: "自定义",      baseUrl: "", requiresKey: true }
];

// ===== 联网搜索平台预设 =====
// type 决定走哪个适配器（extension/search/adapters/），三家均为纯 HTTP：
//   tavily：POST /search，Authorization: Bearer
//   exa：POST /search，x-api-key
//   brave：GET /res/v1/web/search，X-Subscription-Token
// note 显示在设置行副行（如 Brave 免费计划提示）。不做自定义预设（spec 非目标）。

export type SearchProviderType = "tavily" | "exa" | "brave";

export interface SearchProviderPreset {
  id: string;
  name: string;
  type: SearchProviderType;
  baseUrl: string;
  note?: string;
}

export const SEARCH_PROVIDER_PRESETS: readonly SearchProviderPreset[] = [
  {
    id: "tavily",
    name: "Tavily",
    type: "tavily",
    baseUrl: "https://api.tavily.com"
  },
  {
    id: "exa",
    name: "Exa",
    type: "exa",
    baseUrl: "https://api.exa.ai"
  },
  {
    id: "brave",
    name: "Brave Search",
    type: "brave",
    baseUrl: "https://api.search.brave.com",
    note: "免费计划需绑信用卡"
  }
];

export function normalizeBaseUrl(value: unknown): string {
  return String(value || "").trim().replace(/\/+$/, "");
}

// ASR 转写语言档位（全局设置 asrLanguage，auto / zh / en），auto 为默认，
// 非法值回落 auto。zh/en 由适配器转为查询参数传给平台：SiliconFlow 辰星
// （XingChen）系列模型只有传 ?language=english 才走英文转写，否则纯英文
// 音频静默返回空文本；本地 Whisper 忽略该参数（服务端自动识别）。
// 该设置只出现在 popup 顶部。
export function normalizeAsrLanguage(value: unknown): "auto" | "zh" | "en" {
  const lang = String(value || "").trim().toLowerCase();
  return lang === "zh" || lang === "en" ? lang : "auto";
}
