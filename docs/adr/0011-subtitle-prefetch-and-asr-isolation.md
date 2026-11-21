# ADR-0011：视频页字幕预抓取、发送闸重试与 ASR 跨导航/分段流式隔离

> 状态：有效

围绕原生字幕获取与无字幕语音识别（ASR）回退全链路，我们确立**进视频页即预抓取原生字幕（禁自动进 ASR）**、**发送闸失败重试与拦截**、**在途 ASR 任务与导航代次解耦保活**，以及 **Offscreen 内音频分段流式解码闭环**四项机制。

## 已定决策

### 1. 进视频页即预抓取原生字幕（`extension/subtitle/kick-subtitle-fetch.ts`）

- Content Script 首载（`entry/content.ts`）与 SPA 换片（`entry/clip-switch-transaction.ts`）立即起跑预抓取，不设独立设置开关。经共享守卫 `isSubtitleInHandOrInFlight`（字幕在手且视频身份匹配，或相位处于 `loading` / `ready` 时跳过防并发重抓）判定后，先等待 `waitForVideoMetadata(5000)`，再加载总结链并复用 `refreshClip` 唯一接受事务（后台静默执行，失败不弹页面提示）。
- B 站 `x/player/wbi/v2` 字幕列表请求兼作最早可用性探测（解析轨道严格优先取字符串 `id_str` 规避 19 位整数 `Number.MAX_SAFE_INTEGER` 精度丢失，缓存签名剥离轮换 `auth_key`）；**无原生字幕视频只多这一次列表探测，绝不在预抓取中自动触发分钟级付费 ASR**（ASR 维持用户显式触发）。

### 2. 发送闸 `error` 重试拦截与即时等待反馈（`extension/chat/send-gate.ts`）

- 预抓瞬时失败留下 `error` 相位时，发送闸在受理用户消息前自动重试一次抓取；若仍失败，以 `GateOutcome` 的 `fetch-error` 分支明确拦截提示（与 `read-failed` / `no-subtitle` / `cancelled` 并列），严禁放行空字幕上下文任由模型凭标题与热评编造内容。
- 发送闸进入等待即刻展示带加载指示的通知条、禁用发送键但保持输入框可编辑（等待期改动留作下一轮草稿），并订阅 `shared/subtitle-status-bus.ts` 相位在字幕落定瞬间唤醒等待闸，消除轮询尾窗延迟。

### 3. 在途 ASR 任务与 `fetchRunId` 导航代次解耦（`extension/asr/fallback.ts`）

- 用户显式触发的在途 ASR 任务按 `videoKey` 登记在页面内存 `activeAsrTranscribes` 中，与随换片/侧栏刷新递增的 `fetchRunId` 解耦：用户短时切换分P、点击推荐视频或侧栏触发重刷时，仅通过接受事务的 `STALE_RUN` 门控屏蔽对失配 UI 的写入，**后台在途 ASR 任务继续跑完并将结果写入扩展源 IndexedDB**（见 [ADR-0018](0018-layered-storage-and-extension-idb.md)），防止误触导航销毁已付费运行数分钟的音频转写。

### 4. Offscreen 二进制闭环与分段流式 ADTS 解码防 OOM（`extension/entry/offscreen-asr.ts`）

- 音频流下载（200MB 累计字节封顶）、fMP4 按每 10 个 `moof/mdat` 流式提取 ADTS 音频段（`asr/adts.ts`）、`OfflineAudioContext` 解码、静音谷 60s 软切片与并发转写请求全程封闭在 Offscreen 文档内完成，**严禁跨 `runtime.Port` 传输原始音频二进制或 API Key**。
- **严禁整轨下载后一次性调用 `decodeAudioData`**：数小时视频整轨解码成未压缩 PCM 会暴涨至数 GB 内存导致 Offscreen 进程 OOM 崩溃或触发 Chromium 长 ADTS 解码失败。
- 协议区分携带局部片失败摘要的 `ASR_MSG_DONE` 与管线级致命错误 `ASR_MSG_ERROR`；错误分类（`asr/failure-kind.ts`）在截断响应前完成，并将 B 站媒体 CDN HTTP 错误固定归类为 `asr-media`，防止 CDN 403/429 冒充 AI/ASR 平台鉴权错误误导用户修改 API Key。

## 考虑过的方案

- **悬停 AI 按钮才预取或单设预抓轻量管线**：悬停救不了进页秒点窗口；独立轻量管线会与主接受事务漂移。
- **`fetchRunId` 变更即 `abort` 在途音频下载与转写**：在 SPA 高频点击场景下直接造成用户转写额度损失。
- **整轨 `decodeAudioData` 或在 Content Script 执行转写请求**：前者引发长视频 OOM，后者受网页 CORS 与权限预检限制。

## 后果

- 每个视频页后台固定承担一次 `view` 与一次 `player/wbi/v2` 请求（有字幕再拉正文与热评）；重开条件为触发 B 站接口限流或出现更早的无请求字幕存在信号。
