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
// **残留清单裁决（决策 #8 后续，2026-10-04 用户裁定）**：04 号票按当时的「其余行为冻结」
// 裁定，把 31 行分歧冻结进 PENDING_DIVERGENCES 待逐条裁决；用户复审残留清单后裁定
// 「冻结的都按上游，复审以后发现以前的确实都是错的」——冻结机制连同 31 行一并删除
// （12 号票），逐行「旧手写结论 → 上游结论」对照见
// .scratch/tickets/upstream-model-facts/artifacts/12-adjudication-log.md。
// 点名翻转的三处（zhipuai/glm-5.2、zhipuai/glm-5.3、kimi-code-plan-cn/k3）与手写专条
// （TAXONOMY `glm-5.2`、EXCEPTIONS `glm-5.3` / `kimi-k3`）的关系不变：专条**留在原处**，
// 只兜「指派表不认识的 id」（用户自填 / 上游新变体，如 glm-5.3-air）——那些 id 无界，
// 真删会让它们的请求体跟着变，是尚未裁决的开放问题（12 号票非目标）。
//
// 本模块输出的 fields 是**协议无关的中转词汇**（OpenAI 词汇），不回答「这套词汇在
// 某协议请求体里长什么样」：那是线格式映射表（ai/thinking-wire-map.ts）的职责，
// adapter 不再各自 if 着改写。
//
// 事实的唯一主人：
// - 上游逐模型词表 / 指派 / 别名 → 02 产物（构建期生成，勿手改；漂移对账见
//   `pnpm catalog:check`）；
// - 平台 preset 列表 / baseUrl / preset → 上游 provider 的映射 → core/presets.ts
//   （host 索引收口在 core/preset-host-index.ts，不复制 baseUrl；**10 号票起
//   preset → 上游 provider 的唯一来源是 PRESETS[].catalogProvider**，本文件的
//   UPSTREAM_PROVIDER_BY_PRESET 由它派生，见下）；
// - 无上游平台的模型血统（永远/混合/永不思考）与模型名模式 → 本文件的
//   TAXONOMY / EXCEPTIONS（每格注释里简写出处域名）；它们同时是「有上游平台但指派表
//   未覆盖该 id」的兜底（见上「残留清单裁决」）。
// 设计机制（三层声明表 + 稀疏档位 + 测试期校验器）参考 hana-model-catalog
// （github.com/liliMozi/hana-model-catalog；无 LICENSE，仅参考未复制数据）。
//
// 解析语义（04 号票起）：
//   provider = PROVIDERS[presetId] ?? HOST索引[baseUrl host] ?? 无
//   ① provider override 型（OpenRouter / AMD / SenseNova / Opencode Go）：
//      levels[level] 对任何模型整体替换 class 规则（识别层短路）——平台级产品裁定，
//      不逐格比上游（03 报告 §6）。
//   ② 有上游平台（UPSTREAM_PROVIDER_BY_PRESET 命中）：
//      查 02 指派表 → ruleFromUpstreamFact（值集 → 档位投影）；
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
//
// chip 集合（06 号票）：面板上的档位 chip 不再固定三档，而是**渲染
// resolveThinkingAdjustment().availableLevels**（= availableLevelsOf(rule) = A'，与请求
// 落线同一次解析、同一张规则）：只显示存在的档位、不置灰，被 clamp 掉的偏好由对话 UI 的
// 说明文本呈现（2026-10-04 用户裁定：「只显示实际存在的档位」；全局偏好不迁移，逐模型
// clamp 向下取，实发档 = 有效档）。`source` 字段（upstream / override / handwritten /
// unknown）是把同一次解析按来源分层，供 06 号票的三层来源清单（artifacts/06-chip-source.tsv）
// 与 UI 用例对账——它不是 chip 的第二套推导。

import { PRESETS } from "../core/presets.js";
import { hostOf, presetIdForHost } from "../core/preset-host-index.js";
import { lookupThinkingFact, type ThinkingModelFact } from "./catalog/models-dev-thinking.generated.js";

