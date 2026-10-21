# ADR-0018：引入第三种线格式协议（Gemini 原生 generateContent）

> 状态：有效

## 背景

在 multi-protocol-ai 域建立时，`GLOSSARY.md`（时名 `CONTEXT.md`）曾把「第四种协议（Gemini 等）的实现」列为非目标（`_Avoid_`），当时的权衡是协议面维护成本随协议数线性增长、且 Gemini 有 OpenAI 兼容端点可零成本接入。

然而，随着产品演进与实际接入需求出现，事实与权衡发生了根本改变：

1. **Thinking 档位体系需要完整 `thinkingConfig` 形态**：本扩展的 thinking 档位体系需要支持 `thinkingLevel`（离散档位）与 `thinkingBudget`（数值预算）双轨映射，以及逐块保留与回放的 `thoughtSignature`。Gemini 的 OpenAI 兼容层只暴露归一化后的 `reasoning_effort`，未列参数会被官方端点静默忽略，无法支持细粒度档位与签名回放。
2. **工具循环的校验语义缺失**：联网搜索工具循环在 OpenAI 兼容层上缺少 Gemini 原生独占的校验与配对行为（如严格交替、1:1 函数调用配对、顶层 `systemInstruction`、带签名的思考块回放），易引发协议失配。
3. **原生协议的踩坑面封闭且可枚举**：业内已有 `@earendil-works/pi-ai` 与 `MoonshotAI/kimi-code` 的生产级原生 `generateContent`/`streamGenerateContent` 实现，证实其适配器复杂度可控，踩坑面（camelCase、角色映射、交替合并、配对校验、thoughtSignature）完全可以由表驱动测试封闭覆盖。

因此，推翻原 `_Avoid_` 裁决、引入 Gemini 原生协议是必要且风险可控的。

## 决定

1. **新增第三种协议 id `gemini`**：协议 id、平台 id 与平台身份键三者同键。
2. **实现手撸的原生 `generateContent`/`streamGenerateContent` 适配器**：基于标准 `fetch` + SSE 逐块解析，零新增依赖，天然支持 `AbortSignal`，无扩展 CSP 风险与体积膨胀。
3. **预设双协议后路**：Gemini 预设默认使用原生 `gemini` 协议，同时登记 OpenAI 兼容端点（`/v1beta/openai`），允许用户在需要时自主切换到兼容层作为后路。

## 被否决的备选

- **仅走 OpenAI 兼容端点**：实现成本极低，但 thinking 与工具调用语义残缺（未列参数静默丢弃、无 thoughtSignature、无原生校验），无法满足产品对 thinking 双轨和搜索循环的纪律要求，否决。
- **打包 `@google/genai` 官方 SDK**：引入重型依赖，包体积增大，且官方 SDK 存在 `AbortSignal` 支持不完整或流式生命周期封装过紧的问题，增加 Chrome 扩展中的打包与 CSP 风险，否决。
- **将 Vertex AI 一并纳入范围**：Vertex AI 采用 ADC（Application Default Credentials）鉴权与不同的资源路径，与当前本仓统一的 API Key 单形态模型不兼容，超出了当前纯 API Key 平台的定位，作为有意缺口排除在本次范围之外。

## 后果（必须一并接受的代价）

- **协议面扩增**：线格式协议从 2 种扩展至 3 种（`openai`、`anthropic`、`gemini`）。新增协议的登记点清单（词表叶、适配器实现、适配器注册表、下拉选项、线格式映射表、装配边、SW 静态图禁区）需完整落位并建立文档清单。
- **文档与纪律同步**：`GLOSSARY.md` 平台协议词条中的 `_Avoid_` 句予以改写，凭据指向本 ADR。
- **目录对账范围扩大**：`models.dev` 目录对账迎来第 13 家（`google`），产物与计数断言需同步更新。

## 补注：数值预算轨不作为产品能力保留（2026-10-21）

背景第 1 条把「`thinkingLevel` + `thinkingBudget` 双轨映射」列为采用原生协议的理由之一；本补注把其中的**数值预算轨**从产品能力里移除，原生协议的决定本身不变（离散档位表达、`thoughtSignature` 回放与工具循环的校验语义仍是理由）。

- **上游只给区间，不给逐档数值**：2.5 系在 models.dev 里是 `b:128-32768` / `toggle+b:0-24576` 这类区间，`128/2048/8192/32768` 的档位映射是本仓发明，不是平台事实。
- **事实层对这些模型不产写点**：`ai/thinking-profiles.ts` 只在「有上游 effort 词表」或「平台已登记开关形状」时物化写点；Gemini 未登记开关形状，2.5 系因此 A′ = ∅、面板只显示 `Default`。写法层若按模型名另造预算，就会出现「面板说 Default、线上发预算」的两说，且 `off` 会发出区间之外的 0。
- **落线口径**：`ai/thinking-wire-map.ts` 的 gemini 行只把事实层给的离散词汇落成 `generationConfig.thinkingConfig.thinkingLevel`；偏好 `off` 时发词汇落到的档 + `includeThoughts:false`。无可表达写点的模型（2.5 系、上游 toggle 值集、目录外）一个思考字段都不发，落线 = 平台默认，与 [ADR-0015](0015-thinking-default-tier.md) 的 `default`（不干预）同义。
- **判据**：`tests/ai/adapter-gemini.test.ts` 与 `tests/ai/plan-thinking.test.ts` 逐族钉住「不发字段」；按类 golden 把 gemini 纳入同一张表。
