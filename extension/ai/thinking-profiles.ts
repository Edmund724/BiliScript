// ai/thinking-profiles.ts — 思考档位（off/low/high）→ 本次请求发什么思考参数的纯查表模块。
// 无 DOM/port/chrome 依赖；resolveThinkingProfile 是导出纯函数，请求构造单缝
// （ai/completion.ts）与对话 UI（offUnavailable 提示）都直接调用。
//
// **职责（04 号票起）= 产品语义 + 上游未覆盖兜底。** 逐模型「哪档发哪套词汇」的
// 事实源不再是本文件的手写表，而是 02 号票的上游编译产物
// （ai/catalog/models-dev-thinking.generated.ts：值集常量表 VALUESETS + (上游 provider,
// 模型 id) 指派表 ASSIGNMENTS + 别名表，来自 models.dev/api.json 的构建期快照）。
// 本文件只保留两类东西：
//   A. 产品语义（不属上游）：thinkingClass 与 offUnavailable / offFallback 的级联、
//      streamOnly（关思考仅流式）、probeOmitsThinking（在 ai/thinking-wire-map.ts）、
//      unknownClass 白名单兜底、never 血统判定入口；
//   B. 上游未覆盖处的兜底：无上游平台（ollama / custom / 未知 host）继续走正则
//      TAXONOMY / EXCEPTIONS；有上游平台但指派表里查不到该模型（用户自填 id、上游
//      缺口、非 reasoning 模型）同样回落手写表；两边都没事实 → UNKNOWN 哨兵
//      （fail-closed，不发参）。
//
// **本票的过渡态（用户裁定：指派表优先 + 手写降级兜底）**：点名翻转的三处
// （zhipuai/glm-5.2、zhipuai/glm-5.3、kimi-code-plan-cn/k3）原先是手写专条
// （TAXONOMY `glm-5.2`、EXCEPTIONS `glm-5.3` / `kimi-k3`）说了算；现在这三条
// **留在原处但已降级**——解析顺序上指派表在先，命中即不看手写表，所以原生模型照上游翻转；
// 手写专条只剩「指派表不认识的 id」兜底职责（用户自填 / 上游新变体，如 glm-5.3-air）。
// 为什么不真删：那些 id 是无界的，删了正则就会改变它们的请求体，既与「其余行为冻结」
// 冲突，又无法用精确 id 的 PENDING_DIVERGENCES 覆盖（冻结表刻意不是正则）。
// 待残留清单逐条裁完（.scratch/tickets/upstream-model-facts/artifacts/
// 04-prune-matrix.residual.md）再决定是否完成删除。
//
// 本模块输出的 fields 是**协议无关的中转词汇**（OpenAI 词汇），不回答「这套词汇在
// 某协议请求体里长什么样」：那是线格式映射表（ai/thinking-wire-map.ts）的职责，
// adapter 不再各自 if 着改写。
//
// 事实的唯一主人：
// - 上游逐模型词表 / 指派 / 别名 → 02 产物（构建期生成，勿手改；漂移对账见
//   `pnpm catalog:check`）；
// - 平台 preset 列表 / baseUrl → core/presets.ts（host 索引收口在
//   core/preset-host-index.ts，不复制 baseUrl）；
// - preset → 上游 provider 的桥接 → 本文件的 UPSTREAM_PROVIDER_BY_PRESET
//   （临时表，10 号票搬进 core/presets.ts 的 preset 数据）；
// - 无上游平台的模型血统（永远/混合/永不思考）与模型名模式 → 本文件的
//   TAXONOMY / EXCEPTIONS（每格注释里简写出处域名）；它们同时是「有上游平台但指派表
//   未覆盖该 id」的兜底（见上 B 与过渡态说明）；
// - 已确认分歧的**行为冻结** → 本文件的 PENDING_DIVERGENCES（逐条精确 id + 理由 +
//   上游证据；用户裁定 2：本轮只翻点名三处，其余维持现状）。
// 设计机制（三层声明表 + 稀疏档位 + 测试期校验器）参考 hana-model-catalog
// （github.com/liliMozi/hana-model-catalog；无 LICENSE，仅参考未复制数据）。
//
// 解析语义（04 号票起）：
//   provider = PROVIDERS[presetId] ?? HOST索引[baseUrl host] ?? 无
//   ① provider override 型（OpenRouter / AMD / SenseNova / Opencode Go）：
//      levels[level] 对任何模型整体替换 class 规则（识别层短路）——平台级产品裁定，
//      不逐格比上游（03 报告 §6）。
//   ② 有上游平台（UPSTREAM_PROVIDER_BY_PRESET 命中）：
//      PENDING_DIVERGENCES（精确 id 冻结表）→ 手写结论；
//      否则查指派表 → ruleFromUpstreamFact（值集 → 三档投影）；
//      指派表未命中 → 回落 ③。
//   ③ 手写表兜底：EXCEPTIONS（精确/前缀模型） >> TAXONOMY（模式→class）
//      >> provider.unknownClass >> UNKNOWN 哨兵。
//   patch = 规则[level]；streamOnly 规则遇非流式按「无事实」处理（Q14A）。
//   仅 off 级联：never → 不发、静默（关思考已天然成立）；其余有 low 声明
//   （开关型落 on 写点）→ 发 low + offUnavailable + offFallback:"low"；无 low
//   → 不发 + offUnavailable + offFallback:null。
//   low/high 缺档不 clamp、不发（Q12C）。
//   unknown 是显式哨兵（thinkingClass:"unknown"，非静默 false）：三档均不发
//   （Q4C——软失败优于硬 400）。
//
// 三档投影（04 号票；7 档词表与 clamp 是 05 号票）——上游值集 → 本模块的三档：
//   off  = 值集有 toggle → 平台开关的关形状（UPSTREAM_TOGGLE_SHAPES）；
//          effort 词表含 none → reasoning_effort:"none"；
//          两者都没有 = 关不掉 → 走既有 offUnavailable / offFallback 级联（不臆造）。
//   low  = effort 词表里的 "low"；没有则取词表最小档（不足向下取，与 05 号票同向）。
//   high = effort 词表里的 "high"；没有则取词表最大档（如 qwen3.8-max 的 xhigh）。
//   词表里的 "none" 只是 off 的一种线值实现，不参与 low/high 选档。
//   budget_tokens 不进本模块：本仓任何通道都不发预算（硬规则见 ai/thinking-wire-map.ts）。
//   平台没有登记开关形状（UPSTREAM_TOGGLE_SHAPES 缺该平台）时不发开关——不发明形状。
// 上游数据只在构建期被读；本模块消费的是编译产物，且本模块与产物都不在 SW 静态图里
// （scripts/build.js 的 assertBackgroundStaticGraphSlim 对两者都 fail fast）。

import { hostOf, presetIdForHost } from "../core/preset-host-index.js";
import { lookupThinkingFact, type ThinkingModelFact } from "./catalog/models-dev-thinking.generated.js";

// ===== 档位词表 =====
// UI 三档按钮与全局档位键的取值域（唯一主人自本票起收口至此）。
export const AI_THINKING_LEVELS = ["off", "low", "high"] as const;
export type ThinkingLevel = (typeof AI_THINKING_LEVELS)[number];

export function normalizeThinkingLevel(value: unknown): ThinkingLevel {
  return (AI_THINKING_LEVELS as readonly string[]).includes(String(value))
    ? (String(value) as ThinkingLevel)
    : "off";
}

// ===== schema =====
// 单档字段补丁。fields 键白名单：thinking / enable_thinking / reasoning_effort
// （校验器强制）。温度类字段明令禁止——Kimi 等平台思考模式温度/top_p 固定且
// 官方明确不要显式传，本扩展从不发 temperature 是安全属性。
// 这三套字段词汇是**中转词汇**：语义见 compat-vocab 词表的 thinkingFormat，
// 「本协议线上怎么落」见线格式映射表（thinking-wire-map）；本表逐格给「哪档发
// 哪套词汇」的**血统事实**，三层分工不重叠。
export interface ThinkingPatch {
  fields?: Record<string, unknown>;
  // 仅流式可发（如 qwen3-235b/32b/30b 的 enable_thinking:false，百炼限制）；
  // 非流式请求遇此规则按「无事实」处理，走级联（Q14A）。
  // 该限制的平台语义是怪癖 streamingOnlyThinkingOff（compat-vocab 词表）。
  streamOnly?: boolean;
}

