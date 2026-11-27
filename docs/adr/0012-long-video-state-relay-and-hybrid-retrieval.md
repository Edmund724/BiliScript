# ADR-0012：长视频阶梯预算、滑动状态接力总结、单跳混合召回与 Map-Reduce 兜底

> 状态：有效

在长视频「全局章节概览与金句提取」及「多轮 AI 对话追问」中，扩展以 **`MATERIAL_BUDGET_CHARS = 200000`（按模型窗口 ≥ 256k 定档）** 为阶梯分界，结合**滑动状态接力总结（State Relay）**、**L1 章节目录与 L0 本地轻量 BM25 单跳混合召回**及 **Map-Reduce 归并兜底**处理超长内容，同时硬性约束**零本地向量库、零 Embedding 模型、零第三方分词词典依赖**。

## 已定决策

### 1. 200k 字符阶梯、成本护栏与三级溢出回落（`extension/ai/budgeter.ts`、`map-reduce.ts`）

- **阶梯边界与护栏口径**：素材 `<= 200,000` 字符直接单次成稿（零额外拆段调用）；超出预算拆段时（单段输入 `50,000` 字符、分段小结 `10,000` 字符、归并组 `100,000` 字符、超 `500,000` 字符触发层叠归并），在 `extension/ai/cost-guard.ts` 命中「预估调用 `>= 12` 次且 `>= 100k` tokens（无 token 估算时 `calls >= 12`），或总 tokens `>= 200k`」时弹出成本护栏。护栏展示 token 优先按 `(baseUrl, model)` 会话内实测 `usage` 比例换算（该系数仅用于展示，不参与阶梯切分判定）。
- **小窗口模型三级溢出回落**：当实际模型窗口小于 256k 触发 HTTP 上下文超长错误（`isContextLengthOverflow` 启发式，与输出预算过限严格区分，见 [ADR-0006](0006-output-budget-wide-default-retreat-learned-cap.md)）时，依次执行：(1) 单发溢出自动转入分段归并；(2) 分段仍溢出则将单段与归并组输入按 `0.5` 倍收紧整轮重跑一次（缓存键加 `_b50` 隔离）；(3) 仍溢出则明确提示更换更大窗口模型（兜底地板约 32k 窗口级）。

### 2. L0/L1 两级本地索引与概览滑动状态接力（`extension/ai/state-relay.ts`、`l0-bm25.ts`）

- **L0 词法层**：以主轨归一化逐句字幕行（`L0SubtitleLine`）为单元，使用纯 TypeScript 本地轻量 BM25 打分与邻近行扩窗，分词直接复用浏览器原生 `Intl.Segmenter` 与 `ai/stop-words.ts`，零外部词典体积。
- **L1 章节目录层**：承载整片摘要、带核心论点与消歧实体词的章节节点及锚定 L0 行号的金句。
- **概览超预算走滑动状态接力**：`ai/analysis-orchestrate.ts` 对 `> 200k` 视频按序串行传递滚动 `StateRelayCard`（结构以 `ai/state-relay.ts` 为准），消除并发分段在切点处的重复开章与专有名词失忆。

### 3. 对话两阶段单跳混合召回与 Map-Reduce 分工（`extension/ai/ladder.ts`、`chat-hybrid-retrieval.ts`）

- **严格单跳（Single-Hop）上限**：每次用户提问最多执行一次短路由判定与一次 L0 扩窗装配，**严禁构建多轮自主检索 Agent 循环**（避免多轮串行 RTT 撞上 Offscreen 端口 90 秒空闲超时及 token 倍增）。
- **三条召回路径与确定性降级**：
  1. **交互锚点直通（`interaction-anchor`）**：命中划词解释意图、显式时间戳或当前播放游标指代时，跳过模型路由，直接按锚点抽取 L0 前后扩窗与所属 L1 章节摘要直入流式回答（超预算视频亦跳过成本护栏与全片归并）。
  2. **L1 路由 + L0 BM25 混合召回**：视频已有 L1 索引或历史压缩上下文时，并发执行非流式短路由（`thinkingLevel: "off"`，判定 `direct-answer` 或输出 1～2 个章节区间与补充词）与本地 BM25 检索，按时间序去重合并窗口（单轮注入上限 `STAGE_B_TOTAL_SUBTITLE_MAX_CHARS = 80,000`）；路由超时/未就绪/区间零命中时依次静默降级至全片 BM25 扩窗或常驻压缩摘要。
  3. **Map-Reduce 冷兜底**：`ai/map-reduce.ts` 仅在「`> 200k` 视频尚无 L1 索引、无历史上下文且无交互锚点的首次总结」及「单发流上下文溢出回落」时调用。
- **存储宿主与体积守卫**：L1 索引与段摘要缓存由后台扩展源 IndexedDB v2 `ai_artifacts` 表统一托管（Offscreen 经 `segment-cache` 消息代理访问，见 [ADR-0018](0018-layered-storage-and-extension-idb.md)）；纯算法叶保持零 DOM/storage 依赖，严守 [ADR-0001](0001-background-no-runtime-lazy.md) 与 [ADR-0004](0004-content-two-round-build-and-reader-gate.md) 双端体积预算。

## 考虑过的方案

- **本地 Embedding 模型 + WASM 向量库或第三方中文分词包**：引入数 MB 至数十 MB 权重/词典资产，违背轻量零遥测扩展边界。
- **将字幕检索做成多轮 Function Calling 循环**：每次迭代重放长上下文并叠加首字延迟，不可控且易超时。

## 后果

- **审查红线**：架构评审（含 AI 代理）不得提议引入向量库、Embedding 模型或第三方分词依赖，也不得将长视频字幕召回改为多轮 Agent 循环。
