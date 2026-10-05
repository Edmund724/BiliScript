# 思考线格式的作用域：档位集合协议无关、off 写法维持全局归一

> 状态：有效

修「智谱 glm-5.2 关不掉思考」时（该缺口由**逐模型补声明**修掉，不动协议层），评审提出过一个方向：OpenAI chat completions 与 Anthropic Messages 既然是两个协议，能不能各自直接走、不要「转写」。本条把这次评审的边界钉住：**本仓的线格式层不是通用协议转码器，它只有两条职责；为了消除它而把档位事实拆成两份，是明确不走的路线。**

现状的三层结构（`extension/ai/thinking-wire-map.ts` 头注自称「写法层」）：**事实层** `extension/ai/thinking-profiles.ts` 从上游值集算出「这个模型每一档发哪套 OpenAI 词汇」，输出**协议无关**的 patch；**写法层** `THINKING_WIRE_MAPS: Record<AiProtocol, ThinkingWireMap>` 回答「这套词汇在本协议请求体里长什么样」。写法层的两个事实：`openai` 行是**恒等**（`fields` 原样并入，测试「openai 行：血统词汇即本协议的线格式」）；`anthropic` 行只做两件事——按平台选档位出口（`MESSAGES_TIER_VOCABULARY`，8 家登记、每行带出处 URL，未登记平台回落到裸 `output_config.effort`），以及把三种关思考词汇**归一**成 `thinking:{type:"disabled"}`（例外见决定 2）。

## 决定

1. **档位集合协议无关。** 「这个模型有哪些档、能不能关」是模型事实（上游值集 + `UPSTREAM_TOGGLE_SHAPES` 的平台形状），只存一份，不按协议分家。**写法字段**按平台登记、`THINKING_WIRE_MAPS` 本身以协议为键——这一层本来就是协议维度的，本条不改它。
2. **off 的三词汇归一默认全局**（`reasoning_effort:"none"` / `enable_thinking:false` / `thinking.type:"disabled"` → Messages 通道统一发 `thinking:{type:"disabled"}`）。**登记在案的例外只有一格**：只认新式 effort 词汇的平台（怪癖 `effortVocabMessages`，stepfun / amd）收到 `thinking` 字段会 400，故它们的 off 维持不发（今天走的行见决定 4 的 `effort-none` 通道）。它有实测依据（怪癖 `thinkingDisabledMustBeExplicit`：ModelScope 的 Messages 端点实测，`enable_thinking:false` 被忽略、模型继续思考、思考计入 `max_tokens` 把正文挤成空串；只有 `thinking:{type:"disabled"}` 能真正关掉），不是无据的转码；测试「off 三词汇归一为 thinking:{type:disabled}」逐字节钉住它。
3. **档位词的合法性不在写法层**：测试「归一化不发散（08 号票：像集合 ⊆ 该模型 02 值集）」逐条 × 7 档断言线上发出的档位词 ∈ 该模型值集。所以这一层不可能凭空转出一个模型没声明的档位。
4. **off 写点 = 值集 × 平台形状（`toggle` 通道）或值集自带的 `effort-none`（不经形状表）**：值集派生的 off 有两种写法——`toggle` 型**且**该平台在形状表里登记，才落平台开关的 off 载荷；`effort-none` 型落 `reasoning_effort:"none"`，与平台形状登记无关（Messages 侧仍受决定 2 的归一与例外约束）。**未登记 `toggle` 形状 = 没有 off 写点，不等于这一行整条不发**：此时该模型的可表达集 A′ 只由档位写点组成，偏好 off 时走 clamp 的**级联**——带 effort 档位的行照发 A′ 的最小档（glm-5.2 的 `{high,max}` → `high`；2026-10-05 用户裁定级联是期望行为、不是缺陷，界面照实发档显示，见 `extension/chat/thinking-picker.ts` 的口径 ③），**fail-closed 只发生在零档行**（A′ = ∅ → 整条不发思考字段）。实测现状（口径：`ASSIGNMENTS` 逐行取 `lookupThinkingFact` 的 `off` 字段 × `UPSTREAM_TOGGLE_SHAPES` 的平台登记）：「事实带 `toggle` 但平台未登记形状」= **134 行**（openrouter 112 / opencodego 16 / amd 3 / sensenova 3；`minimax` 的 1 行已按 2026-10-05 裁定登记形状，见补注 3），「事实是 `effort-none`」= 47 行（其中 46 行落在未登记形状的平台，照样有关思考写点）。**登记一行是平台级开门、不能按模型收窄**——这是本仓不轻易登记新平台形状的理由。
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

## 补注：off 出口表先于重开条件落地（2026-10-05）

02 号票（Messages 侧 off 出口表）已落地决定 5 实施形态里的**一半**——「Messages 侧为每格**显式声明** off 出口」——但**先于重开条件**（即先于「两通道 off 被证实不同形」的证据）。补注本条与之的边界（逐格清单在票内，按体例不入正文）：

- **不主张新证据**：本票不测任何新平台，只把今天已登记的 off 事实（12 格归一为同一字面量 + `stepfun` / `amd` 一格不发）从「一条全局默认 + 一个 `if` 例外」变成逐格可审的表（`MESSAGES_OFF_EXIT`：`native` / `word` / `silent` / `unresearched` 四态，每格带 provenance）。这正是本条「考虑过的方案」里记的那笔交易：用一层要同步的真值换「可审、可逐格否决」；本次由两条静态对账收口（表键 = `PROVIDERS` 键空间全覆盖；`owner` 声明的格 ≡ 怪癖词表里开该怪癖的平台）。
- **行为不变**：本票前后 `(平台, 模型, 7 档, stream, probe)` 的 Messages 思考字段逐字节 diff 为空（工件 = 02 号票的中立逐格 tsv，提交 `cbf05e4`）。默认仍是原生显式 `thinking:{type:"disabled"}`；`stepfun` / `amd` 的不发仍由怪癖 `effortVocabMessages` 定（表只声明归属，判据取词表的活值），故「`presetId` 与 `baseUrl` 手改指向不同厂」这类既存身份矛盾也与旧实现逐字节相同。
- **范围**：只碰 Messages 通道的 off 一格。档位词表（`MESSAGES_TIER_VOCABULARY`）与键从平台扩成 **(平台, 协议)** 仍是决定 5 的其余实施形态、属 01 号票；01 触发时本表随之改键形，不另立一层。（键形的实际处置见下一条补注：未扩。）

