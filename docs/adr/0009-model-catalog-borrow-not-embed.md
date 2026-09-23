# 模型目录只借 pi-ai 的数据与设计，不内置它的运行时

设置页平台编辑 Modal 要展示模型元数据（上下文窗口 / 是否支持思考 / 是否收图）。上游 `@earendil-works/pi-ai`（MIT）已经为 1354 个模型登记过这些字段，但**我们决定不把 pi-ai 引入运行时**：它只作**数据来源与设计参照**——`devDependency` 精确 pin，构建期脚本从它的 `providers/data/*.json` 裁剪出 11 个文件 / 475 个模型的零依赖叶子产物（`extension/ai/catalog/pi-ai-catalog.generated.ts`），提交进仓库；UI 只在打开平台编辑 Modal 时动态 `import()` 这份产物。

**不变式（硬）：pi-ai 永不进入请求执行路径。** 目录数据只进 UI 渲染层——不落盘、不进 `AiProvider` 存储、不参与请求构造；它不在 `provider-http.ts` → `completion.ts` → `adapters/*` 这条链的任何位置。逐条不变式与判据锚点见 [CONTEXT.md「模型目录（model-catalog）」](../../CONTEXT.md#模型目录model-catalog)。

动机不是"修 bug"。不容易出 bug 来自既有的 `ProtocolAdapter` 缝与 `thinking-profiles.ts` 的单源约束，不来自引入 pi-ai；引入外部数据的收益是**目录能力**，代价是新的不确定性来源，所以必须把它的作用域压到最小。

## 反例证据（2026-09-23 实测）

**体积**（esbuild `--platform=browser`）：

| 打包入口 | raw | minified | gzip |
|---|---|---|---|
| `pi-ai/api/openai-completions`（含 openai SDK） | 436KB | 175KB | 45KB |
| `openai` SDK 单独 | 340KB | 131KB | 32KB |
| `pi-ai` 主入口（只要 `createModels`） | 29KB | 14KB | 4KB |

体积不是主要理由——目录产物本身也有 78KB。**语义叠加**才是：

- **第二套重试**：pi-ai 自设 `maxRetries: 0` 后自己套 `retryProviderRequest`，与本仓库 `completion.ts` 的流式重试 2 次叠加。
- **第二套超时**：openai SDK 未传 `timeoutMs` 时默认 10 分钟，与本仓库 `withTimeout` 叠加。
- **第二套 SSE 解析**：与 `adapters/openai.ts` 的 `drainSseStream` 叠加。
- **一批我们没审核过的默认字段与请求头**：`stream_options.include_usage`、`store`、`prompt_cache_key`、`prompt_cache_retention`、`chat_template_kwargs`、`x-session-affinity` 等。

打包可行性实测**通过**（无 polyfill、无 top-level await；唯一打不进去的是 `api/bedrock-converse-stream`，有 `.lazy` 变体可绕）——**可行性不是不用的理由。**

## 结论

**语义叠加与单一事实源才是理由**：目录任务只取数据，上述成本一个都不发生。因此边界划死：

- **借**：目录 schema 的字段划分（`contextWindow` / `maxTokens` / `reasoning` / `input` / `cost` / `compat`）；`compat` 开关词表（`thinkingFormat`、`maxTokensField`、`requiresReasoningContentOnAssistantMessages` 等平台怪癖的命名与语义，这是当前最缺的东西——非思考类的平台怪癖现在散在三个 adapter 的注释里，没有统一词表）；`dsh-llm-pi-ai` 的二次校验层思路（profile 声明的 compat 字段必须被该协议接纳，否则报错）。
- **不借**：`dsh-llm-pi-ai` 的外来 assistant 消息降级 / replay 机制（那是"跨 provider 迁移多轮历史"的问题，本扩展场景不同，见 `conversation.ts`）；以及任何**运行时数据**——包括**不拿 pi-ai 的 `thinkingLevelMap` / `compat` 去补 `thinking-profiles.ts` 的空白**（那是同一模型两个事实源，正是要避免的 bug 类型）。

## 考虑过的方案

- **内置 pi-ai 运行时，直接调它的模型目录与 client**（已否决）：体积可接受，但带来第二套重试/超时/SSE 解析与未审核的默认请求字段——请求塑形事实出现第二个主人，与 `protocol-vocab-leaf` 之后"协议栈单源"的收口方向相反。
- **构建期裁剪数据 + 零依赖叶子产物（选定）**：只需要 JSON；数据提交进仓库，构建只做打包；产物零 `import`，保证它永远进不了 SW 静态图（SW 平台层面不支持动态 `import()`，见 ADR-0003）。
- **运行时 `fetch` 上游目录 / OpenRouter `/api/v1/models`**：要碰 `web_accessible_resources`、失败降级与 SW 中转（或引入第一条跨域运行时数据依赖），而元数据是"搭建时看的"、变化极慢，静态 vendor 足够。

## 后果

- 上游升级 = 改 `package.json` 的 pin + 重跑 `pnpm catalog:sync` + 提交产物 diff；产物幂等（重跑 `git diff` 为空）。
- 目录**对协议无感**：查表键是 `(piProvider, modelId)`，`protocol` 完全不参与——provider 记录里的协议是可能配错的（历史案例：`moonshot` preset 默认 openai，端点证据指向 anthropic），让协议参与查表等于把配置错误传染进展示层。
- 无数据平台（`qwen` / `stepfun` / `modelscope` / `amd` / `sensenova` / `ollama` / `custom`）永远查不到元数据，UI 整栏静默隐藏，不显示占位。
- 架构评审（含 AI 代理）不得再提议把 pi-ai 接进请求链，也不得用目录数据回填 `thinking-profiles.ts`；重开条件：目录需要参与请求塑形（那要先论证它如何成为该事实的唯一主人）。
