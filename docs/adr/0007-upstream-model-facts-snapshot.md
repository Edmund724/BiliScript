# ADR-0007：上游模型事实以 `models.dev` 构建期快照为源

> 状态：有效

设置页平台编辑弹窗展示的只读模型元数据（上下文窗口、是否支持思考、是否收图）与模型思考档位事实（某模型支持哪些档位、能否关闭思考），统一以 **`https://models.dev/api.json` 的构建期裁剪快照**为唯一上游数据源，编译为两份零 `import` 的纯叶子模块提交入仓：**原始上游 JSON 与第三方 LLM SDK 严禁进入请求执行链、后台静态图或随扩展分发的文件**。

| 域 | 生成产物 | 消费方式与隔离边界 |
| --- | --- | --- |
| UI 目录 | `extension/ai/catalog/models-dev-catalog.generated.ts` | 只读展示元数据；仅经 `ui/lazy-model-catalog.ts` 动态 `import()` 按需加载 |
| 请求塑形事实 | `extension/ai/catalog/models-dev-thinking.generated.ts` | 值集表 `VALUESETS` 与指派表 `ASSIGNMENTS`；供 `ai/thinking-profiles.ts` 解析，线格式落点仍归 [ADR-0008](0008-thinking-tiers-and-wire-maps.md) |

`scripts/build.js` 的 `assertBackgroundStaticGraphSlim` 将上述两份产物与 `ai/model-catalog.ts` 一并列入后台静态图禁区（对齐 [ADR-0001](0001-background-no-runtime-lazy.md)）。

## 已定决策

1. **直连 `models.dev` 源头并按裁剪子集 `contentHash` 锁定**：上游无版本号，同步脚本（`scripts/sync-models-dev-catalog.mjs` / `sync-models-dev-thinking.mjs`）在产物头记录裁剪子集字节级 `sha256` 与逐家上游文档 URL；`scripts/check-models-dev-catalog.mjs` 采用相同 `KEEP_FIELDS` 裁剪口径并纯文本解析 `thinking-profiles.ts`（出处域名存于 `.sources.json` sidecar，零运行时打包开销）核查 `upstream-wins` / `upstream-new` / `hand-only` 分歧。冲突时以上游事实为准，手写表仅兜底上游未收录模型。
2. **不引入第三方 LLM SDK 运行时**：实测表明，将外部多平台 SDK（如 `pi-ai` 或 `openai` SDK）打入运行时，除体积成本外还会叠加**第二套重试、第二套超时、第二套 SSE 解析以及未经审核的默认请求字段与请求头**（如 `store`、`prompt_cache_key`、`x-session-affinity`），制造第二个请求塑形主人；仓库仅保留借自社区的 `extension/ai/compat-vocab.ts` 平台怪癖词表命名与双向对账设计。
3. **目录身份与协议解耦**：`PRESETS[].catalogProvider`（`extension/core/presets.ts`）是预设到上游身份的唯一映射（`custom` 按 host 兜底），**`protocol` 字段不参与目录查表**（防止用户配错协议把展示层元数据一并带偏）。网关自身目录缺失 `reasoning_options` 时按 `canonical_model_id` 借用原生厂商词表；仍查不到时落入未知哨兵（不发思考参数，UI 元数据栏静默隐藏，不回落猜测值）。无上游目录身份的 `ollama` 与 `custom`（`NO_CATALOG_PRESETS`）恒无目录元数据。

## 考虑过的方案

- **转手使用二次封装库的内置快照**：多隔一层发版延迟且预设覆盖不全。
- **引入服务端配置轮询或表达式引擎（如 RestrictedCEL）**：外部静态快照无可靠测试面，且单参数表达式无法表达依赖 `stream` / `probe` / `off` 级联的跨字段产品语义。
- **扩展运行期 `fetch` 上游目录**：模型元数据变化极慢且仅在配置时查看，运行期拉取徒增外部网络依赖、失败降级与跨域中转复杂度。

## 后果

- **审查红线**：架构评审（含 AI 代理）不得提议将原始上游数据或第三方 LLM SDK 接进请求链或运行时；不得用 UI 目录产物回填 `thinking-profiles.ts`；不得让 `protocol` 参与目录查表（重开条件：确需运行期动态刷新目录且先完成单一事实源与离线降级论证）。
