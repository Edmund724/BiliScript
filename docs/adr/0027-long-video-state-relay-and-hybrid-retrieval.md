# ADR-0027：长视频采用「滑动状态接力总结 + L1 章节目录与 L0 本地轻量 BM25 混合单跳召回」

> 状态：有效

在长视频的「全局章节概览与金句提取」及「多轮 AI 对话追问」两类核心场景中，我们决定演进既有 Map-Reduce 与子串检索方案，采用**「滑动状态接力总结 + 章节目录（L1）与本地轻量 BM25（L0）混合单跳召回」**，同时硬性约束**不引入任何本地向量库、Embedding 模型或第三方分词依赖**。本文记录该方案的架构分层、单跳降级链、存储与隐私边界及打包体积零膨胀约束。

## 背景与动机

1. **全局章节概览与金句生成的断点问题**：现行超预算路径（`>200k` 字符，`ai/budgeter.ts`）在 `ai/analysis-orchestrate.ts` 中对各分段并发执行分析，仅在每段前附带前段末尾 `400` 字符（`ANALYSIS_CONTEXT_CHARS`）只读前情回顾，再经 `mergeAnalyses` 按时间戳去重合并。当话题跨越切点时，模型容易重复开章、丢失前文已纠偏的专有名词（ASR 同音错别字）或难以统筹全片每小时 3–5 条的金句节奏。
2. **多轮 AI 对话追问的粒度与召回瓶颈**：现行预算内视频（`<=200k` 字符）在 `ai/context.ts` 中将整篇字幕随系统提示词全量发送；超预算视频虽走 `ai/followup-context.ts` 的「压缩摘要（`<=60k`）+ 按需原始段注入（`<=30k`）」，但 `ai/raw-retrieval.ts` 仅依赖硬编码 `STOP_WORDS`（`ai/stop-words.ts`）做精确子串匹配，缺乏词频与逆文档频率加权（BM25），且命中单位是 50k 字符级别的整段原始段（`BudgetPlanSegment`），信噪比低、容易触发预算截断。
3. **浏览器扩展的硬边界**：扩展全部运行在 Chromium 本地上下文（Content / Service Worker / Offscreen），`package.json` 的运行时依赖仅有 `katex` 与按需懒加载的 `mermaid`，`scripts/build.js` 设有 `DIST_RUNTIME_MAX_BYTES = 3,900,000` 与 SW 静态图守卫，不能承受 Embedding 模型权重、向量索引 WASM 或数 MB 分词词典的体积与内存开销。

## 已定决策

### 1. 两级数据分层（L0 词法层 + L1 章节目录层）

- **L0 词法层（原始字幕行与邻近扩窗）**：
  - 以主轨归一化后的逐句时间戳字幕为最小检索单元（`L0SubtitleLine`：0-based `lineNumber`、`from`、`to`、`content`）。
  - 检索命中后以命中行为中心向前后扩展连贯上下文窗口（`L0ContextWindow`），携带精确行号与秒级起止时间，代替整段 50k 字符粗粒度注入。
  - 词法打分使用纯 TypeScript 实现的本地轻量 BM25，词切分复用浏览器原生 `Intl.Segmenter`（Chromium 内置，`subtitle/segmentation.ts` 已有先例）与既有停用词表（`ai/stop-words.ts`），零第三方依赖。
- **L1 章节目录层（结构化整片索引）**：
  - 统一承载整片摘要（`globalSummary`）、按时间升序的章节目录节点（`L1ChapterNode`）及锚定到 L0 行号的精选金句（`L1QuoteRef`）。
  - 每个 `L1ChapterNode` 除起止时间（`from`/`to`）与标题外，必须包含**核心论点（`coreThesis`）**、**关键实体词列表（`keyEntities`，用于术语消歧与补充检索词扩展）**和**精选金句关联行号（`quoteLineNumbers`）**。

### 2. 滑动状态接力总结（State Relay Summarization）

- 针对需要分段处理的超长视频，在保留 ADR-0001 的 `MATERIAL_BUDGET_CHARS = 200000` 阶梯边界与三级溢出兜底的前提下，引入串行接力的**「前序状态卡（`StateRelayCard`）」**：
  - 输入：上一窗口输出的状态卡（首窗口为 `null`）、本窗口 L0 字幕行、可选边界极短前情只读行，以及给定章节目录约束（对齐 `ai/chapter-plan.ts`）。
  - 状态卡载荷：已覆盖时间游标与行号、有界滚动主线摘要（`rollingSummary`）、跨切点延续话题（`activeTopic`）、已确认/纠偏的实体词表（`confirmedEntities`）、未闭合论证线索（`openThreads`）、近期章节标题（防重复开章）与已选金句计数（控制配额）。
  - 输出：更新后的 `StateRelayCard`、分段小结、本窗口 L1 章节节点与锚定 L0 行号的精选金句。
- 预算内（`<=200k` 字符）单发路径仍保持单次调用产出 L1 索引，不强行拆段以增加费用与首字延迟。

### 3. 多轮对话渐进式单跳召回与降级策略

- **严格单跳（Single-Hop）原则**：每次用户提问最多执行一次路由判定与一次 L0 召回装配，禁止构建自主多轮检索 Agent 循环（避免多轮串行延迟触发 `offscreen-chat-port.ts` 的 90 秒空闲超时及不可控 token 消耗）。
- **三类路由计划（`ChatRetrievalRoutePlan`）**：
  1. `direct-answer`（直接作答）：全局总结或常识性问题，直接利用 `globalSummary`、L1 章节目录与 `compressedSummaryMarkdown` 作答，零 L0 检索。
  2. `hybrid-single-hop`（选定章节时间区间 + 补充检索词）：基于 L1 章节目录锁定候选时间区间（`RetrievalTimeRange[]`），并从命中章节的 `keyEntities` 提取补充检索词，在限定区间内执行一次 L0 本地 BM25 检索与邻近扩窗。
  3. `interaction-anchor`（交互锚点直通）：当问题包含显式时间戳（对齐 `ai/raw-retrieval.ts` 的 `parseTimestampSeconds`）、来自划词解释的待解释意图（`reader/explain-intent.ts` 的 `ReaderExplainIntent`）或当前播放游标时，跳过 L1 路由直接按锚点行号/时间戳抽取 L0 邻近扩窗片段。
