// extension/ai/catalog/models-dev-thinking.generated.ts — 生成产物，勿手改。
//
// 来源：https://models.dev/api.json（构建期抓取；上游无版本号，溯源靠 source + contentHash）
// 生成：pnpm catalog:sync:thinking（scripts/sync-models-dev-thinking.mjs）
// 口径：12 个上游 provider 的 reasoning 模型 → 归一值集常量表 VALUESETS + 指派表
//       ASSIGNMENTS。值集按结构去重；指派只回答「属于哪个值集」，线格式（怎么落请求体）
//       是 adapter 与 ai/thinking-wire-map.ts 的职责。352 个模型直接有
//       reasoning_options（取值序 19 号票：值集覆盖表 > canonical_model_id（13 号票 canonical
//       优先：direct 非空时也先借 canonical_model_id 的词表，悬空才回落 direct）> direct；
//       canonical 重定向表见 --report 的 canonical 优先节，值集覆盖表见 --report 的值集覆盖节；
//       能力补声明（本仓给一行补 off 写点，先增强上游事实再走同一取值序）见 --report 的本仓补声明节）；
//       63 个缺口里 7 个按 canonical_model_id /
//       别名表借到原生词表，其余 56 个标「未知词表」（不进表，查表返回 null =
//       请求侧不发参）。逐条借词来源与缺口清单在 --report / --matrix 工件。
//
// 值集 id 文法：<part>("+"<part>)*，part = "toggle" | effort 档位按上游顺序用 "-" 连接
// （如 low-medium-high）| "b" 或 "b:<min>-<max>"（缺省一边留空，如 b:-81920）。label 沿用
// ai/thinking-profiles.ts 的 CLASSES 命名（hybrid/always/switch/effort/budget/none）；
// 值集 id 才是键。刻意不带：reasoning_options 原文、线格式、offUnavailable / offFallback /
// streamOnly / probe 等产品语义（04/05/08 号票）。
//
// 叶子纪律：零 import（静态/动态都没有），只导出纯数据与纯查表函数；上游数据只在构建期
// 被读，请求路径（core/provider-http.ts → ai/completion.ts → ai/adapters/*）绝不引用本模块
// （scripts/build.js 的 assertBackgroundStaticGraphSlim 把本文件列为 SW 静态图禁区）。
// 同一份上游数据重跑幂等（git diff 为空）：没有生成/抓取时间戳，抓取时间只在 --report 里。

export interface ThinkingBudgetRange {
  readonly min?: number;
  readonly max?: number;
}

// 值集表存的结构（键 = 值集 id，见文件头 id 文法）。省缺 = toggle false / effort 无 /
// budget 无：表里只写真值（少一半 null/false，更好读），查表结果一律补全。
// off 是 (toggle, effort) 的纯函数，不重复存进表 —— 查表结果里按 offChannelOf 派生。
export interface ThinkingValueset {
  readonly label: string;
  readonly toggle?: boolean;
  readonly effort?: readonly string[];
  readonly budget?: ThinkingBudgetRange;
}

// 别名表条目：本仓/历史口径的 localId → 上游 id（upstream）+ 它对应的值集；reason 逐条
// 写清理由（可审），生成期保证 upstream 在快照里有词表。
export interface ThinkingModelAlias {
  readonly provider: string;
  readonly localId: string;
  readonly upstream: string;
  readonly valuesetId: string;
  readonly reason: string;
}

// 查表结果：归一后的档位空间 + 派生 off + deprecated（「表里有但废弃」≠「表里没有」）。
export interface ThinkingModelFact {
  readonly valuesetId: string;
  readonly label: string;
  readonly toggle: boolean;
  readonly effort: readonly string[] | null;
  readonly budget: ThinkingBudgetRange | null;
  readonly off: "toggle" | "effort-none" | null;
  readonly deprecated: boolean;
}

// 数据版本（UI 的 title 展示与漂移判定用）：contentHash = 值集 + 指派 + deprecated +
// 别名指向的 sha256（别名 reason 是文档，不进 hash）。同一份上游数据两次生成必然同值。
export const UPSTREAM_THINKING_SOURCE = {
  source: "https://models.dev/api.json",
  contentHash: "sha256:3b477bc5ad81f0543613baa3302795151b83d1c041339e30abbfc0da6f17b35a",
  counts: {
    models: 578,
    reasoning: 415,
    withOptions: 352,
    gaps: 63,
    borrowed: 7,
    unknown: 56,
    effortSets: 29,
    valuesets: 50,
    deprecated: 9,
    aliases: 6
  }
} as const;

