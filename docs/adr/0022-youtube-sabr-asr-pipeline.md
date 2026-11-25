# ADR-0022：YouTube 无字幕 ASR 的主世界 SABR/UMP 采集、离屏推流解码与门控边界

> 状态：有效

在 [ADR-0021](0021-multi-site-and-youtube-core.md) 的多站点底座之上，为 Chromium（120+）与桌面端 Firefox（153+）同步交付 YouTube 桌面端 `/watch` 页的无字幕 ASR 语音转写能力（含已打开 YouTube 标签页的本地 Agent 桥接）。采用**极薄静态主世界模板嗅探 + 按需加载 SABR/UMP 拉流引擎 + Offscreen 推流解码复用 16 kHz WAV 管线 + 真无字幕自动回退与字幕不可用手动触发分离**架构。

## 已定决策

### 1. 主世界双段式注入（薄静态嗅探器 + 按需 SABR 拉流器）与零新增域名权限

- **极薄静态 `MAIN` 嗅探器**：在 [extension/manifest.json](../../extension/manifest.json)（及 `scripts/firefox-manifest.js` 派生清单）对 `https://www.youtube.com/*` 静态注册 `world: "MAIN"`、`run_at: "document_start"` 的独立脚本 `entry/youtube-sabr-sniffer.main.js`（约 2–3 KB，独立构建，不计入 [ADR-0004](0004-content-two-round-build-and-reader-gate.md) 的 40 KB 常驻内容脚本预算）。该脚本仅旁路观察非广告 `POST https://*.googlevideo.com/videoplayback` 请求（请求体上限 `64 KB`、响应 `application/vnd.yt-ump`），在 `Symbol.for` 内存槽中保留最近 1 条未过期模板，异常严格 `try/catch` 隔离、绝不阻塞宿主请求。
- **按需加载 SABR 拉流引擎**：仅当真正触发 ASR 时，由后台通过 `chrome.scripting.executeScript({ world: "MAIN", files: ["entry/youtube-sabr-worker.main.js"] })` 按需注入完整 SABR/UMP 状态机；若页面打开即暂停尚未捕获 `fetch` 模板，再退回从活动播放器实例与 `ytcfg` 合成初始请求（`parameterCandidate`）。
- **零新增 `host_permissions`**：SABR `POST` 请求在 YouTube 页面主世界同源发起，复用页面原生 CORS 放行与真实 `WEB` BotGuard 凭证，不在清单中新增 `https://*.googlevideo.com/*`，避免升级权限弹窗，且严禁伪装 `ANDROID` / `IOS` 客户端。

### 2. SABR/UMP 音频采集、编解码选择与广告三重门禁

- **线格式最小改写**：`extension/youtube/sabr-protocol.ts` 采用零依赖 wire-level Protobuf 字节改写（原样保留未知防伪字段），强制仅请求音频（`clientAbrState.mediaType = 1`、固定 `playbackRate = 1.0`、剔除视频字段 `2/3/17`），循环维护 `PlaybackCookie`（Part `35`）、`SabrContextUpdate`（Part `57/59`）与 `backoffTimeMs` 退避；收到 Part `58`（`status === 3`）立即以 `ATTESTATION_REJECTED` 中止。
- **音轨与容器选择**：不劫持 MSE；从播放器 `adaptiveFormats` 严格按当前播放音轨的 `audioTrack.id` 与 `xtags` 映射对应 `audio/mp4`（`mp4a.40.*`），**优先选择 `itag 140`（AAC-LC）而非 `itag 139`（HE-AAC/SBR）**，规避双端 `AudioContext.decodeAudioData` 对隐式 SBR 的采样率解析差异。
- **广告与切视频隔离**：执行三重门禁（排除 `.ad-showing` / `.ad-interrupting`、核对 `player.getVideoData().video_id`、校验 UMP `MediaHeader.videoId`）；视频切换、音轨切换或任务取消时立即中止 SABR 会话。
- **线性流式调度（首期）**：从 `0s` 顺序拉取并复用现有 `200 MB` 下载上限（`itag 140` 覆盖约 3.4 小时）与渐进渲染，不在首期引入播放头抢占与乱序区间拼装，保持 `stream-chunker.ts` 与整片 IDB 缓存模型简洁确定。

### 3. 离屏推流解码、ADTS 加固与双端兼容