- **单跳降级策略（确定性兜底）**：
  1. **L1 索引缺失/未就绪**：跳过章节裁剪，直接对全片 L0 执行轻量 BM25 检索与扩窗（`degradeReason = "l1-index-missing"`）。
  2. **指定章节区间内零命中**：自动放宽区间限制至全片 L0 执行一次 BM25 检索（`degradeReason = "chapter-range-empty-hits"`）。
  3. **全片 BM25 仍零命中**：退回既有 `compressedSummaryMarkdown`（或 `raw-retrieval.ts` 既有兜底，不抛错、不阻塞提问，`degradeReason = "l0-zero-hits"`）。
  4. **预算封顶**：注入 L0 窗口总量严格受单轮检索预算（对齐 `RAW_INJECTION_MAX_CHARS = 30000`）与 `buildBudgetPlan` 字符线约束，超出按 BM25 得分截断。
- **与既有工具链正交**：`ai/tool-loop.ts` 承载的联网搜索（`web_search`）、视频关键帧采样（`capture_current_video_frame` / `capture_video_frame_at_time`）与热门评论（`fetch_hot_comments`）继续独立运行；单跳召回仅负责字幕上下文装配，不占用搜索配额。

### 4. 本地存储与隐私边界（对齐 `PRIVACY.md`）

- **宿主判据不变（对齐 `GLOSSARY.md`「缓存宿主」）**：offscreen 消费的 L1 索引与段/摘要缓存以 Service Worker 为唯一真实存储宿主（`chrome.storage.local`），offscreen 经消息代理读写，不得在 offscreen 引入 storage 垫片。
- **键位与 LRU 同源**：L1 整片索引缓存按 `(bvid, cid, sourceKey, subtitleSignature)` 建键，封装 `{ index, timestamp }` 并纳入 `core/cache-lru.ts` 的统一 LRU 淘汰策略（每族保留最近 3 个视频），在 `PRIVACY.md` 声明的 `unlimitedStorage` 本地缓存边界内管理，清除扩展存储或删除历史时一并清理。
- **数据不出端与透明发送**：L0 BM25 索引构建、打分与 L1 索引落盘 100% 在用户浏览器本地完成，**不连接任何开发者后端、外部向量数据库或云端分词服务**。仅当用户主动触发总结或对话请求时，才将路由命中并经字符预算裁剪后的字幕片段发往用户自配的 AI 平台（OpenAI / Anthropic / Gemini 原生协议及 ModelScope 等预设端点）；划词解释（`ai/explain.ts`）与视频截帧（`chat/historical-video-frame.ts`）的隐私边界保持与 `PRIVACY.md` 完全一致。

### 5. 打包体积零膨胀约束

- **零新运行时依赖**：`package.json` 的 `dependencies` 保持只含 `katex` 与 `mermaid`，禁止引入任何向量库、Embedding 模型、ONNX/WASM 推理引擎或外部中文分词词典包。
- **静态图与体积守卫**：遵循 ADR-0003 与 `scripts/build.js` 守卫（`BACKGROUND_JS_MAX_KB = 256`、`DIST_RUNTIME_MAX_BYTES = 3,900,000`、`assertBackgroundStaticGraphSlim`、`assertLadderChunkSlim`）：
  - 纯类型契约独立落在 `extension/ai/long-video-hybrid-types.ts`（零运行时 import，构建期完全擦除）；
  - 后续 BM25 检索与 L1 路由纯算法叶必须保持零 chrome / DOM / storage 依赖，避免污染 `entry/background.ts` 常驻体积或 `ladder` chunk 依赖边界。

## 考虑过的备选

- **本地 Embedding 模型 + 向量检索（如 Transformers.js / WebGPU / 本地 HNSW）**：会引入数十 MB 模型资产或外网模型权重下载、显著增加扩展包体与内存占用，且与无后端零遥测的轻量定位冲突，予以否决。
- **引入第三方中文分词依赖（如 jieba 系词典库）**：附带数 MB 词表 JSON/二进制数据，违反打包体积零膨胀约束；Chromium 原生 `Intl.Segmenter` 已可零体积支持中英文词边界切分，予以否决。
- **多跳 Agent 自主检索循环（将 L0 检索封装为多轮 tool call）**：每次检索额外增加一次 LLM 往返 RTT 与完整上下文重放成本，易触发 90 秒空闲超时并破坏追问 token 近似常数的目标，予以否决。

## 后果

- **本阶段落盘边界**：核心纯类型契约先落盘于 `extension/ai/long-video-hybrid-types.ts`，现有 `ai/analysis-orchestrate.ts`、`ai/ladder.ts`、`ai/followup-context.ts`、`ai/raw-retrieval.ts` 与 `ai/context.ts` 等业务逻辑保持零修改。
- **后续实施纪律**：任何后续实装（State Relay 编排、BM25 纯叶、L1 索引缓存族接入与渐进路由）必须直接消费 `extension/ai/long-video-hybrid-types.ts` 的类型契约，并受本 ADR 的「零向量/Embedding/外部分词依赖」「单跳上限」与「打包体积守卫」审查红线约束。