export const VALUESETS: Readonly<Record<string, ThinkingValueset>> = {
  "b": { label: "always-budget", budget: {} },
  "b:1024-": { label: "always-budget", budget: { min: 1024 } },
  "b:128-32768": { label: "always-budget", budget: { min: 128, max: 32768 } },
  "high": { label: "always-effort", effort: ["high"] },
  "high-xhigh": { label: "always-effort", effort: ["high", "xhigh"] },
  "high-xhigh-max": { label: "always-effort", effort: ["high", "xhigh", "max"] },
  "low-high": { label: "always-effort", effort: ["low", "high"] },
  "low-high-max": { label: "always-effort", effort: ["low", "high", "max"] },
  "low-medium": { label: "always-effort", effort: ["low", "medium"] },
  "low-medium-high": { label: "always-effort", effort: ["low", "medium", "high"] },
  "low-medium-high+b:1024-": { label: "always-effort-budget", effort: ["low", "medium", "high"], budget: { min: 1024 } },
  "low-medium-high-max+b:1024-": { label: "always-effort-budget", effort: ["low", "medium", "high", "max"], budget: { min: 1024 } },
  "low-medium-high-xhigh": { label: "always-effort", effort: ["low", "medium", "high", "xhigh"] },
  "low-medium-high-xhigh-max": { label: "always-effort", effort: ["low", "medium", "high", "xhigh", "max"] },
  "low-medium-xhigh": { label: "always-effort", effort: ["low", "medium", "xhigh"] },
  "medium-high-xhigh": { label: "always-effort", effort: ["medium", "high", "xhigh"] },
  "minimal-high": { label: "always-effort", effort: ["minimal", "high"] },
  "minimal-low-medium-high": { label: "always-effort", effort: ["minimal", "low", "medium", "high"] },
  "minimal-low-medium-high-xhigh": { label: "always-effort", effort: ["minimal", "low", "medium", "high", "xhigh"] },
  "minimal-low-medium-high-xhigh-max": { label: "always-effort", effort: ["minimal", "low", "medium", "high", "xhigh", "max"] },
  "none-high": { label: "hybrid-effort-none", effort: ["none", "high"] },
  "none-low-high": { label: "hybrid-effort-none", effort: ["none", "low", "high"] },
  "none-low-medium-high": { label: "hybrid-effort-none", effort: ["none", "low", "medium", "high"] },
  "none-low-medium-high-xhigh": { label: "hybrid-effort-none", effort: ["none", "low", "medium", "high", "xhigh"] },
  "none-low-medium-high-xhigh-max": { label: "hybrid-effort-none", effort: ["none", "low", "medium", "high", "xhigh", "max"] },
  "none-low-medium-xhigh": { label: "hybrid-effort-none", effort: ["none", "low", "medium", "xhigh"] },
  "none-medium-high": { label: "hybrid-effort-none", effort: ["none", "medium", "high"] },
  "none-minimal-low-medium-high": { label: "hybrid-effort-none", effort: ["none", "minimal", "low", "medium", "high"] },
  "none-minimal-low-medium-high-max": { label: "hybrid-effort-none", effort: ["none", "minimal", "low", "medium", "high", "max"] },
  "none-minimal-low-medium-high-xhigh-max": { label: "hybrid-effort-none", effort: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] },
  "toggle": { label: "hybrid-switch", toggle: true },
  "toggle+b": { label: "hybrid-switch-budget", toggle: true, budget: {} },
  "toggle+b:-131072": { label: "hybrid-switch-budget", toggle: true, budget: { max: 131072 } },
  "toggle+b:-262144": { label: "hybrid-switch-budget", toggle: true, budget: { max: 262144 } },
  "toggle+b:-32768": { label: "hybrid-switch-budget", toggle: true, budget: { max: 32768 } },
  "toggle+b:-38912": { label: "hybrid-switch-budget", toggle: true, budget: { max: 38912 } },
  "toggle+b:-81920": { label: "hybrid-switch-budget", toggle: true, budget: { max: 81920 } },
  "toggle+b:0-24576": { label: "hybrid-switch-budget", toggle: true, budget: { min: 0, max: 24576 } },
  "toggle+b:512-24576": { label: "hybrid-switch-budget", toggle: true, budget: { min: 512, max: 24576 } },
  "toggle+high-max": { label: "hybrid-switch-effort", toggle: true, effort: ["high", "max"] },
  "toggle+low-high-max": { label: "hybrid-switch-effort", toggle: true, effort: ["low", "high", "max"] },
  "toggle+low-medium+b": { label: "hybrid-switch-effort-budget", toggle: true, effort: ["low", "medium"], budget: {} },
  "toggle+low-medium-high": { label: "hybrid-switch-effort", toggle: true, effort: ["low", "medium", "high"] },
  "toggle+low-medium-high-xhigh-max": { label: "hybrid-switch-effort", toggle: true, effort: ["low", "medium", "high", "xhigh", "max"] },
  "toggle+low-medium-xhigh": { label: "hybrid-switch-effort", toggle: true, effort: ["low", "medium", "xhigh"] },
  "toggle+low-medium-xhigh+b:-262144": { label: "hybrid-switch-effort-budget", toggle: true, effort: ["low", "medium", "xhigh"], budget: { max: 262144 } },
  "toggle+low-medium-xhigh+b:0-262144": { label: "hybrid-switch-effort-budget", toggle: true, effort: ["low", "medium", "xhigh"], budget: { min: 0, max: 262144 } },
  "toggle+medium-high+b": { label: "hybrid-switch-effort-budget", toggle: true, effort: ["medium", "high"], budget: {} },
  "toggle+medium-xhigh": { label: "hybrid-switch-effort", toggle: true, effort: ["medium", "xhigh"] },
  "toggle+minimal-low-medium-high": { label: "hybrid-switch-effort", toggle: true, effort: ["minimal", "low", "medium", "high"] },
};