// 模型血统规则。thinkingClass 是血统事实（校验器强制必填）：
// always=关不掉（off 缺失时级联）；hybrid=可开关（必有 off 声明，可 streamOnly）；
// never=从不思考（无任何档位，off 静默）。
// 开关型平台用 on 作为 low/high 的唯一写点（GLM/Kimi/Mimo/SiliconFlow 等——
// 档位只表达「开」，无力度差异）；三档型（effort/budget 系）写显式 low/high。
export interface ClassRule {
  thinkingClass: "always" | "hybrid" | "never";
  off?: ThinkingPatch;
  on?: ThinkingPatch;
  low?: ThinkingPatch;
  high?: ThinkingPatch;
  // token 上限参数的随表事实（openai-reasoning 系须 max_completion_tokens）；
  // 缺省 = max_tokens。参数名差异的平台语义见 compat-vocab 词表的 maxTokensField
  // （本表只给逐模型事实，词表给"这条怪癖是什么"）；该事实落到某协议线上叫什么名字，
  // 由线格式映射表的出参决定（本表不决定协议写法）。
  tokenParam?: "max_tokens" | "max_completion_tokens";
}

// 模式表条目：patterns 为模型名前缀（小写比较），内嵌 * 为通配（两端锚定）。
// 数组序 = 优先级（先命中先得），靠序解决前缀包含关系（如 glm-5.2 先于 glm-5）。
export interface TaxonomyEntry {
  class: string;
  patterns: string[];
}

// 平台规则：unknownClass 给「词汇平台无关」平台的未列模型兜底；override 型
// （OpenRouter）对任何模型整体替换 class 规则。两者互斥使用。
export interface ProviderOverride {
  thinkingClass: "always" | "hybrid" | "never";
  levels: Partial<Record<ThinkingLevel, ThinkingPatch>>;
}

export interface ProviderRule {
  unknownClass?: string;
  override?: ProviderOverride;
}

// ===== CLASSES：class 规则（参数事实的写点，一格一事实）=====
export const CLASSES: Record<string, ClassRule> = {
  // --- OpenAI（developers.openai.com）---
  // gpt-5.x/o3/o4/gpt-6 血统：effort 档位，无 none 的模型关不掉 → always，off 级联落 low。
  "openai-reasoning": {
    thinkingClass: "always",
    low: { fields: { reasoning_effort: "low" } },
    high: { fields: { reasoning_effort: "high" } },
    // reasoning 模型不认 max_tokens（04 号票消费此事实）
    tokenParam: "max_completion_tokens"
  },
  // 例外表成员 gpt-5.1/5.2：支持 reasoning_effort:"none" → hybrid。
  "openai-reasoning-none": {
    thinkingClass: "hybrid",
    off: { fields: { reasoning_effort: "none" } },
    low: { fields: { reasoning_effort: "low" } },
    high: { fields: { reasoning_effort: "high" } },
    tokenParam: "max_completion_tokens"
  },

  // --- Qwen/百炼（alibabacloud.com 百炼 Deep Thinking；qwen.ai）---
  // 开关型：enable_thinking，档位无力度差异 → on 唯一写点。
  "qwen-hybrid-switch": {
    thinkingClass: "hybrid",
    off: { fields: { enable_thinking: false } },
    on: { fields: { enable_thinking: true } }
  },
  // 例外表成员 qwen3-235b*/qwen3-32b/qwen3-30b*：enable_thinking:false 仅流式可用。
  // （矩阵矩阵行只点名 235b/32b「仅流式」，spec/工单把 30b 一并标 streamOnly——
  // 从宽处理，非流式落级联最安全。）
  "qwen-hybrid-switch-streamonly": {
    thinkingClass: "hybrid",
    off: { fields: { enable_thinking: false }, streamOnly: true },
    on: { fields: { enable_thinking: true } }
  },
  // 例外表成员 qwen3.8-max*：开关 + effort 三档（high 映射 xhigh）。
  "qwen-hybrid-effort": {
    thinkingClass: "hybrid",
    off: { fields: { enable_thinking: false } },
    low: { fields: { reasoning_effort: "low" } },
    high: { fields: { reasoning_effort: "xhigh" } }
  },
  // thinking-2507 系 / qwen3-next-*-thinking / qwq / qwen3.7-max-preview /
  // qwen3.8-2.4t-a95b：永远思考，无关闭无档位。
  "qwen-always": { thinkingClass: "always" },

  // --- DeepSeek（api-docs.deepseek.com）---
  // v3.2/v4-pro/flash 现行混合：off 用 thinking 开关、low/high 用 effort。
  "deepseek-hybrid-effort": {
    thinkingClass: "hybrid",
    off: { fields: { thinking: { type: "disabled" } } },
    low: { fields: { reasoning_effort: "low" } },
    high: { fields: { reasoning_effort: "high" } }
  },
  // deepseek-reasoner（V3.2 时代）/ deepseek-r1 系：永远思考、无档位。
  "deepseek-reasoner-always": { thinkingClass: "always" },
  // deepseek-chat（V3.2-Exp 时代）：永不思考。
  "deepseek-chat-never": { thinkingClass: "never" },

  // --- GLM 智谱（docs.bigmodel.cn）---
  // glm-4.5~5.1：开关型 thinking.type。
  "glm-hybrid-switch": {
    thinkingClass: "hybrid",
    off: { fields: { thinking: { type: "disabled" } } },
    on: { fields: { thinking: { type: "enabled" } } }
  },
  // glm-5.2 起 effort 三档（关闭仍走 thinking 开关）。
  // 04 号票后只服务行为冻结行 alibaba-cn/glm-5.2（PENDING_DIVERGENCES）+ 指派表不认识的
  // glm-5.2* id（用户自填 / 上游新变体）兜底；原生 zhipuai/glm-5.2 已按上游指派表翻转
  // （值集 high-max：关不掉 + effort 档，见文件头「两套匹配不并存」）。
  "glm-hybrid-effort": {
    thinkingClass: "hybrid",
    off: { fields: { thinking: { type: "disabled" } } },
    low: { fields: { reasoning_effort: "low" } },
    high: { fields: { reasoning_effort: "high" } }
  },
  // 永远思考：04 号票后只服务行为冻结行 zhipuai/glm-5.3-flash|-flashx 与 alibaba-cn/glm-5.3
  // + 指派表不认识的 glm-5.3* id 兜底（原「例外表成员 glm-5.3*」；原生 zhipuai/glm-5.3 已按
  // 上游指派表翻转成 effort low-high-max）。
  "glm-always": { thinkingClass: "always" },

  // --- Kimi（platform.kimi.ai / kimi.com/code/docs）---
  // kimi-k2.5/k2.6：开关型 thinking.type（k2.x 无档位）。
  "kimi-hybrid-switch": {
    thinkingClass: "hybrid",
    off: { fields: { thinking: { type: "disabled" } } },
    on: { fields: { thinking: { type: "enabled" } } }
  },
  // 永远思考 + effort 三档（默认 max）。
  // 04 号票后只服务指派表不认识的 kimi-k3* id 兜底（原「例外表成员 kimi-k3*」；原生
  // kimi-code-plan-cn/k3 已按上游指派表翻转：值集 toggle+low-high-max → off 可用）。
  "kimi-k3-effort": {
    thinkingClass: "always",
    low: { fields: { reasoning_effort: "low" } },
    high: { fields: { reasoning_effort: "high" } }
  },
  // 例外表成员 kimi-k2.7*：强制 thinking:{type:"enabled",keep:"all"}（仅接受该形状）
  // → 永远思考；无档位 → off 级联不发（泛化的 enabled 形状也不发，缺事实不指定）。
  "kimi-always": { thinkingClass: "always" },
  // kimi-k2 instruct 系：永不思考。
  "kimi-instruct-never": { thinkingClass: "never" },

  // --- MiniMax（platform.minimax.io / github.com/MiniMax-AI）---
  // m1~m3 全系永远思考：无关闭开关、无档位参数。
  "minimax-always": { thinkingClass: "always" },

  // --- 豆包/火山方舟（volcengine.com 方舟深度思考）---
  // doubao-seed 系混合开关；depth 档位随模型不同、无逐模型事实 → 不写（Q8A）。
  "doubao-hybrid-switch": {
    thinkingClass: "hybrid",
    off: { fields: { thinking: { type: "disabled" } } },
    on: { fields: { thinking: { type: "enabled" } } }
  },

  // --- StepFun（platform.stepfun.com step_plan reasoning API）---
  // 例外表成员 step-3.7：永远思考 + effort 三档（/think off 客户端语义即映射 low 档）。
  "step37-effort": {
    thinkingClass: "always",
    low: { fields: { reasoning_effort: "low" } },
    high: { fields: { reasoning_effort: "high" } }
  },
  // step-3 / step-3.5-flash：推理模型，无关闭参数、无已文档化档位参数（3.5 的
  // low-inference 是产品模式非请求参数）→ 不写 patch。
  "step-always": { thinkingClass: "always" },

  // --- Mimo 小米（aliyun.com 百炼代售页）---
  // 开关型 enable_thinking（v2.5-pro 默认开），无官方档位参数。
  "mimo-hybrid-switch": {
    thinkingClass: "hybrid",
    off: { fields: { enable_thinking: false } },
    on: { fields: { enable_thinking: true } }
  },

  // --- Ollama（docs.ollama.com OpenAI 兼容）---
  // effort 词汇：off=none、low/high=effort；thinking/enable_thinking 被静默忽略。
  // 作为 unknownClass 给未列模型兜底（hybrid=平台词汇可用、模型是否思考未知）。
  "ollama-effort": {
    thinkingClass: "hybrid",
    off: { fields: { reasoning_effort: "none" } },
    low: { fields: { reasoning_effort: "low" } },
    high: { fields: { reasoning_effort: "high" } }
  },

  // --- SiliconFlow（docs.siliconflow.cn）---
  // 开关型 enable_thinking（适用大多数推理模型），作为 unknownClass 兜底；
  // 其 effort/thinking_budget 只对特定模型文档化且未给逐模型事实 → 不写。
  "siliconflow-switch": {
    thinkingClass: "hybrid",
    off: { fields: { enable_thinking: false } },
    on: { fields: { enable_thinking: true } }
  }
};

