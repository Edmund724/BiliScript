# 实时伴看与实时字幕翻译域词表（Live）

返回根索引：[GLOSSARY.md](../../GLOSSARY.md) · 相关架构裁决：[ADR-0015](../adr/0015-live-websocket-offscreen-dnr.md)、[ADR-0016](../adr/0016-live-companion-overlay-hosts.md)、[ADR-0017](../adr/0017-firefox-desktop-compatibility.md)。

## 实时伴看与浮窗

### 实时伴看

在观看视频或 B 站直播时，与 AI 语音助手建立低延迟双工音画交互的伴随式对话能力（Chromium 专属，Firefox 按 [ADR-0017](../adr/0017-firefox-desktop-compatibility.md) 隐藏入口）。视频页会话独立于文摘面板生命周期，关闭面板不销毁伴看；入口在播放器控制栏与对话空态发送键，启动时中止在途面板文本流；对话面板打开时展示伴看状态条，并将文本模型委派记录保存为只读「伴看记录」条目。WebSocket 固定在 `["BLOBS"]` Offscreen 文档发起，由 SW DNR 规则 `9002` 注入鉴权头与 `Origin`。

- 代码锚点：`extension/live/live-companion-session.ts`、`extension/live/live-overlay-binding.ts`、`extension/live/player-live-toggle.ts`、`extension/live/player-notice.ts`、`extension/live/offscreen-live-session-runtime.ts`、`extension/reader/chat-live-status.ts`
- _Avoid_: 语音对话、实时通话、把伴看说成与主播或弹幕互动

### 伴看浮窗

实时伴看在播放器内的统一浮窗（`FullscreenLiveOverlay`），全屏与非全屏共用并监听全屏切换自动迁移挂载宿主；首次从空闲启动或失败时默认展开，可最小化为状态胶囊；支持在播放器容器内拖动并按左右边缘就近吸附。

- 代码锚点：`extension/live/fullscreen-live-overlay.ts`、`extension/live/viewport-drag.ts`、`extension/live/audio-popover.ts`
- _Avoid_: 伴看面板、全屏浮窗（不再限于全屏）

### 直播间伴看

在 B 站直播间（`live.bilibili.com/<数字房间号>` 及 `/blanc/<数字房间号>`）通过按需经典组 `g-live-room` 承载实时伴看：仅挂载伴看浮窗与播放器开关，不挂载文摘面板，设置经按需伴看设置对话框就地配置。会话身份为房间号，上下文仅含实时音视频流、房间标题与主播名，无字幕/概览/章节且不抓弹幕。

- 代码锚点：`extension/live/live-room-entry.ts`、`extension/live/live-room-settings.ts`、`extension/live/lazy-live-room.ts`
- _Avoid_: 直播面板、直播总结、把房间号当 `bvid`

## 伴看音频与混音

### 视频原声共享与语音优先

- **视频原声共享（`liveShareVideoAudio`）**：将当前视频音频流与用户麦克风音频在本地混音后输入 AI，使其可听取视频对白与音效。_Avoid_: 屏幕音频录制、系统内录。
- **语音优先（`liveVoicePriority`）**：检测到用户说话或 AI 播报回复时自动压低视频播放音量，结束后平滑恢复。_Avoid_: 闪避、自动静音。
- **伴看音频同步**：`liveVoiceVolume`、`liveVoiceSpeed`、`liveShareVideoAudio` 与 `liveVoicePriority` 在设置抽屉「实时伴看」子页与伴看浮窗音频弹层共用同一组设置键，经 live 域叶子跨标签页实时同步；对话朗读音量 `speechVoiceVolume` 归属对话朗读设置，不与伴看音量混称。

- 代码锚点：`extension/live/live-audio-settings.ts`、`extension/live/page-media-capture.ts`、`extension/live/pcm-capture-core.ts`、`extension/live/moss-audio-player.ts`
- _Avoid_: 为浮窗另建会话级音频偏好副本、把对话朗读音量与伴看音量混称

## 伴看记录（`"live-text-tool"`）

### 只读伴看记录与 IDB v4 懒水合

实时伴看期间委派后台文本模型处理的工具查询结果，以 `kind: "live-text-tool"` 落盘于 IDB v4 的 `conversation_meta` 与 `conversation_messages`（通过 SW 原子 RPC 合并同一视频的 `records` 列表，受 `MAX_LIVE_TEXT_TOOL_RECORDS_PER_VIDEO` 约束）。对话历史列表仅消费轻量头字段 `recordCount`，不将整份 `records` 文本常驻内容页内存；用户点击打开伴看记录详情时再按 `id` 异步水合完整 `records`。

- 代码锚点：`extension/live/live-text-tool-history.ts`、`extension/live/live-text-tool-records.ts`、`extension/reader/chat-live-text-records.ts`、`extension/reader/chat-lists.ts`、`extension/subtitle/idb-store.ts`
- _Avoid_: 把伴看语音转写写入普通面板对话历史、在内容页列表常驻全量 `records`

## 实时字幕翻译

### 播放器内双语/译文叠层

播放器内承载的实时字幕翻译叠层与菜单：无原生 CC 轨时基于播放游标滑动窗口调度 ASR 切片转写与 LLM 逐句翻译；已有跨语种原生多轨时默认零 Token 按时间交集配对；单语种原生轨（含繁简同族）按需流式翻译并过滤同语种族目标语言。有原生 CC 时控制栏按钮以「双语」与原生「字幕」区分，未开启时不发请求、不接管原生字幕层；激活时无损隐藏原生字幕 DOM，关闭即恢复。上下行顺序共用 `bilingualDisplayOrder`。

- 代码锚点：`extension/live/interpret-session-controller.ts`、`extension/live/player-interpret.ts`、`extension/live/interpret-subtitle-preferences.ts`、`extension/asr/asr-setup.ts`
- _Avoid_: 同声传译、同传、把译文写回 `clip.subtitles` 或篡改原生主轨为 `asr`