// 指派表：上层键 = 上游 provider id（preset → 上游 provider 的映射留在调用侧），
// 下层键 = 上游模型 id（逐字大小写）。没有词表的模型不进表（fail-closed）。
export const ASSIGNMENTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "deepseek": {
    "deepseek-v4-flash-vision-exp": "toggle+low-high-max",
    "deepseek-flash": "toggle+low-high-max",
    "deepseek-v4-pro": "toggle+low-high-max",
    "deepseek-v4-flash": "toggle+low-high-max",
  },
  "alibaba-cn": {
    "qwen-flash": "toggle+b:-81920",
    "qwen3.5-flash": "toggle+b:-81920",
    "qwen3.7-max": "toggle+b",
    "qwen3-vl-plus": "toggle+b:-81920",
    "qwen3-next-80b-a3b-thinking": "b",
    "qwen3.8-max": "toggle+low-medium-xhigh+b:0-262144",
    "kimi-k3": "low-high-max",
    "qwen3.5-plus": "toggle+b:-81920",
    "glm-5": "toggle+b:-32768",
    "deepseek-v4.1-flash": "toggle+low-high-max",
    "qwen3-32b": "toggle+b:-38912",
    "qwen-plus": "toggle+b:-81920",
    "qwen3.7-flash": "toggle+b:-262144",
    "kimi-k2.6": "toggle+b:-81920",
    "qwen3-max": "toggle+b:-81920",
    "qwen-turbo": "toggle+b:-38912",
    "kimi-k2-thinking": "b",
    "qwen3.8-omni-flash": "none-low-medium-xhigh",
    "qwen3-omni-flash": "toggle",
    "qwen3-235b-a22b": "toggle+b:-38912",
    "kimi-k2.5": "toggle+b:-81920",
    "qwen3.6-flash": "toggle+b",
    "qwen3.8-flash": "toggle+low-medium-xhigh+b:-262144",
    "qwen3.6-max-preview": "toggle+b:-131072",
    "qwen3.5-397b-a17b": "toggle+b:-81920",
    "qwen3-8b": "toggle+b:-38912",
    "glm-5.2": "toggle+high-max",
    "glm-5.1": "toggle+b:-131072",
    "deepseek-v4-pro": "toggle+low-high-max",
    "qwen3.6-plus": "toggle+b:-81920",
    "qwen3-14b": "toggle+b:-38912",
    "glm-5.3": "low-high-max",
    "qwen3.7-plus": "toggle+b",
    "deepseek-v4-flash": "toggle+low-high-max",
    "siliconflow/deepseek-v3.1-terminus": "toggle",
    "siliconflow/deepseek-v3.2": "toggle",
    "kimi/kimi-k2.5": "toggle",
  },
  "zhipuai": {
    "glm-5v-turbo": "toggle",
    "glm-5.3-flash": "low-high-max",
    "glm-5": "toggle",
    "glm-5.3-flashx": "low-high-max",
    "glm-5.2": "toggle+high-max",
    "glm-5.1": "toggle",
    "glm-5.3": "low-high-max",
    "glm-4.5-air": "toggle",
    "glm-4.7-flashx": "toggle",
    "glm-4.5-flash": "toggle",
    "glm-4.7": "toggle",
    "glm-4.7-flash": "toggle",
    "glm-4.5v": "toggle",
    "glm-4.6v-flash": "toggle",
    "glm-4.6": "toggle",
    "glm-4.5": "toggle",
    "glm-4.6v": "toggle",
  },
  "kimi-code-plan-cn": {
    "kimi-for-coding": "toggle+low-high-max",
    "k3-256k": "low-high-max",
    "k3": "low-high-max",
  },
  "xiaomi": {
    "mimo-v2.6-pro": "toggle",
    "mimo-v2-flash": "toggle",
    "mimo-v2.5": "toggle",
    "mimo-v2-omni": "toggle",
    "mimo-v2.6-pro-ultraspeed": "toggle",
    "mimo-v2-pro": "toggle",
    "mimo-v2.5-pro": "toggle",
    "mimo-v2.6-flash": "toggle",
    "mimo-v2.5-pro-ultraspeed": "toggle",
  },
  "opencode-go": {
    "mimo-v2.6-pro": "toggle",
    "qwen3.7-max": "toggle+b:-262144",
    "grok-4.7": "low-medium-high-xhigh",
    "longcat-2.5-preview-free": "toggle",
    "glm-5.3-flash": "low-high-max",
    "qwen3.8-max": "toggle+low-medium-xhigh+b:0-262144",
    "kimi-k3": "low-high-max",
    "deepseek-v4.1-flash": "toggle+low-high-max",
    "deepseek-v4-flash-vision-exp": "toggle+low-high-max",
    "kimi-k2.6": "toggle",
    "longcat-2.0": "toggle",
    "grok-4.5": "low-medium-high",
    "space-bunny-free": "low-medium-high-xhigh-max",
    "mimo-v2.6-flash": "toggle",
    "minimax-m3": "toggle",
    "gpt-5.6-luna": "none-low-medium-high-xhigh-max",
    "qwen3.8-flash": "toggle+low-medium-xhigh+b:-262144",
    "glm-5.2": "toggle+high-max",
    "hy3": "none-low-high",
    "muse-spark-1.2-contributor": "minimal-low-medium-high-xhigh",
    "gpt-6-luna": "none-low-medium-high-xhigh-max",
    "deepseek-v4-pro": "toggle+low-high-max",
    "qwen3.6-plus": "toggle+b:-81920",
    "hy4-preview": "none-high",
    "muse-spark-1.3-contributor": "minimal-low-medium-high-xhigh",
    "glm-5.3": "low-high-max",
    "grok-4.6": "low-medium-high-xhigh",
    "qwen3.7-plus": "toggle+b:-262144",
    "deepseek-v4-flash": "toggle+low-high-max",
  },
  "openrouter": {
    "stealth/space-bunny-alpha": "low-medium-high-xhigh-max",
    "bytedance-seed/seed-1.6-flash": "toggle",
    "bytedance-seed/seed-2.0-lite": "toggle+minimal-low-medium-high",
    "bytedance-seed/seed-2-1-turbo": "toggle",
    "bytedance-seed/seed-2.0-mini": "toggle+minimal-low-medium-high",
    "bytedance-seed/seed-2.0-code": "toggle+low-medium-high",
    "bytedance-seed/seed-1.6": "toggle",
    "~moonshotai/kimi-latest": "toggle+low-high-max",
    "poolside/laguna-s-2.1:free": "toggle",
    "poolside/laguna-s-2.1": "toggle",
    "poolside/laguna-xs-2.1:free": "toggle",
    "poolside/laguna-xs-2.1": "toggle",
    "prism-ml/ternary-bonsai-2-27b": "toggle+medium-xhigh",
    "anthropic/claude-opus-4.1": "toggle",
    "anthropic/claude-opus-4.5": "low-medium-high+b:1024-",
    "anthropic/claude-opus-4.6": "low-medium-high-max+b:1024-",
    "anthropic/claude-opus-4.7": "low-medium-high-xhigh-max",
    "anthropic/claude-opus-4.8": "low-medium-high-xhigh-max",
    "anthropic/claude-haiku-4.5": "b:1024-",
    "anthropic/claude-opus-5": "low-medium-high-xhigh-max",
    "anthropic/claude-sonnet-5.5": "low-medium-high-xhigh-max",
    "anthropic/claude-fable-5.1": "low-medium-high-xhigh-max",
    "anthropic/claude-sonnet-4.5": "b:1024-",
    "anthropic/claude-fable-5": "low-medium-high-xhigh-max",
    "anthropic/claude-sonnet-4": "toggle",
    "anthropic/claude-sonnet-5": "toggle+low-medium-high-xhigh-max",
    "anthropic/claude-sonnet-4.6": "low-medium-high-max+b:1024-",
    "anthropic/claude-opus-5.5": "low-medium-high-xhigh-max",
    "nex-agi/nex-n2.5-mini": "none-medium-high",
    "nex-agi/nex-n2.5-pro": "none-medium-high",
    "cohere/command-a-plus": "toggle",
    "cohere/north-mini-code:free": "toggle",
    "deepseek/deepseek-chat-v3.1": "toggle",
    "deepseek/deepseek-v4-flash-0731": "toggle+low-high-max",
    "deepseek/deepseek-v4.1-flash": "toggle+low-high-max",
    "deepseek/deepseek-v4-flash-vision-exp": "toggle+low-high-max",
    "deepseek/deepseek-v3.1-terminus": "toggle",
    "deepseek/deepseek-v4-pro-0813": "toggle+low-high-max",
    "deepseek/deepseek-v3.2-exp": "toggle",
    "deepseek/deepseek-v4-pro": "toggle+low-high-max",
    "deepseek/deepseek-v3.2": "toggle",
    "deepseek/deepseek-v4-flash": "toggle+low-high-max",
    "tencent/hy3-preview": "none-low-high",
    "tencent/hunyuan-a13b-instruct": "toggle",
    "tencent/hy3": "none-low-high",
    "tencent/hy4-preview": "none-low-high",
    "~google/gemini-flash-latest": "low-medium-high",
    "~google/gemini-pro-latest": "low-medium-high",
    "perceptron/perceptron-mk1": "toggle",
    "perceptron/perceptron-mk1.5": "none-minimal-low-medium-high",
    "z-ai/glm-4.6v": "toggle",
    "z-ai/glm-4.5": "toggle",
    "z-ai/glm-5.3-prime": "low-high-max",
    "z-ai/glm-5v-turbo": "toggle",
    "z-ai/glm-5.3-flash": "low-high-max",
    "z-ai/glm-4.6": "toggle",
    "z-ai/glm-5": "toggle",
    "z-ai/glm-4.5v": "toggle",
    "z-ai/glm-5.3-flashx": "low-high-max",
    "z-ai/glm-4.7-flash": "toggle",
    "z-ai/glm-4.7": "toggle",
    "z-ai/glm-5.2": "toggle+high-max",
    "z-ai/glm-5.1": "toggle",
    "z-ai/glm-5-turbo": "toggle",
    "z-ai/glm-4.5-air": "toggle",
    "z-ai/glm-5.3": "low-high-max",
    "thinkingmachines/inkling-small:free": "none-minimal-low-medium-high-max",
    "thinkingmachines/inkling-small": "none-minimal-low-medium-high-max",
    "thinkingmachines/inkling:free": "none-minimal-low-medium-high-max",
    "thinkingmachines/inkling": "none-minimal-low-medium-high-max",
    "meituan/longcat-2.0": "toggle+b",
    "perplexity/sonar-deep-research": "toggle",
    "perplexity/sonar-reasoning-pro": "toggle",
    "meta/muse-spark-1.3": "minimal-low-medium-high-xhigh-max",
    "meta/muse-glimmer-30b": "low-medium-high-xhigh",
    "meta/muse-spark-1.1": "minimal-low-medium-high-xhigh",
    "meta/muse-spark-1.2": "minimal-low-medium-high-xhigh",
    "meta/muse-spark-1.2-contributor": "minimal-low-medium-high-xhigh",
    "meta/muse-spark-1.3-contributor": "minimal-low-medium-high-xhigh-max",
    "nousresearch/hermes-4-405b": "toggle",
    "~z-ai/glm-flash-latest": "low-high-max",
    "~z-ai/glm-latest": "low-high-max",
    "~openai/gpt-terra-latest": "none-low-medium-high-xhigh-max",
    "~openai/gpt-luna-latest": "none-low-medium-high-xhigh-max",
    "~openai/gpt-sol-latest": "low-medium-high-xhigh-max",
    "~openai/gpt-astra-latest": "low-medium-high-xhigh-max",
    "~openai/gpt-mini-latest": "none-low-medium-high-xhigh",
    "baidu/ernie-4.5-vl-424b-a47b": "toggle",
    "x-ai/grok-4.20-multi-agent": "low-medium-high-xhigh",
    "x-ai/grok-4.7": "low-medium-high-xhigh",
    "x-ai/grok-4.3": "none-low-medium-high",
    "x-ai/grok-4.5": "low-medium-high",
    "x-ai/grok-4.20": "toggle",
    "x-ai/grok-4.6": "low-medium-high-xhigh",
    "~anthropic/claude-opus-latest": "low-medium-high-xhigh-max",
    "~anthropic/claude-haiku-latest": "toggle",
    "~anthropic/claude-sonnet-latest": "low-medium-high-xhigh-max",
    "~anthropic/claude-fable-latest": "low-medium-high-xhigh-max",
    "upstage/solar-pro-3": "none-minimal-low-medium-high",
    "upstage/solar-pro4": "none-minimal-low-medium-high-xhigh-max",
    "upstage/solar-mini4": "none-minimal-low-medium-high-xhigh-max",
    "~deepseek/deepseek-flash-latest": "toggle+low-high-max",
    "~deepseek/deepseek-pro-latest": "toggle+low-high-max",
    "~deepseek/deepseek-v4-flash-latest": "toggle+low-high-max",
    "~x-ai/grok-latest": "low-medium-high-xhigh",
    "google/gemma-4-31b-it": "toggle",
    "google/gemini-3.1-flash-image-preview": "minimal-high",
    "google/gemma-4-31b-it:free": "toggle",
    "google/gemma-4-26b-a4b-it:free": "toggle",
    "google/gemini-3.6-flash": "minimal-low-medium-high",
    "google/gemma-4-26b-a4b-it": "toggle",
    "google/gemini-3.5-flash-lite": "minimal-low-medium-high",
    "google/gemini-3.1-flash-image": "minimal-high",
    "google/gemini-3.1-pro-preview": "low-medium-high",
    "google/gemini-3.5-flash": "minimal-low-medium-high",
    "google/gemini-2.5-pro": "b:128-32768",
    "google/gemini-3-pro-image": "low-high",
    "google/gemini-2.5-flash": "toggle+b:0-24576",
    "google/gemini-3.1-flash-lite-image": "minimal-high",
    "google/gemini-3.7-flash": "low-medium-high",
    "google/gemini-3.1-pro-preview-customtools": "low-medium-high",
    "google/gemini-3-flash-preview": "minimal-low-medium-high",
    "google/gemini-3.8-flash": "low-medium-high",
    "google/gemini-2.5-flash-lite": "toggle+b:512-24576",
    "google/gemini-2.5-pro-preview": "b:128-32768",
    "google/gemini-3.1-flash-lite-preview": "minimal-low-medium-high",
    "google/gemini-3.1-flash-lite": "minimal-low-medium-high",
    "ibm-granite/granite-4.2-8b": "none-low-high",
    "fireworks/ember-1": "toggle+low-high-max",
    "mistralai/mistral-medium-3-5": "none-high",
    "mistralai/mistral-small-2603": "none-high",
    "sakana/fugu-max": "high-xhigh-max",
    "sakana/fugu-ultra-v2": "high-xhigh-max",
    "sakana/fugu-ultra": "high-xhigh",
    "sakana/sakana-namazu": "toggle",
    "inclusionai/ling-3.0-flash-sante:free": "toggle",
    "inclusionai/ling-3.0-flash": "toggle",
    "inclusionai/ling-3.1-flash": "toggle",
    "inclusionai/ling-3.0-flash-vl": "toggle",
    "inclusionai/ling-3.0-flash-fin": "toggle",
    "moonshotai/kimi-k3": "low-high-max",
    "moonshotai/kimi-k2.6": "toggle",
    "moonshotai/kimi-k2.5": "toggle",
    "apodex/apodex-1.1-mini:free": "toggle",
    "nvidia/nemotron-3-nano-30b-a3b": "toggle",
    "nvidia/nemotron-3.5-content-safety:free": "toggle",
    "nvidia/nemotron-3.5-lightning": "toggle",
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free": "toggle+b",
    "nvidia/nemotron-3-super-120b-a12b": "toggle+low-medium+b",
    "nvidia/nemotron-3-ultra-550b-a55b:free": "toggle+medium-high+b",
    "nvidia/nemotron-3-ultra-550b-a55b": "toggle+medium-high+b",
    "nvidia/nemotron-3-super-120b-a12b:free": "toggle+low-medium+b",
    "nvidia/nemotron-3.5-content-safety": "toggle",
    "nvidia/nemotron-3.5-lightning:free": "toggle",
    "xiaomi/mimo-v2.6-pro": "toggle",
    "xiaomi/mimo-v2.5": "toggle",
    "xiaomi/mimo-v2.6-pro-ultraspeed": "toggle",
    "xiaomi/mimo-v2.5-pro": "toggle",
    "xiaomi/mimo-v2.6-flash": "toggle",
    "minimax/minimax-m1": "toggle",
    "minimax/minimax-m3": "toggle",
    "stepfun/step-3.5-flash": "low-high",
    "stepfun/step-3.7-flash": "low-medium-high",
    "dots-studio/dots-3-note-preview:free": "toggle",
    "inception/mercury-2.5": "none-low-medium-high",
    "inception/mercury-2": "none-low-medium-high",
    "amazon/nova-2-lite-v1": "toggle",
    "aion-labs/aion-3.5": "low-high-max",
    "aion-labs/aion-3.5-mini": "low-high-max",
    "qwen/qwen3.7-max": "toggle+b",
    "qwen/qwen3.8-27b": "toggle+low-medium-xhigh",
    "qwen/qwen3.8-2.4t-a95b": "low-medium-xhigh",
    "qwen/qwen3.5-27b": "toggle+b",
    "qwen/qwen3-next-80b-a3b-thinking": "b",
    "qwen/qwen3-32b": "toggle+b",
    "qwen/qwen3.7-flash": "toggle+b:-262144",
    "qwen/qwen3.8-omni-flash": "none-low-medium-xhigh",
    "qwen/qwen3-235b-a22b": "toggle+b",
    "qwen/qwen3.5-122b-a10b": "toggle+b",
    "qwen/qwen3.6-35b-a3b": "toggle+b",
    "qwen/qwen3.6-flash": "toggle+b",
    "qwen/qwen3.5-flash-02-23": "toggle",
    "qwen/qwen3-max-thinking": "toggle",
    "qwen/qwen3.5-9b": "toggle",
    "qwen/qwen3.8-max-prime": "minimal-low-medium-high-xhigh",
    "qwen/qwen3.5-plus-20260420": "toggle",
    "qwen/qwen3.8-flash": "toggle+low-medium-xhigh+b:-262144",
    "qwen/qwen3.5-35b-a3b": "toggle+b",
    "qwen/qwen3.6-max-preview": "toggle+b",
    "qwen/qwen3-30b-a3b": "toggle",
    "qwen/qwen3.5-397b-a17b": "toggle+b",
    "qwen/qwen3-8b": "toggle",
    "qwen/qwen3.5-plus-02-15": "toggle",
    "qwen/qwen3.6-27b": "toggle+b",
    "qwen/qwen3.6-plus": "toggle+b",
    "qwen/qwen3-14b": "toggle",
    "qwen/qwen3.7-plus": "toggle+b",
    "qwen/qwen3.8-27b:free": "toggle+low-medium-xhigh",
    "qwen/qwen3.8-max-0902": "minimal-low-medium-high-xhigh",
    "openai/gpt-5.4": "none-low-medium-high-xhigh",
    "openai/gpt-5.4-image-2": "none-low-medium-high-xhigh",
    "openai/gpt-5.4-pro": "medium-high-xhigh",
    "openai/gpt-6-astra-pro": "low-medium-high-xhigh-max",
    "openai/gpt-5.5-pro": "medium-high-xhigh",
    "openai/gpt-5.4-nano": "none-low-medium-high-xhigh",
    "openai/gpt-5.2-codex": "low-medium-high-xhigh",
    "openai/gpt-5.1-codex": "low-medium-high",
    "openai/gpt-5.6-sol-pro": "none-low-medium-high-xhigh-max",
    "openai/gpt-5-mini": "minimal-low-medium-high",
    "openai/gpt-5.2-pro": "medium-high-xhigh",
    "openai/o4-mini": "low-medium-high",
    "openai/o3-mini": "low-medium-high",
    "openai/gpt-5.3-codex": "none-low-medium-high-xhigh",
    "openai/gpt-5-nano": "minimal-low-medium-high",
    "openai/o1": "low-medium-high",
    "openai/gpt-5-pro": "high",
    "openai/gpt-6.1-sol": "low-medium-high-xhigh-max",
    "openai/gpt-6-astra": "low-medium-high-xhigh-max",
    "openai/gpt-5.6-luna-pro": "none-low-medium-high-xhigh-max",
    "openai/gpt-5.1": "none-low-medium-high",
    "openai/o3-pro": "low-medium-high",
    "openai/gpt-oss-20b": "low-medium-high",
    "openai/gpt-oss-safeguard-20b": "low-medium-high",
    "openai/o3-mini-high": "high",
    "openai/gpt-6-sol-pro": "none-low-medium-high-xhigh-max",
    "openai/gpt-5.4-mini": "none-low-medium-high-xhigh",
    "openai/gpt-5.6-luna": "none-low-medium-high-xhigh-max",
    "openai/gpt-5.1-codex-max": "low-medium-high-xhigh",
    "openai/gpt-5.2": "none-low-medium-high-xhigh",
    "openai/gpt-5.5": "none-low-medium-high-xhigh",
    "openai/gpt-5.6-terra-pro": "none-low-medium-high-xhigh-max",
    "openai/gpt-6-luna": "none-low-medium-high-xhigh-max",
    "openai/gpt-6.1-sol-pro": "low-medium-high-xhigh-max",
    "openai/o4-mini-high": "high",
    "openai/gpt-6-luna-pro": "none-low-medium-high-xhigh-max",
    "openai/gpt-5.6-terra": "none-low-medium-high-xhigh-max",
    "openai/gpt-oss-120b": "low-medium-high",
    "openai/gpt-5.1-codex-mini": "toggle+low-medium-high",
    "openai/o3": "low-medium-high",
    "openai/gpt-5": "minimal-low-medium-high",
    "openai/gpt-5.6-sol": "none-low-medium-high-xhigh-max",
    "openai/gpt-6-sol": "none-low-medium-high-xhigh-max",
    "openai/o1-pro": "low-medium-high",
  },
  "stepfun-step-plan": {
    "step-5-preview": "low-medium-high",
    "step-3.5-flash-2603": "low-high",
    "step-3.5-flash": "low-high",
    "step-3.7-flash": "low-medium-high",
  },
  "modelscope": {
    "ZhipuAI/GLM-4.6": "toggle",
    "ZhipuAI/GLM-4.5": "toggle",
  },
  "amd": {
    "Qwen3.8-27B": "low-medium",
    "DeepSeek-V4.1-Flash": "toggle+low-high-max",
    "DeepSeek-V4-Flash": "toggle+low-high-max",
    "Qwen3.8-Flash-Next": "low-medium-xhigh",
    "DeepSeek-V4-Flash-Vision-Exp": "toggle+low-high-max",
  },
  "sensenova": {
    "kimi-k3": "low-high-max",
    "sensenova-6.8-flash-lite": "none-low-medium-high",
    "glm-5.2": "toggle+high-max",
    "deepseek-v4-pro": "toggle+low-high-max",
    "deepseek-v4-flash": "toggle+low-high-max",
  },
  "minimax-cn": {
    "MiniMax-M3": "toggle",
  },
};

