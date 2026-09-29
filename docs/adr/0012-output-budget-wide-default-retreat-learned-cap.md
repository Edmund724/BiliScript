# 输出上限给宽、被平台拒收就退回、学过就记住

> 状态：有效

三条链（对话 / 概览 / 归并成稿）共用一个「输出上限」决策，此前各写各的：adapter 兜底 8192（`anthropic.ts` 旧 `DEFAULT_MAX_TOKENS`）、概览估算封顶 8192（`estimateOutputTokens` 的 ceiling）、空正文重试定值 16384（`empty-text-retry.ts`）。三个失败出口都没有统一处理：**截断**（有正文，对话挂徽标、概览靠 `json-repair` 静默救回）、**空正文**（思考把预算吃光）、**超上限 400**（硬失败，且被 `isContextLengthOverflow` 的 `"max_tokens"` 子串误判成「输入太长」，推去 Map-Reduce 或报「上下文过长」）。ADR-0010 文末把这套预算明确列为「留作独立议题」，本条收口。

**不变式（硬）：输出的「请求值」只有一个解析路径**，三层依次生效，任何一处不得自建第二套：

1. 调用方显式给的值（探针 1 / 选区解释 320 / 快捷提示词 256 / 概览 `estimateOutputTokens`）；
2. 没给时取协议声明的兜底 `ProtocolAdapter.defaultMaxTokens`（`ai/output-budget.ts` 的 `DEFAULT_MAX_TOKENS`，单源）；openai 协议不声明 = 不发这个字段；
3. 再夹一层**会话内存**里学到的平台上限（`ai/learned-budget.ts`，只夹低、不持久化）。

## 决定

1. **兜底 32768、退回下限 8192**（`output-budget.ts`）。旧 8192 只够旧模型：思考计入 `max_tokens` 的平台（ModelScope + DeepSeek-V4.1-Flash 实测）会先把预算烧在思考上，长回答再被截断。
2. **被平台按「超上限」拒收 → 退回 8192 重发一次**（`completion.ts` 的唯一 fetch 点）：不消耗重试次数、不报 `onRetry`（对用户无感的降级）；且这类 400 不再冒充上下文溢出——「上下文过长」提示与 Map-Reduce 分流都指错方向。
3. **估算封顶与兜底同源**：`estimateOutputTokens` 的 ceiling 由 8192 改为 `DEFAULT_MAX_TOKENS`。旧的 8192 与 ADR-0001 的「分段小结 ≤10k / 成稿 ≤16k」自相矛盾——5 万字的段按 ratio 0.5 本应拿 25k，被砍到 8k，截断是常态而非例外。
4. **概览链补上截断信号**：`requestValidatedPart` 接 `onFinishReason`，`"length"` 或空正文时用 `retryBudget` 加倍重跑一次（首发半截正文作废，同 `onStreamReset` 语义）；`canRaiseBudget` 为假（学到的上限已经到顶，加倍请求与首发完全相同）时跳过，省一次白花调用。
5. **判据是启发式且偏向不误判**（`isOutputBudgetTooLarge`）：输出侧参数名（`max_tokens` / `max_completion_tokens` / `max_output_tokens` / 最大输出）+ 过限措辞（比较式 `> N` / `valid range` / `invalid` / `too large` / `exceed` / 中文「超出|超过」），并排除上下文与输入侧措辞。漏判退化为现状的溢出错误，误判只是多一次 8192 重发（安全侧）。

## 考虑过的方案

- **只把常量调大**（否决）：低上限模型（`claude-3-haiku` 4096、`cohere command-r` 4000、旧 `deepseek-chat` 16384）会从「截断」变成「整轮硬失败」。
- **平台/模型上限表**（否决）：模型目录不在 SW 静态图且只覆盖 7 家（ADR-0009）；`modelscope` / `stepfun` / `amd` / `sensenova` / `qwen` / `ollama` / `custom` 永远查不到数据（`NO_CATALOG_PRESETS`），而这批正是宽兜底最需要保护的对象。
- **openai 协议也声明默认上限**（暂缓）：判据没覆盖到的 400 会把「本来能用（平台默认）」变成硬失败，而这条链今天无人抱怨。重开条件：拿到真实 400 文案且判据能认。
- **几何试探找平台真实上限**（32768 → 16384 → 8192，否决）：每次试探都要付一次 400 往返，而 8192 是已验证可用值；收益只对 8192~32768 之间上限的平台可见。
- **持久化学到的上限**（否决）：会把「一次 400」固化成跨会话结论，还要进存储 schema；SW 重启清零即可。
- **per-provider「最大输出 tokens」设置项**（未做）：判据漏判时的逃生口，跨 UI/存储/迁移，留作独立工单。

## 后果

- 低上限平台每会话首个被拒请求多一次往返，之后按学到的值直发；SW 重启或换模型/端点即重新学习。
- 概览每次截断/空正文最多多一次调用；平台上限已到顶时（`canRaiseBudget` 为假）跳过。对话链的空正文重跑**不**加这道门：它的首发起伏值取决于协议是否发字段（openai 未指定时压根没发），调用方不知道，误跳会损失一次本可成功的重跑；代价是低上限平台上最多一次空转，接受。
- 对话链「有正文被截断」仍只挂常驻徽标、不自动重跑（重跑白花额度且回答未必一致）；静默重跑只发生在概览（用户看不到截断的地方）。
- 判据是启发式：新增平台时若出现「本该退回却没退」的错误，先补 `isOutputBudgetTooLarge` 的样本，而不是放宽到裸 `exceed`——那会把「max tokens exceeded」这类输入超长文案误判进来。
- 素材预算（`MATERIAL_BUDGET_CHARS` = 200k 字符）不动：200k 输入 + 32.8k 输出仍在 ADR-0001 假设的 256k 窗口内，只是余量从约 39k 降到约 23k；更小窗口的模型靠溢出回落进 Map-Reduce（2026-09-29 就地更正：回落有地板、有白花代价，前提与边界见 [ADR-0001](0001-long-video-summarization-map-reduce.md) 的「使用前提」条）。