// ===== 档位词表 =====
// 档位取值域（UI 按钮与全局档位键的唯一来源）自 05 号票起是**上游词表的 7 档投影**：
// 词表实体下沉到零 import 的叶 ai/thinking-levels.ts（SW 静态图两侧的消费者同源：
// 请求路径的本模块与设置归一化的 core/validators.ts），本模块整体再导出，保持
// 「档位词汇的 import 面 = thinking-profiles」不变。
export {
  AI_THINKING_LEVELS,
  isThinkingLevel,
  normalizeThinkingLevel,
  type ThinkingLevel
} from "./thinking-levels.js";
import {
  AI_THINKING_LEVELS,
  isThinkingLevel,
  normalizeThinkingLevel,
  type ThinkingLevel
} from "./thinking-levels.js";

// 非 off 档（按档位序），可用集推导与 clamp 共用。
const NON_OFF_LEVELS: readonly ThinkingLevel[] = AI_THINKING_LEVELS.filter((level) => level !== "off");

// ===== schema =====
// 单档字段补丁。fields 键白名单：thinking / enable_thinking / reasoning_effort
// （校验器强制）。温度类字段明令禁止——Kimi 等平台思考模式温度/top_p 固定且
// 官方明确不要显式传，本扩展从不发 temperature 是安全属性。
// 这三套字段词汇是**中转词汇**：语义见 compat-vocab 词表的 thinkingFormat，
// 「本协议线上怎么落」见线格式映射表（thinking-wire-map）；「哪档发哪套词汇」的
// 逐模型事实第一主人是构建期编译产物（ai/catalog/models-dev-thinking.generated.ts），
// 本文件解析它并补产品语义与兜底，三层分工不重叠。
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
// 开关型平台用 on 作为任何非 off 档的唯一写点（GLM/Kimi/Mimo/SiliconFlow 等——
// 档位只表达「开」，无力度差异）；effort 型平台逐档给显式写点（05 号票起 7 档：
// minimal/low/medium/high/xhigh/max 各一格，**有哪个写点 = 该档可用**——clamp 的
// 可用集 A 就由这些写点派生，见 availableLevelsOf）。
export interface ClassRule {
  thinkingClass: "always" | "hybrid" | "never";
  off?: ThinkingPatch;
  on?: ThinkingPatch;
  minimal?: ThinkingPatch;
  low?: ThinkingPatch;
  medium?: ThinkingPatch;
  high?: ThinkingPatch;
  xhigh?: ThinkingPatch;
  max?: ThinkingPatch;
  // token 上限参数的随表事实（openai-reasoning 系须 max_completion_tokens）；
  // 缺省 = max_tokens。参数名差异的平台语义见 compat-vocab 词表的 maxTokensField
  // （本表只给逐模型事实，词表给"这条怪癖是什么"）；该事实落到某协议线上叫什么名字，
  // 由线格式映射表的出参决定（本表不决定协议写法）。
  //
  // **登记（2026-10-05 用户裁定，上游模型事实 effort 登记项 ② 收口）：本字段是手写表
  // 独有的写点，上游产物（ai/catalog/models-dev-thinking.generated.ts）与
  // PROVIDERS[].override 刻意都不产它——不是覆盖漏洞，改了反而是用户可见的行为变更：**
  //   - 唯一真正的消费者是「custom preset + 用户自填 api.openai.com / azure 端点」：
  //     本仓无 openai preset、api.openai.com 也不在 core/preset-host-index 的索引里，
  //     那条路径永远走手写兜底，命中下面两个 openai-reasoning 类；
  //   - 上游无此事实可借：models.dev 只登记 reasoning_options，limit.output 是数字不是
  //     参数名（scripts/sync-models-dev-thinking.mjs 的取材口径）；
  //   - 上游命中的 OpenAI 血统模型恰好全住在 override 平台上（上游 12 家里没有 openai
  //     provider：openrouter/openai/* 与 opencode-go/gpt-5.6-luna、gpt-6-luna），它们收
  //     max_tokens；改发 max_completion_tokens 会把 reasoning token 计入预算 → 同数值下
  //     正文可见长度变短，用户 2026-10-05 明确拒绝该变更。
  // 现状由 tests/ai/thinking-profiles.test.ts「override + 上游命中的 OpenAI 血统模型恒
  // max_tokens」钉桩，改本字段前先看那条用例。
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
  // 04 号票起只服务指派表不认识的 glm-5.2* id（用户自填 / 上游新变体）兜底；命中指派表的
  // 模型（原生 zhipuai/glm-5.2、托管 alibaba-cn/glm-5.2）一律按上游投影
  // （值集 high-max：关不掉 + effort 档，见文件头）。
  "glm-hybrid-effort": {
    thinkingClass: "hybrid",
    off: { fields: { thinking: { type: "disabled" } } },
    low: { fields: { reasoning_effort: "low" } },
    high: { fields: { reasoning_effort: "high" } }
  },
  // 永远思考：04 号票起只服务指派表不认识的 glm-5.3* id 兜底（原「例外表成员 glm-5.3*」）；
  // 命中指派表的 glm-5.3 族（含 zhipuai/glm-5.3-flash|-flashx、alibaba-cn/glm-5.3、原生
  // zhipuai/glm-5.3）一律按上游投影 effort low-high-max。
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
  // 已让位给 02 指派表（解析顺序：override 短路 → 指派表 → 手写兜底 → unknownClass → fail-closed）。
  // 它们现在只服务「指派表不认识的 id」：用户自填 / 上游新变体（如 glm-5.3-air、kimi-k3-air）。
  // 真删会让这些无界 id 的请求体跟着变，是尚未裁决的开放问题（12 号票非目标）。
  // glm-5.3*：disabled 直接报错 → 永远思考（docs.bigmodel.cn）
  { class: "glm-always", patterns: ["glm-5.3"] },
  // kimi-k2.7*：强制 keep:all → 永远思考（platform.kimi.ai）
  { class: "kimi-always", patterns: ["kimi-k2.7"] },
  // kimi-k3*：effort 三档 → 永远思考（platform.kimi.ai）
  { class: "kimi-k3-effort", patterns: ["kimi-k3"] },
  // gpt-5.1/5.2：off → reasoning_effort:"none"（developers.openai.com）
  { class: "openai-reasoning-none", patterns: ["gpt-5.1", "gpt-5.2"] },
  // gpt-6*/o3/o4*：无 none（传了 400）→ 永远思考（developers.openai.com）
  // 注（2026-10-05 用户裁定）：o 系早期型号（o1 / o1-mini / o1-pro 等）已废弃，**刻意不补
  // 覆盖**——它们不在本表命中即走 UNKNOWN、不发思考字段、token 上限回落 max_tokens。
  // 这是登记过的取舍，不要当成缺口捡回来补。
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
// 06 号票（2026-10-04 用户裁定）：override 的 levels 是**平台可表达集**，有上游词表的
// 模型还要与上游词表相交出 A'（ruleFor 里按模型收窄）；本表只声明平台口径，不逐模型写。 
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
  // effort 词汇，任何模型（含托管的 qwen/deepseek 血统）在写点形状上不走血统表，避免 taxonomy
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

// ===== 上游桥接：preset → 上游 provider id（10 号票起由 PRESETS 派生）=====
// **单源**：preset → 上游 provider 的唯一映射是 core/presets.ts 的
// PRESETS[].catalogProvider（映射依据见 spec.md §preset → 上游 provider：11 家按
// `api` 字段与 preset baseUrl 逐字相同，minimax 是人工裁定——本仓
// api.minimaxi.com/v1 与上游 minimax-cn 的 api.minimax.cn/anthropic/v1 判为同一家）。
// 本常量只是同一份事实的查表形状（键 = presetId，值 = 02 产物的上游 provider id），
// 不再复制第二份表；键顺序 = PRESETS 顺序（= 工件与用例的枚举顺序）。
// 无 catalogProvider 的 2 家（ollama / custom，同 NO_CATALOG_PRESETS）与 non-preset
// 的 siliconflow 不在表内 → 永远走手写表。
export const UPSTREAM_PROVIDER_BY_PRESET: Readonly<Record<string, string>> = Object.fromEntries(
  PRESETS.flatMap((preset) =>
    preset.catalogProvider ? [[preset.id, preset.catalogProvider] as const] : []
  )
);

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

// ===== 上游值集 → class 规则（04 号票建，05 号票扩到 7 档）=====
// 输入是 02 产物的查表结果（值集 + 派生 off + deprecated），输出是本模块的 ClassRule。
// 规则：值集里**每一个** effort 档位物化成一个写点（05 号票：7 档词表暴露上游真实档位，
// 「有写点 = 该档可用」= clamp 的可用集 A）；无 effort 词表时 toggle 型落平台开关的
// 「开」写点。刻意不做的事：不发 budget_tokens、不给未登记方言的平台发明开关形状、
// 不把 none 当档位（它只是 off 的线值实现，决策 #7）。
export type UpstreamThinkingFact = Pick<ThinkingModelFact, "valuesetId" | "toggle" | "effort" | "off">;

// 上游逐模型词表的 7 档投影（06 号票裁定的模型侧集合 U，2026-10-04 用户裁定）：
//   off    = 值集有 toggle 或 effort 含 none（关得掉）；
//   档位   = effort 词表里的 7 档（none 不是档位）；
//   开关型（有 toggle 无 effort）：非 off 域整体可表达——「开」是唯一写点，任何非 off
//          档都落它（05 语义），故 U 的非 off 部分是全部非 off 档。
// 与 ruleFromUpstreamFact 的写点推导同源，但用途不同：这是 A' 的**模型侧**（哪些档位
// 该模型真的有），平台侧可表达集由规则写点/override 声明给出，两者相交即 A'。
export function upstreamVocabularyOf(fact: UpstreamThinkingFact): readonly ThinkingLevel[] {
  const tiers = (fact.effort ?? []).filter((tier): tier is ThinkingLevel => isThinkingLevel(tier));
  const levels: ThinkingLevel[] = [];
  if (fact.off) {
    levels.push("off");
  }
  levels.push(...(tiers.length > 0 ? tiers : fact.toggle ? NON_OFF_LEVELS : []));
  return AI_THINKING_LEVELS.filter((level) => levels.includes(level));
}

export function ruleFromUpstreamFact(fact: UpstreamThinkingFact, providerId: string): ClassRule {
  const shape = UPSTREAM_TOGGLE_SHAPES[providerId];
  // none 不是档位；阶梯外的值（上游新增词汇）不物化——test 断言 VALUESETS 里不存在
  // 这种值，故过滤不丢档（tests/ai/thinking-levels.test.ts）。
  const tiers = (fact.effort ?? []).filter((tier): tier is ThinkingLevel => isThinkingLevel(tier));
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
    for (const tier of tiers) {
      rule[tier] = { fields: { reasoning_effort: tier } };
    }
    return rule;
  }
  // 无 effort 词表：toggle 型落平台开关的「开」写点（开关型的唯一写点）。
  if (fact.toggle && shape) {
    rule.on = { fields: { ...shape.on } };
  }
  return rule;
}

