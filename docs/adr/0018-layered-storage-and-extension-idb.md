# ADR-0018：扩展三层存储架构：`sync` 配额护栏、`local` 密钥与模型目录、扩展源 IndexedDB v4

> 状态：有效

扩展的持久化数据按跨端同步配额、明文密钥安全边界、用户资产保护级别与数据体量划分为三层，配合后台只读设置快照双通道失效与单写者原子 RPC 保障高并发读写一致性。

## 已定决策

### 1. `chrome.storage.sync` 配额护栏、`local` 明文密钥/模型目录分离与官方凭据单源引用

- **配置与密钥物理分域**：`extension/core/provider-store.ts` 将轻量服务商元数据与通用偏好存入 `chrome.storage.sync`；明文 `apiKey`（列表读出仅暴露脱敏布尔值 `hasSavedKey`）、独立窗口像素宽高记忆（`extension/core/detached-bounds-store.ts`）与本地激活标签位置（`extension/reader/script-tab-persistence.ts`）严格隔离在 `chrome.storage.local`，防止明文密钥跨设备云同步扩散。
- **AI 模型目录 `sync`/`local` 双层拆分（`extension/core/ai-provider-store.ts`）**：为守住 `chrome.storage.sync` 单键 `8,192 B` UTF-8 配额，`aiProviders` 落入 `sync` 时每平台最多保留 `5` 个常用模型（`AI_PROVIDER_SYNC_MAX_MODELS_PER_PROVIDER = 5`）且受 `6,000 B` 软字节上限动态裁剪（保留每平台至少 1 个主模型确保跨设备回退可用）；完整用户配置模型清单持久化于 `chrome.storage.local["biliscript_ai_provider_models_v1"]`，读取时优先合并本地完整清单，新设备无缝回落 `sync` 摘要。
- **长文本设置 `4,096 B` UTF-8 截断护栏**：`extension/core/validators.ts` 与 `extension/core/settings-store.ts` 同步对 `aiSystemPrompt`、`noteCustomPrompt`、`subtitleTranslateGlossary` 与 `noteExportTemplate` 执行 `4,096 B` UTF-8 字节截断，杜绝单键写爆 `sync` 配额。
- **跨族官方凭据单向引用**（`extension/core/ai-credential-reference.ts`）：联网搜索 DeepSeek 与实时伴看 Gemini Live 不设独立 Key 存储，发请求时单向实时读取 AI 族中第一条启用且通过严格官方 HTTPS 域名校验（强制 `https:`、默认端口 443、主机名全等匹配）的记录密钥，消除双写腐化并防止官方 Key 误发往第三方反代。

### 2. 后台只读设置快照与强制双通道失效（`extension/core/settings-snapshot.ts`）

- 四个高频读入口（解析 AI 平台、解析搜索链、读取 ASR 配置、读取设置）统一消费后台内存归一化快照（热路径零 `storage` I/O），**不提供 write-through 写缓存入口**（避免并发 read-modify-write 交错覆盖丢键）。
- 因 WebExtension `chrome.storage.onChanged` **不会向发起写入的同一上下文回发事件**，所有修改 `SNAPSHOT_STORAGE_KEYS` 受辖键的后台写路径必须经 `invalidatingWrite` / `writeSnapshotKeys` 在落盘完成后**同步执行本进程内联失效**（保证同进程写后即读立即可见），同时订阅 `onChanged` 兜底跨上下文与跨设备同步变更；AI 族失效时单向级联清除 Search 族快照以对齐凭据引用。

### 3. 后台扩展源 IndexedDB v4 全表契约、SW 单写者原子 RPC 与单会话懒水合（`extension/subtitle/idb-store.ts`）

大体积缓存与用户对话/高亮资产统一托管于后台持有的**扩展源 IndexedDB v4**（`biliscript-subtitle-store`，`SUBTITLE_IDB_VERSION = 4`，跨站存储键规则见 [ADR-0021](0021-multi-site-and-youtube-core.md)）；Content Script（`extension/subtitle/store-client.ts`）与 Offscreen（`extension/ai/segment-cache-proxy.ts`）一律经消息 RPC 访问，后台内部直调（`directStore: true`）：

