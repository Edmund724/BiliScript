# 字幕与缓存域词表（Subtitle & IDB v4）

返回根索引：[GLOSSARY.md](../../GLOSSARY.md) · 相关架构裁决：[ADR-0010](../adr/0010-bilingual-secondary-subtitle-and-translation.md)、[ADR-0011](../adr/0011-subtitle-prefetch-and-asr-isolation.md)、[ADR-0018](../adr/0018-layered-storage-and-extension-idb.md)、[ADR-0021](../adr/0021-multi-site-and-youtube-core.md)、[ADR-0022](../adr/0022-youtube-sabr-asr-pipeline.md)。

## 字幕轨道与双语

### 字幕与双语副轨

视频的一条时间轴字幕轨由归一化条目 `{from, to, content}` 构成；无原生字幕轨时在支持站点可经语音识别（ASR）生成。同一个视频可同时展示主轨与副轨（双语），两行同属一条字幕条目，上下行顺序由 `bilingualDisplayOrder`（`original-first` / `translation-first`）统一驱动文摘面板、播放器叠层与 TXT/Markdown/SRT 导出。

轨道按来源性质分为原生人工轨（`manual-cc`）、**平台自动字幕**（B 站 `bili-ai` 标 `（B 站 AI）`，YouTube `youtube-auto` 标 `（YouTube 自动）`，紧凑 trigger 保持裸语言名）与本扩展转写伪轨（`asr`）。语种族经 `getLangFamily` 归一（如繁简及 `ai-zh`/`asr-zh` 同属 `"zh"` 族）：跨语种原生多轨默认零 Token 配对两条原生真轨，并支持手动切换 AI 精翻；单语种视频与 ASR 伪轨开启双语时进入 AI 译文副轨模式，`resolveTargetLang` 自动过滤同语种族目标语言。B 站轨道身份取接口 `id_str` 避免 `> 2^53` 精度丢失。

- 代码锚点：`extension/subtitle/fetcher.ts`、`extension/subtitle/body.ts`、`extension/subtitle/signature.ts`、`extension/subtitle/translated-track-session.ts`、`extension/subtitle/asr-translation.ts`、`extension/reader/secondary-subtitle.ts`
- _Avoid_: 转录、transcript、把同语种族繁简轨配成假双语、把副轨与主轨混入同一份正文或装载态

### 平台自动字幕

视频站点自身生成的机器字幕轨（B 站 `ai-*` 与 YouTube `kind: "asr"`），与本扩展自配平台转写伪轨（`asr`）严格隔离：不得写入 `id_asr:` 缓存命名空间或触发扩展 ASR 孤儿清理；无标点断句与双语 AI 精翻统一走无标点断句与 `boundary-v3` 协议（`extension/subtitle/segmentation.ts`、`extension/subtitle/boundary-protocol.ts`）。

- _Avoid_: 把 YouTube `kind: "asr"` 归入扩展 `asr` 伪轨、在 YouTube 标注 `（B 站 AI）`

### 字幕接受事务

一段字幕成为当前视频生效字幕的唯一事务：稳定排序（`from` 升序）→ 写状态 → `fetchState = "ready"` → 清理无字幕原因 → 触发热评与 `subtitle-ready` 通知（派生 Markdown/SRT/TXT 惰性构建，切视频时由 `invalidateDerived()` 清空缓存）。事务带可选 `runId` 代次自检：URL 变化编排在 `reset` 之前同步递增 `fetchRunId`，旧抓取落盘前比对失败即抛 `STALE_RUN` 让位。

双语副轨使用并列接受事务 `acceptSecondarySubtitle` 与独立通知 `secondary-subtitle-ready`，不污染主轨选择态、无字幕状态或热评。

- 代码锚点：`extension/subtitle/commit.ts`、`extension/subtitle/core.ts`、`extension/subtitle/fetcher.ts`
- _Avoid_: 手抄字幕落账序列、把主副两条接受事务合并、在 `reset` 内部迟到递增 `fetchRunId`

### 字幕轨身份

一条字幕轨在缓存键里的身份，封闭判别联合六态：`track`（B 站轨 ID）、`url`（轨地址）、`lang`（槽语言）、`asr`（`id_asr:<p>:<m>:<l>`）、`translated`（`id_translate-<lang>`）、`track-translated`（`<sourceKey>_translate-<lang>`）。优先级 `id > url > lang` 与变体前缀判据（`isAsrVariantSourceKey` / `isTranslatedVariantSourceKey`）单源收口。