// ===== clamp（05 号票，决策 #8；06 号票改 A'）=====
// 可用集 A'（2026-10-04 用户裁定：「希望只显示实际存在的档位」）=
// **上游逐模型词表 ∩ 平台线格式可表达集**，且由**一次解析**的同一张规则承载：
//   - 非 override 平台：规则本身就是「值集 ∩ 平台已登记方言」的产物（ruleFromUpstreamFact
//     只物化平台表达得了的写点；未登记开关形状的平台连 off 都不发明）→ 写点集 == A'；
//   - override 平台：平台级裁定声明的档位键是平台侧，再与上游词表 U 相交（ruleFor）；
//   - 无上游词表的模型（上游缺口 56 / 用户自填 id / ollama / custom）：维持今日手写口径。
// 「可用集即写点集合」不变：提示面（resolveThinkingAdjustment）与落线（applyClassRule）
// 读同一张规则，两处不可能漂移。
export function availableLevelsOf(rule: ClassRule): readonly ThinkingLevel[] {
  if (rule.on) {
    return rule.off ? [...AI_THINKING_LEVELS] : [...NON_OFF_LEVELS];
  }
  const available: ThinkingLevel[] = [];
  if (rule.off) {
    available.push("off");
  }
  for (const level of NON_OFF_LEVELS) {
    if (rule[level]) {
      available.push(level);
    }
  }
  return available;
}