## 补注 2：档位出口表落地（2026-10-05）

01 号票（逐协议的 off / 档位写法断言）落了决定 5 实施形态的**另一半**——「档位出口逐格显式声明」——同样**先于重开条件**（off 那一半见上一条补注）：

- **不主张新证据**：档位侧今天没有「两通道不同形」的实测 / 文档证据（票面点名的 `moonshot` 擦边格是**同通道**内 off 与档位不同形，票面自己写明它不是触发条件）。本次只把「8 家显式登记 + 其余平台隐式回落裸 `output_config.effort`」变成逐格可审的 `MESSAGES_TIER_EXIT`：键 = `PROVIDERS` 键空间全覆盖，四态 `effort` / `effort-bare` / `reasoning-effort` / `unresearched`（未研究过与「有依据地只发档位字段」在类型与静态对账上可区分），每格带 provenance；怪癖 `effortVocabMessages` 的两个平台（`stepfun` / `amd`）声明 `owner`，判据取该怪癖的**活值**。交易与上一条补注同一笔：用一层要同步的真值换「可审、可逐格否决」。
- **行为不变**：本次前后 `(平台, 模型, 7 档, stream, probe)` 的 Messages 思考字段逐字节 diff 为空——复用 02 号票的中立域与脚本复算，留档 = 01 号票的中立复算 tsv（与 02 号票的 before 版逐字节相同）。
- **实施形态的一处改写（记录在案）**：决定 5 写的「把**形状载荷**的键从平台扩到 (平台, 协议)」**未按字面执行**。理由：写法层本来就以协议为键（`THINKING_WIRE_MAPS: Record<AiProtocol, …>`），两张出口表就长在 `anthropic` 那一行里——`(平台, 协议)` 已是它的物理键形；把 `protocol` 再下沉进形状事实（`UPSTREAM_TOGGLE_SHAPES`，属协议无关的档位事实层，决定 1）会与出口表形成第二份真值，且要把 `protocol` 穿进 `resolveThinkingProfile` 与两个 adapter，而收益只是把一处隐含假设显式化。新增协议的编译期强制仍然成立（`Record<AiProtocol, …>` 漏登记即红），决定 5 要防的那件事没有丢。
- **范围**：只碰 Messages 通道的档位出口一格；off 一格见上一条补注；档位词的合法性仍在 02 值集产物（决定 3），形状事实层与目录身份查表未动（ADR-0013 红线）。

## 补注 3：开词出口逐格落地（2026-10-05，**这一次是行为变更**）

MiniMax 的开关形状登记（票 toggle-shape-registration 01；2026-10-05 用户裁定「完整登记 off + on」）第一次把决定 5 的逐格显式声明用在**开词**上。与补注 1 / 2 有两点不同，记录在案：

- **不是中立表化，是行为变更**：此前 `minimax-cn/MiniMax-M3` 的可用集 A′ = ∅（上游值集是 `toggle`，但平台形状未登记 → 一个写点都不产、面板整行不可选、任何偏好都不发思考字段）。登记 `UPSTREAM_TOGGLE_SHAPES.minimax`（off `thinking:{type:"disabled"}` / on `thinking:{type:"adaptive"}`，两通道同词）后该行 A′ = 全部档位、面板出现 `Default / Off / On`，偏好 off 在两条通道都发 `thinking:{type:"disabled"}`。前后请求体逐字节 diff **只**含该行的 14 条（7 个非 `default` 偏好 × 2 通道），其余 358 行不变；证据等级 = 厂商文档级（本仓无任何平台 API key，未实测）。
- **触发条件落在重开条件之外（口径缺口，记录在案）**：决定 5 写的重开条件是「两通道的 off / 档位词被证实不同形」，而本次证据是**平台开词 ≠ Anthropic 原生开词**——MiniMax 的 `thinking.type` enum 只有 `disabled` / `adaptive`，此前写法层把任何开形状硬写成 `enabled` 就是替平台发明词；两条通道的开词其实同形。故新增第三张同形表 `MESSAGES_ON_EXIT`（键 = `PROVIDERS` 键空间全覆盖，三态 `native` / `word` / `unresearched` + provenance；`minimax` = `word` / `adaptive`，其余 13 格 `native` = 建表前的硬写值）。实施形态仍**不**把 `protocol` 下沉进形状事实（同补注 2 的理由：平台 off / on 词本就同形，形状表登记一份即可）。
- **行为变更的安全边界**：形状登记是**平台级**开门（决定 4），而厂商事实是**逐模型**的（`MiniMax-M3` 关得掉；M2.x 收下但忽略；`MiniMax-M3.1-Flash-Preview` 发 `disabled` 直接 400）。今天的边界靠「目录内只有 `MiniMax-M3` 一行有思考事实」天然成立（M2.x / M3.1 走手写兜底，逐档不发任何字段，因此既不会发被忽略的字段也不会触发 400）；**逐模型收窄机制未建**——上游一旦给这些 id 补词表就会踩到，该门记在票内，不属本 ADR。