// ===== EXCEPTIONS：精确/前缀模型例外（压过 TAXONOMY，Q11C：换线协议的新一代）=====
// 数组序 = 优先级；首条是刻意前置的 carve-out：*thinking-2507 变体若不先命中，
// 会被下面的 qwen3-235b/qwen3-30b 前缀误判成 streamOnly 混合（对永远思考模型
// 发 enable_thinking:false 会报错）。
export const EXCEPTIONS: readonly TaxonomyEntry[] = [
  // 百炼：qwen3-*-thinking-2507 永远思考（alibabacloud.com）
  { class: "qwen-always", patterns: ["qwen3-*-thinking-2507"] },
  // qwen3.8-max*：effort 档位、high→xhigh（alibabacloud.com / qwen.ai）
  { class: "qwen-hybrid-effort", patterns: ["qwen3.8-max"] },
  // qwen3-235b*/qwen3-32b/qwen3-30b*：off 规则仅流式（alibabacloud.com）
  { class: "qwen-hybrid-switch-streamonly", patterns: ["qwen3-235b", "qwen3-32b", "qwen3-30b"] },
  // 注（04 号票·降级兜底）：下表两条 + TAXONOMY 的 glm-5.2 专条**保留原处**，但逐模型事实
  // 已让位给 02 指派表（解析顺序：指派表命中 → 手写兜底 → unknownClass → fail-closed）。
  // 它们现在只服务「指派表不认识的 id」：用户自填 / 上游新变体（如 glm-5.3-air、kimi-k3-air）。
  // 真删会让这些无界 id 的请求体跟着变，与「只翻点名三处、其余行为冻结」冲突；上游不一致的
  // 托管/变体行（zhipuai/glm-5.3-flash(x)、alibaba-cn/glm-5.3 等）另在 PENDING_DIVERGENCES
  // 逐条冻结。
  // glm-5.3*：disabled 直接报错 → 永远思考（docs.bigmodel.cn）
  { class: "glm-always", patterns: ["glm-5.3"] },
  // kimi-k2.7*：强制 keep:all → 永远思考（platform.kimi.ai）
  { class: "kimi-always", patterns: ["kimi-k2.7"] },
  // kimi-k3*：effort 三档 → 永远思考（platform.kimi.ai）
  { class: "kimi-k3-effort", patterns: ["kimi-k3"] },
  // gpt-5.1/5.2：off → reasoning_effort:"none"（developers.openai.com）
  { class: "openai-reasoning-none", patterns: ["gpt-5.1", "gpt-5.2"] },
  // gpt-6*/o3/o4*：无 none（传了 400）→ 永远思考（developers.openai.com）
  { class: "openai-reasoning", patterns: ["gpt-6", "o3", "o4"] }
];

// ===== TAXONOMY：模型名模式 → class（数组序 = 优先级）=====
// 模型 identity → class 的逐行落地；模式统一小写前缀匹配（内嵌 * 通配）。
export const TAXONOMY: readonly TaxonomyEntry[] = [
  // 百炼永远思考族：qwen3-next-*-thinking / qwen3.7-max-preview /
  // qwen3.8-2.4t-a95b / qwq（thinking-2507 系在例外表前置 carve-out）
  { class: "qwen-always", patterns: ["qwen3-next-*-thinking", "qwen3.7-max-preview", "qwen3.8-2.4t-a95b", "qwq"] },
  // qwen3 商业族 + qwen3.5/3.6/3.7/3.8：混合开关（默认值随代际不同，不影响显式发参）
  { class: "qwen-hybrid-switch", patterns: ["qwen3-max", "qwen-plus", "qwen-flash", "qwen-turbo", "qwen3.5", "qwen3.6", "qwen3.7", "qwen3.8"] },
  // DeepSeek：chat 永不 / reasoner·r1 永远 / v3.2·v4 混合（api-docs.deepseek.com）
  { class: "deepseek-chat-never", patterns: ["deepseek-chat"] },
  { class: "deepseek-reasoner-always", patterns: ["deepseek-reasoner", "deepseek-r1"] },
  { class: "deepseek-hybrid-effort", patterns: ["deepseek-v3.2", "deepseek-v4"] },
  // GLM：5.2 先于 glm-5 前缀（数组序=优先级，降级兜底，见 EXCEPTIONS 上的 04 注）；
  // 4.5~5.1 开关（docs.bigmodel.cn）。
  { class: "glm-hybrid-effort", patterns: ["glm-5.2"] },
  { class: "glm-hybrid-switch", patterns: ["glm-5", "glm-5.1", "glm-4.5", "glm-4.6", "glm-4.7"] },
  // Kimi：k2-thinking/k-thinking 永远 → k2.5/2.6 混合 → k2- 前缀 instruct 永不
  // （顺序不可换：kimi-k2-thinking 也以 kimi-k2- 开头）（platform.kimi.ai）
  { class: "kimi-always", patterns: ["kimi-k2-thinking", "kimi-thinking"] },
  { class: "kimi-hybrid-switch", patterns: ["kimi-k2.5", "kimi-k2.6"] },
  { class: "kimi-instruct-never", patterns: ["kimi-k2-"] },
  // MiniMax m1~m3：永远思考（platform.minimax.io）
  { class: "minimax-always", patterns: ["minimax-m1", "minimax-m2", "minimax-m3"] },
  // 豆包 seed 系：混合开关（volcengine.com）
  { class: "doubao-hybrid-switch", patterns: ["doubao-seed"] },
  // OpenAI gpt-5 血统：effort 档位；5.1/5.2 的 off=none 在例外表（developers.openai.com）
  { class: "openai-reasoning", patterns: ["gpt-5"] },
  // StepFun：3.7 先于 step-3 前缀（platform.stepfun.com）
  { class: "step37-effort", patterns: ["step-3.7"] },
  { class: "step-always", patterns: ["step-3"] },
  // Mimo v2 系：混合开关（aliyun.com）
  { class: "mimo-hybrid-switch", patterns: ["mimo-v2"] }
];