- **复用 16 kHz WAV 管线**：主世界通过 `window.postMessage`（`Transferable ArrayBuffer`）将 `init(0)` 与 `moof/mdat` 分片移交内容脚本；内容脚本经 `asr-decode` Port 以 `sourceMode: "stream"` 分块 Base64 推入 Offscreen（兼容 Chromium JSON 序列化 Port），并施加待解码队列背压上限；Offscreen 复用 [extension/asr/adts.ts](../../extension/asr/adts.ts)、Web Audio 重采样、`stream-chunker.ts` 与并发转写引擎，天然同时支持 Chromium Offscreen Document 与 Firefox 153+ Event Page 隐藏 `iframe`（[ADR-0017](0017-firefox-desktop-compatibility.md)）。YouTube 推流模式跳过 B 站 Referer DNR 规则注册。
- **ADTS 解封装加固**：[extension/asr/adts.ts](../../extension/asr/adts.ts) 改为标准 MPEG-4 Descriptor 变长解析 `esds`（修复 44.1 kHz 音轨回退 48 kHz 导致的时钟漂移），完整跳过 `trun` 的 `0x4` / `0x400` / `0x800` 标志字段并支持 `tfhd` `default_sample_size` 回退，支持按帧/时长预算控制吐出粒度以降低 YouTube 大 `moof`（5–10 秒）的首字延迟。

### 4. 触发门控、多音轨缓存键与 Agent 桥接

- **成本隔离与手动触发门禁**：遵守 [ADR-0011](0011-subtitle-prefetch-and-asr-isolation.md)，仅在确认真无字幕（`nativeTracks.length === 0`）且 `asrAutoFallback === true` 时自动回退 ASR；`youtube-captions-unavailable`（如 `exp=xpe` 拦截）或存在官方 `kind=asr` 时绝不自动偷跑付费接口。面板仅在「无字幕 / 字幕不可用」空态提供手动「使用语音转写」按钮（不向已有原生/自动字幕的轨道选择器增加常驻项），手动触发通过 `trigger: "manual"` 绕过 `asrAutoFallback === false` 拦截。
- **多音轨缓存键零迁移兼容**：[extension/subtitle/source-key.ts](../../extension/subtitle/source-key.ts) 的 `asr` `TrackIdentity` 增加可选 `audioTrackId`；缺省或为空时维持既有 `id_asr:<provider>:<model>:<lang>` 字节不变（B 站与单音轨零迁移），YouTube 多配音轨追加转义后的 `:<audioTrackId>`；[extension/asr/fallback.ts](../../extension/asr/fallback.ts) 显式透传 `site`。
- **本地 Agent 桥接**：放开已打开 YouTube 标签页的无字幕 ASR（仍走标签页内 `refreshClip` + 既有 `asrAutoFallback` 门控），并在 [extension/agent-bridge/content-subtitles.ts](../../extension/agent-bridge/content-subtitles.ts) 中将 YouTube ASR 产出的 `subtitle.source` 准确标为 `"asr"`。

## 考虑过的方案

- **纯按需注入（不静态挂 `document_start` 嗅探器）**：日常浏览零 `window.fetch` hook，但暂停态、已缓冲完毕或 Agent Bridge 无人值守调用时完全依赖 `playerResponse` 暴露 `poToken`，一旦缺失即卡死或报错，故选用 2–3 KB 极薄静态嗅探器 + 按需 SABR 引擎。
- **新增免重编码 `.m4a` 重封装直传**：虽可节省约一半上传带宽，但仍需先解码 PCM 做波谷 VAD，且需维护 ISO BMFF 重封装器与帧边界时间戳补偿；复用既有 16 kHz WAV 管线在 55 秒 1.76 MB 下已远低于各平台上限且双端兼容性更好。
- **首期引入播放头优先（Playhead-First）与 Seek 抢占**：需重写单调时间轴切片器、渐进合并器与整片时长校验，改动面与复杂度远高于文摘阅读器首期收益，保留为后续跨站演进项。

## 后果

- **验证门槛**：需覆盖 `adts.ts`（44.1 kHz 短长度 `esds`、`trun` 全 flags、`tfhd` 回退）、`sabr-protocol.ts`（Protobuf 改写、UMP 分包、Part 35/57/58/59、音轨匹配）、`offscreen-asr.ts` 推流模式与手动触发单测，并通过 Chromium/Firefox 双端构建与 `web-ext lint`。
- **审查红线**：
  - 不得在清单中新增 `https://*.googlevideo.com/*` 常驻 `host_permissions`，也不得通过伪装 `ANDROID` / `IOS` 客户端绕过 SABR/PO Token 校验。
  - 不得在 `youtube-captions-unavailable` 或存在 YouTube 官方 `kind=asr` 时静默自动触发付费 ASR。
  - 不得将完整 SABR 协议逻辑打入 40 KB 常驻 `content-resident.iife.js` 或 256 KB `background.js`。
