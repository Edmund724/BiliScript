# ADR-0015：实时伴看 Offscreen WebSocket 承载与 DNR 握手头注入

> 状态：有效

实时语音伴看（MOSS-LIVE 与 Gemini Live）通过 `wss://` 全双工连接收发控制事件与 PCM 音频流，服务端在 WebSocket Upgrade 握手阶段要求校验鉴权头与合法 `Origin`，而浏览器原生 `WebSocket` API 不支持自定义请求头，且下行音频流依赖 `AudioContext` 实时排队播放。

## 已定决策

1. **WebSocket 连接固定承载于 Offscreen 文档**：客户端（`extension/live/offscreen-moss-client.ts`、`offscreen-gemini-live-client.ts`）统一在 `entry/offscreen.ts` 内发起并持有连接。`shared/offscreen-constants.ts` 将 `OFFSCREEN_CREATE_REASONS` 锁定为 `["BLOBS"]`——Chromium 运行时拒收非法的 `"WEBSOCKET"` 原因，而 `"AUDIO_PLAYBACK"` 在无音频输出满 30 秒时会被浏览器强杀断连。
2. **后台按会话代际注入 DNR 握手规则（固定 `ruleId: 9002`）**：建连前由后台 `LiveSessionTracker.prepare`（`live/live-session-tracker.ts`）写入 `declarativeNetRequest` 会话规则（`MOSS_LIVE_WS_RULE_ID = 9002`，`resourceTypes: ["websocket"]`，与 ASR 动态规则池 `32001..32999` 及内置翻译请求头规则 `9003` 互不冲突），对目标域名同步覆写鉴权头（MOSS `Authorization: Bearer` / Gemini `x-goog-api-key`）与目标 `http(s)://` `Origin` 请求头，并按代际防并发建连与迟到清理互相踩踏。
3. **`http(s)://` 与 `ws(s)://` 主机权限成对声明与预检**：Chromium DNR `modifyHeaders` 拦截改写 `wss://` 握手要求扩展显式持有对应 `ws://` / `wss://` 主机权限（仅持 `https://` 会静默跳过头改写）。因此 `manifest.json` 的 `optional_host_permissions`、点击手势权限请求与 `LiveSessionTracker.prepare` 预检一律成对覆盖两种协议。

## 考虑过的方案

- **在 Service Worker 中直接发起 WebSocket**：Chromium 存在平台缺陷（`crbug/40815149`），Service Worker 内部发起的 WebSocket Upgrade 握手绕过 DNR `modifyHeaders` 管线导致鉴权头与 `Origin` 无法注入；且 Service Worker 无 `AudioContext`，跨端口逐帧转发下行 PCM 会引入序列化抖动。
- **在 Content Script（B 站页面源）中直接发起 WebSocket**：受宿主页面 CSP `connect-src` 拦截；且若对网页源发出的 `websocket` 注入鉴权头，同域页面脚本发起的连接也会被附上用户 API Key，破坏密钥隔离边界。
- **保留扩展页默认 `Origin`**：Offscreen 页面默认携带 `Origin: chrome-extension://<id>`，会被服务端同源校验直接拒绝。

## 后果

- **审查红线**：架构评审（含 AI 代理）不得再提议将实时伴看 WebSocket 客户端迁回 Service Worker 或 Content Script（前端浮窗宿主边界见 [ADR-0016](0016-live-companion-overlay-hosts.md)，Firefox 门控边界见 [ADR-0017](0017-firefox-desktop-compatibility.md)）。
