# 思考线格式的作用域：档位集合协议无关、off 写法维持全局归一

> 状态：有效

修「智谱 glm-5.2 关不掉思考」时（该缺口由**逐模型补声明**修掉，不动协议层），评审提出过一个方向：OpenAI chat completions 与 Anthropic Messages 既然是两个协议，能不能各自直接走、不要「转写」。本条把这次评审的边界钉住：**本仓的线格式层不是通用协议转码器，它只有两条职责；为了消除它而把档位事实拆成两份，是明确不走的路线。**

现状的三层结构（`extension/ai/thinking-wire-map.ts` 头注自称「写法层」）：**事实层** `extension/ai/thinking-profiles.ts` 从上游值集算出「这个模型每一档发哪套 OpenAI 词汇」，输出**协议无关**的 patch；**写法层** `THINKING_WIRE_MAPS: Record<AiProtocol, ThinkingWireMap>` 回答「这套词汇在本协议请求体里长什么样」。写法层的两个事实：`openai` 行是**恒等**（`fields` 原样并入，测试「openai 行：血统词汇即本协议的线格式」）；`anthropic` 行只做两件事——按平台选档位出口（`MESSAGES_TIER_VOCABULARY`，8 家登记、每行带出处 URL，未登记平台回落到裸 `output_config.effort`），以及把三种关思考词汇**归一**成 `thinking:{type:"disabled"}`。

## 决定

1. **档位集合协议无关。** 「这个模型有哪些档、能不能关」是模型事实（上游值集 + `UPSTREAM_TOGGLE_SHAPES` 的平台形状），只存一份，不按协议分家。**写法字段**按平台登记、`THINKING_WIRE_MAPS` 本身以协议为键——这一层本来就是协议维度的，本条不改它。
2. **off 的三词汇归一维持全局**（`reasoning_effort:"none"` / `enable_thinking:false` / `thinking.type:"disabled"` → Messages 通道统一发 `thinking:{type:"disabled"}`）。它有实测依据（怪癖 `thinkingDisabledMustBeExplicit`：ModelScope 的 Messages 端点实测，`enable_thinking:false` 被忽略、模型继续思考、思考计入 `max_tokens` 把正文挤成空串；只有 `thinking:{type:"disabled"}` 能真正关掉），不是无据的转码；测试「off 三词汇归一为 thinking:{type:disabled}」逐字节钉住它。
3. **档位词的合法性不在写法层**：测试「归一化不发散（08 号票：像集合 ⊆ 该模型 02 值集）」逐条 × 7 档断言线上发出的档位词 ∈ 该模型值集。所以这一层不可能凭空转出一个模型没声明的档位。
4. **off 写点 = 值集 × 平台形状**：值集有 `toggle` **且** 该平台在形状表里登记，才有 off 写点；未登记 = 不发（fail-closed）。实测现状：「事实带 `toggle` 但平台未登记形状」= **132 行**（openrouter 111 / opencodego 15 / amd 3 / sensenova 2 / minimax 1）。**登记一行是平台级开门、不能按模型收窄**——这是本仓不轻易登记新平台形状的理由。
5. **重开条件**：出现「同一平台两个通道的 off 或档位词被证实不同形」的证据（厂商文档，或实测 400 / 静默无效）时，新开一篇取代本条，实施形态为：把形状载荷的键从平台扩到 **(平台, 协议)**，并在 Messages 侧为每格**显式声明** off 出口（平台自有词 / Anthropic 原生 `thinking:{type:"disabled"}` / 明确不发），默认仍是现状的原生写法——改的是「可断言、可逐格否决」，不是「改成不发」。**没有这种证据就不改**：已登记平台的 off 在 Messages 侧本就被归一成同一个字面量，改了行为逐字节相同。

## 考虑过的方案

- **完全拆表（每协议一套值集 / 指派）**（否决）：同一模型两个事实主人，与 [ADR-0013](0013-upstream-model-facts-borrow-not-embed.md)「上游是本域（值集 + 指派）唯一主人」冲突；构建产物与漂移面同时翻倍。
- **只把 off 载荷的键扩成 (平台, 协议)**（不否决，属重开条件下的实施形态）：无证据时不做——收益是把一处隐含假设显式化，代价是多一层要同步的真值；12 个格（6 家登记平台 × 2 协议）里目前只有 modelscope 那格有实测支撑，表格替代不了实测。
- **维持全局归一**（本条裁决）。
- **让 adapter 各自 `if` 着改写**（否决）：04 号票前的形态，「档位塌陷」（低档与高档压成同一个预算）就藏在这种 `if` 里；写法层立表正是为了让「哪一档发什么」可审、可被 golden 逐字节钉住。

## 后果

- 架构评审（含 AI 代理）不得再提议「为消除转写而按协议拆分档位事实」，除非重开条件成立。**边界说明**：这不是 [ADR-0013](0013-upstream-model-facts-borrow-not-embed.md) 那条「不得让 `protocol` 参与目录查表」的延伸——那条管的是身份与目录查表（`PRESETS[].catalogProvider`），写法层本来就以协议为键；本条只钉「该拆哪一层、拿什么证据拆」。
- 新增协议时：写法层加一行出口（`Record<AiProtocol, …>` 编译期强制）；新增平台时：平台形状/出口各加一行；**档位事实照旧只加一份**。
- 已接受的代价：跨方言等价断言在多数格上没有实测支撑（例：`qwen` 的 chat 通道 off 发 `enable_thinking:false`、Messages 通道发 `thinking:{type:"disabled"}`，后者出处是百炼 Anthropic 兼容页的**档位**出口而非 off 专项；`moonshot` 的 Kimi Code 端点档位走顶层 `reasoning_effort`、off 却发 `thinking:{type:"disabled"}`，该端点的 `thinking` 形状无官方文档）。这类格子若被证实不成立，回滚面 = 形状表 / 出口表里的一行。
