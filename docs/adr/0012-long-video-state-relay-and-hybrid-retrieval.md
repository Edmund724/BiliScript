# ADR-0012：长视频阶梯预算、KV 前缀缓存锁、滑动状态接力总结与单跳混合召回

> 状态：有效

在长视频「全局章节概览与金句提取」及「多轮 AI 对话追问」中，扩展以 **`MATERIAL_BUDGET_CHARS = 200000`（按模型窗口 ≥ 256k 定档）** 为阶梯分界，结合**滑动状态接力总结（State Relay）**、**KV 前缀缓存锁与意图分流**、**L1 章节目录 + 25s Contextual BM25 与 RRF 单跳混合召回**及 **Map-Reduce 兜底**处理超长内容，同时硬性约束**零本地/远程向量引擎、零 Embedding 模型、零第三方分词词典依赖**。

## 已定决策

### 1. 200k 字符阶梯、成本护栏与三级溢出回落（`extension/ai/budgeter.ts`、`map-reduce.ts`）

- **阶梯边界与护栏口径**：素材 `<= 200,000` 字符直接单次成稿（零额外拆段调用）；超出预算拆段时（单段输入 `50,000` 字符、分段小结 `10,000` 字符、归并组 `100,000` 字符、超 `500,000` 字符触发层叠归并），在 `extension/ai/cost-guard.ts` 命中「预估调用 `>= 12` 次且 `>= 100k` tokens（无 token 估算时 `calls >= 12`），或总 tokens `>= 200k`」时弹出成本护栏。护栏展示 token 优先按 `(baseUrl, model)` 会话内实测 `usage` 比例换算（该系数仅用于展示，不参与阶梯切分判定）。
- **小窗口模型三级溢出回落**：当实际模型窗口小于 256k 触发 HTTP 上下文超长错误（`isContextLengthOverflow` 启发式，与输出预算过限严格区分，见 [ADR-0006](0006-output-budget-wide-default-retreat-learned-cap.md)）时，依次执行：(1) 单发溢出自动转入分段归并；(2) 分段仍溢出则将单段与归并组输入按 `0.5` 倍收紧整轮重跑一次（缓存键加 `_b50` 隔离）；(3) 仍溢出则明确提示更换更大窗口模型（兜底地板约 32k 窗口级）。

### 2. KV 前缀缓存锁与多轮会话上下文稳定（`extension/ai/context.ts`、`tool-loop.ts`、`adapters/anthropic.ts`）

- **静态顶层前缀与动态块下移**：顶层 `system` 仅承载固定系统提示词、视频元数据及静态章节目录 / 压缩摘要 / 短片全量字幕；每轮动态召回字幕窗口与视频帧提示经 `formatDynamicTurnUserContent` 附于当轮 `user` 消息（`<retrieved_subtitles>` / `<video_frame_context>`），严禁改写已缓存前缀。
- **静态工具表与无前缀破坏拦截**：工具循环全程保持 `tools` 定义静态一致；达到工具调用上限或重复调用拦截时以 `role: "tool"` 软拦截回填提示，严禁在循环中途追加 `role: "system"` 消息。Anthropic 适配器在静态前缀与倒数第二条历史消息挂载 `cache_control: { type: "ephemeral" }` 滚动断点。
- **长对话滚动压缩锚点**：超长多轮会话结合持久化 `summaryAnchor` 与过期轮次工具结果折叠控制上下文长度，避免反复全量重放。

### 3. 25s Contextual BM25 + L1 目录与概览滑动状态接力（`extension/ai/state-relay.ts`、`l0-bm25.ts`）

