# ADR-0033：字幕流水线单源签名、ASR 任务跨导航隔离与游标优先翻译调度

> 状态：有效

在字幕获取、B 站签名轨道归一化、无字幕 ASR 转写回退以及 AI 断句/双语翻译流水线中，我们决定采用 **无存储依赖的轨道身份与去噪缓存签名叶**、**与 `fetchRunId` 解耦的 ASR 在途作业生命周期**、**无时间戳 `boundary-v3` 流式协议**，以及 **播放游标优先的首屏独享翻译调度器**。

## 背景与动机

1. **大数字 ID 截断与动态签名 URL 导致缓存失配**：B 站字幕 `id` 为超过 `Number.MAX_SAFE_INTEGER` 的 19 位整数（`JSON.parse` 数字字段末尾失真），且带签名 `auth_key` 每次拉取都会轮换；若签名纳入 API Key 或完整签名 URL，用户改配 Key 或刷新页面便会缓存全量失效。
2. **侧边栏同步或短时换片误杀数小时 ASR 任务**：`refreshClip` 每次进入/切换视频都会递增 `fetchRunId`；若把后台长达数分钟的音频转写直接绑定到 `fetchRunId`，用户点击侧边栏或临时看别处就会白白中止已花费 Token/额度的转写任务。
3. **LLM 幻觉时间戳与全片顺序翻译首屏延迟**：让 LLM 在断句/翻译时输出时间戳容易产生漂移幻觉；而长视频从头按顺序并发翻译全部 60s 分片会导致用户当前正在观看的时间点迟迟等不到译文，且流式中间更新高频直写 IDB 会产生严重 I/O 放大。

## 已定决策

### 1. 纯净单源身份、去噪签名与 B 站大整数精度保护

- `bilibili/native-payload.ts` 在解析 B 站轨道时严格优先 `id_str`，`view_points` 大于 86400s 的值自动按毫秒折算秒；`subtitle/source-key.ts` 与 `subtitle/signature.ts` 作为零存储依赖叶模块按 `id > normalizedUrl(去 auth_key) > lang` 唯一生成键名，并用 `WeakMap` 按数组引用记忆体度量。
- `subtitle/cache.ts` 计算断句与翻译缓存签名时有意排除 API Key、端点、并发度、超时与未命中本片字幕的无关术语表条目；流式译文更新先经 1500ms 内存防抖缓冲聚合，并在切换视频/源轨、`pagehide`、`visibilitychange` 与页面记录读出前强制落盘。

### 2. ASR 任务独立生命周期（`activeAsrTranscribes`）与源感知错误分类

- `asr/fallback.ts` 将在途 ASR 任务按 `videoKey` 挂入 `activeAsrTranscribes`：URL 临时导航或侧边栏 `refreshClip` 递增 `fetchRunId` 仅屏蔽对当前失配 UI 的写入（`STALE_RUN` 静默让位），后台 ASR 任务继续完成并写入扩展源 IDB（60s 内零产出且 `failedChunks > 0` 时仅快速自动重试 1 次）。
- `asr/failure-kind.ts` 在 Offscreen 阶段对完整响应体先于 200 字符截断完成分类，且明确将 B 站媒体源 HTTP 错误固定归为 `asr-media`，防止 CDN 的 403/429 冒充平台鉴权或配额错误误导用户修改 API Key。
- `subtitle/fetcher.ts` 与 `subtitle/commit.ts` 在视频切换、重载或无字幕文案输出上维持单一退出语义：必须先 `ensureRunActive` 再写 `clipState`，且 `commitNoSubtitle` 保留既有高优先级 ASR 诊断并与 `STATUS_LINE_BASE` 拼接，防止状态栏误把报错当作 5 秒自动消失提示。

### 3. 无时间戳 `boundary-v3` 协议与游标优先翻译调度

- `subtitle/boundary-protocol.ts` 仅向 LLM 发送 `{ id, text, pauseMs? }`，严禁模型生成时间戳，断句结果由前端按原始事件序列精确重建起止时间与文本，并配置 4 层降级挽救路径保证单集永不因格式畸形中断；`streaming-parser.ts` 使用 O(N) 增量扫描并区分散文方括号（如 `[Note]`）与 JSON 顶层数组。
- `subtitle/chunk-scheduler.ts` 实现播放游标优先调度：首屏第一片未落定或用户 `seek` 前保持并发=1 消除队头竞争；优先零抖动调度 `[currentTimeSec, currentTimeSec + 90]` 窗口内分片，窗口外分片施以 300–600ms 抖动且前向优先于历史分片；配合 `translated-track-session.ts` 的双阶段签名重算、分片版本门控与 `[chunkFromSec, chunkToSec]` 区间回滚保证乱序不串轨。

## 考虑过的备选

- **每次 `fetchRunId` 变更即 abort 正在执行的音频下载与转写**：会在用户误触跳转后丢失已付费转写进度，予以否决。
- **使用传统 `JSON.parse` 逐块重解析流式输出或依赖模型回传时间戳**：前者导致 O(N²) CPU 尖峰，后者引入时间戳幻觉与错位，予以否决。

## 后果

- `subtitle/` 领域内任意修改 `state.clip.chapters` 或 `subtitleBody` 的写入方必须保持不可变整体替换语义（支撑 `WeakMap` 记忆与排序不变量）。
- 已知 `refreshClip` 当前仍硬编码强制拉网绕过本地 IDB 缓存及混源 ASR 轨道切回未完全打通，已列入后续技术债 Issue 治理。
