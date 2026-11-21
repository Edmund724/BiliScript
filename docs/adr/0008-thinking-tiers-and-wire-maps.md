# ADR-0008：思考档位双词表、协议无关事实层与三协议线格式出口表

> 状态：有效

模型思考控制拆分为**「双词表归一化 → 协议无关事实层 → 按协议分派的写法层」**三层单向流水线（由思考装配边 `extension/ai/plan-thinking.ts` 在唯一请求点 `completion.ts` 组装），严禁为消除协议映射而把模型档位事实按协议拆成多份。

## 已定决策

### 1. 强度阶梯与可选值双词表分离，出厂与缺省统一归 `default`

- `extension/ai/thinking-levels.ts` 维护两张独立词表：**强度阶梯** `AI_THINKING_LEVELS`（`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` 共 7 档，专供向下 clamp 级联排序）与**全量可选值** `AI_THINKING_LEVEL_VALUES = ["default", ...AI_THINKING_LEVELS]`（供存储、面板与归一化消费）。
- `default` 语义为**「不干预」**（线上不发任何思考字段，交由平台默认决定），与显式发关思考字段的 `off` 严格区分。出厂默认（`DEFAULT_SETTINGS`）、请求链缺省值与不可识别脏值经 `normalizeThinkingLevel` **统一归一为 `default`**（使各协议连通性探针与面板显示口径一致）。
- **`default` 严禁并入 `AI_THINKING_LEVELS`**：偏好为强度档或 `off` 但当前模型不支持时，clamp 必须级联至阶梯内的**最小可用档**（如仅支持 `{high, max}` 时选 `off` 落 `high`）；唯有可表达集为空（A′ = ∅）时才落 `default`。面板档位首项恒为 `Default`（配重置键），即便 A′ = ∅ 也照常渲染思考强度行供用户主动选回 `Default`，不因可选条目 ≤ 1 隐藏整行。

### 2. 协议无关事实层与参数隔离（`extension/ai/thinking-profiles.ts`）

- 事实层基于 [ADR-0007](0007-upstream-model-facts-snapshot.md) 的上游值集输出封闭判别联合 `ThinkingVocabulary`（`reasoningEffort` / `enableThinking` / `thinkingType` + `noFields` / `unknown` 哨兵），在类型层面排除 `temperature` 与 `top_p` 等采样参数（防止触发思考模型禁传采样参数的 400 报错）。
- `off` 写点仅在模型值集自带 `effort-none` 或所属平台已在 `UPSTREAM_TOGGLE_SHAPES` 显式登记开关形状时生成（形状登记为平台级开门；未登记形状的平台仅无 `off` 写点、按阶梯级联，并非整行静默）。
- `ClassRule.tokenParam`（`max_completion_tokens`）仅保留在手写 OpenAI reasoning 兜底类供自定义端点使用，**不从上游 `models.dev` 投影写入**，以保留 `openrouter` / `opencodego` 等聚合网关上的 `max_tokens` 语义。

### 3. 三协议写法层与 Messages 显式出口表（`extension/ai/thinking-wire-map.ts`）

`THINKING_WIRE_MAPS` 以 `AiProtocol` 全键覆盖（新增协议漏配即编译失败），且为请求体思考字段与输出上限参数名的唯一出口：

- **`openai` 行**：将中转词汇恒等投影为 OpenAI 线格式字段，输出参数名随血统事实取 `max_tokens` 或 `max_completion_tokens`。
- **`anthropic` 行**：探针请求省略思考字段（`probeOmitsThinking`）；对 `PlatformKey` 全键空间维护三张带出处（`provenance`）的显式出口表——档位出口表 `MESSAGES_TIER_EXIT`、关词出口表 `MESSAGES_OFF_EXIT`（默认显式发 `thinking: { type: "disabled" }` 防 ModelScope 等网关忽略关思考吃光预算；`stepfun` / `amd` 受怪癖 `effortVocabMessages` 约束静默不发）与开词出口表 `MESSAGES_ON_EXIT`（如 `minimax` 枚举仅认 `adaptive` 而非 `enabled`）。**硬规则：Messages 通道绝不自造 `thinking.budget_tokens` 数值预算**。
- **`gemini` 行**：将离散词汇映射为 `generationConfig.thinkingConfig.thinkingLevel`，输出参数名固定 `maxOutputTokens`（详见 [ADR-0009](0009-gemini-native-protocol.md)）。

## 考虑过的方案

- **按协议拆分模型档位事实表**：导致同一模型出现多套事实源，产物与漂移面成倍膨胀。
- **在各协议 Adapter 内手写 `if` 分支改写字段**：历史曾因此引发高低档位塌陷为同一预算的隐蔽缺陷，且无法做全平台静态穷尽对账。

## 后果

- **审查红线**：
  - 架构评审（含 AI 代理）不得提议「为消除映射而按协议拆分档位事实」（重开条件：同一平台两条协议通道的档位集本身被厂商文档或实测证实不同构且无法由写法层出口表表达）。
  - 架构评审（含 AI 代理）不得提议将 `default` 并入 `AI_THINKING_LEVELS`，也不得以「可选条目 ≤ 1」为由隐藏零档模型的思考强度行。
