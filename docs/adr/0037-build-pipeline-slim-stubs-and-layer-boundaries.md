# ADR-0037：构建期 Mermaid 裁剪替身、Firefox MV3 显式 CSP、跨层依赖边界与模型目录零嵌入校验

> 状态：有效

在双目标构建管线、扩展/测试类型边界、跨层模块依赖拓扑以及上游模型目录对账中，仓内存在多项必须在构建脚本、类型声明与目录解析层严格守恒的结构性不变量，现统一归档为本决策。

## 背景与动机

1. **Mermaid 12 体积与双实例风险**：`mermaid@12.0.0` 原始 ESM 分包包含大量未用图表、图表布局引擎（`cose-bilkent`、`ELK`）、`katex` 重复副本与全量 `d3` 伞包；直接改写 `node_modules` 会污染依赖树并导致构建状态漂移。
2. **Firefox MV3 默认 CSP 升级本机连接**（补充 ADR-0028）：Firefox 桌面端 MV3 默认 `extension_pages` CSP 隐含 `upgrade-insecure-requests`，会把后台 Event Page 对本机 Agent Bridge（`ws://127.0.0.1`）与本地模型（`http://localhost`）的明文连接升级为 `wss://` / `https://`，致使本地桥接与本地推理握手失败。
3. **无 `@types/node` / `@types/chrome` 隔离与 CommonJS 仓根限制**：仓库 `package.json` 为 `"type": "commonjs"`，且 `tsconfig.json` 刻意不引入 `@types/chrome` 与 `@types/node`，以防 Node 全局类型或冗余 Chrome API 泄漏进扩展上下文；同时 `extension/` 内运行代码禁止跨目录导入仓库根脚本。
4. **上游模型目录校验与零依赖注释门禁**：`models.dev` 同步与校验脚本需要零运行时包体开销地核对 `extension/ai/thinking-profiles.ts` 与上游目录的一致性，而仓库级禁注释门禁需要零第三方依赖且不误伤字面量与白名单指令。

## 已定决策

### 1. Mermaid 12 构建期副本裁剪与替身别名管线

- **本地副本裁剪与源码哈希锁**：`scripts/vendor-mermaid-slim.mjs` 将 Mermaid 12 chunk 复制到构建区而非修改 `node_modules`，按内容锚点而非构建哈希文件名裁剪 `swimlane`、`cose-bilkent`、`ELK`、`katex` 及未保留图表类型，并在 `scripts/build-content.js` 锁定 Mermaid 版本与源码哈希；同时在轮 B 与探针轮中利用 sourcemap `inputs` 守卫防止上游依赖漂移回流或形成双实例。
- **最小构建期替身**：`scripts/vendor-iconify-stub.mjs`、`scripts/vendor-marked-stub.mjs` 与 `scripts/vendor-d3-slim.mjs` 在构建期替代重型传递依赖。其中 `vendor-d3-slim.mjs` 要求 `transition().duration().style(k, v)` 立即写入样式而非静默空操作（因 Mermaid 提示气泡初始为 `opacity: 0`，纯空操作会导致气泡永久不可见），`duration`/`delay`/`ease` 保持链式返回，`interrupt()` 返回 selection 本身。

### 2. Firefox MV3 显式 `extension_pages` CSP（补充 ADR-0028）

- `scripts/firefox-manifest.js` 在派生 `dist-firefox/manifest.json` 时显式写入 `content_security_policy: { extension_pages: "script-src 'self'" }`，覆盖 Firefox MV3 默认含 `upgrade-insecure-requests` 的策略，确保后台 Event Page 到 `ws://127.0.0.1` 与 `http://localhost` 的本地连接不被强制升级。

### 3. 手写 `.d.ts` 契约、全仓无环分层与物理双副本同步

