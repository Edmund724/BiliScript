# ADR-0006：输出上限宽默认、平台拒收退回与会话内学习上限

> 状态：有效

对话、概览与长视频归并成稿三条链共用唯一的输出 token 上限解析路径（`extension/ai/output-budget.ts`、`extension/ai/learned-budget.ts`、`extension/ai/completion.ts`），三层依次生效，禁止各链另建规则：

1. 调用方显式指定值（如探针 `1`、选区解释 `320`、快捷提问 `256`、概览 `estimateOutputTokens`）；
2. 未指定时取协议声明的兜底 `ProtocolAdapter.defaultMaxTokens`（单源常量 `DEFAULT_MAX_TOKENS = 32768`）；
3. 最后经当前会话内存中学到的 `(baseUrl, model)` 平台上限向下夹紧（只夹低、不持久化）。

## 已定决策

1. **仅 `anthropic` 声明协议默认 `32768`，`openai` 与 `gemini` 留空交平台默认**：Anthropic Messages 协议必填 `max_tokens`，且部分兼容网关将思考 token 计入 `max_tokens`（8192 会被思考耗尽导致空正文），故给宽至 `32768`。OpenAI 兼容系与 Gemini 原生协议省略该字段时由平台自行决定，且同一端点在思考/非思考态的默认上限方向相反（如 DeepSeek 未设 `max_tokens` 时非思考默认 8K、思考默认 64K），任何固定协议级常量都会对其中一侧劣化。
2. **超上限 400 无感退回 `8192` 重发并记入会话内存**：唯一请求点 `completion.ts` 用 `isOutputBudgetTooLarge` 识别输出参数过限 400（严格排除输入侧上下文超长措辞，防止误入 `isContextLengthOverflow` 触发错误提示或长视频分段），不消耗常规重试次数，自动退回 `CONSERVATIVE_MAX_TOKENS = 8192` 重发一次，并将上限记入 `learned-budget.ts`（后台重启或切换模型即清零，不落存储）。
3. **概览与对话的截断差异化处置**：`estimateOutputTokens` 的封顶值对齐 `DEFAULT_MAX_TOKENS`（匹配 [ADR-0012](0012-long-video-state-relay-and-hybrid-retrieval.md) 的分段与成稿体量）。概览链遇 `finish_reason="length"` 或空正文时，仅在 `canRaiseBudget` 为真（尚未触及已学上限）时加倍预算重跑一次；对话链出现有正文截断时只渲染截断提示徽标，不自动重跑以免重复扣费。

## 考虑过的方案

- **只调大常量不退回**：上限较低的模型（如 4096 / 16384 上限模型）会从回答截断恶化为整轮 400 硬失败。
- **依赖模型目录表查输出上限**：模型目录不在后台静态图内，且覆盖不到 `ollama` 与 `custom` 自定义端点（见 [ADR-0007](0007-upstream-model-facts-snapshot.md)），而这两类端点正是宽兜底最需保护的对象。
- **几何级数多次试探（32768 → 16384 → 8192）或持久化学习结果**：多次试探每次白花一轮 400 RTT；持久化会把偶发网关异常固化为永久降级。
- **新增 per-provider「最大输出 tokens」设置项**：引入 UI、存储与迁移负担，而漏判场景仅需向 `isOutputBudgetTooLarge` 补充错误文案样本即可零 UI 收口。
