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
  // 模型目录归属（model-catalog/02）：本预设对应 @earendil-works/pi-ai 的
  // provider 目录文件名。presetId 与上游文件名不是一套（zhipu/zai-coding-cn、
  // mimo/xiaomi…），且实测按 host 自动匹配会错配
  // （zhipu 同域不同路径、mimo 曾用不解析的 api.mimo.ai），故逐平台显式登记；
  // 查表时 presetId 命中即不再看 baseUrl（host 只兜底 custom/未知预设）。
  // 没有登记 = 该预设永远没有目录数据（白名单见 ai/model-catalog.ts）。
  piProvider?: string;
}

export const PRESETS: readonly AiProviderPreset[] = [
  { id: "deepseek",      name: "DeepSeek",    baseUrl: "https://api.deepseek.com/v1", requiresKey: true, piProvider: "deepseek", protocol: "anthropic", protocolBaseUrls: { anthropic: "https://api.deepseek.com/anthropic" } },
  { id: "qwen",          name: "Qwen",        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", requiresKey: true, protocolBaseUrls: { anthropic: "https://dashscope.aliyuncs.com/apps/anthropic" } },
  { id: "zhipu",         name: "GLM",         baseUrl: "https://open.bigmodel.cn/api/paas/v4", requiresKey: true, piProvider: "zai-coding-cn", protocolBaseUrls: { anthropic: "https://open.bigmodel.cn/api/anthropic" } },
  { id: "moonshot",      name: "Kimi",        baseUrl: "https://api.kimi.com/coding/v1", requiresKey: true, piProvider: "kimi-coding", protocolBaseUrls: { anthropic: "https://api.kimi.com/coding" } },
  { id: "minimax",       name: "MiniMax",     baseUrl: "https://api.minimaxi.com/v1", requiresKey: true, piProvider: "minimax-cn", protocolBaseUrls: { anthropic: "https://api.minimaxi.com/anthropic" } },
  { id: "mimo",          name: "Mimo",        baseUrl: "https://api.xiaomimimo.com/v1", requiresKey: true, piProvider: "xiaomi", protocolBaseUrls: { anthropic: "https://api.xiaomimimo.com/anthropic" } },
  { id: "opencodego",    name: "Opencode Go", baseUrl: "https://opencode.ai/zen/go/v1", requiresKey: true, piProvider: "opencode-go", protocolBaseUrls: { anthropic: "https://opencode.ai/zen/go" } },
  { id: "openrouter",    name: "OpenRouter",  baseUrl: "https://openrouter.ai/api/v1", requiresKey: true, piProvider: "openrouter", protocolBaseUrls: { anthropic: "https://openrouter.ai/api" } },
  { id: "stepfun",       name: "Stepfun",     baseUrl: "https://api.stepfun.com/step_plan/v1", requiresKey: true, protocolBaseUrls: { anthropic: "https://api.stepfun.com/step_plan" } },
  { id: "modelscope",    name: "ModelScope",  baseUrl: "https://api-inference.modelscope.cn/v1", requiresKey: true, protocolBaseUrls: { anthropic: "https://api-inference.modelscope.cn" } },
  { id: "amd",           name: "AMD Radeon Cloud（免费）", baseUrl: "https://developer.amd.com.cn/radeon/api/v1", requiresKey: true, protocolBaseUrls: { anthropic: "https://developer.amd.com.cn/radeon/api" } },
  { id: "sensenova",     name: "SenseNova 商汤（免费）", baseUrl: "https://token.sensenova.cn/v1", requiresKey: true, protocolBaseUrls: { anthropic: "https://token.sensenova.cn" } },
  { id: "ollama",        name: "Ollama (本地)", baseUrl: "http://localhost:11434/v1", requiresKey: false },
  { id: "custom",        name: "自定义",      baseUrl: "", requiresKey: true }
];

// 无数据白名单（model-catalog/02）：这些预设在上游 pi-ai 目录里没有对应 provider
// 文件，模型元数据永远查不到，UI 静默降级（不显示占位）。与上面的 piProvider
// 字段同源对账：每个预设恰好属于「登记了 piProvider」或「在本清单」之一——新增
// 预设忘配即测试失败，而不是悄悄进白名单（tests/ai/model-catalog.test.ts）。
// custom 虽然在白名单里，它的查表仍走 baseUrl host 兜底（ai/model-catalog.ts
// 的 IDENTITYLESS_PRESETS：custom 的语义就是用户自填端点，presetId 不带身份）。
export const NO_CATALOG_PRESETS = [
  "qwen",
  "stepfun",
  "modelscope",
  "amd",
  "sensenova",
  "ollama",
  "custom"
] as const;

// ===== 联网搜索平台预设 =====
// type 决定走哪个适配器（extension/search/adapters/），六家均为纯 HTTP：
//   firecrawl：POST /v2/search，无鉴权头（keyless 模式完全不发 Authorization）
//   tavily：POST /search，无 Key 走 x-tavily-access-mode: keyless，有 Key 走 Authorization: Bearer
//   doubao：POST /search_api/web_search，authorization: Bearer（必填）
//   anysearch：POST /v1/search，无鉴权头
//   parallel：POST /mcp（JSON-RPC tools/call + web_search），无鉴权头
//   exa：POST /search，x-api-key（必填）
// access 是接入与额度形态的单一真源（spec §7）：keyless 无 Key 即可调用（配 Key
// 走自己账号提额，不改形态）；free-quota 必须自带 Key，耗用服务方赠予的额度。
// note 显示在设置行副行。不做自定义预设（spec 非目标）。

export type SearchProviderAccess = "keyless" | "free-quota";

export type SearchProviderType = "firecrawl" | "tavily" | "doubao" | "anysearch" | "parallel" | "exa";

export interface SearchProviderPreset {
  id: string;
  name: string;
  type: SearchProviderType;
  baseUrl: string;
  access: SearchProviderAccess;
  note?: string;
}

// 搜索平台缺省预设：编辑 Modal 解析不到所选 preset 时的兜底（引用此处，
// 不再硬编码字面量）。即预设表首项 firecrawl；**不再是链首选**（spec §1 S3
// 2026-10-01 修订：链序见 DEFAULT_SEARCH_PROVIDER_ORDER）。
export const DEFAULT_SEARCH_PROVIDER_PRESET: SearchProviderPreset = {
  id: "firecrawl",
  name: "Firecrawl",
  type: "firecrawl",
  baseUrl: "https://api.firecrawl.dev",
  access: "keyless"
};

// 表顺序 = 预设目录序（spec §1 S3 2026-10-01 修订：徽章 / access / 编辑 Modal 的
// defaultPresetId / DEFAULT_SEARCH_PROVIDER_PRESET 兜底的来源），**不再是链序**。
// 链序 = searchProviderOrder 归一序 > DEFAULT_SEARCH_PROVIDER_ORDER（spec §12.2）。
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
  }
];

// 内置默认链序（spec §2「内置默认链序」/ §12.2）：Exa → 豆包 → Tavily → Firecrawl
// → AnySearch → Parallel。与 SEARCH_PROVIDER_PRESETS 的表序解耦（表序只管预设目录）；
// free-quota 两家（Exa / 豆包）没配 Key 时自动跳过，故无 Key 用户的实际首家 = Tavily。
// 用户拖拽顺序（searchProviderOrder）优先于本表；不在用户数组中的记录按本表位次排在
// 数组内记录之后（spec §12.2 排序键规则）。
export const DEFAULT_SEARCH_PROVIDER_ORDER: readonly string[] = [
  "exa",
  "doubao",
  "tavily",
  "firecrawl",
  "anysearch",
  "parallel"
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