// deprecated 模型（spec 裁定 12）：进表并标记，不删。
export const DEPRECATED_MODELS: readonly string[] = [
  "deepseek/deepseek-v4-flash-vision-exp",
  "deepseek/deepseek-v4-flash",
  "xiaomi/mimo-v2-flash",
  "xiaomi/mimo-v2-omni",
  "xiaomi/mimo-v2-pro",
  "opencode-go/qwen3.7-max",
  "opencode-go/kimi-k2.6",
  "opencode-go/grok-4.5",
  "opencode-go/qwen3.6-plus",
];

// 别名表（spec 裁定 13：精确匹配 + 折叠大小写 + 别名表）。生成期已校验每条 upstream
// 在快照里有词表；reason 是逐条理由（上游 id 依据），可审。
export const MODEL_ID_ALIASES: readonly ThinkingModelAlias[] = [
  { provider: "kimi-code-plan-cn", localId: "kimi-k3", upstream: "kimi-code-plan-cn/k3", valuesetId: "low-high-max", reason: "上游没有 kimi-k3，实际 id 是 k3（canonical_model_id = moonshotai/kimi-k3）；本仓 thinking-profiles 的 EXCEPTIONS/TAXONOMY 用 kimi-k3 称呼它。" },
  { provider: "kimi-code-plan-cn", localId: "kimi-k2.6", upstream: "moonshotai/kimi-k2.6", valuesetId: "toggle", reason: "上游 kimi-code-plan-cn 没有 kimi-k2.6；本仓 TAXONOMY 的 kimi-k2.6 模式指原生 moonshotai 的 K2.6（词表 toggle）。" },
  { provider: "stepfun-step-plan", localId: "step-3.7", upstream: "stepfun-step-plan/step-3.7-flash", valuesetId: "low-medium-high", reason: "上游只有 step-3.7-flash（没有 step-3.7 本身）；本仓 TAXONOMY 用前缀 step-3.7 命中它。" },
  { provider: "opencode-go", localId: "kimi-k2.6", upstream: "moonshotai/kimi-k2.6", valuesetId: "toggle", reason: "上游 opencode-go/kimi-k2.6 词表为空数组（deprecated）且无 canonical 可借；原生 moonshotai 同名模型是 toggle。" },
  { provider: "modelscope", localId: "GLM-4.6", upstream: "modelscope/ZhipuAI/GLM-4.6", valuesetId: "toggle", reason: "上游 modelscope 的 id 带命名空间前缀且大小写混排（ZhipuAI/GLM-4.6，name 是裸 GLM-4.6）；本仓/用户口径是裸 id。" },
  { provider: "modelscope", localId: "GLM-4.5", upstream: "modelscope/ZhipuAI/GLM-4.5", valuesetId: "toggle", reason: "同上：上游 id 是 ZhipuAI/GLM-4.5，本仓/用户口径是裸 GLM-4.5。" },
];

