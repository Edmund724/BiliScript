# ADR-0004：Content 经典脚本粗粒度分组、ISOLATED 注册表与懒域宽类型门面

> 状态：有效

为彻底消除 Content Script 在受 Service Worker 与 `Connection-Allowlist(-Report-Only)` 控制的宿主页面上发起 `chrome-extension://` / `moz-extension://` JS 子资源请求（`modulepreload` 与 ESM 动态 `import()`），同时兼顾首帧按钮注入速度、按需包体隔离、按钮交互预注入与双端发布预算，Content Script 采用**经典 IIFE 粗粒度分组（含跨宿公共交集组 `g-shared`）+ `ISOLATED` world `globalThis` 共享注册表与单例槽 + 后台静态白名单 `executeScript` 按需注入（含直播间域宿主权限补齐与按钮悬停/聚焦预注入）+ 懒域宽类型双通道门面**架构。

## 已定决策

### 1. 首帧直注、经典 IIFE 粗粒度分组与公共交集组（`scripts/build-content.js`）

- **全经典脚本交付（零页面侧模块请求）**：Content Script 全量产物以经典 `iife` 格式构建与加载，不生成、不引用页面上下文的 ESM 动态 `import()` 或 `<link rel="modulepreload">`（`extension/entry/onboarding-entry.ts` 作为扩展自有页面脚本回归 `scripts/build.js` 独立打包，不进入内容脚本分组）。
- **合并首帧常驻壳与有状态基础导出（`entry/content-resident.iife.js`）**：
  - `extension/manifest.json` 的视频页 `content_scripts[0].js` 与直播页 `content_scripts[1].js` 均直接静态注入单个合并文件 `["entry/content-resident.iife.js"]`，消除启动引导链与冷启动唤醒后台的额外往返。
  - 常驻 IIFE 将 `extension/entry/content.ts` 与核心有状态单例模块（`core/state.ts`、`shared/{logging,messaging,content-event-bus,lazy-import,watch-storage-keys}.ts`、`ai/lazy-player-ai.ts`、`reader/lazy-{reader,shell}.ts`、`subtitle/lazy.ts`、`ui/lazy-ui.ts`）的**显式具名导出**注册到 `ISOLATED` world 的 `globalThis.__BILISCRIPT_RT__`，并注入幂等重入守卫与分块加载器 `globalThis.__BILISCRIPT_LOAD_CHUNK__`。严禁对共享模块使用全量 `import *` 导出或拆分为多文件常驻加载（避免破坏 tree-shaking 与跨文件内联导致常驻包体膨胀至 50–63 KB）。
- **6 按需业务分组 + 跨宿公共交集组 `g-shared`（`V2-app + M2 + M3 + L3`）**：
  - 按业务生命周期划分按需经典 IIFE 组：**首帧控件组 `g-buttons`**（`script-button`、`player-ai`、`playback-rate`、`youtube/host-adapter`）、**首帧字幕分组 `g-subtitle`**（`subtitle/fetcher.ts`、`subtitle/ui.ts`、`subtitle/asr-translation.ts`、`youtube/gateway.ts`，注册共享树摇具名导出至 `globalThis.__BILISCRIPT_SUBTITLE__` 并置 `globalThis.__BILISCRIPT_SUBTITLE_READY__ = true`，不反向依赖 `g-shared` 或前置拉入 `g-app`）、**核心应用组 `g-app`**（阅读面板壳层、阅读域、AI 概览与对话、无字幕 ASR、播放器实时伴看与同传、Agent 桥接）、**富文本子图组 `g-mermaid`**（`ui/mermaid-render.ts`）、**数学公式组 `g-math`**（`ui/math-render.ts`）以及**直播间组 `g-live-room`**（`live/live-room-entry.ts`、`live/live-room-settings.ts`，仅 Chromium 构建），各自写入 `globalThis.__BILISCRIPT_CHUNKS__[moduleId]`。
  - **跨宿公共交集组 `g-shared`（`entry/chunks/g-shared.iife.js`）**：收拢阅读/设置/直播/引导页共用的公共模块（设置与供应商编辑器、模型目录、AI 协议适配器与思考事实表等）并挂载至 `globalThis.__BILISCRIPT_SHARED__`，且**不反向依赖 `content-resident.iife.js` 或 `g-subtitle`**。视频页按需加载 `g-app` 时由 `__BILISCRIPT_LOAD_CHUNK__` 先行并确保 `g-shared` 与 `g-subtitle`（`needsShared`、`needsSubtitle`）均就绪；直播页按需加载 `g-live-room` 时前置注入 `g-shared`（`needsShared = true`、`needsSubtitle = false`）；`extension/onboarding.html` 通过同源经典 `<script>` 直接复用同一份 `g-shared.iife.js`。
  - **esbuild 注册表桥接插件**：构建期通过 `onResolve`（标记 `sideEffects: false` 以保留 Firefox 平台 `live` 死代码裁剪）将共享核心导入重写为读取 `globalThis.__BILISCRIPT_RT__`；将属于 `g-shared` 的导入（含 `g-shared` 内部动态 `import` 的 `ui/provider-editor.ts` 与 `ai/model-catalog.ts`）重写为同步读取 `globalThis.__BILISCRIPT_SHARED__`；将 `g-app` 中与 `g-subtitle` 重叠的非 `g-shared` 核心模块重写为同步读取 `globalThis.__BILISCRIPT_SUBTITLE__`（具名导出按需树摇，不重复打包）；将跨组动态 `import()` 重写为 `__BILISCRIPT_LOAD_CHUNK__(groupId, moduleId, needsShared, needsSubtitle)`、同组动态 `import()` 重写为读取 `__BILISCRIPT_CHUNKS__`。
