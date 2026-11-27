# ADR-0010：双语副轨独立槽、并列接受事务与 AI 译文游标调度

> 状态：有效

同一视频的双语对照字幕（主轨原文 + 副轨伴侣真轨或 AI 译文）采用**独立状态槽 `clip.secondarySubtitle`、并列接受事务 `acceptSecondarySubtitle` 与独立通知 `secondary-subtitle-ready`**，在渲染、搜索与导出消费点按时间重叠纯函数投影会合，绝不与主轨状态或整片装载相位混写。

## 已定决策

### 1. 状态槽、接受事务与渲染通知隔离

- **独立状态槽**：`core/state.ts` 为副轨单设 `clip.secondarySubtitle`（含自有 `idle | loading | ready | error` 相位），不触碰 `subtitleBody`、`subtitleFetchState` 与 `selectedSubtitle*` 三元组——确保副轨失败绝不把整片字幕面打成失败态阻塞主轨，也不污染只消费主轨的 AI 概览与对话上下文签名（对齐 [ADR-0002](0002-state-bag-write-discipline.md)）。
- **并列接受事务与窄副作用通知**：`subtitle/commit.ts` 提供并列的 `acceptSecondarySubtitle`（同样先校验 `runId` 防跨视频串写），只发 `secondary-subtitle-ready` 通知驱动列表幂等重渲，**不复用 `subtitle-ready`**（避免副轨到站误触发热评拉取、概览重算与对话上下文刷新）。
- **乐观选中与引用失效**：副轨语言选择乐观写入且失败不回退为空（保留「本视频无该语言轨」与「装载失败可重试」的界面区分）。导出派生内容（Markdown / SRT / TXT）的缓存指纹纳入 `secondarySubtitle.body` 引用；`bilingualSubtitles`、`secondarySubtitleLang` 与上下行语序 `bilingualDisplayOrder`（`"original-first" | "translation-first"`）统一持久化并贯通文摘面板、播放器叠层与导出。
- **纯函数时间重叠配对**：列表行集合恒等于主轨段集合（锚定 `data-index`、搜索与播放同步），`subtitle/alignment.ts` 按严格 `> 0` 时间重叠拼接副行，对齐结果不落 state；划词解释取整句时显式剔除内嵌副行节点。

### 2. 跨语种原生配对与 AI 译文副轨三判据

- **原生多轨优先零 Token 配对**：匹配副轨时完整 `lan` 精确命中优先，未命中按 `getLangFamily` 语种族回退（`manual-cc` 人工轨优先于 `bili-ai` 机器轨），**严格剔除同语种族轨道**防止繁简配成假双语（YouTube 站点禁用原生双轨配对，统一走 AI 译文副轨，见 [ADR-0021](0021-multi-site-and-youtube-core.md)）。
- **AI 译文副轨触发与协议分流**：当命中**「单语种原生轨 ∨ ASR 伪轨（无跨语种真轨）∨ 跨语种多轨用户显式开启 AI 精翻覆盖」**三判据之一时，第二路进入 `subtitle/asr-translation.ts`（归属 `g-subtitle` 经典 IIFE 分组，见 [ADR-0004](0004-content-two-round-build-and-reader-gate.md)）。除全量缓存命中零请求直挂外，**必须经用户显式动作才发起付费翻译请求**。
  - 人工 CC 源轨走 JSON 数组严格 ID 对齐流式协议，缓存键 `${sourceTrackKey}_translate-<CanonicalBCP47>`；
  - 平台自动字幕（`bili-ai` / YouTube `kind: "asr"`）与 `asr` 源轨走**禁传时间戳的 `boundary-v3` 联合断句翻译协议**（仅传 `{ id, text, pauseMs? }`，严禁模型输出时间戳以根绝时间漂移幻觉，由前端按原始事件序列精确重建时间轴；ASR 译文键 `id_translate-<lang>` 在新 ASR 原文落盘时定向清理）。

### 3. 90 秒播放游标优先调度与防抖持久化

- `subtitle/chunk-scheduler.ts` 以当前播放进度为中心优先零抖动调度 `[currentTimeSec, currentTimeSec + 90]` 窗口内分片（首片未落定或用户 `seek` 时并发压至 1 消除队头竞争，后台窗口并发为 2），配合分片版本门控与区间回滚支持乱序流式增量上屏（生成期间副轨槽保持 `ready`，单片失败容错跳过并保留补齐入口）。
- 流式译文更新先经 1500ms 内存防抖缓冲聚合再写入扩展源 IndexedDB v2 `subtitle_pages` 表（见 [ADR-0018](0018-layered-storage-and-extension-idb.md)；换片、`pagehide`、`visibilitychange` 前强制刷盘；缓存签名排除 API Key、并发度与未命中本片的无关术语表项）。

## 考虑过的方案

- **给 `acceptSubtitle` 加 `role` 参数或复用 `subtitle-ready`**：稀释主轨事务语义，并让副轨加载连带触发概览与对话重刷。
- **按数组下标 zip 双轨或让 LLM 回传断句时间戳**：多轨分段边界天然不一致，硬 zip 会整片错位；模型生成时间戳会产生越界与漂移幻觉。
- **从片头串行翻译且每片立刻整份写盘**：用户拖拽进度条后需漫长等待当前位置译文，且流式高频写 IDB 造成严重 I/O 放大。