// ===== PROVIDERS：平台规则（键 = core/presets.ts 的 AI preset id）=====
// unknownClass 分工（spec）：词汇平台无关的（Ollama/SiliconFlow/ModelScope/Mimo）
// 给 provider 级默认；按模型定协议的（DeepSeek/Qwen/GLM/Kimi/MiniMax/
// StepFun）不给，未知模型落 unknown 哨兵。override 型：OpenRouter / AMD /
// SenseNova / Opencode Go（严格拒收 thinking 开关、整域只认 effort 词汇的网关，
// 平台语义见 compat-vocab 词表的 overrideEffortVocabulary）。
export const PROVIDERS: Record<string, ProviderRule> = {
  deepseek: {},      // 协议按模型定（api-docs.deepseek.com）
  qwen: {},          // 百炼模型族已覆盖 taxonomy；未列模型白名单制风险高，不发
  zhipu: {},         // docs.bigmodel.cn
  moonshot: {},      // platform.kimi.ai（未知字段容忍度未文档化）
  minimax: {},       // platform.minimax.io
  mimo: { unknownClass: "mimo-hybrid-switch" },
  openrouter: {
    // override 型：reasoning_effort 是官方顶层合法参数（含 none），对任何模型
    // 生效、透传上游解释（openrouter.ai/docs）。reasoning:{exclude} 语义是
    // 「藏思考」不是「关思考」，不用于 off。
    override: {
      thinkingClass: "hybrid",
      levels: {
        off: { fields: { reasoning_effort: "none" } },
        low: { fields: { reasoning_effort: "low" } },
        high: { fields: { reasoning_effort: "high" } }
      }
    }
  },
  stepfun: {}, // step_plan 订阅端点（platform.stepfun.com），模型族已覆盖 taxonomy
  modelscope: { unknownClass: "qwen-hybrid-switch" }, // 托管模型用原生 enable_thinking（modelscope.cn）
  ollama: { unknownClass: "ollama-effort" },
  siliconflow: { unknownClass: "siliconflow-switch" },
  // AMD Radeon Cloud（developer.amd.com.cn，免费模型 API；AI preset 已收录，识别
  // 走 presetId 或 host 索引）：网关对未知字段严格 400——发 thinking 直接报错并
  // 提示改用 reasoning_effort 控制思考（实测 2026-09）→ override 型：整域只认
  // effort 词汇，任何模型（含托管的 qwen/deepseek 血统）不走血统表，避免 taxonomy
  // 命中 deepseek-v4 后发出网关拒收的 thinking 开关。
  amd: {
    override: {
      thinkingClass: "hybrid",
      levels: {
        off: { fields: { reasoning_effort: "none" } },
        low: { fields: { reasoning_effort: "low" } },
        high: { fields: { reasoning_effort: "high" } }
      }
    }
  },
  // SenseNova 商汤 Token Plan（token.sensenova.cn/v1，OpenAI 兼容；免费额度）：
  // 托管的 deepseek-v4-flash 官方文档化 reasoning_effort 词表 none/low/medium/high
  // （openhanako issue #1998/#1682；发 thinking 开关无效）→ override 型同 AMD。
  // 原生 sensenova-6.7-flash-lite 无已文档化的思考控制参数：effort 字段是否被
  // 静默忽略未见 400 报告，随 override 照发（软失败优于硬 400）。
  sensenova: {
    override: {
      thinkingClass: "hybrid",
      levels: {
        off: { fields: { reasoning_effort: "none" } },
        low: { fields: { reasoning_effort: "low" } },
        high: { fields: { reasoning_effort: "high" } }
      }
    }
  },
  // Opencode Go（opencode.ai/zen/go/v1，$10/月订阅网关；官方文档只讲请求头，未
  // 文档化思考控制参数）：网关自己暴露的模型元数据（models.dev 的 opencode-go，
  // opencode 客户端发参依据，2026-09 快照）显示 41 个模型里只有 effort 词表
  // （glm-5.3、deepseek-v4-flash、grok-4.x、qwen3.8-max/flash、muse-spark… 各按
  // 模型给 low…max）、开关（minimax-m3、qwen3.7/3.8 系）与完全没有档位
  // （glm-5.1、kimi-k2.6/k2.5/k2.7-code、mimo-*、minimax-m2.x）三类。据产品裁定
  // 取「整域只认 effort 词表」：off 无关闭声明 → 既有级联落 low（explain/overview
  // 钉的 off 因此真发出最低档，对话 tab 显示「关不掉思考」长版提示），low/high 直传。
  // 不写 off 声明：元数据里只有 gpt-6-luna/hy3 少数模型收 effort none，整域一刀切
  // 发 none 会对其他模型硬 400。走 Messages 协议的模型（minimax-m3、qwen3.7/3.8）
  // 的档位落线见线格式映射表：该网关无档位词汇文档，按产品裁定发 output_config.effort
  // （裸形态，ai/thinking-wire-map.ts 的 MESSAGES_TIER_VOCABULARY）。
  opencodego: {
    override: {
      thinkingClass: "always",
      levels: {
        low: { fields: { reasoning_effort: "low" } },
        high: { fields: { reasoning_effort: "high" } }
      }
    }
  }
};

// ===== 上游桥接：preset → 上游 provider id（04 号票，临时表）=====
// 键 = core/presets.ts 的 AI preset id（= PROVIDERS 的键空间，识别口径同
// resolveThinkingProviderId）；值 = 02 产物的上游 provider id。映射依据见
// spec.md §preset → 上游 provider：11 家按 `api` 字段与 preset baseUrl 逐字相同，
// minimax 是人工裁定（api.minimaxi.com/v1 ↔ minimax-cn 的 api.minimax.cn/anthropic/v1，
// 同一家 coding/anthropic 端点）。无上游 2 家（ollama / custom）与 non-preset 的
// siliconflow 不在表内 → 永远走手写表。
// **临时**：10 号票把它搬进 core/presets.ts 的 preset 数据（本票不动 presets.ts）。
export const UPSTREAM_PROVIDER_BY_PRESET: Readonly<Record<string, string>> = {
  deepseek: "deepseek",
  qwen: "alibaba-cn",
  zhipu: "zhipuai",
  moonshot: "kimi-code-plan-cn",
  minimax: "minimax-cn",
  mimo: "xiaomi",
  opencodego: "opencode-go",
  openrouter: "openrouter",
  stepfun: "stepfun-step-plan",
  modelscope: "modelscope",
  amd: "amd",
  sensenova: "sensenova"
};