// 用户偏好 L + 可用集 A → 有效档位（票面写死）：L ∈ A → L；否则 A 中 ≤ L 的最大档
// （向下取）；A 中没有 ≤ L 的档 → A 的最小档；A 为空 → null（无档可落，维持不发参）。
// 档位序 = AI_THINKING_LEVELS（off 在其中：偏好 low 而模型只有 {off,high} 时落 off）。
export function clampThinkingLevel(preference: ThinkingLevel, available: readonly ThinkingLevel[]): ThinkingLevel | null {
  if (available.length === 0) {
    return null;
  }
  if (available.includes(preference)) {
    return preference;
  }
  const rank = (level: ThinkingLevel): number => AI_THINKING_LEVELS.indexOf(level);
  const below = available.filter((level) => rank(level) <= rank(preference));
  if (below.length > 0) {
    return below.reduce((best, level) => (rank(level) > rank(best) ? level : best), below[0]);
  }
  return available.reduce((best, level) => (rank(level) < rank(best) ? level : best), available[0]);
}

// 被调整的原因（提示面文案分层）：
//   model-vocabulary    = 该模型的档位词表（02 值集）里没有这个档位；
//   upstream-unlisted   = 上游未登记该模型，档位来自本仓手写表；
//   platform-vocabulary = 平台级裁定（override 平台整域只认自己的档位词表）。
export type ThinkingClampReason = "model-vocabulary" | "upstream-unlisted" | "platform-vocabulary";

