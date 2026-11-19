# ADR-0028：桌面端 Firefox（140+）兼容架构与双目标发布边界

> 状态：有效

我们决定正式重开并落地 **桌面端 Firefox（140.0 及以上）** 兼容支持，取代早期单平台裁决（[ADR-0002](0002-chrome-only.md)）。本次兼容采用**「双目标构建产物分离 + 后台 Event Page 挂载隐藏 `iframe` 承载 Offscreen + 主流预设域名常驻与自定义地址独立弹窗授权 + 首期聚焦核心阅读与无字幕 ASR」**的技术路线，在不放松既有 Chromium 构建体积与架构守卫的前提下实现双端同仓演进。

## 背景与重开依据

[ADR-0002](0002-chrome-only.md) 当年决定仅维护 Chromium 变体，列出了两项重开前提：「提供与 Script 等价的阅读载体」与「提供 offscreen 音频能力替代，并重新验收播放器同步、音频处理与发布范围」。当前代码库演进已使两项前提同时成熟：

1. **阅读载体已彻底页面内化**：[ADR-0006](0006-script-host-panel.md) 已将唯一交互界面收敛为注入 B 站视频页右栏的文摘阅读面板（`#biliscript-reading-view`）与设置抽屉，完全不依赖 Chrome `sidePanel` 或 Firefox `sidebar_action`。
2. **Firefox MV3 Event Page 天然具备完整 DOM 与音频解码能力**：Firefox 虽未实现扩展 `service_worker`（[MDN `manifest.json/background`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background)）与 `offscreen` API（[MDN WebExtensions API 兼容性表](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Browser_support_for_JavaScript_APIs)），但其 MV3 后台运行在带完整 `window` 与 DOM 的非持久化 Event Page 中（[MDN `Background scripts`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts)），且自 Firefox 113 起支持 `declarativeNetRequest.updateSessionRules` 请求头改写（[MDN `declarativeNetRequest`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest)），足以完整支撑无字幕 ASR 下载解码、概览流式代发与多轮对话。
3. **AMO 合规基线明确**：自 2025 年 11 月起，提交至 Mozilla 官方商店（AMO）的新扩展必须声明内置数据收集披露字段 `browser_specific_settings.gecko.data_collection_permissions`，该字段自 **Firefox 140** 起在桌面端完整支持（[MDN `browser_specific_settings`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings)）。

## 已定决策

### 1. 目标平台、最低版本与分发合规