// 纯查表（请求路径的唯一入口）：键 = (上游 provider id, 模型 id)。
//   命中序：精确 → 折叠大小写 → 别名表；都不中返回 null（fail-closed：未知词表的模型
//   请求侧不发任何思考参数，行为同今日）。
// provider 也折叠大小写（上游 provider id 全小写，请求侧来源可能是 preset 名）。
export function lookupThinkingFact(upstreamId: unknown, modelId: unknown): ThinkingModelFact | null {
  if (typeof upstreamId !== "string" || typeof modelId !== "string") {
    return null;
  }
  const providerKey = upstreamId.trim().toLowerCase();
  const modelKey = modelId.trim();
  if (providerKey.length === 0 || modelKey.length === 0) {
    return null;
  }
  const resolved = resolveThinkingKey(providerKey, modelKey);
  if (!resolved) {
    return null;
  }
  const valueset = VALUESETS[resolved.valuesetId];
  if (!valueset) {
    return null;
  }
  return {
    valuesetId: resolved.valuesetId,
    label: valueset.label,
    toggle: valueset.toggle === true,
    effort: valueset.effort ?? null,
    budget: valueset.budget ?? null,
    off: offChannelOf(valueset),
    deprecated: DEPRECATED_MODELS.includes(`${resolved.provider}/${resolved.modelId}`)
  };
}

