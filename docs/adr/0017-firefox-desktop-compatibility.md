# ADR-0017：桌面端 Firefox（153+）兼容架构与双目标发布边界

> 状态：有效

仓库同时支持 **Chromium（最低 Chrome 120）** 与 **桌面端 Firefox（最低 Firefox 153，对齐 ESR 153，不含 Android）**，采用**源码单源、双目标构建产物分离、后台 Event Page 隐藏 `iframe` 承载 Offscreen、预设域名常驻配自定义域弹窗授权**架构，在不放宽 Chromium 既有体积与权限守卫的前提下同仓演进。

## 已定决策

### 1. 目标基线、AMO 合规与三包发布

- Firefox 清单固定声明 `gecko.id = "biliscript@edmund724.github.io"`（绑定 `storage.sync` 与 MV3 签名）、`"strict_min_version": "153.0"`（省略 `gecko_android` 限定桌面端）及 `data_collection_permissions.required = ["websiteContent", "searchTerms", "authenticationInfo"]`（对齐 `PRIVACY.md`）。
- `scripts/build_release.py` 依次构建 `dist/` 与 `dist-firefox/`，同时产出 `BiliScript-v{version}-Chromium.zip`、`BiliScript-v{version}-Firefox.zip` 与供 AMO 审核复现构建的 `BiliScript-v{version}-Source.zip`。

### 2. Manifest 纯函数派生与显式 `extension_pages` CSP（`scripts/firefox-manifest.js`）

`extension/manifest.json` 保持为 Chromium 单一事实源；`pnpm build:firefox` 通过 `scripts/firefox-manifest.js` 纯函数派生 `dist-firefox/manifest.json`（具体字段转换由单测 `tests/build/firefox-manifest.test.ts` 锁死），核心边界如下：

- 后台改为 Event Page（`scripts` + `type: "module"`），剔除 Firefox 不支持的 `offscreen` / `tts` / `live.bilibili.com/*` 与全部 `web_accessible_resources`；
- 从 `extension/core/presets.ts` 官方 HTTPS 预设自动派生 **29 个常驻 `host_permissions` 域**（不含 `localhost` 与空 `custom`），消除常驻预设在 Firefox 非手势链路下的授权失败；
- **显式声明 `content_security_policy: { extension_pages: "script-src 'self'" }`**：Firefox MV3 默认 `extension_pages` CSP 隐含 `upgrade-insecure-requests`，若不显式覆盖，会把后台 Event Page 连往本机 Agent Bridge（`ws://127.0.0.1`）与本地服务（`http://localhost` Ollama / Whisper）的明文连接强升为 `wss://` / `https://` 导致握手失败。

### 3. Event Page 隐藏 `iframe` 承载 Offscreen 与 DNR 源适配（`extension/core/offscreen-host.ts`）

- 在无 `chrome.offscreen` 但具备完整 DOM 的 Firefox Event Page 中，`ensureOffscreenDocument()` 在后台 `document.body` 下幂等挂载 `<iframe id="biliscript-offscreen-iframe" src="entry/offscreen.html" hidden>` 并等待首次加载；关闭时移除该节点释放解码内存。子帧内的 `runtime.sendMessage` 与 `runtime.connect` 原生触发父级 Event Page 监听器并维持活跃端口保活，零侵入复用跨帧协议、[ADR-0001](0001-background-no-runtime-lazy.md) 256KB 后台体积守卫与 [ADR-0018](0018-layered-storage-and-extension-idb.md) 存储拓扑。
- 注入 DNR 会话规则时，从 `runtime.getURL("")` 提取 `moz-extension` UUID 主机名作为 `initiatorDomains`（规避含 `@` 的 `gecko.id` 被 Firefox DNR 校验拒绝），异常时降级 `tabIds: [-1]`。

### 4. 无端口 Match Pattern 与自定义域独立弹窗授权

- Firefox Match Pattern 禁止携带显式端口（如 `http://localhost:11434/*` 非法），`core/host-permissions.ts` 通过 `toPermissionMatchPattern` 统一剥离端口为 `${protocol}//${hostname}/*`。
- Firefox 不将网页 Content Script 转发的消息视为合法扩展用户手势。`core/host-permission-handlers.ts` 保持入口零 `await` 同步调 `chrome.permissions.request`（兼容 Chromium 手势链）；当 Firefox 因手势缺失抛错时，先经 `permissions.contains` 复核（命中 29 个常驻预设域直接放行），确属未授权自定义反代或本地地址时打开 `entry/permission-grant.html` 弹窗（配 `permission-grant-keepalive` 端口防等待期 Event Page 休眠）由用户单击完成原生授权。

### 5. `XrayWrapper`、CSS 滚动条隔离与功能门控边界

- **禁劫持 DOM 属性描述符**：Firefox Content Script 的 `XrayWrapper` 会使覆写原生 DOM 属性描述符（如拦截 `hidden`）失效，组件显隐同步统一使用原生 `MutationObserver`（`attributeFilter: ["hidden"]`）。
- **Content Script 禁止构造 `new ReadableStream({...})`**：Firefox Content Script 的 `XrayWrapper` 会在构造 WebIDL `ReadableStream` 时跨 compartment 读取沙箱配置对象属性（触发 `Permission denied to access property "autoAllocateChunkSize"`），流式代发在同 realm 用纯 JS 队列合成响应对象。
- **Firefox 滚动条样式隔离**：`scrollbar-width` 与 `scrollbar-color` 必须包裹在 `@supports (-moz-appearance: none)` 内，严禁裸写以免覆盖 Chromium 121+ 的 `::-webkit-scrollbar` 定制样式；滑块补齐 `::-moz-range-track` / `::-moz-range-thumb`。
- **门控隐藏 `tts` 与 `live`**：Firefox 无 `chrome.tts`，且实时伴看涉及媒体捕获前缀与 WSS DNR 差异，当前在 Firefox 下完整门控隐藏对话朗读、视频页伴看入口与设置分区，核心阅读（[ADR-0003](0003-light-dom-script-panel.md)）、双轨翻译、概览、对话、金句导出、Agent 桥接与无字幕 ASR 全量交付。

## 考虑过的方案

- **单份 `manifest.json` 混写双端字段或申请 `<all_urls>` 常驻权限**：前者触发 Firefox 未知字段警告并扩大 Chromium 权限提示，后者违背最小权限原则并引发 AMO 高风险人工审查。
- **将 `offscreen.ts` 直接并入 Event Page 主窗口**：同窗口 `runtime.sendMessage` 不自触发 `onMessage`，需另造进程内回环总线并撑破 256KB 后台静态图上限。

## 后果

- **审查红线**：
  - 不得将 `<all_urls>` 或 `https://*/*` 移入任一端的常驻 `host_permissions`；Firefox 常驻预设域必须由 `presets.ts` 官方 HTTPS 预设自动派生并经单测锁死。
  - 不得在未包裹 `@supports (-moz-appearance: none)` 的选择器上裸写 `scrollbar-width` 或 `scrollbar-color`。
  - 二期专项立项验收前，不得在 Firefox 构建中暴露半成品 `live` 实时伴看或 `tts` 朗读入口。
