# ADR-0004：Content 两轮构建、双实例共享槽与懒域宽类型门面

> 状态：有效

为兼顾视频页首帧按钮注入速度与按需功能解耦，Content Script 采用**两轮构建 + `globalThis` 双实例共享槽 + 懒域宽类型双通道门面**架构。

## 已定决策

### 1. 两轮构建与首帧 2 请求预算（`scripts/build-content.js`）

- **轮 B（懒加载区）**：将全部动态 `import()` 目标（`lazyTargets`）作为 `entryPoints` 以 `splitting: true` 打包至 `chunks/`。
- **轮 A（常驻主包）**：对 `entry/content.ts` 设 `splitting: false`，通过 `onResolve` 插件将懒目标 external 指向轮 B 产物路径，配合轻量 IIFE bootstrap 将首帧常驻控制在 **2 个本地请求**与 `MAX_RESIDENT_BYTES = 40960` 体积上限内。接受常驻底座在懒 chunk 区重复打包一份的本地体积代价（零网络开销）。

### 2. 双实例共享槽与同帧内页分发

- 两轮构建使共享底座在主包与懒 chunk 区各求值一份。**凡跨实例共享的可变状态必须挂载于 `globalThis` 单例槽**（`state` / `messaging` / `reader-bus` / `style-injector` / `logging` / `content-event-bus`，由 `assertSharedSlotsInBothRegions` 构建期核验）；其余双实例模块不得携带未声明的可变状态，含局部安全可变状态者须标注 `BILISCRIPT_DUAL_INSTANCE_STATEFUL` 头注并通过 `assertDualInstanceAllowlist` 双向对账。
- 因 WebExtension `chrome.runtime.sendMessage` 不会向发起方同帧自身派发 `runtime.onMessage`，且分层边界禁止 `ui/` 逆向导入组合根 `entry/`，同页跨层指令统一经 `shared/messaging.ts` 挂在 `globalThis` 共享槽上的内页分发器（`dispatchContentScriptMessage`）同步直调。

### 3. Reader 懒域宽类型面与双访问通道

- 常驻与壳侧代码统一经 `reader/lazy-reader.ts` 与 `ui/reader-gate.ts`（`whenReaderReady` / `withReader`）动态获取 reader 域入口；reader 域内部模块之间维持同步直 `import`。
- `ReaderDomain = typeof import("./index.js")` 直接推导完整域入口类型面，不维护手写窄接口，也不引入字符串命令分发。

## 考虑过的方案

- **单轮 `splitting: true`**：esbuild 会将共享模块提升为主入口静态依赖 chunk，使首帧退化为多级串行模块发现链，拖慢按钮挂载。
- **`seam external` 手工划定外部边界**：缺乏编译期导出面校验（漏符号即运行期硬崩溃），且传递闭包边界极易随改动腐化（同 [ADR-0001](0001-background-no-runtime-lazy.md) 所防问题）。
- **收窄 `ReaderDomain` 或统一 reader 单通道访问**：手写窄类型在多消费方演进时易漂移；壳侧直引会把懒包拖进常驻图，域内改走 gate 则把同步调用劣化为无谓异步跳转。

## 后果

- **审查红线**：
  - 常驻请求结构（2 请求）仍是体验瓶颈期间，架构评审（含 AI 代理）不得提议 Content 单轮化或 `seam external`（重开条件：浏览器扩展内容脚本普及原生的预解析/打包缓存原语使多 chunk 请求零额外开销）。
  - 架构评审（含 AI 代理）不得提议收窄 `ReaderDomain`、统一 reader 域两条访问通道或改用字符串分发。