- **交互触发预注入（`extension/ui/panel-preload.ts`）**：
  - 放弃基于 `<link rel="modulepreload">` 的页面请求与 `requestIdleCallback` 空闲预加载，视频页首帧仅按需注入 `g-buttons` 与 `g-subtitle`（除常驻包外首帧注入 `≤ 300 KB`）；仅在用户将指针悬停（`pointerenter`）或聚焦（`focus`）到文摘/播放器按钮时，经 `__BILISCRIPT_CHUNK_INFLIGHT__` 确保 `g-shared` 与 `g-subtitle` 均已就绪后按需预注入 `g-app`（一次触发、幂等去重、不阻断主流程）。
- **扩展自有引导页复用（`extension/onboarding.html`）**：
  - `extension/entry/onboarding-entry.ts` 作为独立经典脚本（`entry/onboarding-entry.js`）由 `scripts/build.js` 构建；`onboarding.html` 按序以同源 `<script>` 加载 `./entry/theme-init.js`、`./entry/chunks/g-shared.iife.js` 与 `./entry/onboarding-entry.js`，原生满足 Chromium 默认 CSP 与 Firefox `extension_pages: "script-src 'self'"`，无需放宽 CSP。
- **双端体积与图谱守卫**：
  - 硬体积预算：`MAX_RESIDENT_BYTES = 46080`（首帧常驻）、除常驻包外视频页首帧不悬停额外注入 `≤ 300 KB`（`g-buttons + g-subtitle`）、`BACKGROUND_JS_MAX_KB = 256`（`262,144 B`）、Chromium `DIST_RUNTIME_MAX_BYTES = 4350000`、Firefox `DIST_RUNTIME_MAX_BYTES = 4050000`、双端 `Release ZIP ≤ 1,200,000 B`。
  - `scripts/build-content.js`、`scripts/build.js` 与 `scripts/build_release.py` 强制执行上述体积阈值及 `assertAnalysisNotInReaderGraph`、`assertScriptButtonSlim`、`assertPlayerAiSlim`、`assertMermaidStubsApplied`、`assertFirefoxLivePruned` 等图谱/替身守卫。

### 2. 后台静态白名单 `executeScript`、发起方锁定与 `live.bilibili.com` 宿主权限（`extension/core/content-chunk-handlers.ts`）