// 规则来源层（06 号票三层来源清单的审计列）：与 ruleFor 的解析分支一一对应，由
// **同一次解析**给出，不是第二套推导——chip 集合本身仍只由 availableLevelsOf 派生
// （06 号票：清单是「哪一层的规则服务了该模型」的视图，不是 chip 的第二来源）。
//   upstream    = 02 指派表命中（上游逐模型词表；构建期按 canonical_model_id / 别名
//                 借到词表的行也走这一支——产物里 7 条借词已折叠进指派表，
//                 运行期看不出「直接 / 借词」，逐条借词来源在 06 工件里用 02 矩阵对账）；
//   override    = 平台级裁定短路（openrouter / amd / sensenova / opencodego，03 报告 §6）；
//   adjudicated = 用户点名的单点裁决行（ADJUDICATED_MODEL_RULES，见下）；
//   handwritten = 手写兜底（EXCEPTIONS >> TAXONOMY >> unknownClass）；
//   unknown     = 无结论（fail-closed，三档不发）。
export type ThinkingRuleSource = "upstream" | "override" | "adjudicated" | "handwritten" | "unknown";

// ===== 单点裁决条目（06 号票，2026-10-04 用户裁定）=====
// 场景：A' = 上游词表 ∩ 平台可表达集 = ∅（上游唯一登记的词平台表达不了），但**用户点名**
// 要按该模型的原生厂商方言发参的单点例外——不适用「向下兼容」（没有可落的档），也不再
// fail-closed。与 CLASSES / EXCEPTIONS / TAXONOMY 的分工：那些是「上游没有事实时」的手写
// 兜底；这里是「上游有事实、却被平台词表挡住」的逐条裁决，所以写成带理由的显式表、范围
// 最小：只对 presetId + model 精确命中生效（用户裁定原文：不许扩到 opencodego 的其它模型，
// 也不许扩到其它平台托管的同名模型）。
// 条目只登记「按谁家的方言」：规则 = 镜像行按上游值集投影出的写点（ruleFromUpstreamFact），
// 线格式出口沿用镜像行的平台（已登记的厂商方言）。镜像事实缺失时退回 A' 收窄（fail-closed），
// 绝不发明写点。
export interface AdjudicatedModelRule {
  presetId: string;
  model: string;
  /** 方言来源行：规则按这一行的上游事实投影（写点形状与档位词表都随之）。 */
  mirrorOf: { presetId: string; model: string };
  /** 裁决理由（报告 / 06 工件的审计列，逐条引用用户原话与出处）。 */
  reason: string;
}

export const ADJUDICATED_MODEL_RULES: readonly AdjudicatedModelRule[] = [
  {
    presetId: "opencodego",
    model: "kimi-k3",
    mirrorOf: { presetId: "moonshot", model: "kimi-k3" },
    reason:
      "2026-10-04 用户裁定：openCodeGo 的 kimi-k3 按 kimi 官方 k3 方言发参（上游值集只有 max、与平台词 low/high 无交集，不 fail-closed）"
  }
];

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
  // token 上限参数事实（04 号票消费）；unknown、override 平台与**上游命中平台**都不返回
  // （后者两层刻意不产该字段，理由见 ClassRule.tokenParam 上的 2026-10-05 登记）。
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

