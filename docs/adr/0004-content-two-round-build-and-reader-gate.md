# ADR-0004：Content 经典脚本粗粒度分组、ISOLATED 注册表与懒域宽类型门面

> 状态：有效

为消除 Content Script 在受 Service Worker 与 `Connection-Allowlist(-Report-Only)` 控制的宿主页面上发起 `chrome-extension://` / `moz-extension://` JS 子资源请求（`modulepreload` 与 ESM 动态 `import()`），同时守住首帧注入速度与双端包体预算，Content Script 采用**经典 IIFE 粗粒度分组（含跨宿公共交集组 `g-shared`）+ `ISOLATED` world `globalThis` 注册表与单例槽 + 后台静态白名单 `executeScript` 按需注入（含按钮交互预注入）+ 懒域宽类型双通道门面**架构。

## 已定决策

### 1. 全经典 IIFE 交付、粗粒度分组与交互预注入（`scripts/build-content.js`）

- **零页面侧模块请求**：Content Script 全量产物以经典 `iife` 格式构建加载，不生成、不引用页面上下文的 ESM 动态 `import()` 或 `<link rel="modulepreload">`；扩展自有引导页 `onboarding-entry.js` 由 `scripts/build.js` 独立打包，并通过同源 `<script>` 复用 `g-shared.iife.js`，原生满足双端严格 CSP。
- **单文件常驻壳与显式具名注册表**：视频页与直播页静态注入单个 `entry/content-resident.iife.js`，将核心有状态单例模块的**显式具名导出**注册到 `ISOLATED` world 的 `globalThis.__BILISCRIPT_RT__`，并注入幂等重入守卫与分块加载器 `globalThis.__BILISCRIPT_LOAD_CHUNK__`。严禁使用全量 `import *` 导出或拆分为多文件常驻注入。
- **6 按需业务分组 + `g-shared` 公共交集组**：按生命周期划分为首帧控件 `g-buttons`、首帧字幕 `g-subtitle`（导出至 `__BILISCRIPT_SUBTITLE__`，不反向依赖 `g-shared`/`g-app`）、核心应用 `g-app`、图表 `g-mermaid`、公式 `g-math`、直播间 `g-live-room`（仅 Chromium），以及收拢跨宿公共依赖的 `g-shared`（导出至 `__BILISCRIPT_SHARED__`，不反向依赖常驻壳或 `g-subtitle`）。构建期插件将共享核心导入与跨组动态 `import()` 重写为注册表读取或 `__BILISCRIPT_LOAD_CHUNK__` 调用。
- **交互触发预注入（`extension/ui/panel-preload.ts`）**：放弃 `requestIdleCallback` 空闲预注入，仅在用户指针悬停（`pointerenter`）或聚焦（`focus`）文摘/播放器按钮时幂等预注入 `g-shared`、`g-subtitle` 与 `g-app`。
- **双端体积与图谱守卫**：`scripts/build-content.js`、`scripts/build.js` 与 `scripts/build_release.py` 强制校验 `MAX_RESIDENT_BYTES = 46080`（45 KB 常驻）、`BACKGROUND_JS_MAX_KB = 256`、Chromium `DIST_RUNTIME_MAX_BYTES = 4350000`、Firefox `DIST_RUNTIME_MAX_BYTES = 4050000`、Release ZIP `≤ 1,200,000 B`，以及静态依赖种子守卫（`assertStaticSeedGuards`）、Mermaid 替身守卫与 Firefox `live` 死代码裁剪守卫。

### 2. 后台静态白名单 `executeScript` 与权限边界（`extension/core/content-chunk-handlers.ts`）

