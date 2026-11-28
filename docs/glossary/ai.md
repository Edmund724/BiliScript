# AI 总结、检索、协议与对话域词表（AI & Chat）

返回根索引：[GLOSSARY.md](../../GLOSSARY.md) · 相关架构裁决：[ADR-0005](../adr/0005-provider-http-dual-relay.md)、[ADR-0006](../adr/0006-output-budget-wide-default-retreat-learned-cap.md)、[ADR-0007](../adr/0007-upstream-model-facts-snapshot.md)、[ADR-0008](../adr/0008-thinking-tiers-and-wire-maps.md)、[ADR-0009](../adr/0009-gemini-native-protocol.md)、[ADR-0012](../adr/0012-long-video-state-relay-and-hybrid-retrieval.md)、[ADR-0013](../adr/0013-chat-turn-dag-and-dual-context.md)、[ADR-0014](../adr/0014-web-search-privacy-gate-and-cooldown.md)、[ADR-0018](../adr/0018-layered-storage-and-extension-idb.md)。

## 总结阶梯、概览与长视频上下文

### 阶梯与素材预算

单次请求允许喂给模型的原视频字幕量上限为 `MATERIAL_BUDGET_CHARS = 200,000`（按 256k 窗口定档）。素材在预算内一次成稿；超出预算时，概览走滑动状态接力（`StateRelayCard`），对话走单跳混合召回，Map-Reduce 仅作冷兜底与单发溢出回落。触发上下文超长错误时执行三级回落：单发转分段 → 预算按 `0.5` 倍收紧整轮重跑（缓存键带 `_b50` 隔离）→ 提示换更大窗口模型。

- 代码锚点：`extension/ai/ladder.ts`、`extension/ai/budgeter.ts`、`extension/ai/reduce.ts`、`extension/ai/map-reduce.ts`、`extension/ai/state-relay.ts`、`extension/ai/cost-guard.ts`
- _Avoid_: 降级（阶梯不是报错降级）、窗口/配额（与模型窗口混淆）

### 概览、分章计划、成稿笔记与压缩摘要

- **概览**：全片简介 + 章节列表 + 金句；分章来源优先级为「简介/热评时间戳目录 > 站点官方章节 > AI 自由分章」，由 **分章计划**（`resolveChapterPlan`）一次性推导提示词、给定章节与末章界 `graft` 闭包。
- **成稿笔记**：AI 总结阶梯产出的完整 Markdown 中间产物（非用户笔记库）；`extension/notes/` 负责字幕与模板化 Markdown / Obsidian 导出（支持 `{{videoId}}` / `{{site}}` 与兼容别名 `{{bvid}}`）。
- **分段小结**与**压缩摘要**：超预算分段压缩的中间结果，经 SW 托管的 `ai_artifacts` 缓存（Offscreen 通过 `segment-cache` 消息代理读写，run-scoped 写会话 `createSegmentCacheWriteSession` 聚合落盘），作为长视频追问的常驻有界上下文。

- 代码锚点：`extension/ai/analysis.ts`、`extension/ai/analysis-orchestrate.ts`、`extension/ai/chapter-plan.ts`、`extension/ai/followup-context.ts`、`extension/ai/segment-cache.ts`、`extension/ai/segment-cache-proxy.ts`、`extension/ai/segment-cache-handler.ts`、`extension/ai/segment-cache-key-fields.ts`、`extension/shared/chapter-outline.ts`、`extension/notes/render.ts`、`extension/notes/export-actions.ts`
- _Avoid_: 总览、小总结、在编排层二次判断 `chapterSource.kind`

## AI v4 缓存与单跳检索架构

### KV 前缀缓存锁

多轮对话中锁定顶层 `system` 与静态工具定义以最大化跨轮 Prompt Cache 命中率：