// 一次解析的中间结论：本模型该用哪张 class 规则，以及这张规则来自哪一层
// （层决定 clamp 被调整时对用户说的原因，06 号票起同时是 chip 来源清单的审计列）。
interface ResolvedRule {
  rule: ClassRule | undefined;
  reason: ThinkingClampReason | null;
  source: ThinkingRuleSource;
}

// 单点裁决命中 → 直接用镜像行的规则（不经 A' 收窄）；未命中 / 镜像事实缺失返回 null
// （后者退回 A' 收窄，fail-closed）。
function adjudicatedRuleFor(providerId: string, model: string): ResolvedRule | null {
  const normalizedModel = String(model || "").trim().toLowerCase();
  const entry = ADJUDICATED_MODEL_RULES.find(
    (rule) => rule.presetId === providerId && rule.model.toLowerCase() === normalizedModel
  );
  if (!entry) {
    return null;
  }
  const mirrorUpstreamId = UPSTREAM_PROVIDER_BY_PRESET[entry.mirrorOf.presetId];
  const mirrorFact = mirrorUpstreamId ? lookupThinkingFact(mirrorUpstreamId, entry.mirrorOf.model) : null;
  if (!mirrorFact) {
    return null;
  }
  return {
    rule: ruleFromUpstreamFact(mirrorFact, entry.mirrorOf.presetId),
    reason: "model-vocabulary",
    source: "adjudicated"
  };
}

// 规则解析的唯一施加点（resolveThinkingProfile 与 resolveThinkingAdjustment 共用）：
//   provider override（平台级裁定，识别层短路；06 号票起再与上游词表相交出 A'，其中用户
//                       点名的单点裁决行先短路，见 ADJUDICATED_MODEL_RULES）
//   >> 上游平台：02 指派表
//   >> 手写兜底（EXCEPTIONS >> TAXONOMY >> unknownClass）
//   >> 无结论（UNKNOWN 哨兵）。
function ruleFor({ presetId, baseUrl, model, level }: ResolveThinkingInput): ResolvedRule {
  const normalizedModel = String(model || "").trim().toLowerCase();
  const providerId = resolveThinkingProviderId(presetId, baseUrl);
  const provider = providerId ? PROVIDERS[providerId] : undefined;
  const upstreamId = providerId ? UPSTREAM_PROVIDER_BY_PRESET[providerId] : undefined;

  // override 型：对任何模型整体替换 class 规则（识别层直接短路——上游与手写血统都
  // 不参与**写点形状**）。06 号票（2026-10-04 用户裁定）：该模型有上游词表时，
  // A' = 上游逐模型词表 ∩ 平台可表达档（平台侧 = override 声明的档位键），把 A' 之外的
  // 档位写点从规则里去掉——「只显示实际存在的档位」+「不发平台表达不了的词」。
  // 没有上游词表的模型（用户自填 id / 上游缺口）维持平台声明口径（今日三档）。
  if (provider?.override) {
    // 用户点名的单点裁决行先于收窄（该行按原生厂商方言发参，不受平台声明限制）。
    const adjudicated = providerId ? adjudicatedRuleFor(providerId, model) : null;
    if (adjudicated) {
      return adjudicated;
    }
    const overrideLevels = provider.override.levels;
    const fact = upstreamId ? lookupThinkingFact(upstreamId, model) : null;
    if (!fact) {
      return {
        rule: { thinkingClass: provider.override.thinkingClass, ...overrideLevels },
        reason: "platform-vocabulary",
        source: "override"
      };
    }
    const upstreamLevels = new Set<ThinkingLevel>(upstreamVocabularyOf(fact));
    const levels: Partial<Record<ThinkingLevel, ThinkingPatch>> = {};
    for (const tier of AI_THINKING_LEVELS) {
      const patch = overrideLevels[tier];
      if (patch && upstreamLevels.has(tier)) {
        levels[tier] = patch;
      }
    }
    const requested = normalizeThinkingLevel(level);
    return {
      rule: { thinkingClass: provider.override.thinkingClass, ...levels },
      // 偏好档被哪一侧排除：平台声明里有、上游词表没有 → 模型词表；否则平台词表。
      reason: overrideLevels[requested] && !upstreamLevels.has(requested) ? "model-vocabulary" : "platform-vocabulary",
      source: "override"
    };
  }

  // 有上游平台：逐模型事实的主人是 02 指派表（04 号票）——12 号票删掉冻结表后，
  // 残留清单裁决过的行也一律按上游投影。指派表未命中 → 手写兜底
  // （上游未覆盖：用户自填 id / 上游缺口 / 非 reasoning 模型）。
  if (upstreamId) {
    const fact = lookupThinkingFact(upstreamId, model);
    if (fact) {
      return { rule: ruleFromUpstreamFact(fact, providerId!), reason: "model-vocabulary", source: "upstream" };
    }
  }

  // 手写兜底：例外表 >> 模式表 >> provider.unknownClass >> UNKNOWN 哨兵。
  const className = matchRuleClass(EXCEPTIONS, normalizedModel) ?? matchRuleClass(TAXONOMY, normalizedModel) ?? provider?.unknownClass;
  return {
    rule: className ? CLASSES[className] : undefined,
    reason: className ? "upstream-unlisted" : null,
    source: className ? "handwritten" : "unknown"
  };
}