- **编译期静态白名单与发起方锁定**：后台 `content-chunk-load` 仅接受 `ALLOWED_CONTENT_CHUNK_FILES` 静态枚举（`Object.prototype.hasOwnProperty` 校验），并经 `resolveSenderFrameTarget(sender)` 严格锁定 `sender.tab.id` 与 `sender.frameId`；严禁接受任意路径或回传代码文本执行（禁用 `eval`、`new Function`、`blob:` URL 及 DNR 篡改宿主 `Connection-Allowlist*` 头）。
- **`live.bilibili.com/*` 宿主权限与热重载守卫**：Chromium `manifest.json` 的 `host_permissions` 包含 `https://live.bilibili.com/*`（已覆盖于 `content_scripts[1].matches`，`effective_hosts` 零扩张），使直播间同样走轻壳 + 按需 `executeScript`；Firefox 派生清单完整剔除 `live.bilibili.com/*`。后台兜底注入（`extension/core/background-content-orchestration.ts` 的 `ensureReaderContentReady` 与 `entry/background.ts`）统一注入 `entry/content-resident.iife.js`；`entry/content.ts` 的 `init()` 在写入版本号前先检查 `__BILISCRIPT_CONTENT_SCRIPT_LOADED__`，保留热重载版本漂移检测能力。若宿主权限被撤销，返回明确错误或引导授权，不降级为脚本文本回传。
- **独立窗口与 `web_accessible_resources` 收窄**：独立窗口（[ADR-0020](0020-detached-reader-window.md)）无独立 JS 环境，所有懒加载仍经宿主帧注入。`web_accessible_resources` 彻底移除 `entry/chunks/*` 通配与 `https://www.youtube.com/*`，Chromium 仅对 B 站页面暴露 `entry/chunks/pcm-capture-worklet.mjs`，Firefox 清空 `web_accessible_resources`。

### 3. `globalThis` 单例槽、双实例纪律与 Reader 宽类型门面

- 跨常驻壳、`g-shared` 与按需分组共享的可变状态必须挂载于 `ISOLATED` world `globalThis` 单例槽（包括跨层同帧消息分发 `dispatchContentScriptMessage` 与 `watch-storage-keys` 订阅表，由构建守卫校验完整性）；其余跨包模块含局部安全可变态者须标注 `BILISCRIPT_DUAL_INSTANCE_STATEFUL` 并通过 `assertDualInstanceAllowlist` 对账。
- 常驻与壳侧代码经 `extension/reader/lazy-reader.ts` / `extension/ui/reader-gate.ts` 异步获取 reader 域入口，域内维持同步直 `import`；`ReaderDomain = typeof import("./index.js")` 直接推导宽类型面，不手写窄接口、不改用字符串分发。

## 考虑过的方案

- **去掉 `__BILISCRIPT_RT__` 让各分组各自打包核心模块**：实测仅微幅减少常驻壳体积，却使下游每包重复打包核心模块、放大运行时与 ZIP 体积，并引发跨包单例与监听器状态分裂，否决。
- **维持 ESM 动态 `import()` 并用 DNR 篡改宿主策略头 / `blob:` 包装，或后台回传 JS 文本 `eval`**：违反安全最小干预原则且触发双端商店审核拒审，否决。
- **保留 `requestIdleCallback` 空闲预注入或静态堆叠重型业务包**：在未打开面板的普通浏览页强行解析 MB 级脚本，否决。

## 后果

- **审查红线**：
  - 不得重新引入页面侧 `chrome-extension://` / `moz-extension://` 的 JS `import()` 或 `<link rel="modulepreload">`，不得在 `content-chunk-load` 中接受动态路径或回传可执行代码字符串，不得将 `https://www.youtube.com/*` 加回 `web_accessible_resources`。
  - 不得移除 `__BILISCRIPT_RT__`、将常驻包改为全量 `import *` 或拆分为多文件常驻注入、恢复 `requestIdleCallback` 空闲预注入，亦不得收窄 `ReaderDomain`、统一 reader 域双访问通道或改用字符串分发。
  - 真机与 CI 持续验证「Service Worker + 强制 `Connection-Allowlist`」场景全程 0 条 `Unsafe attempt` 告警。