- **静态顶层前缀**：`extension/ai/context.ts` 仅将固定系统提示词、视频元数据及静态章节目录（`staticDirectoryMarkdown` / `compressedSummaryMarkdown` / 短片全量字幕）置于顶层 `system`；每轮动态召回的字幕窗口与关键帧提示经 `formatDynamicTurnUserContent` 包裹为 `<retrieved_subtitles>` / `<video_frame_context>` 附于当轮 `user` 消息，不改写前缀。
- **静态工具表与软拦截**：`extension/ai/tool-loop.ts` 在整个工具循环中保持 `tools` 定义静态稳定；达到 `webSearchMaxToolCalls` 或重复工具调用上限时通过 `role: "tool"` 软拦截返回提示文案，严禁在循环中途追加 `role: "system"` 消息击穿缓存。
- **Anthropic 缓存断点**：`extension/ai/adapters/anthropic.ts` 通过 `attachRollingCacheBreakpoint` 为静态系统块、工具定义及倒数第二条历史消息挂载 `cache_control: { type: "ephemeral" }` 滚动断点。

### 意图分流与 25s Contextual BM25 + RRF 单跳混合召回

长视频或超预算对话严格遵守单跳（Single-Hop）上限，不引入本地或远程向量引擎（[ADR-0012](../adr/0012-long-video-state-relay-and-hybrid-retrieval.md)）：

- **意图分流与模式锁**：`isMacroSummaryTurn` 区分宏观全片总结与局部细节问答，结合 `transcriptMode`（`"full" | "hybrid"`）在会话级别锁定上下文模式，防止中途切换击穿前缀缓存。
- **交互锚点直通**：划词解释（`explain-selection`）、显式时间戳或当前播放进度（`playbackCursorSeconds`）指代提问直接跳过路由模型，零额外首字延迟抽取局部窗口。
- **25s Contextual BM25**：`extension/ai/l0-bm25.ts` 将字幕按 25 秒目标窗长、5 秒重叠（`DEFAULT_SEMANTIC_CHUNK_TARGET_SECONDS = 25`、`DEFAULT_SEMANTIC_CHUNK_OVERLAP_SECONDS = 5`、`DEFAULT_SEMANTIC_CHUNK_MAX_CHARS = 600`）切分为带上下文标题前缀的语义块，采用 `Intl.Segmenter` 词级（权重 `1.0`）+ 中文字符二元组（权重 `0.45`）双通道 BM25 打分，并在 Offscreen 内存维持 `MAX_CACHED_BM25_VIDEOS = 3` 槽缓存（随字幕槽淘汰联动清理）。
- **RRF 融合与单跳路由**：`extension/ai/chat-hybrid-retrieval.ts` 并发执行本地 BM25 与极简 L1 路由（`thinkingLevel: "off"`，高置信 BM25 命中时可免路由直出），通过倒数排名融合（`RRF_K = 60`，`RRF_WEIGHT_L1 = 1.0`、`RRF_WEIGHT_BM25 = 1.1`）合并窗口并截断于 `STAGE_B_TOTAL_SUBTITLE_MAX_CHARS = 80,000`。

- 代码锚点：`extension/ai/chat-hybrid-retrieval.ts`、`extension/ai/l0-bm25.ts`、`extension/ai/l1-directory.ts`、`extension/ai/long-video-hybrid-types.ts`、`extension/ai/ladder.ts`、`extension/entry/offscreen-subtitle-slot.ts`
- _Avoid_: 多轮 Agent 自主检索循环、引入本地或远程 Float32 向量块 / Embedding 引擎、第三方中文分词词典

### 滚动摘要锚点与工具结果折叠

超长多轮会话通过持久化于 `conversation_meta` / `conversation_messages` 的 `summaryAnchor`（`ConversationSummaryAnchor`）记录已压缩历史边界，并在装配后续上下文时将过期轮次中的大体积工具返回折叠为精简占位，在控制上下文窗口的同时保留前缀稳定性。

- 代码锚点：`extension/ai/context.ts`、`extension/ai/ladder.ts`、`extension/ai/conversation.ts`、`extension/chat/conversation-types.ts`、`extension/subtitle/idb-store.ts`

## 平台、协议、思考档位与存储边界

### 激活平台、平台协议与协议适配器