export function resolveThinkingProfile(input: ResolveThinkingInput): ThinkingResolution {
  const rule = ruleFor(input).rule;
  return rule ? applyClassRule(rule, normalizeThinkingLevel(input.level), input.stream) : UNKNOWN_RESOLUTION;
}

// 提示面入口（05 号票）：一次给出「偏好档位 → 实发档位 + 原因」，供对话 UI 渲染
// 「档位已按模型能力调整：high → medium」。请求字段与这里的 effectiveLevel 同源
// （同一张规则 + 同一个 clampThinkingLevel），不会出现「提示说 medium、请求发 xhigh」。
export interface ThinkingLevelAdjustment {
  // 与请求侧同一个解析结果（UI 的 offUnavailable / offFallback 判定读它）。
  resolution: ThinkingResolution;
  requestedLevel: ThinkingLevel;
  // 模型可用集（档位序）；空 = 该模型无任何档位可落（不发思考参数）。
  // **06 号票起这就是面板 chip 集合的唯一来源**（UI 只渲染这个集合里的档位，不置灰、
  // 不显示请求不发的选择）：与落线同一次解析、同一张规则，两处不可能漂移。
  availableLevels: readonly ThinkingLevel[];
  // 实发档位；null = 无档可落。
  effectiveLevel: ThinkingLevel | null;
  // 被调整的原因；null = 未调整（L ∈ A）或无可落档位（不报「已调整」）。
  reason: ThinkingClampReason | null;
  // 这张规则来自哪一层（06 号票：三层来源清单的审计列，与 availableLevels 同源）。
  source: ThinkingRuleSource;
}