- **仅支持桌面端 Firefox 140+**：Firefox 产物清单固定声明 `"strict_min_version": "140.0"`，显式省略 `gecko_android` 键以将商店分发范围限定在桌面端 Firefox（[MDN `browser_specific_settings`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings)）。Chromium 端继续维持 Chrome 120 基线不变。
- **固定扩展 ID 以绑定同步存储**：Firefox 下 `storage.sync` 依赖固定扩展 ID 工作（[MDN `storage.sync`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/sync)），且 MV3 签名强制要求提供 `gecko.id`。默认采用 `"biliscript@edmund724.github.io"`（首次提交 AMO 签名前确认锁定，一经发布永不变更）。
- **内置数据收集披露**：对齐仓库 `PRIVACY.md` 披露的数据流向與 [Firefox 内置数据授权规范](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)，在 `gecko.data_collection_permissions` 中声明 `"required": ["websiteContent", "searchTerms", "authenticationInfo"]`（分别对应发往用户所选 AI/ASR/内置翻译服务的视频字幕与音频片段、联网搜索查询词、以及用户自带的第三方平台 API Key）。
- **双渠道签名分发与源码包配套**：正式版上架 AMO 官方商店（Listed），审核通过后下载 AMO 签名生成的 `.xpi` 随 GitHub Releases 一并发布（[AMO 签名与分发概览](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)）；因构建管线包含 `esbuild` 打包压缩与定制脚本，`scripts/build_release.py` 同步产出可离线复现的源码压缩包供 AMO 审核上传（[AMO 源码提交要求](https://extensionworkshop.com/documentation/publish/source-code-submission/)）。

### 2. 双目标构建与 Manifest 派生（源码单源、产物分离）

- **保留 `extension/manifest.json` 为 Chromium 单一事实源**：不把双端冲突键塞入同一份静态文件，避免 Firefox 对 `"offscreen"`、`"tts"`、`"minimum_chrome_version"` 持续抛出安装警告，同时保证既有 Chromium 清单守卫单测（`tests/asr/manifest-asr-host.test.ts`、`tests/search/manifest-search-host.test.ts`）零破坏。
- **构建期纯函数派生 `dist-firefox/manifest.json`**：新增 `--target=firefox` 构建通道（`pnpm build:firefox`），输出至独立目录 `dist-firefox/`：
  - 将 `background` 由 `{ "service_worker": "entry/background.js", "type": "module" }` 转换为 `{ "scripts": ["entry/background.js"], "type": "module" }`（[MDN `manifest.json/background`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background)）；
  - 从 `permissions` 中移除 `"offscreen"` 与 `"tts"`，移除顶层 `"minimum_chrome_version"`；
  - 注入 `browser_specific_settings.gecko`（`id`、`strict_min_version: "140.0"`、`data_collection_permissions`）；
  - 首期移除 `https://live.bilibili.com/*` 内容脚本条目及对应的 `web_accessible_resources.matches` 项。

### 3. Offscreen 宿主采用方案 A（后台 Event Page 动态挂载隐藏 `iframe`）

- **宿主适配收口在 `extension/core/offscreen-host.ts`**：在不支持 `chrome.offscreen`（[Chrome `browser.offscreen` 文档](https://developer.chrome.com/docs/extensions/reference/api/offscreen)）但具备 `document` 的 Firefox Event Page 语境下：
  - `ensureOffscreenDocument()` 在后台 `document.body` 下幂等创建 `<iframe id="biliscript-offscreen-iframe" src="entry/offscreen.html" hidden>` 并等待首次 `load` 完成；
  - `hasExistingOffscreenDocument()` 直接检查该 `iframe` 节点及其 `contentWindow` 是否存活；
  - `closeOffscreenDocument()` 将该 `iframe` 从 DOM 移除，立即释放子文档上下文与解码缓冲；
  - `isOffscreenDocumentSender(sender)` 维持 `!sender?.tab && sender?.url === chrome.runtime.getURL(OFFSCREEN_URL)` 判据不变。
- **保持跨帧消息契约与构建守卫不变**：由于 `entry/offscreen.html` 运行在独立子 frame `window` 中，子帧调用的 `chrome.runtime.sendMessage` 与 `chrome.runtime.connect`（`offscreen-chat`、`provider-http-offscreen`、`asr-decode`）均会原生触发父级 Event Page 的 `runtime.onMessage` / `runtime.onConnect`（[MDN `runtime.onMessage`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/onMessage)），且活跃 `Port` 会阻止 Event Page 空闲休眠（[MDN `Background scripts`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts)）。`entry/offscreen.ts` 内的按需 `import()` 懒加载、`ADR-0027` 存储单点宿主约束及 `scripts/build.js` 的 256 KB 后台静态图守卫全部原样保留。

### 4. 主机权限双层策略与无端口 Match Pattern 归一化

- **主流官方预设域名进 Firefox 常驻 `host_permissions`**：Firefox 不把网页 Content Script 转发到后台的点击视为合法扩展用户手势（[MDN `User actions`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/User_actions)）。为保证主流平台在侧栏设置抽屉内保存时零弹窗顺滑落盘，构建期从 `extension/core/presets.ts` 的 `PRESETS`（含 `protocolBaseUrls`）与 `ASR_PROVIDER_PRESETS` 自动提取全部官方 HTTPS 域名并入 Firefox `host_permissions`（在既有 15 个常驻域基础上新增硅基流动、通义千问、智谱、Kimi、MiniMax、小米 Mimo、Opencode Go、OpenRouter、阶跃星辰、ModelScope、AMD、商汤 SenseNova、Google Gemini 共 13 个官方域，合计 **28 个常驻域**；不含本地 `http://localhost` 预设与空 `custom` 项）。
- **无端口 Match Pattern 归一化**：Firefox 的权限 Match Pattern 不支持显式端口号（如 `http://localhost:11434/*` 会报格式非法，`http://localhost/*` 即匹配任意端口，见 [MDN `Match patterns`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Match_patterns)）。在 `extension/core/host-permissions.ts` 新增面向 `chrome.permissions.contains` / `request` / `remove` 的无端口归一化函数 `toPermissionMatchPattern`（输出 `${protocol}//${hostname}/*`），同时保持纯展示/键提取逻辑向后兼容。
- **自定义中转与本地地址走轻量扩展弹窗授权**：`entry/background.ts` 的 `handleRequestProviderOrigins` 保持入口同步直调 `chrome.permissions.request`（零先行 `await`，不破坏 Chromium 手势守卫 `tests/ui/options-save-gesture.test.ts`）。当 Firefox 因缺少扩展页手势抛错时，捕获分支先经 `chrome.permissions.contains` 复核（命中常驻域则直接返回 `{ ok: true }`）；仅当确属未授权的自定义中转域或本地地址（如 Ollama / 本地 Whisper）时，通过 `chrome.windows.create({ type: "popup" })` 打开极简扩展自有授权页 `entry/permission-grant.html`，由用户在扩展页内点击一次按钮完成原生手势授权并回传结果。

### 5. 首期功能范围、CSS 渐进降级与 T2 自动化验证

| 领域 | 首期（Phase 1）裁决 | 备注与二期重开条件 |
| :--- | :--- | :--- |
| **核心与 ASR 能力** | 全量交付文摘面板、字幕提取与双轨翻译、IndexedDB 多级缓存、全局概览、AI 对话、金句导出、Agent 桥接及无字幕 ASR 转写 | 全部复用既有业务代码与方案 A 子帧宿主 |
| **语音朗读（TTS）** | 在 Firefox 下门控隐藏对话气泡朗读按钮与语音音量设置项 | Firefox 无 `chrome.tts`（[MDN API 兼容性表](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Browser_support_for_JavaScript_APIs)）；二期视需求评估页面内 Web Speech API `speechSynthesis` 适配 |
| **实时伴看（Live）** | 在 Firefox 下门控隐藏视频页伴看开关、对话语音通话入口、设置面板伴看分区，且不注入直播间脚本 | 规避 `mozCaptureStream` 差异、WSS DNR 头改写与液态玻璃滤镜重做成本；待首期稳定后单独评估二期立项 |
| **CSS 样式兼容** | 用 `@supports (-moz-appearance: none)` 隔离注入 `scrollbar-width: thin` 与 `scrollbar-color`；为 `.biliscript-range-input` 补齐 `::-moz-range-track` 与 `::-moz-range-thumb` | 严禁在无 `@supports` 守卫下裸写标准滚动条属性（否则 Chrome 121+ 会跳过 `::-webkit-scrollbar` 回退成粗灰条）；`corner-shape` 在 Firefox 下自然降级为标准 `border-radius` 圆角（[MDN `corner-shape`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/corner-shape)） |
| **自动化测试（T2）** | Vitest 单测守卫 + `pnpm dlx web-ext lint`（[`web-ext` 官方工具指南](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/)） + 1 个覆盖平台分叉点的 Firefox 真机冒烟脚本 | 只测构建清单、Event Page 子帧挂载、DNR 会话规则与自定义权限弹窗等真实分叉面，不重复建设全量 UI E2E |

## 考虑过的方案

- **单份 `manifest.json` 同时塞入双端字段**（否决）：Firefox 加载含 `"offscreen"`、`"tts"`、`"minimum_chrome_version"` 的清单会持续输出未知权限/字段警告，且把 13 个 AI/ASR 预设域强行塞进 Chromium 常驻权限会扩大 Chrome 端安装与更新时的权限提示范围，破坏既有最小权限单测契约。
- **Offscreen 方案 B：把 `offscreen.ts` 直接合流进 Firefox Event Page 主窗口**（首期否决，保留远期演进可能）：同窗口内调用 `runtime.sendMessage` 不会触发自身的 `runtime.onMessage`（[MDN `runtime.onMessage`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/onMessage)），需要为 7 类后台消息与 3 条 `Port` 通道额外维护一套进程内 Loopback 总线，还会打破 `scripts/build.js` 的 256 KB 后台体积守卫。方案 A 仅改 `core/offscreen-host.ts` 约 50 行代码即可零侵入复用全套双上下文契约，且随时可无痛演进。
- **申请 `<all_urls>` 常驻权限以彻底绕开 Firefox 手势限制**（否决）：违背仓库最小权限原则，在 AMO 人工审核中属于高风险审查项，也会显著降低用户安装信任度。
- **首期同步改写 Web Speech API 朗读与 `mozCaptureStream` 实时伴看**（否决）：这两块涉及跨端音色枚举差异、媒体流捕获前缀与 WebGL/SVG 镜面降级，工作量占整体一半却非核心高频路径，延期至二期可大幅缩短首期交付周期。

## 后果

- `AGENTS.md` 解除「仅支持 Chromium」限制，确立 Chromium 120+ 与桌面端 Firefox 140+ 双目标边界。
- `scripts/build_release.py` 升级为同时产出 `BiliScript-v{version}-Chromium.zip`、`BiliScript-v{version}-Firefox.zip` 与 `BiliScript-v{version}-Source.zip` 三份发布物。
- **审查红线**：
  - 架构评审（含 AI 代理）不得提议将 `<all_urls>` 或 `https://*/*` 移入任一端的常驻 `host_permissions`；Firefox 新增常驻域必须严格由 `extension/core/presets.ts` 的官方 HTTPS 预设自动派生并经单测锁死。
  - 架构评审（含 AI 代理）不得在未包裹 `@supports (-moz-appearance: none)` 的选择器上裸写 `scrollbar-width` 或 `scrollbar-color`，以免破坏 Chromium 121+ 的 `::-webkit-scrollbar` 定制外观。
  - 在二期专项立项前，不得在 Firefox 构建中半吊子暴露未验收的 `live` 实时伴看或 `tts` 朗读 UI 入口。
