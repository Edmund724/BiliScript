# ADR-0001：background 禁运行时惰性加载与 300KB 静态图守卫

> 状态：有效

Chromium MV3 Service Worker 在平台层面不支持动态 `import()`（`crbug.com/40760920`），且 Chromium 与桌面端 Firefox 共用同一份 `extension/entry/background.ts` 构建入口。我们决定：**后台入口的 import 图保持全静态（`splitting: false`）**，体积与冷启动解析成本只走打包 minify（`scripts/build.js`）与源码级静态拆链（拆断小用途拖入大模块的静态边，如静音 WAV 探针与 `asr/stream-chunker.ts` 解耦、连通性测试移出后台），并由 `BACKGROUND_JS_MAX_KB = 300`（容纳 IDB v4 拆轨账本与单写者原子 RPC 后的硬上限）与 `assertBackgroundStaticGraphSlim` 在构建期硬拦截。动态 `import()` 惰性化只允许在页面环境（Content Script、Offscreen 文档、扩展自有页面）使用。

## 考虑过的方案

- **后台冷处理器内动态 `import()`**：Chromium MV3 Service Worker 平台直接禁止，写入即运行期报错。
- **把后台冷处理器整体搬离至 Offscreen**：增加跨上下文消息往返与保活时序复杂度，为规避平台限制付出不成比例的架构代价。

## 后果

- 架构评审（含 AI 代理）不得再提议后台运行时惰性化，除非 `crbug/40760920` 落地（重开条件）。
- 新增重型模块（如模型目录生成叶、协议适配器栈、富文本渲染器）必须登记进 `scripts/build.js` 的 `assertBackgroundStaticGraphSlim` 禁区，严防静态边意外污染后台图。
