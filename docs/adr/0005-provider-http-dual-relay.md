# ADR-0005：跨上下文 AI 请求双代发通道与宿主权限代查

> 状态：有效

在 B 站页面源（`https://www.bilibili.com`）直接向第三方 AI 平台发起跨域 `fetch` 会受制于平台网关单方面固定的 CORS 预检白名单（如阿里云 ModelScope 的 Anthropic 端点预检头不含 `x-api-key` 与 `anthropic-version`，页面直发必败）。我们决定：**Content Script 发起的第三方平台 HTTP 请求一律由扩展上下文代发，严禁回落页面源直发**，并按请求时长与流式需求静态装配两条代发通道。

## 已定决策

### 1. 按请求形态静态分工的两条代发通道

通道选择在各业务链静态装配（能力由 `ProviderTransport.supportsStreaming` 表达），不做运行时切换或失败回落：

- **SW 短请求代发**（`extension/core/provider-http.ts`）：服务连通性探针、划词选区解释、联网搜索、AI / ASR 模型列表拉取等非流式短请求（`supportsStreaming: false`），固定 15s 超时覆盖响应头与正文，受后台生命周期约束。
- **Offscreen 长流式代发**（`extension/core/provider-http-offscreen.ts`，端口 `provider-http-offscreen`）：服务概览生成、快捷提问生成、AI 字幕翻译、视频伴看后台任务 4 条流式或分钟级长请求链（`supportsStreaming: true`）。一请求一端口、不设硬超时（由取消键或端口断连中止），一律按「响应头 `{ok, status}` → 正文分片 `{ok, chunk}` → `{done: true}`」流式分块回吐并在 Content 侧合成 `ReadableStream` `Response`，避免非流式长请求触发平台网关无字节超时（输出 token 上限治理见 [ADR-0006](0006-output-budget-wide-default-retreat-learned-cap.md)）。

### 2. Offscreen 代发端口 2s 活性确认（防死通道空挂）

- 当新请求与 Offscreen 闲置回收窗口撞车时，`runtime.connect` 建出的端口可能落到后台保活 `onConnect` 空监听上，既不回吐也不断连。
- Offscreen 收到 `provider-http` 消息后先于校验与 `fetch` 立即回传 `{ ok: true, accepted: true }` 派发确认；Content 侧若在 `DISPATCH_ACK_TIMEOUT_MS`（2s）内未收到确认或首包前即断连，立即断端口、等待 `DISPATCH_RETRY_DELAY_MS`（400ms）待旧文档关闭收尾后重跑 `ensure` 并重连一次，仍失败则报可读错误，杜绝界面永久静默挂起。

### 3. 宿主权限统一经后台真门预检

- Content Script 与 Offscreen 文档均无 `chrome.permissions` 访问权（在该语境直调权限检查只会退化为恒放行假门）。
- 所有跨上下文或 Offscreen 内部直发的平台请求（含 Offscreen 流式代发、Offscreen 对话链、Offscreen ASR 转写链）统一在链入口通过 `check-provider-origin` 消息交由后台真门预检（`core/host-permissions.ts` 的 `hasHostPermissionViaBackground` / `hasHostPermissionFromOffscreen`；SW 代发通道直接在后台本地校验），未授权立即返回可操作的 `HOST_PERMISSION_HINT`，不建无谓连接、不提前下载音频。

## 考虑过的方案

- **放宽 SW 代发超时承载分钟级请求**：破坏 15s 探针语义，且将长请求正确性押在 MV3 Service Worker 事件保活上限上不可靠。
- **在 Content Script 配合 DNR 改写请求头直发**：`declarativeNetRequest` 无法绕过浏览器对网页源施加的 CORS 预检拦截。
- **为个别网关特判改写协议鉴权头**：只能修补单一端点，无法覆盖同类固定预检白名单网关，且污染协议适配器单源契约。
