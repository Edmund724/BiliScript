# ADR-0018：扩展三层存储架构：`sync` 配置、`local` 密钥与 SW 快照、扩展源 IndexedDB v2

> 状态：有效

扩展的持久化数据按跨端同步配额、明文密钥安全边界与数据体量划分为三层，配合后台只读设置快照双通道失效保障高并发读写一致性（具体 IndexedDB 表结构与淘汰阈值见 [`docs/state-contract.md`](../state-contract.md)）。

## 已定决策

### 1. `chrome.storage.sync` 配置与 `local` 明文密钥隔离 + 官方凭据单源引用

- **配置与密钥物理分域**：`extension/core/provider-store.ts` 将轻量服务商元数据（名称、端点、模型列表）与通用偏好存入 `chrome.storage.sync`；明文 `apiKey`（列表读出仅暴露脱敏布尔值 `hasSavedKey`）以及按视频增长的高亮（`notes/highlights-store.ts`）和本地激活标签位置（`reader/script-tab-persistence.ts`）严格隔离在 `chrome.storage.local`，既防止明文密钥跨设备云同步扩散，也避免撑爆 `sync` 单键 `8192` UTF-8 字节配额。
- **跨族官方凭据单向引用**（`extension/core/ai-credential-reference.ts`）：联网搜索 DeepSeek 与实时伴看 Gemini Live 不设独立 Key 存储，发请求时单向实时读取 AI 族中第一条启用且通过严格官方 HTTPS 域名校验（强制 `https:`、默认端口 443、主机名全等匹配）的记录密钥，消除多处改 Key 的双写腐化，并防止将官方 Key 误发往不支持对应专有接口的第三方反代。

### 2. 后台只读设置快照与强制双通道失效（`extension/core/settings-snapshot.ts`）

- 四个高频读入口（解析 AI 平台、解析搜索链、读取 ASR 配置、读取设置）统一消费后台内存归一化快照（热路径零 `storage` I/O），**不提供 write-through 写缓存入口**（避免并发 read-modify-write 交错覆盖丢键）。
- 因 WebExtension `chrome.storage.onChanged` **不会向发起写入的同一上下文回发事件**，所有修改 `SNAPSHOT_STORAGE_KEYS` 受辖键的后台写路径必须经 `invalidatingWrite` / `writeSnapshotKeys` 在落盘完成后**同步执行本进程内联失效**（保证同进程写后即读立即可见），同时订阅 `onChanged` 兜底跨上下文与跨设备同步变更；AI 族失效时单向级联清除 Search 族快照以对齐凭据引用。

### 3. 后台扩展源 IndexedDB v2 单点托管与写后删迁移（`extension/subtitle/idb-store.ts`）

- 大体积字幕轨（`subtitle_pages`）、长视频 L1 目录与分段产物（`ai_artifacts`，见 [ADR-0012](0012-long-video-state-relay-and-hybrid-retrieval.md)）及外部化对话附图（`chat_images`）统一存储在后台持有的**扩展源 IndexedDB v2** 中，Content Script（`subtitle/store-client.ts`）与 Offscreen（`ai/segment-cache-proxy.ts`）一律经消息 RPC 访问，后台内部直调（`directStore: true`）。
- 历史 `chrome.storage.local` 缓存键与历史会话内联 base64 图片均执行**「先写入 IDB 并确认 `ok: true`，再删除旧键或替换为 `{ mime, idbRef }` 引用」**的幂等迁移顺序；IDB 写入失败则保留内联/旧键或回滚新写记录，绝不产生悬空引用或静默丢数据。

## 考虑过的方案

- **将大体积缓存写入网页源 IndexedDB 或留在 `chrome.storage.local`**：网页源 IDB 按 B 站子域（`www` / `bangumi` 等）分桶隔离、跨上下文不可达且易被清理站点数据波及；`storage.local` 混存数 MB 图片与字幕会拖慢全量键值反序列化。
- **后台设置快照仅依赖 `storage.onChanged` 失效或做 write-through**：前者在后台连续写后读时必命中陈旧快照，后者在并发更新时存在覆盖竞态。