- 代码锚点：`extension/subtitle/source-key.ts`、`extension/subtitle/cache.ts`、`extension/bilibili/native-payload.ts`
- _Avoid_: 在调用点手拼 `id_asr:` 前缀或复制第二份 URL 归一逻辑

### 字幕预抓取

进入视频页或 SPA 换片即起跑的原生字幕抓取，不等用户打开文摘面板或点击 AI 键，复用「字幕接受」同一事务链。仅在确认视频真无原生字幕（且非页面提取失败）、`asrAutoFallback === true` 且已配置 ASR 时自动回退转写；已有原生或平台自动字幕时不静默触发付费 ASR。共享守卫 `isSubtitleInHandOrInFlight` 防止重复起跑，失败留下的 `error` 态由发送闸重试一次。

- 代码锚点：`extension/entry/message-handler.ts`、`extension/subtitle/subtitle-in-hand.ts`、`extension/subtitle/kick-subtitle-fetch.ts`
- _Avoid_: 预热（已被快捷提问占用）、给预抓取单开开关

## ASR 音频分片与失败摘要

### 音频分片与片级失败摘要

长音频按固定时长切出的上传单元（默认 60 秒/片，16 kHz WAV；YouTube SABR 音轨经离屏分段推流解码），与 AI 总结的「分段小结」互不相干。片级失败摘要包含 `kind / status / detail`（wire 形态为 `failedKind / failedStatus / failedDetail`），`kind` 是唯一存在判据；面向用户的病因与补救文案由单源模块组装。

- 代码锚点：`extension/asr/chunker.ts`、`extension/asr/stream-chunker.ts`、`extension/asr/failure-kind.ts`、`extension/asr/pipeline.ts`、`extension/asr/fallback.ts`、`extension/core/asr-failure-notice.ts`、`extension/youtube/sabr-session.ts`
- _Avoid_: 与「分段小结」混称、把片级失败与管线整体失败混为一谈

## 扩展源 IndexedDB v4 与缓存宿主

### IDB v4 字幕与产物存储契约

后台单点持有的扩展源 IndexedDB（`biliscript-subtitle-store`，`SUBTITLE_IDB_VERSION = 4`）统一托管大体积字幕轨与派生 AI 产物（Content Script 经 `extension/subtitle/store-client.ts`、Offscreen 经 `extension/ai/segment-cache-proxy.ts` 通过消息 RPC 访问，SW 内部直调）：

- **`subtitle_pages`**：按 `id`（编码视频页键）存储轻量页头元数据、`trackIndex`、`estimatedBytes` 与 `lastUsed`（索引 `by_lastUsed`、`by_bvid`），不再把全量轨道正文塞在单行记录内。
- **`subtitle_tracks`**：独立分表按 `trackId` 存储 `raw` / `segmented` / `translated` 三层轨道正文，通过 `by_pageId` 索引按需读取或随页级联删除。
- **`ai_artifacts`**：托管长视频 L1 目录（`biliscript_lvs_l1_index_`）、概览终稿（`biliscript_lvs_analysis_final_`）、概览中间态（`biliscript_lvs_analysis_`）与分段小结（`biliscript_lvs_summary_`），索引 `by_family_bvid`、`by_bvid`、`by_lastUsedAt`。
- **`store_meta`**：记录 `video_cache_ledger` 增量字节账本及幂等迁移完成标记（`biliscript_idb_v2_migration_done`、`conversations_v1_migrated`、`note_highlights_migrated_v1`）。
- **零全表扫描淘汰与配额同步**：淘汰依赖 `store_meta` 增量账本与 `by_lastUsed` 游标逐条回收，拒绝 `store.getAll()`；用户设置 `videoCacheMaxMb`（`50 | 150 | 300 | 500 | 1024`）在 SW 冷启动及写前同步至存储实例。
- **用户资产隔离**：`conversation_meta`、`conversation_messages`、`chat_images`（原生 `Blob`）与 `note_highlights` 独立存储，不参与视频缓存字节 LRU 淘汰。

- 代码锚点：`extension/subtitle/idb-store.ts`、`extension/subtitle/subtitle-cache-handler.ts`、`extension/subtitle/store-client.ts`、`extension/subtitle/storage-migration.ts`、`extension/core/cache-lru.ts`、`extension/shared/site.ts`、`extension/bilibili/video-id-shared.ts`
- _Avoid_: 在网页源 IDB 写缓存、在 Offscreen 侧引入 `chrome.storage` 垫片、用 `getAll()` 扫全表算容量
