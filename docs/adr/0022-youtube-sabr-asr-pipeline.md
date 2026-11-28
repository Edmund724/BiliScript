# ADR-0022：YouTube 主世界 SABR/UMP 采集、离屏推流解码与 ASR 门控边界

> 状态：有效

在 [ADR-0021](0021-multi-site-and-youtube-core.md) 底座之上，为 Chromium（120+）与桌面端 Firefox（153+）的 YouTube 桌面端 `/watch` 页提供无字幕 ASR 语音转写与多时间点历史截帧能力。采用**极薄静态主世界模板嗅探 + 按需加载 SABR/UMP 拉流引擎（零新增域名权限）+ Offscreen 推流解码复用 16 kHz WAV 管线 + 真无字幕自动回退与字幕不可用手动触发分离**架构。

## 已定决策

### 1. 主世界双段式注入与零新增 `googlevideo` 权限

- **极薄静态 `MAIN` 嗅探器**：对 `https://www.youtube.com/*` 静态注册 `world: "MAIN"`、`run_at: "document_start"` 的独立脚本 `entry/youtube-sabr-sniffer.main.js`（2–3 KB，独立构建，不计入 [ADR-0004](0004-content-two-round-build-and-reader-gate.md) 的 `45 KB` 常驻内容包预算），仅旁路缓存最近 1 条非广告 `POST https://*.googlevideo.com/videoplayback` 请求模板（上限 `64 KB`），异常完全隔离、绝不阻塞宿主请求。
- **按需 SABR 拉流引擎与零新增权限**：仅当触发 ASR 或历史时间点截帧时，由后台经 `scripting.executeScript({ world: "MAIN", files: ["entry/youtube-sabr-worker.main.js"] })` 按需注入完整 SABR/UMP 状态机（页面暂停未捕获模板时退回从活动播放器实例合成初始参数）。SABR 请求在主世界同源发起，复用页面原生 CORS 与真实 `WEB` BotGuard 凭证，**不在清单中新增 `https://*.googlevideo.com/*`**，亦不伪装 `ANDROID` / `IOS` 客户端。

### 2. SABR/UMP 采集策略与广告三重门禁

- **线格式最小改写（`extension/youtube/sabr-protocol.ts`）**：零依赖 wire-level Protobuf 改写（原样透传未知防伪字段），维护播放会话上下文与退避；收到鉴权拒绝信号时以 `ATTESTATION_REJECTED` 立即中止。
- **编解码选择与三重广告门禁**：不劫持 MSE；音频转写按当前播放音轨的 `audioTrack.id` / `xtags` 严格匹配 `audio/mp4` 并**优先 `itag 140`（AAC-LC）而非 `itag 139`（HE-AAC/SBR）**（规避双端 `AudioContext.decodeAudioData` 采样率解析差异），线性流式拉取并守 `200 MB` 上限。多时间点历史截帧复用同一 Worker（默认 `spanSeconds = 0` 每点精确单帧，可选邻域跨度展开 `[t-s, t, t+s]` 并按 `0.25s` 阈值中心优先去重），将升序目标点按前后 `600 ms` 缓冲与双阈值窗口聚类（相邻间距 `<= 10 s`、合并跨度 `<= 20 s`、单次最多 `6` 个分散窗口）串行拉取 720p 优先低帧率视频短窗（单窗最多 `24 MB`），回传内容脚本后对同编解码 MIME 复用单个离屏 `MediaSource + <video>` 并执行 `2.5 s` 缓冲漂移守卫解码截帧，完成后统一清理，不扰动主播放器。采集全程执行三重门禁（排除广告态 DOM、核对当前 `video_id`、校验 UMP `MediaHeader.videoId`），切视频或取消时立即中止。

### 3. 离屏推流解码、触发门控与多音轨缓存兼容

- **复用 16 kHz WAV 管线**：主世界经 `Transferable ArrayBuffer` 将 `init` 与 `moof/mdat` 分片移交内容脚本，再经 `asr-decode` Port 背压推入 Offscreen，复用 [extension/asr/adts.ts](../../extension/asr/adts.ts)（支持标准 MPEG-4 变长 `esds`、`trun` 全标志与 `tfhd` 默认帧长）、重采样与并发转写引擎，天然兼容 Chromium Offscreen 与 Firefox Event Page 隐藏 `iframe`（[ADR-0017](0017-firefox-desktop-compatibility.md)），并跳过 B 站 Referer DNR 规则。
- **成本门控与手动触发分离**：遵守 [ADR-0011](0011-subtitle-prefetch-and-asr-isolation.md)，仅确认真无字幕（`nativeTracks.length === 0`）且 `asrAutoFallback === true` 时自动回退 ASR；`youtube-captions-unavailable` 或存在官方 `kind=asr` 时绝不自动触发付费 ASR。仅在无字幕/字幕不可用空态提供手动「使用语音转写」入口（`trigger: "manual"` 可绕过 `asrAutoFallback === false`）。
- **多音轨缓存键零迁移兼容**：`extension/subtitle/source-key.ts` 的 `asr` 标识支持可选 `audioTrackId`（空时保持 `id_asr:<provider>:<model>:<lang>` 字节不变，多配音轨追加转义后缀）。已打开 YouTube 标签页的本地 Agent 桥接复用同一页内转写与 `asrAutoFallback` 门控。

## 考虑过的方案

- **纯按需注入（不静态挂 `document_start` 嗅探器）**：暂停态、已缓冲完毕或 Agent Bridge 无人值守场景缺乏捕获模板易失败，故采用 2–3 KB 极薄静态嗅探器 + 按需 Worker。
- **新增免重编码 `.m4a` 重封装直传**：仍需解码 PCM 做波谷 VAD 且需维护 ISO BMFF 重封装与时间戳补偿；复用既有 16 kHz WAV 管线（`60` 秒/片）远低于各平台单次上传上限且双端兼容性更好。
- **首期引入播放头优先（Playhead-First）与 Seek 抢占**：需重写单调时间轴切片器与渐进合并器，复杂度高于收益，保留为后续跨站演进项。

## 后果

- **审查红线**：
  - 不得在清单中新增 `https://*.googlevideo.com/*` 常驻 `host_permissions`，也不得通过伪装 `ANDROID` / `IOS` 客户端绕过 SABR/PO Token 校验。
  - 不得在 `youtube-captions-unavailable` 或存在 YouTube 官方 `kind=asr` 时静默自动触发付费 ASR。
  - 不得将完整 SABR 协议逻辑打入 `45 KB` 常驻 `content-resident.iife.js` 或 `256 KB` `background.js`。
