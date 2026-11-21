# ADR-0009：引入第三种线格式协议（Gemini 原生 `generateContent`）

> 状态：有效

在 `openai`（Chat Completions）与 `anthropic`（Messages）之外，引入第三种平台协议 `gemini`，由 `extension/ai/adapters/gemini.ts` 基于标准 `fetch` + SSE 流式解析实现原生 `generateContent` / `streamGenerateContent?alt=sse` 协议适配器，零新增运行时依赖。

## 背景与理由

1. **思考签名与工具循环校验在兼容层缺失**：Gemini 的 OpenAI 兼容层只暴露粗粒度 `reasoning_effort`、静默丢弃未列参数，不提供多轮思考块与工具调用必需逐块保留回放的 `thoughtSignature`，也缺少原生协议的严格角色交替合并、顶层 `systemInstruction` 与 1:1 `functionCall`/`functionResponse` 配对校验。
2. **原生协议面封闭可控**：camelCase 字段、角色映射、交替合并、函数配对与 `thoughtSignature` 回放边界清晰，可完全由表驱动单测封闭锁死。

## 已定决策

1. **三键合一与兼容层后路**：协议 id、预设平台 id 与平台身份键同用 `"gemini"`；`core/presets.ts` 默认使用原生 `gemini` 协议（`x-goog-api-key` 鉴权 + `/v1beta/models` 分页过滤拉取模型列表），同时在 `protocolBaseUrls` 登记 `/v1beta/openai` 兼容端点供用户按需切换。
2. **仅落离散 `thinkingLevel`，不提供 `thinkingBudget` 数值预算轨**：对齐 [ADR-0008](0008-thinking-tiers-and-wire-maps.md)，`ai/thinking-wire-map.ts` 的 `gemini` 行仅将事实层产出的离散档位映射为 `generationConfig.thinkingConfig.thinkingLevel`（偏好 `off` 时发落定最小档并附 `includeThoughts: false`）。对仅在 `models.dev` 登记连续预算区间的模型（如 Gemini 2.5 系）或无词表模型，事实层不发明任意档位折算值（A′ = ∅），线上一个思考字段都不发，保持平台默认行为。
3. **明确排除 Vertex AI**：Vertex AI 依赖 Google Cloud ADC 鉴权与项目级资源路径，超出本扩展统一的纯 API Key 接入模型，列为有意缺口。

## 考虑过的方案

- **仅接入 Gemini OpenAI 兼容端点**：省去适配器实现，但丢失 `thoughtSignature` 与原生工具调用校验。
- **打包 `@google/genai` 官方 SDK**：显著增大扩展包体，流式生命周期与 `AbortSignal` 封装过重，且引入额外打包与 CSP 风险（同 [ADR-0007](0007-upstream-model-facts-snapshot.md) 不嵌入第三方 SDK 原则）。

## 后果

- 线格式协议扩展为 `openai` / `anthropic` / `gemini` 三种，Anthropic Messages 三张出口表对 `gemini` 显式标记 `"non-messages"`。
- 新增第四种协议时须同步完成词表叶、适配器实现、注册表、下拉选项、`thinking-wire-map.ts`、`plan-thinking.ts` 与 `scripts/build.js` 后台静态图禁区共 7 处登记。