- **手写最小 `.d.ts` 声明**：不引入 `@types/chrome` 与 `@types/node`，通过 `extension/chrome-types.d.ts`、`extension/reader/reader-env.d.ts` 与 `tests/**/node-*.d.ts`（`tests/agent-bridge/node-http.d.ts`、`tests/bilibili/node-builtins.d.ts`、`tests/reader/node-stubs.d.ts`、`tests/reader/reader-test-env.d.ts`）精确收窄暴露面。
- **全仓无环分层边界**（`tests/layer-deps.test.ts`）：`extension/shared/**` 为叶层，禁止非 `type-only` 地相对导入 `shared/` 以外模块；`extension/entry/**` 为唯一组合根，任何非 `entry/**` 层禁止导入 `entry/**`；跨上下文叶模块（如 `extension/core/provider-http-shared.ts`、`extension/core/asr-failure-notice.ts`）保持零运行时导入，避免拖曳多余图或造成双实例分裂。
- **物理双副本同步与核心域协议不变量**：`escapeRegExp` 在 ESM 扩展源码（受 `localImportGuard` 禁止跨出 `extension/` 导入）与 CommonJS `scripts/build.js` 之间保留物理双副本，由 `tests/shared/escape-regexp-sync.test.ts` 锁定逐字等价；`chrome.storage.sync` 单键 `8192` 字节配额按 UTF-8 字节长计量并由 `initializeSettingsStorage` 在安装/更新时展开空提示词占位符；`extension/core/presets.ts` 中 `protocolBaseUrls.anthropic` 禁止尾随 `/v1`（由 `anthropicAdapter.endpoint()` 统一拼接 `/v1/messages`）；`providerFetchViaOffscreen` 依赖 offscreen 端口回传 `accepted` ack 握手，防止 ASR 终态自动关闭与同帧新请求撞车时被 SW 保活 `onConnect` 静默吞接挂起。

### 4. `models.dev` 构建期对账与零依赖词法禁注释门禁

- **目录裁剪字节等价与文本解析**：`scripts/check-models-dev-catalog.mjs` 的 `cropForCheck`/`hashCatalog` 与 `scripts/sync-models-dev-catalog.mjs` 保持 `KEEP_FIELDS` 白名单与键序字节等价以防误报漂移；脚本以固定格式锚点（`PROFILE_MARKERS` 与 2 空格缩进）纯文本解析 `extension/ai/thinking-profiles.ts`（不执行仓内代码、零运行时打包负担），出处域名从伴随 `.sources.json` sidecar（`scripts/thinking-profile-sources.json`、`tests/fixtures/models-dev/check-profiles.sources.json`）读取，并在不可解析行上 fail-loud；`tests/fixtures/models-dev/check-profiles.ts` 保留本地 `FixtureOverrideRule` 覆盖平台覆写校验分支。
- **思考档位边界**：`ThinkingVocabulary` 以闭合判别联合在类型层面排除 `temperature` 与 `top_p`（防止 Kimi 等思考模式禁用参数泄漏）；`ClassRule.tokenParam`（`max_completion_tokens`）仅保留在手写 `CLASSES`（`openai-reasoning` / `openai-reasoning-none`）供自定义端点使用，不从上游投影写入，使 OpenAI 谱系在 `openrouter` / `opencode-go` 等通道保留 `max_tokens` 语义；`EXCEPTIONS` / `TAXONOMY` 中的未收录回落项（如 `glm-5.3`、`glm-5.2`）防新变体 fail-open 漂移，同时刻意省略旧 `o1` 家族使之落入 `UNKNOWN`；`matchHandwrittenClass` 仅对 `TAXONOMY` 剥离组织前缀、`EXCEPTIONS` 保持全小写 ID 精确匹配（防平台专属 `streamOnly` 规则外泄）。
- **零依赖词法门禁**：`scripts/check-no-comments.mjs` 不引入第三方解析器，使用状态机词法扫描 TS/JS/MJS/CJS/`.d.ts`/CSS，仅放行白名单机器指令（shebang、`/// <reference>`、`BILISCRIPT_DUAL_INSTANCE_STATEFUL`、`@vitest-environment`、`@license`、`eslint-disable*`、`DO NOT EDIT`、带说明的 `@ts-expect-error` 等）。

## 考虑过的备选

- **直接引入 `@types/node` / `@types/chrome` 或在运行时执行 `thinking-profiles.ts` 做对账**：前者会令 Node 全局类型污染扩展上下文并掩盖手写窄接口契约，后者会在对账脚本中耦合 TS 运行时加载与打包依赖，均予以否决。
- **将 `ClassRule.tokenParam` 统一纳入上游 `models.dev` 投影**：`models.dev` 仅记录 `reasoning_options` 与 `limit.output` 数值而不含参数名，强行按协议投影会破坏 `openrouter` 等网关计费与预算语义（参见 ADR-0013/0014），予以否决。

## 后果

- 任何增删 Mermaid 保留图表类型、修改 `KEEP_FIELDS` 或调整 `thinking-profiles.ts` 表格缩进/锚点的改动，必须同步更新对应构建裁剪器、sidecar `.sources.json` 与对账守卫。
- `extension/shared/**`、`extension/entry/**` 与 `escapeRegExp` 物理双副本边界由测试持续锁定，不可为便利跨层直接导入。