// ===== 上游开关形状（平台线格式方言；04 号票）=====
// 值集里有 toggle 时「关/开」在本平台落成什么字段——线格式方言是平台事实
// （spec 决策 4：preset/平台定线格式方言），与手写表同源同出处，只是从 CLASSES 里
// 抽出来给上游投影复用：
// - deepseek：thinking:{type} （api-docs.deepseek.com；同 CLASSES.deepseek-hybrid-effort）
// - qwen 百炼：enable_thinking （alibabacloud.com；同 CLASSES.qwen-hybrid-switch）
// - zhipu：thinking:{type} （docs.bigmodel.cn；同 CLASSES.glm-hybrid-switch）
// - moonshot（Kimi Code）：thinking:{type} （platform.kimi.ai；同 CLASSES.kimi-hybrid-switch）
// - mimo 小米：enable_thinking （aliyun.com；同 CLASSES.mimo-hybrid-switch）
// - modelscope：enable_thinking （modelscope.cn 托管模型用原生开关；
//   PROVIDERS.modelscope.unknownClass = qwen-hybrid-switch）
// 未登记的（stepfun / minimax / ollama / custom …）：**不发明开关形状**——上游值集若
// 只有 toggle，本模块不发参数（关不掉 → 走级联 / fail-closed），宁少发不错发。
// OpenRouter / AMD / SenseNova / Opencode Go 走 override 短路，永远到不了这张表。
export const UPSTREAM_TOGGLE_SHAPES: Readonly<
  Record<string, { off: Record<string, unknown>; on: Record<string, unknown> } | undefined>
> = {
  deepseek: { off: { thinking: { type: "disabled" } }, on: { thinking: { type: "enabled" } } },
  qwen: { off: { enable_thinking: false }, on: { enable_thinking: true } },
  zhipu: { off: { thinking: { type: "disabled" } }, on: { thinking: { type: "enabled" } } },
  moonshot: { off: { thinking: { type: "disabled" } }, on: { thinking: { type: "enabled" } } },
  mimo: { off: { enable_thinking: false }, on: { enable_thinking: true } },
  modelscope: { off: { enable_thinking: false }, on: { enable_thinking: true } }
};

// ===== 行为冻结表（PENDING_DIVERGENCES；04 号票）=====
// 键 = `${上游 provider id}/${调用方传来的模型 id}`，模型 id 小写（查表时折叠大小写，
// 与 02 产物的查表口径一致）——**调用方传什么 id 就查什么键**（不做别名词干归并：
// modelscope 的本仓口径 id 是裸 GLM-4.6，上游 id 是 ZhipuAI/GLM-4.6，两者的手写结论
// 不同源，各自按自己的键守现状）。
//
// 命中 = 该模型**不改走上游指派表**：结论回到 CLASSES[class]；class: null = 手写侧
// 本来也无结论，维持 fail-closed（行为同今日）。
//
// 为什么冻结（用户裁定 2，2026-10-04）：本轮**只翻点名三处**
// （zhipuai/glm-5.2、zhipuai/glm-5.3、kimi-code-plan-cn/k3），其余分歧一律维持手写
// 现状、挂残留清单待逐条裁决。表里每条都写「冻结理由 + 上游证据（值集 / last_updated /
// doc URL）」，供以后有人问「为什么这行没让位」。三类：
//   ① upstream-wins（03 §2 除点名三处）：上游与手写不相容；
//   ② upstream-new（03 §3）：上游有词表、手写侧无结论 → 不采纳（冻结为 unknown）；
//   ③ 03 未列（04 逐格枚举新发现）：字段方言差（托管第三方模型）、streamOnly 产品语义、
//      上游有词表而手写无结论的行——同样按裁定 2 冻结。
// 表不含点名的三处（它们正是本轮要翻的）；静态用例断言这三处不在表里、且表里每条都
// 与手写侧结论一致、02 指派表里「手写侧也有话说且两边不同」的行一条不漏。
export interface PendingDivergence {
  // 冻结到的手写 class（CLASSES 键）；null = 手写侧无结论（fail-closed，不发参）。
  class: string | null;
  reason: string;
  upstream: string;
}

