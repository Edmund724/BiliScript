# ADR-0016：实时伴看浮窗主承载架构：视频页与直播间双宿主边界

> 状态：有效

实时伴看在**视频页**与**直播间**统一由播放器内伴看浮窗（`extension/live/fullscreen-live-overlay.ts` + `live-overlay-binding.ts`）主承载全双工语音对话与快捷音频控制（后台 WebSocket 承载见 [ADR-0015](0015-live-websocket-offscreen-dnr.md)），全屏与非全屏共用同一浮窗组件，同时按视频页与直播间的载体差异划分双宿主边界。

## 已定决策

### 1. 双端共用的播放器浮窗承载

- 浮窗监听 `fullscreenchange` / `webkitfullscreenchange` 与容器尺寸变化，在全屏容器与 `.bpx-player-container` 间自动迁移挂载；首次从空闲启动或进入失败态时默认展开（`forceExpand: true`），支持最小化为胶囊并通过 `live/viewport-drag.ts` 左右边缘就近吸附记忆侧向偏移。
- 语音实时转写与助手语音回复仅在浮窗内展示，不混入文本 AI 对话历史消息流。

### 2. 视频页：独立会话属主 + 文摘面板轻量协同

- **生命周期解耦**：视频页伴看会话由 `live/live-companion-session.ts` 独立持有，关闭右栏文摘面板（[ADR-0003](0003-light-dom-script-panel.md)）只终止面板文本生成与朗读，**不销毁在途伴看连接与浮窗**。
- **双入口与状态/工具协同**：可从播放器控制栏快捷按钮或对话面板空态发送键启动（启动时中止在途面板文本流）。文摘面板打开时，对话区顶部由 `reader/chat-live-status.ts` 展示连接状态条与控制动作；伴看期间触发的文本模型委派结果（`LiveTextToolRecord`）保存为面板历史中独立的只读「伴看记录」条目；伴看音频偏好在浮窗弹层与设置抽屉「实时伴看」分区同源读写（`live/live-audio-settings.ts`）。

### 3. 直播间：独立按需分组分流，不加载文摘面板

- **入口分流与无 `bvid` 会话身份**：B 站直播间（`live.bilibili.com/<房间号>` 及 `/blanc/<房间号>` 同源内嵌播放器）无 `bvid`/`cid`、无字幕与章节。`entry/content.ts` 命中 `isLiveRoomPage()` 时直接按需加载 `g-live-room` 经典 IIFE 分组（含 `live/live-room-entry.ts` 与 `live/live-room-settings.ts`，详见 [ADR-0004](0004-content-two-round-build-and-reader-gate.md)；视频页永不加载，Firefox 下直接退出，见 [ADR-0017](0017-firefox-desktop-compatibility.md)），**不挂载文摘面板、阅读壳、字幕与文本对话链路**。会话身份为房间号（`MossLiveRoomContext`，注入房间标题与主播名，不抓弹幕，换房即新会话、不持久化）。
- **页面工具封禁与就地设置**：直播间不暴露视频页专属工具（Gemini 仅声明联网搜索；MOSS 通过系统提示词声明不可用并在客户端 `executeTool` 硬拒绝执行）。点击浮窗设置键或失败卡入口时直接就地打开轻量伴看设置弹窗完成平台与密钥配置并重连。

## 考虑过的方案

- **视频页彻底剥离文摘面板侧一切伴看感知**：用户打开面板时看不到伴看运行状态，也无法回看关闭浮窗前的长篇文本委派结果。
- **直播间强行裁剪挂载右栏文摘面板**：直播以全屏观看为主且缺失字幕/分P/历史身份前提，拆改阅读壳底座收益极低。
- **把语音对话直接写进面板对话历史**：口语碎句污染文本多轮问答上下文并争用会话持久化模型。