export function resolveThinkingAdjustment(input: ResolveThinkingInput): ThinkingLevelAdjustment {
  const { rule, reason, source } = ruleFor(input);
  const requestedLevel = normalizeThinkingLevel(input.level);
  const resolution = rule ? applyClassRule(rule, requestedLevel, input.stream) : UNKNOWN_RESOLUTION;
  const availableLevels = rule ? availableLevelsOf(rule) : [];
  const effectiveLevel = rule ? clampThinkingLevel(requestedLevel, availableLevels) : null;
  return {
    resolution,
    requestedLevel,
    availableLevels,
    effectiveLevel,
    // 「被调整」= 落了别的档位；无档可落（effectiveLevel null）不是调整，不报文案。
    reason: rule && effectiveLevel !== null && effectiveLevel !== requestedLevel ? reason : null,
    source
  };
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

// 单条 class 规则 + 档位 → 解析结果（clamp 落线 / off 级联 / streamOnly / 缺档 /
// tokenParam 的唯一施加点）。导出供结构用例复算手写侧结论（04 号票：对指派表未覆盖的
// id，runtime 结论必须等于手写表结论）。
//
// 05 号票（决策 #8）：档位先过 clamp——用户偏好遇到模型不支持的档位时**向下取**
// 最近可用档（A' 由 availableLevelsOf 从写点派生：06 号票起 = 上游词表 ∩ 平台可表达）；
// 落线取值一律走 clamp 后的档位，所以「提示里说发哪档」与「请求里发哪档」是同一个值。
// off 的既有判定（offUnavailable / offFallback 级联）不变，只是级联目标 = A' 的最小
// 非 off 档（none/high 类模型偏好 low → 落 off，线上发 effort none）。
export function applyClassRule(rule: ClassRule, level: ThinkingLevel, stream: boolean): ThinkingResolution {
  const available = availableLevelsOf(rule);
  const effective = clampThinkingLevel(level, available);

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
    // 级联目标 = 可用集里最小的非 off 档（关不掉的模型给最低思考档；开关型即 on 写点）。
    const fallbackLevel = available.find((candidate) => candidate !== "off");
    const lowPatch = streamEnabledPatch(fallbackLevel ? patchForLevel(rule, fallbackLevel) : undefined, stream);
    if (lowPatch?.fields && Object.keys(lowPatch.fields).length > 0) {
      return withTokenParam({ fields: { ...lowPatch.fields }, offUnavailable: true, offFallback: "low", thinkingClass: rule.thinkingClass }, rule);
    }
    // 无档位可落（如 minimax/k2.7-code 无档位参数）：不发 + 标记。
    return withTokenParam({ fields: {}, offUnavailable: true, offFallback: null, thinkingClass: rule.thinkingClass }, rule);
  }

  // 非 off 档：落 clamp 后的档位写点（开关型的档位写点仍是 on）。
  const patch = streamEnabledPatch(patchForLevel(rule, effective), stream);
  if (patch?.fields && Object.keys(patch.fields).length > 0) {
    return withTokenParam({ fields: { ...patch.fields }, offUnavailable: false, offFallback: null, thinkingClass: rule.thinkingClass }, rule);
  }
  return withTokenParam({ fields: {}, offUnavailable: false, offFallback: null, thinkingClass: rule.thinkingClass }, rule);
}

// 档位 → 该档的写点：effort 型查本档的显式写点，开关型（有 on）任何非 off 档都落 on；
// off 落 off 写点。null（无档可落）→ undefined。
function patchForLevel(rule: ClassRule, level: ThinkingLevel | null): ThinkingPatch | undefined {
  if (level === null) {
    return undefined;
  }
  if (level === "off") {
    return rule.off;
  }
  return rule[level] ?? rule.on;
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
const LEVEL_KEYS = ["off", "on", ...NON_OFF_LEVELS] as const;

export interface ThinkingTables {
  classes?: Record<string, ClassRule>;
  taxonomy?: readonly TaxonomyEntry[];
  exceptions?: readonly TaxonomyEntry[];
  providers?: Record<string, ProviderRule>;
}

export function validateThinkingTables(tables: ThinkingTables = {}): string[] {
  const classes = tables.classes ?? CLASSES;
  const taxonomy = tables.taxonomy ?? TAXONOMY;
  const exceptions = tables.exceptions ?? EXCEPTIONS;
  const providers = tables.providers ?? PROVIDERS;
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
    if (rule.thinkingClass === "never" && (rule.on || NON_OFF_LEVELS.some((tier) => rule[tier]))) {
      errors.push(`${at}: never 无任何档位`);
    }
    // 同级冲突：on 是开关型（无力度差异）的唯一写点，与显式档位写点同存即写点歧义。
    const explicitTiers = NON_OFF_LEVELS.filter((tier) => rule[tier]);
    if (rule.on && explicitTiers.length > 0) {
      errors.push(`${at}: on 与显式档位（${explicitTiers.join("/")}）同级冲突（开关型的唯一写点是 on）`);
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

  // 行为冻结表（04 号票）随残留清单裁决（2026-10-04 用户裁定：31 行全部按上游）删除，
  // 本校验器不再有冻结表一节。

  return errors;
}

function checkPatchFields(at: string, patch: ThinkingPatch | undefined, errors: string[]): void {
  for (const field of Object.keys(patch?.fields ?? {})) {
    if (!FIELD_WHITELIST.has(field)) {
      errors.push(`${at}: 字段 "${field}" 不在白名单（thinking/enable_thinking/reasoning_effort）`);
    }
  }
}