export const PENDING_DIVERGENCES: Readonly<Record<string, PendingDivergence>> = {
  // --- ① upstream-wins（03 报告 §2 除点名的三处）---
  "alibaba-cn/deepseek-v4-flash": {
    class: "deepseek-hybrid-effort",
    reason: "03 §2 根因1（upstream-wins）：上游 toggle+effort[high,max] 无 low 档，手写 low=effort low 不相容；裁定 2 冻结。",
    upstream: "toggle+high-max ｜ last_updated 2026-04-24 ｜ https://www.alibabacloud.com/help/en/model-studio/models"
  },
  "alibaba-cn/deepseek-v4-pro": {
    class: "deepseek-hybrid-effort",
    reason: "03 §2 根因1（upstream-wins）：同根因（上游无 low、手写 low=effort low）；裁定 2 冻结。",
    upstream: "toggle+high-max ｜ last_updated 2026-04-24 ｜ https://www.alibabacloud.com/help/en/model-studio/models"
  },
  "alibaba-cn/glm-5.2": {
    class: "glm-hybrid-effort",
    reason: "03 §2 根因2（upstream-wins）：上游 high-max 无 toggle、无 none（关不掉）而手写声明可关闭 + low 档；裁定 2 冻结（翻的是原生 zhipuai/glm-5.2）。",
    upstream: "high-max ｜ last_updated 2026-06-13 ｜ https://www.alibabacloud.com/help/en/model-studio/models"
  },
  "alibaba-cn/glm-5.3": {
    class: "glm-always",
    reason: "03 §2 根因3（upstream-wins）：上游 effort[low,high,max]，手写未表达档位；裁定 2 冻结（翻的是原生 zhipuai/glm-5.3）。",
    upstream: "low-high-max ｜ last_updated 2026-08-14 ｜ https://www.alibabacloud.com/help/en/model-studio/models"
  },
  "zhipuai/glm-5.3-flash": {
    class: "glm-always",
    reason: "03 §2 根因3（upstream-wins）：同族变体，手写未表达档位；裁定 2 冻结。",
    upstream: "low-high-max ｜ last_updated 2026-08-26 ｜ https://docs.z.ai/guides/overview/pricing"
  },
  "zhipuai/glm-5.3-flashx": {
    class: "glm-always",
    reason: "03 §2 根因3（upstream-wins）：同族变体，手写未表达档位；裁定 2 冻结。",
    upstream: "low-high-max ｜ last_updated 2026-09-18 ｜ https://docs.z.ai/guides/overview/pricing"
  },
  "alibaba-cn/siliconflow/deepseek-v3.2": {
    class: null,
    reason: "03 §2 根因4（upstream-wins）：上游只有 toggle（无 effort）。**实测订正**：03 报告说手写经 TAXONOMY 模式 deepseek-v3.2 命中 deepseek-hybrid-effort，但 resolver 的匹配是前缀 startsWith，org 前缀 id siliconflow/deepseek-v3.2 不命中 → 手写侧实际无结论（今日不发参）；裁定 2 维持现状（冻结为 unknown）。",
    upstream: "toggle ｜ last_updated 2025-12-03 ｜ https://www.alibabacloud.com/help/en/model-studio/models"
  },
  "minimax-cn/minimax-m3": {
    class: "minimax-always",
    reason: "03 §2 根因7（upstream-wins）：上游 toggle（可关），手写声明关不掉；裁定 2 冻结。",
    upstream: "toggle ｜ last_updated 2026-06-25 ｜ https://platform.minimaxi.com/docs/guides/quickstart"
  },
  "stepfun-step-plan/step-3.5-flash": {
    class: "step-always",
    reason: "03 §2 根因6（upstream-wins）：上游 effort[low,high]，手写未表达档位；裁定 2 冻结。",
    upstream: "low-high ｜ last_updated 2026-02-13 ｜ https://platform.stepfun.com/docs/zh/step-plan/integrations/reasoning-api"
  },
  "stepfun-step-plan/step-3.5-flash-2603": {
    class: "step-always",
    reason: "03 §2 根因6（upstream-wins）：同族变体，手写未表达档位；裁定 2 冻结。",
    upstream: "low-high ｜ last_updated 2026-04-02 ｜ https://platform.stepfun.com/docs/zh/step-plan/integrations/reasoning-api"
  },

  // --- ② upstream-new（03 报告 §3：上游有词表、手写表未覆盖）---
  // 用户裁定 2：不采纳 → 冻结为 unknown（fail-closed，请求侧不发参，行为同今日）。
  "deepseek/deepseek-flash": {
    class: null,
    reason: "03 §3（upstream-new）：上游有词表、手写侧 EXCEPTIONS/TAXONOMY/unknownClass 都没命中；裁定 2 不采纳 → 维持不发参。",
    upstream: "toggle+low-high-max ｜ last_updated 2026-09-10 ｜ https://api-docs.deepseek.com/quick_start/pricing"
  },
  "alibaba-cn/qwen3-14b": {
    class: null,
    reason: "03 §3（upstream-new）：上游有词表、手写侧无结论；裁定 2 不采纳 → 维持不发参。",
    upstream: "toggle+b:-38912 ｜ last_updated 2025-04 ｜ https://www.alibabacloud.com/help/en/model-studio/models"
  },
  "alibaba-cn/qwen3-8b": {
    class: null,
    reason: "03 §3（upstream-new）：上游有词表、手写侧无结论；裁定 2 不采纳 → 维持不发参。",
    upstream: "toggle+b:-38912 ｜ last_updated 2025-04 ｜ https://www.alibabacloud.com/help/en/model-studio/models"
  },
  "alibaba-cn/qwen3-omni-flash": {
    class: null,
    reason: "03 §3（upstream-new）：上游有词表、手写侧无结论；裁定 2 不采纳 → 维持不发参。",
    upstream: "toggle ｜ last_updated 2025-09-15 ｜ https://www.alibabacloud.com/help/en/model-studio/models"
  },
  "alibaba-cn/qwen3-vl-plus": {
    class: null,
    reason: "03 §3（upstream-new）：上游有词表、手写侧无结论；裁定 2 不采纳 → 维持不发参。",
    upstream: "toggle+b:-81920 ｜ last_updated 2025-09-23 ｜ https://www.alibabacloud.com/help/en/model-studio/models"
  },
  "alibaba-cn/siliconflow/deepseek-v3.1-terminus": {
    class: null,
    reason: "03 §3（upstream-new）：上游有词表、手写侧无结论；裁定 2 不采纳 → 维持不发参。",
    upstream: "toggle ｜ last_updated 2025-11-25 ｜ https://www.alibabacloud.com/help/en/model-studio/models"
  },
  "kimi-code-plan-cn/k3-256k": {
    class: null,
    reason: "03 §3（upstream-new）：上游有词表、手写侧无结论；裁定 2 不采纳 → 维持不发参。",
    upstream: "low-high-max ｜ last_updated 2026-07-16 ｜ https://www.kimi.com/code/docs/en/kimi-code/models.html"
  },
  "kimi-code-plan-cn/kimi-for-coding": {
    class: null,
    reason: "03 §3（upstream-new）：上游有词表、手写侧无结论；裁定 2 不采纳 → 维持不发参。",
    upstream: "toggle+low-high-max ｜ last_updated 2026-09-11 ｜ https://www.kimi.com/code/docs/en/kimi-code/models.html"
  },
  "stepfun-step-plan/step-5-preview": {
    class: null,
    reason: "03 §3（upstream-new）：上游有词表、手写侧无结论；裁定 2 不采纳 → 维持不发参。",
    upstream: "low-medium-high ｜ last_updated 2026-09-20 ｜ https://platform.stepfun.com/docs/zh/step-plan/integrations/reasoning-api"
  },

  // --- ③ 03 报告未列（04 逐格枚举新发现：同根因族 / 字段方言 / 产品语义）---
  // 这些行 03 的分类器没覆盖（03 只覆盖 404/415 个 reasoning 模型；未分类的 11 个 +
  // 别名/方言差异行都落在这里）。裁定 2 同款处置：冻结维持现状，逐条挂残留清单。
  "alibaba-cn/deepseek-v4.1-flash": {
    class: "deepseek-hybrid-effort",
    reason: "03 未列：上游 toggle+effort[low,high,max]，手写按 deepseek 模型族发 thinking 关思考、指派表按 qwen preset 方言发 enable_thinking（字段方言不同）。裁定 2 冻结。",
    upstream: "toggle+low-high-max ｜ last_updated 2026-09-10 ｜ https://www.alibabacloud.com/help/en/model-studio/models"
  },
  "alibaba-cn/glm-5": {
    class: "glm-hybrid-switch",
    reason: "03 §5 判为「不是分歧」（只比了档位/开关有无），但字段方言不同：手写按 GLM 血统发 thinking:{type}，指派表按 qwen preset 方言发 enable_thinking。裁定 2 冻结。",
    upstream: "toggle+b:-32768 ｜ last_updated 2026-02-11 ｜ https://www.alibabacloud.com/help/en/model-studio/models"
  },
  "alibaba-cn/glm-5.1": {
    class: "glm-hybrid-switch",
    reason: "03 §5 同族行（字段方言差：thinking vs enable_thinking）。裁定 2 冻结。",
    upstream: "toggle+b:-131072 ｜ last_updated 2026-04-14 ｜ https://www.alibabacloud.com/help/en/model-studio/models"
  },
  "alibaba-cn/kimi-k2.5": {
    class: "kimi-hybrid-switch",
    reason: "03 §5 同族行（字段方言差：手写按 Kimi 血统发 thinking:{type}，指派表按 qwen preset 方言发 enable_thinking）。裁定 2 冻结。",
    upstream: "toggle+b:-81920 ｜ last_updated 2026-01-27 ｜ https://www.alibabacloud.com/help/en/model-studio/models"
  },
  "alibaba-cn/kimi-k2.6": {
    class: "kimi-hybrid-switch",
    reason: "03 §5 同族行（字段方言差同 kimi-k2.5）。裁定 2 冻结。",
    upstream: "toggle+b:-81920 ｜ last_updated 2026-04-21 ｜ https://www.alibabacloud.com/help/en/model-studio/models"
  },
  "alibaba-cn/kimi/kimi-k2.5": {
    class: null,
    reason: "03 未列：上游有 toggle，手写侧无结论（org 前缀 id 不匹配模式表、qwen 平台无 unknownClass）；裁定 2 冻结为 unknown（不新增发参）。",
    upstream: "toggle ｜ last_updated 2026-01-27 ｜ https://www.alibabacloud.com/help/en/model-studio/models"
  },
  "alibaba-cn/qwen3-235b-a22b": {
    class: "qwen-hybrid-switch-streamonly",
    reason: "03 §5 判为「不是分歧」（只比档位塌陷），但手写带 streamOnly 产品语义（关思考仅流式），指派表投影没有该语义、非流式会真发关思考参数；streamOnly 属本票不动产品语义。裁定 2 冻结。",
    upstream: "toggle+b:-38912 ｜ last_updated 2025-04 ｜ https://www.alibabacloud.com/help/en/model-studio/models"
  },
  "alibaba-cn/qwen3-32b": {
    class: "qwen-hybrid-switch-streamonly",
    reason: "03 §5 同族行（streamOnly 产品语义同上）。裁定 2 冻结。",
    upstream: "toggle+b:-38912 ｜ last_updated 2025-04 ｜ https://www.alibabacloud.com/help/en/model-studio/models"
  },
  "alibaba-cn/qwen3.8-flash": {
    class: "qwen-hybrid-switch",
    reason: "03 未列：上游 toggle+effort[low,medium,xhigh]，手写当开关型（low/high 同 on 写点塌陷）；裁定 2 冻结。",
    upstream: "toggle+low-medium-xhigh+b:-262144 ｜ last_updated 2026-08-26 ｜ https://www.alibabacloud.com/help/en/model-studio/models"
  },
  "alibaba-cn/qwen3.8-omni-flash": {
    class: "qwen-hybrid-switch",
    reason: "03 未列：上游 effort[none,low,medium,xhigh]（off 走 effort none），手写当开关型；裁定 2 冻结。",
    upstream: "none-low-medium-xhigh ｜ last_updated 2026-09-17 ｜ https://www.alibabacloud.com/help/en/model-studio/models"
  },
  "modelscope/glm-4.5": {
    class: "glm-hybrid-switch",
    reason: "03 未列：本仓口径裸 id GLM-4.5 在手写侧命中 TAXONOMY glm-4.5（摸 thinking:{type}），指派表按 modelscope preset 方言发 enable_thinking（字段方言差）。裁定 2 冻结。",
    upstream: "toggle ｜ last_updated 2025-07-28 ｜ https://modelscope.cn/docs/model-service/API-Inference/intro"
  },
  "modelscope/glm-4.6": {
    class: "glm-hybrid-switch",
    reason: "03 未列：同 GLM-4.5（字段方言差）。裁定 2 冻结。注：上游 id 写法 ZhipuAI/GLM-4.6 不在本表——它手写落在 unknownClass qwen-hybrid-switch（enable_thinking），与指派表投影逐字节相同。",
    upstream: "toggle ｜ last_updated 2025-09-30 ｜ https://modelscope.cn/docs/model-service/API-Inference/intro"
  }
};