- **可淘汰视频缓存表（受 `videoCacheMaxMb` 约束，游标增量淘汰零 `getAll()`）**：
  - `subtitle_pages`：轻量页头与 `trackIndex`、`estimatedBytes`、`lastUsed`（索引 `by_lastUsed`、`by_bvid`）；
  - `subtitle_tracks`：按 `trackId` 拆分存储 `raw` / `segmented` / `translated` 轨道正文，索引 `by_pageId`，避免单行大对象读写放大；
  - `ai_artifacts`：长视频 L1 目录与分段/概览缓存（索引 `by_family_bvid`、`by_bvid`、`by_lastUsedAt`，见 [ADR-0012](0012-long-video-state-relay-and-hybrid-retrieval.md)）；
  - `store_meta`：持久化 `video_cache_ledger` 增量字节账本与各类幂等迁移门控标记（`biliscript_idb_v2_migration_done`、`conversations_v1_migrated`、`note_highlights_migrated_v1`）。
- **用户资产表（严禁参与视频缓存字节 LRU 静默淘汰）**：
  - `conversation_meta`（轻量列表头，索引 `by_updatedAt`、`by_contextKey`）与 `conversation_messages`（单会话正文消息、`records` 与 `summaryAnchor`）：普通会话与 `"live-text-tool"` 伴看记录统一元/体分离落盘；`chatHistoryMaxCount = 0` 表示无限制不裁剪，仅 `> 0` 时按用户配置保留最近 N 条；
  - `chat_images`（索引 `by_conversationId`、`by_bvid`）：以**原生 `Blob`** 存储对话附图，仅在单会话 IPC 边界按 DataURL 互转（不制造内容侧重复 `ObjectURL` 副本），随会话删除或清理原子回收；
  - `note_highlights`（索引 `by_updatedAt`）：以 `videoKey` 独立托管字幕与概览划词高亮（每视频上限 200 条），与视频缓存淘汰完全隔离。
- **SW 单写者原子 RPC、单会话懒水合与 `O(1)` 跨标签同步**：`extension/subtitle/subtitle-cache-handler.ts` 与 `extension/subtitle/idb-store.ts` 在 SW 侧串行化会话原子写/删/裁剪与伴看记录合并；内容页列表仅持有轻量头数组 `ConversationSummaryItem[]`，切换会话或查看伴看详情时按 `id` 异步懒水合单条正文；跨标签页经 `chrome.storage.local["biliscript_ai_conversations_sync_v2"]` 广播轻量增量信号实现 `O(1)` 同步。
- **写后删幂等迁移**：历史 `chrome.storage.local` 缓存键、历史会话与内联图片以及 `biliscript_note_highlights_v1` 均严格遵循「先写入 IDB 并确认落盘成功，再置迁移完成标记或清理旧键」，IDB 失败时保留原数据绝不静默丢失。

## 考虑过的方案

- **将大体积缓存、对话全文或高亮留在 `chrome.storage.local` 或写入网页源 IndexedDB**：网页源 IDB 按站点分桶隔离且跨上下文不可达；`storage.local` 混存数 MB 图片、字幕与全量会话正文会拖慢全量反序列化并造成多标签页内存膨胀。
- **在 `sync` 中直接剔除全部 `models[]` 仅回退单字段**：`AiProvider` 仅持久化 `models[]`（无单数 `model` 落盘字段），全量剔除会导致跨设备同步后非默认平台全部失活，因此采用 `sync` 留 5 个常用模型摘要 + `local` 存全量目录的分层方案。
- **后台设置快照仅依赖 `storage.onChanged` 失效或做 write-through**：前者在后台连续写后读时必命中陈旧快照，后者在并发更新时存在覆盖竞态。
