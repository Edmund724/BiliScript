# ADR-0015：思考「不干预」档（default）与出厂默认

> 状态：有效

## 背景

思考偏好在存储 / 面板里是一个 7 档的词表（`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`，ADR-0014 决定 1）。其中 `off` 是「**显式**发一个关思考的字段」——线值可能是 `thinking:{type:"disabled"}`、`enable_thinking:false`、`reasoning_effort:"none"`，也可能被平台忽略甚至 400。

于是有一批行（2026-10-05 盘点的 A′ = ∅ 共 104 行：平台只登记了 `toggle` 而我们没登记该平台的开关形状 97 行、模型侧词表是 budget-only 7 行）出现两种同时成立的坏状态：

- 面板一个勾都没有（偏好 `off` 落不下去、偏好强度档也没有档可落），用户读不出「线上实际发什么」；
- 线下确实什么都没发——**「什么都不发」这个状态在词表里没有名字**，只能靠「chip 显示偏好词」的假话带过。

同一时期确立的显示口径 ③（偏好 ≠ 实发档时一级行/chip 写实发档）在这种情况下无从落地：没有实发档可写。

## 决定

1. **新增第 8 个可选值 `default`：不干预。** 落线 = **不发任何思考字段**，由平台自己的默认行为决定（M3 等平台省略字段即「思考开」、有的平台省略即「关」——这正是不表态的含义）。与 `off` 的分工：`off` 是显式关（可能被忽略 / 400），`default` 是压根不表态。
2. **所有模型恒可选、恒可发。** 面板档位列表首项恒为 `Default`；可表达的强度档为空（A′ = ∅）时列表只剩这一项，而一级行**照旧显示**——「可选条目 ≤1 就隐藏整行」的旧规则退休（用户裁定原话：「破例 = 能主动选」）。
3. **`default` 不进强度阶梯。** `AI_THINKING_LEVELS` 同时是 clamp 的档位序（「向下取最近可用档」），`default` 混进去会被当成最小强度档参与级联，把「关不掉 → 落最小思考档」的既有裁定悄悄推翻。因此词表分两张：**强度阶梯**（`AI_THINKING_LEVELS`，clamp 用）与**可选值**（`AI_THINKING_LEVEL_VALUES = default + 阶梯`，存储 / 面板 / 归一化用）。
4. **级联方向不许反向短路。** 偏好是强度档或 `off` 而落不下来时，级联目标仍是**阶梯里的最小可用档**（例如偏好 `off`、A′ = `{high,max}` → 发 `high`）；只有「没有任何可表达的强度档」（A′ = ∅）才落 `default`。`default` 只在偏好本身就是 `default` 时生效。
5. **零档行的显示随之收口**：chip / 一级行按口径 ③ 写实发档，A′ = ∅ 的行现在写 `Default`（不再回落偏好词）；偏好是强度档而被降到 `default` 时，提示行照既有句式写「当前模型不支持思考强度 high，已使用 default」。`effectiveLevel: null` 的语义收窄为「**没有解析结论**」（unknown 哨兵），不再是「无档可落」。
6. **出厂 / 重置默认偏好 = `default`**（`DEFAULT_SETTINGS` 与初始 chat 会话状态同源）。settings 与 storage 两处都取不到值时，chat 侧兜底也回落这一份默认，不在 `providers.ts` 里硬写某个档位词——否则界面写 `Off`、线上按「不干预」发的分裂会一直存在。

## 被否决的备选

- **把 `default` 加进 `AI_THINKING_LEVELS`**：省一张词表，但污染 clamp 序（决定 3），并让「先向下取、没有更低的才落它」这类隐式语义渗进每一处 clamp 调用点。
- **只改 UI（显示 `Default`）不改线**：chip 会在 A′ = ∅ 的行上说假话——线上什么都没发，界面却写着一个「正在发」的档位。
- **维持「条目 ≤1 隐藏整行」**：A′ = ∅ 的行用户无法主动选到「不干预」，只能被动接受；用户明确否决。
- **出厂默认保持 `off`**：新装用户第一次请求就带上「关思考」的显式字段（可能被忽略 / 400），与 `default` 的引入理由（不表态最安全）相悖；用户明确否决。

## 后果（必须一并接受的代价）