- **L0 Contextual BM25 词法层**：以主轨归一化逐句字幕行（`L0SubtitleLine`）按 `25s` 目标窗长 / `5s` 重叠（上限 `600` 字符）组装带章节上下文前缀的语义块，采用 `Intl.Segmenter` 词级（权重 `1.0`）+ 中文字符二元组（权重 `0.45`）双通道 BM25 打分（`extension/ai/stop-words.ts`），零外部词典体积；Offscreen 内存维持 `3` 视频槽缓存并随字幕槽淘汰联动清理。
- **L1 章节目录层**：承载整片摘要、带核心论点与消歧实体词的章节节点及锚定 L0 行号的金句；无缓存目录时回退至本地时间分桶目录。
- **概览超预算走滑动状态接力**：`extension/ai/analysis-orchestrate.ts` 对 `> 200k` 视频按序串行传递滚动 `StateRelayCard`（结构以 `extension/ai/state-relay.ts` 为准），消除并发分段在切点处的重复开章与专有名词失忆。

### 4. 意图分流、单跳混合召回（RRF）与 Map-Reduce 分工（`extension/ai/ladder.ts`、`chat-hybrid-retrieval.ts`）

- **严格单跳（Single-Hop）上限**：每次用户提问最多执行一次短路由判定与一次 L0 扩窗装配，**严禁构建多轮自主检索 Agent 循环或逐页字幕翻页循环**（避免多轮串行 RTT 撞上 Offscreen 端口 90 秒空闲超时及 token 倍增）。
- **意图分流与会话模式锁定**：通过 `isMacroSummaryTurn` 区分宏观全片总结与局部细节问答，并在会话头持久化 `transcriptMode`（`full` / `hybrid`）防止多轮中途切换破坏前缀缓存。
- **三条召回路径与 RRF 融合**：
  1. **交互锚点直通（`interaction-anchor`）**：命中划词解释意图、显式时间戳或当前播放游标指代时，跳过模型路由，直接按锚点抽取 L0 前后扩窗与所属 L1 章节摘要直入流式回答（超预算视频亦跳过成本护栏与全片归并）。
  2. **L1 路由 + 25s Contextual BM25 与 RRF 单跳召回**：高置信 BM25 命中时免路由直出；否则并发执行非流式短路由（`thinkingLevel: "off"`，判定 `direct-answer` 或输出 1～2 个章节区间与补充词）与本地 BM25 检索，按 RRF（`RRF_K = 60`、`RRF_WEIGHT_L1 = 1.0`、`RRF_WEIGHT_BM25 = 1.1`）排序并按时间序去重合并窗口（单轮注入上限 `STAGE_B_TOTAL_SUBTITLE_MAX_CHARS = 80,000`）；路由超时或异常时静默降级至本地 BM25 扩窗或常驻压缩摘要。
  3. **Map-Reduce 冷兜底**：`extension/ai/map-reduce.ts` 仅在「`> 200k` 视频尚无 L1 索引、无历史上下文且无交互锚点的首次宏观总结」及「单发流上下文溢出回落」时调用。
- **存储宿主与体积守卫**：L1 索引与段摘要缓存由后台扩展源 IndexedDB v4 `ai_artifacts` 表统一托管（Offscreen 经 `segment-cache` 消息代理访问，见 [ADR-0018](0018-layered-storage-and-extension-idb.md)）；纯算法叶保持零 DOM/storage 依赖，严守 [ADR-0001](0001-background-no-runtime-lazy.md) 与 [ADR-0004](0004-content-two-round-build-and-reader-gate.md) 双端体积预算。

## 考虑过的方案

- **本地或远程 Embedding 模型 + 向量块/WASM 向量库或第三方中文分词包**：本地权重与词典引入数 MB 至数十 MB 资产；远程同源 Embedding 与多种内置非 OpenAI 预设失配且存在未经用户确认的静默扣费与反复 400 探测风险，均否决。
- **将字幕检索做成多轮 Function Calling 翻页循环**：每次迭代重放长上下文并叠加首字延迟，不可控且易超时。

## 后果

- **审查红线**：架构评审（含 AI 代理）不得提议引入本地/远程向量引擎、Embedding 模型或第三方分词依赖，也不得将长视频字幕召回改为多轮自主检索或翻页循环。
