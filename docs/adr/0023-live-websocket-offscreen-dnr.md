# 实时伴看 WebSocket 承载于 offscreen 文档，握手机密与同源头由 DNR 会话规则注入

> 状态：有效

MOSS-LIVE 实时语音伴看通过 `wss://` 全双工连接收发控制事件与 16kHz/48kHz PCM 音频流，服务端在 WebSocket Upgrade 握手阶段要求校验 `Authorization: Bearer <key>` 请求头与合法的 HTTP(S) `Origin` 请求头，而浏览器原生 `WebSocket` API 不支持自定义请求头，且下行音频流依赖 `AudioContext` 无缝排队播放。

**决策**：实时伴看的 WebSocket 连接固定在 **offscreen 文档**（`extension/live/offscreen-moss-client.ts`，由 `entry/offscreen.ts` 经 `moss-live` 端口承载，`OFFSCREEN_CREATE_REASONS` 声明 `["BLOBS", "WEBSOCKET"]`，见 `commit caa70aeb`）中发起并持有；建连前由 Service Worker 经 `LiveSessionTracker.prepare` 注入 `declarativeNetRequest`（DNR）会话规则（`live/live-session-tracker.ts` 的 `setMossLiveWsAuthRule`，固定 `ruleId: 9002`，`resourceTypes: ["websocket"]`），对目标域名同时覆写 `Authorization` 与 `Origin` 请求头（`commit 3ef14b18`）；平台主机权限申请与预检必须同时覆盖 `http(s)://` 与 `ws(s)://` 两种协议（`commit 3f3e033f`）。

## 考虑过的方案

- **在 Service Worker 中直接发起 WebSocket**（否决）：① Chromium 存在未修复缺陷（`crbug/40815149`），从 Service Worker 内部发起的 WebSocket Upgrade 请求不经过 DNR `modifyHeaders` 管线，`Authorization` 与 `Origin` 无法注入；② Service Worker 无 `AudioContext`，下行 48kHz PCM 音频帧若跨端口逐帧转发至其它上下文播放会引入额外序列化开销与调度抖动。
- **在 Content Script（B 站页面源）中直接发起 WebSocket**（否决）：受宿主页面 CSP `connect-src` 约束；且若依赖 DNR 向页面源发出的 `websocket` 请求注入 `Authorization`，宿主页面同域脚本发起的 WebSocket 连接也会被一并附上平台 API Key，破坏密钥隔离边界。
- **仅申请 `https://` 主机权限或保留默认 `Origin`**（否决）：Chromium DNR `modifyHeaders` 拦截 `wss://` 请求要求扩展显式持有 `ws://` / `wss://` 协议的主机权限，仅授予 `https://` 时鉴权头会被静默跳过（`commit 3f3e033f`）；offscreen 扩展页面发起的 WebSocket 默认携带 `Origin: chrome-extension://<id>`，会被服务端同源校验拒绝，必须由同一条 DNR 规则同步改写为目标 `http(s)://` Origin（`commit 3ef14b18`）。

## 后果

- 架构评审（含 AI 代理）不得再提议将实时伴看 WebSocket（`OffscreenMossLiveClient`）迁回 Service Worker 或 Content Script。
- 凡依赖 DNR `modifyHeaders` 注入 WebSocket 握手头的平台，权限声明（`manifest.json` 的 `optional_host_permissions`）、手势链权限请求（`requestOrigins`）与会话预检（`LiveSessionTracker.prepare`）必须成对覆盖 `http(s)://` 与 `ws(s)://` 源。
- MOSS-LIVE 握手规则固定使用 `MOSS_LIVE_WS_RULE_ID = 9002`（与 ASR 动态规则池 `32001..32999` 隔离），生命周期由 `LiveSessionTracker` 按会话代际单点托管，防乱序 prepare 与过期 cleanup 踩踏在途连接的鉴权规则。同声传译（`/v1/realtime/interpret`）复用同一条规则（同域名同 Key）：伴看与同传为两个独立通道，各自维护会话所有权，规则按通道共享持有，任一方 cleanup 只在另一方也无持有时才真正清除。