- **出厂行为变化**：新装 / 重置的用户请求体不再带思考字段（存量偏好一律不动）。
- 档位列表恒多一项 `Default`（可点集合变大）；`Off` 仍然只在模型真能关时才出现。
- 「无档可落」不再是终态：A′ = ∅ 的行有了一个可说、可选、可发的名字；线格式层无需新增写点（空 patch 两条通道本来就会发空）。
- 词表从一张变两张，新增档位值时必须同时问「它进不进 clamp 序」——这是本 ADR 的**唯一**新增纪律。

## 重开条件

无。本条是新增档位值与出厂默认的裁决，不推翻既有 ADR：口径 ③ 与 off 写点作用域仍归 ADR-0014，本条只补上「不说话」这一格的语义与它的显示 / 级联边界。

## 修订（2026-10-05：缺省 / 脏值 = `default`（不干预）——请求侧与存储侧同口径，探针两链对齐）

决定 1 只裁了 `default` 这个值本身，没说「**没有值**」（请求链上 `thinkingLevel` 缺省）与「**不认识的值**」（端口消息 / 直接调用传进来的脏串）算哪一档。此前的实现把两者都塞进值域归一化的回退值 `off`，于是同一条「我没有偏好」的意图在两条链上说成两件事：OpenAI chat 链的探针（不传档位）实发一个**关思考**字段，Messages 链的探针（怪癖 `probeOmitsThinking`）刻意什么都不发——两边还各被逐字节用例钉着。

2026-10-05 用户裁定（两轮）：**`thinkingLevel` 缺省或无法识别的脏值一律归 `default`（不干预）**——线上不发任何思考字段，两条探针链对齐到这一表现；显式 `off` 的语义不变（照旧走该平台的关思考写点）。第二轮把**存储 / 面板侧也同口径归过来**（裁定理由：同一条「没有偏好」意图全线一个说法）：`core/validators.ts` 的再导出（`normalizeAiThinkingLevel`，持久化设置的归一化）与 `chat/providers.ts` 的档位落盘 / 读回落都走同一条回退——脏值不再被读成「显式关思考」（`off`），回退值与出厂默认（决定 6）现在是同一个词，界面写 `Default`、线上按「不干预」发。

落地形态：**一条归一化、两处消费**。`normalizeThinkingLevel`（`extension/ai/thinking-levels.ts`）——合法值（`default` + 7 档）原样返回，缺省 / 脏值归 `default`。请求侧的两个解析入口 `resolveThinkingProfile` / `resolveThinkingAdjustment` 是它在请求链上的施加点（`ResolveThinkingInput.level` 因此由 `string` 放宽为 `unknown`：它是未归一的外部值，不该被当成合法档位；两个 adapter 不再各自预归一，只把端口值透传给解析层），两条协议链都在它们下游，探针语义不可能再分叉。回退值两边同口径之后，先落地时「请求侧归 `default`、值域归 `off`」的两条归一化入口随之合并回一条——双入口只剩名字差异，是漂移隐患而不是事实。同一份声明面也覆盖**设置 / 面板侧**的归一入口：`chat/providers.ts` 的 `setThinkingLevel`（落盘与读回落都走同一条 `normalizeAiThinkingLevel`）与面板档位出口（`reader/chat-tab.ts` 的 `pickThinkingLevel`，它的声明面是 `reader/chat-model-panel.ts` 的 `deps.pickLevel`）与请求链同用 `ThinkingLevelInput` 声明「未归一的外部值」——两处照旧收到什么都能归一、不抛，收的是声明面而不是过滤器（票 thinking-seam-tightening/03）。

行为面：golden（`tests/ai/thinking-golden.test.ts` / `tests/ai/thinking-golden-messages.test.ts`）只用 7 个有效档位，逐字节不变；变化的既有行为两条：**OpenAI 链的探针不再发关思考字段**（token 上限参数名事实与档位无关，`max_tokens` / `max_completion_tokens` 的换名照旧），**持久化的脏档位值不再落成显式 `off`**（改落 `default`，与出厂默认同词）。判据落在 `tests/ai/thinking-default-fallback.test.ts`（缺省 / 脏值 × 两条链 × 探针 × 归一化同口径，逐条对应失败方式：脏值落具体档、显式 `off` 漂移、两链不一致、`default` 误发字段、golden 漂移、存储侧口径分叉）与 `tests/core/shared-defaults-thinking.test.ts`（存储再导出的回退值）。