const PENDING_DIVERGENCE_INDEX = new Map<string, PendingDivergence>(Object.entries(PENDING_DIVERGENCES));

// 冻结表查表：键 = `${上游 provider}/${模型 id 小写}`（调用方传什么 id 就查什么键）。
function frozenDivergenceFor(upstreamId: string, normalizedModel: string): PendingDivergence | undefined {
  return PENDING_DIVERGENCE_INDEX.get(`${upstreamId}/${normalizedModel}`);
}

// ===== 上游值集 → 三档投影（04 号票）=====
// 输入是 02 产物的查表结果（值集 + 派生 off + deprecated），输出是本模块的 ClassRule。
// 规则见文件头「三档投影」；刻意不做的事：不发 budget_tokens、不给未登记方言的平台发明
// 开关形状、不把 none 当档位、缺档不 clamp（Q12C；clamp 是 05 号票）。
export type UpstreamThinkingFact = Pick<ThinkingModelFact, "valuesetId" | "toggle" | "effort" | "off">;

export function ruleFromUpstreamFact(fact: UpstreamThinkingFact, providerId: string): ClassRule {
  const shape = UPSTREAM_TOGGLE_SHAPES[providerId];
  const tiers = (fact.effort ?? []).filter((tier) => tier !== "none");
  const off: ThinkingPatch | undefined =
    fact.off === "toggle"
      ? shape
        ? { fields: { ...shape.off } }
        : undefined
      : fact.off === "effort-none"
        ? { fields: { reasoning_effort: "none" } }
        : undefined;

  const rule: ClassRule = { thinkingClass: off ? "hybrid" : "always" };
  if (off) {
    rule.off = off;
  }
  if (tiers.length > 0) {
    rule.low = { fields: { reasoning_effort: tiers.includes("low") ? "low" : tiers[0] } };
    rule.high = { fields: { reasoning_effort: tiers.includes("high") ? "high" : tiers[tiers.length - 1] } };
    return rule;
  }
  // 无 effort 词表：toggle 型落平台开关的「开」写点（开关型 low/high 唯一写点）。
  if (fact.toggle && shape) {
    rule.on = { fields: { ...shape.on } };
  }
  return rule;
}

// ===== resolver =====

export type ResolvedThinkingClass = ClassRule["thinkingClass"] | "unknown";

export interface ResolveThinkingInput {
  // preset 识别主路径（provider 记录的 presetId）——02 号票穿线，本票仅参数位生效；
  // 未命中时回落 baseUrl host 推断。
  presetId?: string;
  baseUrl?: string;
  model: string;
  level: string;
  stream: boolean;
}

export interface ThinkingResolution {
  // 要并入请求体的思考字段；空对象 = 不发（软失败优于硬 400）。
  fields: Record<string, unknown>;
  // token 上限参数事实（04 号票消费）；unknown/override 平台不返回。
  tokenParam?: "max_tokens" | "max_completion_tokens";
  // off 不可用标记：级联落了 low 或无 low 可落时为 true（never 静默与
  // unknown 均为 false）——03 号票对话 UI 据此提示。
  offUnavailable: boolean;
  // off 级联去向的显式字段（03 号票对话 UI 区分长/短版文案）："low" = 落了
  // 最低思考档（长版提示）；null = 无 low 可落（短版提示）或 off 正常可用/
  // never 静默/unknown（均无提示）。
  offFallback: "low" | null;
  thinkingClass: ResolvedThinkingClass;
}

// 无事实的解析结果（UNKNOWN 哨兵：三档均不发、offUnavailable=false）。单例复用，
// 调用方按值消费（不持有引用做变更）。
const UNKNOWN_RESOLUTION: ThinkingResolution = { fields: {}, offUnavailable: false, offFallback: null, thinkingClass: "unknown" };

export function resolveThinkingProfile({ presetId, baseUrl, model, level, stream }: ResolveThinkingInput): ThinkingResolution {
  const normalizedLevel = normalizeThinkingLevel(level);
  const normalizedModel = String(model || "").trim().toLowerCase();
  const providerId = resolveThinkingProviderId(presetId, baseUrl);
  const provider = providerId ? PROVIDERS[providerId] : undefined;

  // override 型：对任何模型整体替换 class 规则（识别层直接短路）。
  if (provider?.override) {
    return applyClassRule(
      { thinkingClass: provider.override.thinkingClass, ...provider.override.levels },
      normalizedLevel,
      stream
    );
  }

  // 有上游平台：逐模型事实的主人是 02 指派表（04 号票）。优先级 = 行为冻结表（精确 id）
  // >> 指派表 >> 手写兜底（上游未覆盖：用户自填 id / 上游缺口 / 非 reasoning 模型）。
  const upstreamId = providerId ? UPSTREAM_PROVIDER_BY_PRESET[providerId] : undefined;
  if (upstreamId) {
    const frozen = frozenDivergenceFor(upstreamId, normalizedModel);
    if (frozen) {
      const frozenRule = frozen.class ? CLASSES[frozen.class] : undefined;
      return frozenRule ? applyClassRule(frozenRule, normalizedLevel, stream) : UNKNOWN_RESOLUTION;
    }
    const fact = lookupThinkingFact(upstreamId, model);
    if (fact) {
      return applyClassRule(ruleFromUpstreamFact(fact, providerId!), normalizedLevel, stream);
    }
  }

  // 手写兜底：例外表 >> 模式表 >> provider.unknownClass >> UNKNOWN 哨兵。
  const className = matchRuleClass(EXCEPTIONS, normalizedModel) ?? matchRuleClass(TAXONOMY, normalizedModel) ?? provider?.unknownClass;
  const rule = className ? CLASSES[className] : undefined;
  if (!rule) {
    return UNKNOWN_RESOLUTION;
  }
  return applyClassRule(rule, normalizedLevel, stream);
}

// provider 识别：presetId 优先（02 穿线），host 推断兜底（本票对 custom/直填
// baseUrl 的平台生效）。结果供本模块的档位查表（含上游桥接）消费；
// 「是哪家平台」给怪癖词表的那一口已另立 ai/platform-quirk-id.ts——那边键空间
// 是 PLATFORM_QUIRKS（PROVIDERS ⊋ PLATFORM_QUIRKS，siliconflow 有思考档位但
// 无怪癖声明），且不让词表反向依赖思考表。
export function resolveThinkingProviderId(presetId?: string, baseUrl?: string): string | undefined {
  const byId = String(presetId || "").trim();
  if (byId && PROVIDERS[byId]) {
    return byId;
  }
  return presetIdForHost(hostOf(String(baseUrl || ""))) ?? undefined;
}

function matchRuleClass(entries: readonly TaxonomyEntry[], model: string): string | undefined {
  for (const entry of entries) {
    for (const pattern of entry.patterns) {
      if (modelMatches(pattern, model)) {
        return entry.class;
      }
    }
  }
  return undefined;
}