- **编译期静态白名单**：后台 `content-chunk-load` 消息处理器只接受编译期静态枚举 `ALLOWED_CONTENT_CHUNK_FILES`（仅含 `g-shared`、`g-subtitle`、`g-buttons`、`g-app`、`g-mermaid`、`g-math` 与 Chromium 专属 `g-live-room` -> 静态文件列表，使用 `Object.prototype.hasOwnProperty` 校验），严禁接收客户端传入的任意路径或回传 JS 字符串执行（禁用 `eval`、`new Function`、`blob:` URL 及 `declarativeNetRequest` 篡改宿主 `Connection-Allowlist*` 响应头）。
- **发起方与帧锁定**：`chrome.scripting.executeScript` 必须经 `resolveSenderFrameTarget(sender)` 严格锁定 `sender.tab.id` 与 `frameIds: [sender.frameId ?? 0]`，忽略消息体中任何目标字段。非标签页发起或无效 `chunkId` 一律拒绝。
- **`https://live.bilibili.com/*` 纳入 Chromium `host_permissions`**：
  - Chromium `extension/manifest.json` 的 `host_permissions` 包含 `"https://live.bilibili.com/*"`，使直播页同样保持轻壳 `["entry/content-resident.iife.js"]`（`all_frames: true`）并通过后台白名单 `executeScript` 按需加载 `g-shared` + `g-live-room`。
  - **权限最小增量理由**：原 `content_scripts[1].matches` 已声明 `"https://live.bilibili.com/*"`（安装期权限提示已包含该站点）；补入 `host_permissions` 带来的增量权限仅为后台 `scripting.executeScript` / `insertCSS` 按需注入与携带登录 Cookie 的跨域请求。按 Chromium 上游源码逻辑推断（`extensions/common/permissions/permission_set.cc` 的 `PermissionSet::InitEffectiveHosts` 将 `explicit_hosts` 与 `scriptable_hosts` 取并集为 `effective_hosts`；`chrome/common/extensions/permissions/chrome_permission_message_provider.cc` 的 `IsPrivilegeIncrease` / `IsHostPrivilegeIncrease` 仅对比 `effective_hosts`），该同源模式补入后 `effective_hosts` 零扩张，不触发升级 `DISABLE_PERMISSIONS_INCREASE`（仅按源码推断，本机无法不改策略/绕过商店实测）。Firefox 派生清单（`scripts/firefox-manifest.js`）继续完整剔除 `live.bilibili.com/*`（含 `host_permissions` 与 `content_scripts`）。
- **SPA 兜底注入与热更新版本守卫**：`extension/entry/content-orchestration-wiring.ts` 的 `injectReaderAssets` 注入 `["entry/content-resident.iife.js"]`；`extension/entry/content.ts` 的 `init()` 在首行检查 `if (globalThis.__BILISCRIPT_CONTENT_SCRIPT_LOADED__) return;`，早于版本号写入语句执行。重复注入或扩展热重载后保留既有的旧版本标记，确保 `ensureReaderContentReady` 仍可识别版本不一致并触发 `reloadTab` 恢复。
- **Firefox 153+ Event Page 与权限边界**：Firefox 153 Event Page 原生支持 `scripting.executeScript({ files, target: { tabId, frameIds } })` 且多经典脚本共享同一 `ISOLATED` world sandbox（`globalThis` 不经 `XrayWrapper`）；若站点 `host_permissions` 被用户撤销导致 `executeScript` 抛出宿主权限错误，必须返回明确失败状态或引导授权，严禁降级为回传脚本文本执行。

### 3. 独立窗口与 `web_accessible_resources` 收窄

- **独立窗口（[ADR-0020](0020-detached-reader-window.md)）兼容**：Document PiP 与 `about:blank` popup 仅承载跨文档搬移的 DOM 与镜像 CSS，内部零 JS 运行环境；全部事件与懒分组加载请求仍从宿主标签页的 `ISOLATED` world 发起并注入回宿主帧，通过 `getActiveReaderDocument()` 操作独立窗口 DOM，不受 PiP 窗口不可注入限制影响。
- **`web_accessible_resources` 最小暴露面**：彻底移除 `entry/content-main.mjs`、`entry/chunks/*` 通配与 `https://www.youtube.com/*` 匹配；Chromium 仅保留实时伴看必需的 `AudioWorklet` 模块 `entry/chunks/pcm-capture-worklet.mjs` 并收窄 `matches` 至 `["https://www.bilibili.com/*", "https://live.bilibili.com/*"]`；Firefox 清单清空 `web_accessible_resources`。

### 4. `globalThis` 单例共享槽、双实例纪律与 Reader 宽类型门面

- **跨分组共享状态槽与双实例纪律**：
  - 凡跨常驻壳、`g-shared` 与按需分组共享的可变状态必须挂载于 `ISOLATED` world 的 `globalThis` 单例槽（含 `core/state.ts`、`reader/reader-bus.ts`、`reader/state.ts`、`shared/style-injector.ts`、`shared/logging.ts`、`shared/content-event-bus.ts`、`shared/active-host.ts`、`shared/messaging.ts`、`shared/watch-storage-keys.ts` 的 `subscriptions`/`registeredHost`，以及 `__BILISCRIPT_RT__`、`__BILISCRIPT_SHARED__`、`__BILISCRIPT_CHUNKS__`），由构建守卫校验槽声明完整性（特别是 `g-shared` 兼供独立引导页与内容页使用时，因 `watch-storage-keys.ts` 状态落入 `globalThis` 槽而不产生冗余 `chrome.storage.onChanged` 监听器）。
  - 其余跨包同时存在的纯模块不得携带未声明的可变状态；含局部安全可变状态者须标注 `BILISCRIPT_DUAL_INSTANCE_STATEFUL` 头注并通过 `assertDualInstanceAllowlist` 双向对账。
  - 同页跨层指令继续经 `extension/shared/messaging.ts` 挂在 `globalThis` 共享槽上的 `dispatchContentScriptMessage` 同步直调，保持 `ui/` 不逆向导入组合根 `entry/` 的分层边界。