// 关思考怎么表达（单源派生）：有开关走平台开关；effort 词表含 none 走 effort none；
// 两者都没有 = 关不掉。与 spec §词汇覆盖缺口 的归一规则一一对应。
function offChannelOf(valueset: ThinkingValueset): "toggle" | "effort-none" | null {
  if (valueset.toggle === true) {
    return "toggle";
  }
  return valueset.effort && valueset.effort.includes("none") ? "effort-none" : null;
}

interface ResolvedThinkingKey {
  readonly provider: string;
  readonly modelId: string;
  readonly valuesetId: string;
}

function resolveThinkingKey(providerKey: string, modelKey: string): ResolvedThinkingKey | null {
  const table = ASSIGNMENTS[providerKey];
  if (table) {
    const exact = table[modelKey];
    if (exact) {
      return { provider: providerKey, modelId: modelKey, valuesetId: exact };
    }
    const folded = modelKey.toLowerCase();
    for (const candidate of Object.keys(table)) {
      if (candidate.toLowerCase() === folded) {
        return { provider: providerKey, modelId: candidate, valuesetId: table[candidate] };
      }
    }
  }
  const folded = modelKey.toLowerCase();
  for (const alias of MODEL_ID_ALIASES) {
    if (alias.provider !== providerKey || alias.localId.toLowerCase() !== folded) {
      continue;
    }
    const slash = alias.upstream.indexOf("/");
    if (slash > 0) {
      return {
        provider: alias.upstream.slice(0, slash),
        modelId: alias.upstream.slice(slash + 1),
        valuesetId: alias.valuesetId
      };
    }
  }
  return null;
}