// 前缀匹配为主（日期快照/变体后缀自然命中，如 gpt-5.1-2025-11-13）；
// 内嵌 * 为通配、两端锚定（如 qwen3-next-*-thinking）。
function modelMatches(pattern: string, model: string): boolean {
  if (!pattern.includes("*")) {
    return model.startsWith(pattern);
  }
  const regex = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
  return regex.test(model);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 单条 class 规则 + 档位 → 解析结果（off 级联 / streamOnly / 缺档 / tokenParam 的唯一施加点）。
// 导出供结构用例复算手写侧结论（04 号票的冻结表完整性：不许有静默的第二事实源）。
export function applyClassRule(rule: ClassRule, level: ThinkingLevel, stream: boolean): ThinkingResolution {
  if (level === "off") {
    const offPatch = streamEnabledPatch(rule.off, stream);
    if (offPatch) {
      return withTokenParam({ fields: { ...(offPatch.fields ?? {}) }, offUnavailable: false, offFallback: null, thinkingClass: rule.thinkingClass }, rule);
    }
    // off 缺失（含 streamOnly 被非流式阻断）→ 级联。
    if (rule.thinkingClass === "never") {
      // 关思考已天然成立：不发、静默（03 号票对 never 不渲染提示）。
      return { fields: {}, offUnavailable: false, offFallback: null, thinkingClass: "never" };
    }
    const lowPatch = streamEnabledPatch(rule.low ?? rule.on, stream);
    if (lowPatch?.fields && Object.keys(lowPatch.fields).length > 0) {
      return withTokenParam({ fields: { ...lowPatch.fields }, offUnavailable: true, offFallback: "low", thinkingClass: rule.thinkingClass }, rule);
    }
    // 无 low 可落（如 minimax/k2.7-code 无档位参数）：不发 + 标记。
    return withTokenParam({ fields: {}, offUnavailable: true, offFallback: null, thinkingClass: rule.thinkingClass }, rule);
  }

  // low/high：开关型落 on 唯一写点；缺档不 clamp、不发（Q12C）。
  const patch = streamEnabledPatch(rule[level] ?? rule.on, stream);
  if (patch?.fields && Object.keys(patch.fields).length > 0) {
    return withTokenParam({ fields: { ...patch.fields }, offUnavailable: false, offFallback: null, thinkingClass: rule.thinkingClass }, rule);
  }
  return withTokenParam({ fields: {}, offUnavailable: false, offFallback: null, thinkingClass: rule.thinkingClass }, rule);
}

// Q14A：streamOnly 规则遇非流式按「无事实」处理（返回 undefined，走级联/缺档）。
function streamEnabledPatch(patch: ThinkingPatch | undefined, stream: boolean): ThinkingPatch | undefined {
  if (!patch || (patch.streamOnly && !stream)) {
    return undefined;
  }
  return patch;
}

function withTokenParam(resolution: ThinkingResolution, rule: ClassRule): ThinkingResolution {
  if (rule.tokenParam) {
    resolution.tokenParam = rule.tokenParam;
  }
  return resolution;
}

// ===== 表校验器（测试期「编译器」，Q2B）=====
// 校验真实表（无参调用）或注入违规后的表副本；返回中文错误列表（空 = 通过）。
// 工单 AC 第 6 条的每条规则在此各有一 checks，正反用例见 thinking-profiles.test.js。

const FIELD_WHITELIST = new Set(["thinking", "enable_thinking", "reasoning_effort"]);
const CLASS_FACTS = new Set(["always", "hybrid", "never"]);
const TOKEN_PARAMS = new Set(["max_tokens", "max_completion_tokens"]);
const LEVEL_KEYS = ["off", "on", "low", "high"] as const;

export interface ThinkingTables {
  classes?: Record<string, ClassRule>;
  taxonomy?: readonly TaxonomyEntry[];
  exceptions?: readonly TaxonomyEntry[];
  providers?: Record<string, ProviderRule>;
  divergences?: Record<string, PendingDivergence>;
}

export function validateThinkingTables(tables: ThinkingTables = {}): string[] {
  const classes = tables.classes ?? CLASSES;
  const taxonomy = tables.taxonomy ?? TAXONOMY;
  const exceptions = tables.exceptions ?? EXCEPTIONS;
  const providers = tables.providers ?? PROVIDERS;
  const divergences = tables.divergences ?? PENDING_DIVERGENCES;
  const errors: string[] = [];

  for (const [name, rule] of Object.entries(classes)) {
    const at = `CLASSES.${name}`;
    if (!CLASS_FACTS.has(rule.thinkingClass)) {
      errors.push(`${at}: thinkingClass 必填，取值 always/hybrid/never`);
    }
    if (rule.thinkingClass === "hybrid" && !rule.off) {
      errors.push(`${at}: hybrid 必有 off 声明`);
    }
    if (rule.thinkingClass !== "hybrid" && rule.off) {
      errors.push(`${at}: ${rule.thinkingClass} 不得有 off`);
    }
    if (rule.thinkingClass === "never" && (rule.on || rule.low || rule.high)) {
      errors.push(`${at}: never 无任何档位`);
    }
    // 同级冲突：on 是开关型 low/high 的唯一写点，与显式 low/high 同存即写点歧义。
    if (rule.on && (rule.low || rule.high)) {
      errors.push(`${at}: on 与 low/high 同级冲突（开关型 low/high 唯一写点是 on）`);
    }
    for (const key of LEVEL_KEYS) {
      checkPatchFields(`${at}.${key}`, rule[key], errors);
    }
    if (rule.tokenParam && !TOKEN_PARAMS.has(rule.tokenParam)) {
      errors.push(`${at}: tokenParam 只允许 max_tokens/max_completion_tokens`);
    }
  }

  const entryTables: [string, readonly TaxonomyEntry[]][] = [
    ["TAXONOMY", taxonomy],
    ["EXCEPTIONS", exceptions]
  ];
  for (const [tableName, entries] of entryTables) {
    entries.forEach((entry, index) => {
      if (!entry.patterns || entry.patterns.length === 0) {
        errors.push(`${tableName}[${index}]: patterns 不能为空`);
      }
      if (!classes[entry.class]) {
        errors.push(`${tableName}[${index}]: 引用的 class "${entry.class}" 不存在`);
      }
    });
  }

  for (const [id, rule] of Object.entries(providers)) {
    const at = `PROVIDERS.${id}`;
    if (rule.unknownClass && !classes[rule.unknownClass]) {
      errors.push(`${at}: unknownClass "${rule.unknownClass}" 不存在`);
    }
    if (rule.override) {
      if (!CLASS_FACTS.has(rule.override.thinkingClass)) {
        errors.push(`${at}: override.thinkingClass 必填，取值 always/hybrid/never`);
      }
      if (rule.override.thinkingClass === "hybrid" && !rule.override.levels.off) {
        errors.push(`${at}: override hybrid 必有 off 档`);
      }
      for (const patch of Object.values(rule.override.levels)) {
        checkPatchFields(`${at}.override`, patch, errors);
      }
    }
  }

  // 行为冻结表（04 号票）：键必须是精确 id（不含通配/正则元字符）、引用的 class 必须存在、
  // 冻结理由与上游证据不得为空——冻结是给人裁决的账，不许静默空转。
  for (const [key, entry] of Object.entries(divergences)) {
    const at = `PENDING_DIVERGENCES.${key}`;
    if (key.includes("*") || !key.includes("/")) {
      errors.push(`${at}: 键必须是精确的 \`上游 provider/模型 id\`（不得有通配符）`);
    }
    if (entry.class !== null && !classes[entry.class]) {
      errors.push(`${at}: 冻结的 class "${entry.class}" 不存在（null 表示手写侧也无结论）`);
    }
    if (!entry.reason.trim()) {
      errors.push(`${at}: 冻结理由不能为空`);
    }
    if (!entry.upstream.trim()) {
      errors.push(`${at}: 上游证据不能为空`);
    }
  }

  return errors;
}

function checkPatchFields(at: string, patch: ThinkingPatch | undefined, errors: string[]): void {
  for (const field of Object.keys(patch?.fields ?? {})) {
    if (!FIELD_WHITELIST.has(field)) {
      errors.push(`${at}: 字段 "${field}" 不在白名单（thinking/enable_thinking/reasoning_effort）`);
    }
  }
}