- **激活平台**：概览、选区解释与对话共用单趟 `resolve-ai-provider` 消息解析「当前平台 + API Key」（`extension/ai/active-provider.ts`）。
- **平台协议**：封闭词表 `AiProtocol`（`"openai" | "anthropic" | "gemini"`，定义于零依赖叶 `extension/ai/protocol-vocab.ts`），由唯一注册表 `PROTOCOL_ADAPTERS`（`extension/ai/protocol-adapter.ts`）分派至对应适配器（`extension/ai/adapters/openai.ts`、`extension/ai/adapters/anthropic.ts`、`extension/ai/adapters/gemini.ts`），包含流式解析、tool use 双向翻译与 `listModels`。
- **三层思考事实与平台怪癖**：
  1. 名词层：`extension/ai/compat-vocab.ts`（`COMPAT_QUIRKS` / `PLATFORM_QUIRKS`）与平台身份解析 `extension/ai/platform-identity.ts`、`extension/ai/platform-identity-vocab.ts`、`extension/ai/platform-quirk-id.ts`。
  2. 档位事实层：构建期零依赖快照 `extension/ai/catalog/models-dev-thinking.generated.ts` + 规则解析 `extension/ai/thinking-profiles.ts`（产出封闭中转词汇 `ThinkingVocabulary`）。
  3. 线格式写法与装配边：`extension/ai/thinking-wire-map.ts`（`THINKING_WIRE_MAPS` 与 Messages 三张全覆盖出口表，硬禁止自造 `budget_tokens`）与唯一装配入口 `extension/ai/plan-thinking.ts`（被 `extension/ai/completion.ts` 消费）。
- **只读模型目录与预设覆盖视图**：构建期快照 `extension/ai/catalog/models-dev-catalog.generated.ts` 经 `extension/ai/model-catalog.ts` 与 `extension/ui/lazy-model-catalog.ts` 懒加载，仅用于设置 UI 展示（`extension/ui/provider-editor-model-rows.ts`），永不进请求链或 SW 静态图；`extension/ai/preset-registration-view.ts` 提供新平台 6 面登记覆盖只读视图。

- _Avoid_: 在 adapter 内回抄线格式映射、在 Messages 通道发 `budget_tokens`、让 `protocol` 参与目录查表、将目录产物拖入 SW 静态图

### Provider 模型目录双层存储与 `sync` 配额护栏

为防 `chrome.storage.sync` 单键 `8,192 B` 溢出，`extension/core/ai-provider-store.ts` 将 AI 平台模型目录物理拆为两层：

- **`sync` 轻量摘要**：每个平台在 `aiProviders` 中最多保留 `AI_PROVIDER_SYNC_MAX_MODELS_PER_PROVIDER = 5` 个常用模型，且整体序列化字节受 `AI_PROVIDERS_SYNC_SOFT_BYTE_LIMIT = 6000` 软上限动态裁剪（保留每平台至少 1 个主模型以保障跨设备回退可用）。
- **`local` 完整目录**：全部用户勾选的模型清单持久化于 `chrome.storage.local["biliscript_ai_provider_models_v1"]`（`AI_PROVIDER_MODELS_LOCAL_KEY`），读出时优先合并本地完整清单，新设备回落 `sync` 摘要。
- **长文本 4,096 B UTF-8 截断护栏**：`extension/core/validators.ts` 与 `extension/core/settings-store.ts` 同步对 `aiSystemPrompt`、`noteCustomPrompt`、`subtitleTranslateGlossary` 与 `noteExportTemplate` 施加 `4,096 B` UTF-8 字节上限（`truncateUtf8ByBytes`）。

### 平台请求代发、联网搜索、设置快照与消息守卫

- **平台请求代发**：非流式短请求（15s 超时）走 SW 代发（`extension/core/provider-http.ts`），流式/长请求走 Offscreen 分块端口代发（`extension/core/provider-http-offscreen.ts`），共用零依赖叶 `extension/core/provider-http-shared.ts`。
- **联网搜索（零成本组 / 链首平台 / 付费平台 / 凭据引用）**：七家内置预设按 `keyless | free-quota | paid` 分类（`extension/core/presets.ts`、`extension/core/search-mode.ts`、`extension/search/search-provider-store.ts`、`extension/search/search-chain.ts`、`extension/search/search-executor.ts`、`extension/search/search-runtime.ts`）。单选模式无回退；智能模式按 `searchProviderOrder` 回退，付费平台 DeepSeek 仅在 `allowPaidSearchProviders` 开启时入链，并经 `extension/core/ai-credential-reference.ts` 单向校验官方 HTTPS 端点后借用 AI 族 Key。
- **设置快照与消息入口守卫**：`extension/core/settings-snapshot.ts` 为 SW 四个热路径提供无 write-through 只读快照，通过 `invalidatingWrite` / `writeSnapshotKeys` 内联失效 + `storage.onChanged` 双通道保鲜；`extension/core/message-router.ts` 与 `extension/shared/messaging-protocol.ts` 的 `BACKGROUND_MESSAGE_REGISTRY` 在派发前统一执行 `offscreen` 来源标签与最小 schema 校验。

