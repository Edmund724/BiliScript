# ADR-0031：扩展源 IndexedDB v2 统一存储与 Offscreen 二进制隔离边界

> 状态：有效

在字幕缓存、AI 分片产物与对话图片的大体积持久化，以及音频流解码、ASR 转写和跨源 HTTP 代理承载架构上，我们决定：**扩展内部大体积数据统一沉淀在 SW 侧扩展源 IndexedDB v2（页面通过 RPC 穿透访问）**，并严格将 **二进制音频字节、密钥使用与大流式解码隔离在 `reason: ["BLOBS"]` 承载的单一序列化 Offscreen 宿主中**。

## 背景与动机

1. **网页源 IndexedDB 隔离与 `chrome.storage` 膨胀**：B 站不同子域或页面脚本可直接触及网页源 IDB，且网页源存储易被宿主策略或清站点缓存波及；同时，数 MB 的对话图片与长视频 L1/段缓存直接写入 `chrome.storage.local` 会拖慢通用配置读取与配额预算。
2. **Offscreen 原因限制与并发竞态**：实测发现 Chromium 运行时拒绝非法的 `"WEBSOCKET"` 创建原因，而 `"AUDIO_PLAYBACK"` 在无音频播放 30 秒后会被浏览器强杀（中断长 ASR 或实时会话）；且 `createDocument` / `closeDocument` 或 Firefox 隐藏 `iframe`（ADR-0028）在并发请求下极易死锁。
3. **消息通道二进制损坏与全轨解码 OOM**：`chrome.runtime` 端口底层走 JSON 结构化克隆（或特殊路径会破坏 `Uint8Array`/`ArrayBuffer`）；而对数小时视频整轨调用 `decodeAudioData` 会导致 Offscreen 进程内存暴涨（48kHz 立体声可达数 GB）或触发 Chrome 长 ADTS 流的解码上限失败。

## 已定决策

### 1. 扩展源 IndexedDB v2 与写前删懒迁移

- `subtitle/idb-store.ts` 在扩展源下维护经单一操作队列串行化的 3-store IDB v2 结构，并在页面上下文误触时安全降级至内存后端。
- Content Script 侧通过 `subtitle/store-client.ts` 将字幕与 AI 产物读写统一经 SW RPC 转发至扩展源 IDB（避免多来源分桶孤岛）；SW 自身调用则通过 `directStore: true` 直访本地 IDB（消除自我 `sendMessage`）。
- 历史 `chrome.storage.local` 键与对话内嵌大图（`chat/conversation-storage.ts`、`subtitle/storage-migration.ts`、`subtitle/ai-artifact-cache.ts`）均遵循 **「先成功写入 IDB 并校验 `ok: true`，再删除旧键或回滚引用」** 的懒迁移/外部化顺序，防止网络或 RPC 瞬断导致数据丢失或悬空引用。

### 2. Offscreen 宿主生命周期与 `OFFSCREEN_CREATE_REASONS` 边界

- 补充/细化 ADR-0023：`shared/offscreen-constants.ts` 将 `OFFSCREEN_CREATE_REASONS` 统一锁定为 `["BLOBS"]`，避免 `"WEBSOCKET"` 运行时异常与 `"AUDIO_PLAYBACK"` 30 秒闲置强杀。
- `core/offscreen-host.ts` 通过带代际计数器与在途 iframe 取消机制的串行队列调度创建/关闭；`entry/offscreen-lifecycle.ts` 按负载分级回收（轻载 HTTP/Chat 通道保活与重载 `OfflineAudioContext`/视频捕获快速释放），并在 `onConnect` 同步登记活跃端口防止并发建链期间误关闭。
- Firefox 下提取 `runtime.getURL("")` 的扩展 UUID 作为 DNR `initiatorDomains`（规避含 `@` 的 `gecko.id` 被拒），异常时降级 `tabIds: [-1]`；同时使用 Session DNR 规则 9003 覆写 `index-translate.bilibili.com` 所需 WAF 请求头。

### 3. ASR 音频流、API 密钥 Offscreen 内闭环与 `DONE` / `ERROR` 双通道协议

- 音频流下载（累计 200MB 封顶防御缺/伪 `Content-Length`）、fMP4 到 ADTS 每 10 个 `moof/mdat` 分段（~50s / ~1MB）流式提取（`asr/adts.ts`，含 `stsd +16` / `mp4a +36` 精确 box 偏移）、`OfflineAudioContext` 解码、基于静音谷的 60 秒软切片（`asr/chunker.ts`）、以及最多 `ASR_CONCURRENCY = 10` 路（实测高于 12 路易触发服务端排队降速）的转写请求均完全留在 Offscreen 内部，绝不把原始音频二进制或 API Key 传回 Content Script。
- `entry/offscreen-asr.ts` 与 `asr/protocol.ts` 区分 **`ASR_MSG_DONE`（携带结构化局部失败/截断摘要）** 与 **`ASR_MSG_ERROR`（管线级致命中断）**，并在 Offscreen 截断详情至 200 字符之前基于完整响应体完成错误分类（`asr/failure-kind.ts`）。

## 考虑过的备选

- **直接在页面上下文开网页源 IndexedDB 或在 Content Script 请求 ASR/模型列表**：前者会按网页来源隔离且无法在 SW / Agent Bridge 间共享；后者会受网页 CORS 拦截且在权限校验上存在 fail-open 漏洞，予以否决。
- **整轨下载后一次性 `decodeAudioData`**：长视频必然导致 Offscreen OOM 崩溃，予以否决。

## 后果

- 扩展新增需要大体积二进制、Web Audio 或绕过网页 CORS 的能力时，必须经 Offscreen 或 SW 代理执行，并纳入 `offscreen-lifecycle.ts` 端口登记表。
- `subtitle/store-client.ts` 中仍有个别缓存适配器在 RPC 失败时静默回落内存后端而未对齐 `sendSubtitleStoreRpcDetailed`，已记入技术债追踪。
