# ADR-0018：引入第三种线格式协议（Gemini 原生 generateContent）

> 状态：有效

## 背景

在 multi-protocol-ai 域建立时，`CONTEXT.md` 曾把「第四种协议（Gemini 等）的实现」列为非目标（`_Avoid_`），当时的权衡是协议面维护成本随协议数线性增长、且 Gemini 有 OpenAI 兼容端点可零成本接入。

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
- **文档与纪律同步**：`CONTEXT.md` 平台协议词条中的 `_Avoid_` 句予以改写，凭据指向本 ADR。
- **目录对账范围扩大**：`models.dev` 目录对账迎来第 13 家（`google`），产物与计数断言需同步更新。