- **Reader 懒域宽类型面与双访问通道**：
  - 常驻与壳侧代码继续经 `extension/reader/lazy-reader.ts` 与 `extension/ui/reader-gate.ts`（`whenReaderReady` / `withReader`）异步获取 reader 域入口（底层经 `__BILISCRIPT_LOAD_CHUNK__` 注入对应分组）；reader 域内部模块之间维持同步直 `import`。
  - `ReaderDomain = typeof import("./index.js")` 直接推导完整域入口类型面，不维护手写窄接口，也不引入字符串命令分发。

## 考虑过的方案

- **去掉 `__BILISCRIPT_RT__`（`--no-rt`）让各分组各自打包核心模块**：实测仅节省首帧 `1,746 B`（`42,418 B` 仍超原 `40,960 B` 阈值），却导致下游每包重复打包 `11` 个核心模块（Chromium 运行时 `+17,265 B`、ZIP `+7,342 B`、重复率升至 `18.81%`），并导致 `7` 个尚未全量挂载 `globalThis` 槽的模块发生跨包状态分裂（包括 `extension/ai/lazy-player-ai.ts:12` 的 `isPlayerAiLoaded()` 双向错位、`extension/shared/watch-storage-keys.ts:15-16` 重复注册监听、以及 `lazy-reader`/`lazy-shell`/`lazy-ui`/`subtitle/lazy` 缓存与重试状态分裂），呈明确负收益，直接否决。
- **维持 ESM 动态 `import()` 并用 `declarativeNetRequest` 篡改宿主 `Connection-Allowlist*` 响应头 / `blob:` URL 包装**：修改第三方站点安全策略头或绕过子资源校验策略违反安全最小干预原则且存在商店审核拒审风险，直接否决。
- **后台回传 JS 文本并在内容侧 `eval` / `new Function` 执行**：在 Firefox 与 Chromium MV3 扩展安全模型及商店审核政策中均属明确违规，直接否决。
- **`live.bilibili.com` 仅保留轻壳静态声明，不静态注入重型业务包**：在 `content_scripts[1]` 静态堆叠 `g-shared` 与 `g-live-room` 会使直播间全部框架（`all_frames: true`）在未打开伴看时无条件承受重包解析开销；经源码校验 `live.bilibili.com/*` 已在 `scriptable_hosts` 覆盖范围内，补入 `host_permissions` 后 `effective_hosts` 零扩张，故统一走后台白名单按需 `executeScript`。
- **保留 `requestIdleCallback` 空闲预注入**：会在用户未打算使用面板的视频页提前注入 `~2 MB`（`g-shared` + `g-app`）经典脚本并占用主线程解析时间，故收窄为仅在悬停或聚焦按钮时按需预注入。
- **将原懒入口各自打包为独立完整闭包经典 IIFE，或让 `onboarding-entry.js` 全量自包含依赖**：前者使公共模块重复打包十余份、击穿运行时与分发体积预算；后者产生近 `180 KB` 额外重复，引入 `g-shared` 交集组后将双端 ZIP 全部收敛至 `1,200,000 B` 以内。

## 后果

- **审查红线**：
  - 不得在内容侧重新引入页面上下文 `chrome-extension://` / `moz-extension://` 的 JS `import()` 或 `<link rel="modulepreload">`，不得在 `content-chunk-load` 中接受动态路径或回传可执行代码字符串，不得扩大其他未批准域名或 `<all_urls>` 至 `host_permissions`，也不得将 `https://www.youtube.com/*` 加回 `web_accessible_resources`。
  - 不得移除 `__BILISCRIPT_RT__` 改回无共享注册表的多份拷贝、不得将常驻 `content-resident.iife.js` 改为全量 `import *` 导出或拆分为多文件常驻注入，不得恢复 `requestIdleCallback` 空闲预注入，亦不得将 `ReaderDomain` 收窄为手写窄接口、统一 reader 域双访问通道或改用字符串分发。
  - 真机与 CI 须持续包含「Service Worker + 强制 `Connection-Allowlist`」场景验证首帧挂载、按钮悬停/聚焦预注入、面板交互、独立窗口与懒分组注入全程 0 条 `Unsafe attempt` 告警。