## AI 对话存储与回合控制

### IDB v4 会话懒水合、SW 原子 RPC 与跨标签同步

- **无限制历史默认值**：`chatHistoryMaxCount = 0` 表示**无限制不裁剪**（仅 `> 0` 时按最近 N 条裁剪，定义于 `extension/core/defaults.ts`、`extension/core/validators.ts`）。
- **元/体分离与单会话懒水合**：IDB v4 将普通会话与 `"live-text-tool"` 伴看记录拆分为 `conversation_meta`（轻量列表头：`id`、`title`、`contextKey`、`updatedAt`、`messageCount`、`recordCount`、`hasImages`、`transcriptMode`，索引 `by_updatedAt` / `by_contextKey`）与 `conversation_messages`（正文消息体与 `summaryAnchor`）。内容页内存只持有头列表 `ConversationSummaryItem[]`，切换或打开详情时再按单会话 `id` 异步水合正文；会话附图以原生 `Blob` 存于 `chat_images`，仅在单会话 IPC 边界按 DataURL 互转，不在内容侧制造重复 `ObjectURL` 副本。
- **SW 单写者队列与 `O(1)` 增量同步**：`extension/subtitle/subtitle-cache-handler.ts` 与 `extension/subtitle/idb-store.ts` 在 SW 侧串行化原子写入/删除/裁剪 RPC；跨标签页不再读写整份历史数组，而是通过轻量信号键 `biliscript_ai_conversations_sync_v2`（`ConversationSyncSignal`）广播 `upsert / delete / clear` 实现 `O(1)` 增量同步。

- 代码锚点：`extension/chat/conversation-types.ts`、`extension/chat/conversation-storage.ts`、`extension/chat/conversation-store.ts`、`extension/chat/chat-state.ts`、`extension/chat/chat-image-viewer.ts`

### 图片输入、工具循环、拆除会话、上下文装载、发送闸与历史回放

- **图片输入**：剪贴板粘贴图片挂于 `ChatMessage.images`（WebP q0.9、长边 `<= 1568px`、单条 `<= 4` 张、单张 `<= 1MB`），仅由发送受理时的 `takeInputImages` 消费；上下文跟随带 `preserveInput` 不误清草稿（`extension/chat/image-compress.ts`、`extension/chat/chat-input-images.ts`、`extension/chat/image-support.ts`）。
- **工具循环**：`runToolLoop` 统一承载联网搜索、热评拉取与当前帧 / `targetTime` 历史三帧（前后各 2s，独立隐藏 `<video>` 45s 总超时，20s 空闲自动清理 `video = null`）（`extension/ai/tool-loop.ts`、`extension/chat/historical-video-frame.ts`、`extension/entry/offscreen-chat-port.ts`）。
- **拆除会话 / 上下文装载 / 发送闸 / 历史回放**：严格遵循 [ADR-0013](../adr/0013-chat-turn-dag-and-dual-context.md) 单向等待 DAG（`settled <- switch`、`replay <- sendGate`、`replay` 零等待）；`loadContextState` 在同一模块按固定优先级判定 `no-tab -> skip-unchanged -> error -> apply-pinned -> blocked-streaming -> apply-live`；`createSendGate` 收口发送前上下文就绪与取消；`createConversationReplay` 以世代号 + 50ms 帧预算分片回放。

- 代码锚点：`extension/chat/context-load.ts`、`extension/chat/send-gate.ts`、`extension/chat/replay.ts`、`extension/chat/chat-runtime.ts`、`extension/chat/protocol.ts`、`extension/core/context-assembly.ts`
- _Avoid_: 手抄拆除序列、让回放等待在途回合、把工具全文直接写入持久化历史
