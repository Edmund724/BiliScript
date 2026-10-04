# 上游模型事实以 models.dev 构建期快照为源

> 状态：有效

设置页平台编辑 Modal 展示的模型元数据（上下文窗口 / 是否支持思考 / 是否收图），与「某模型有哪些思考档位、能不能关」（请求塑形事实），此前是两套来源：前者是 pi-ai（`@earendil-works/pi-ai`）vendor 快照的裁剪产物，后者是 `extension/ai/thinking-profiles.ts` 的手写表。本条把两者一并换成 **models.dev** 的构建期快照并删掉 pi-ai devDependency，覆盖 **UI 目录**与**请求塑形数据**两个域；它取代 [ADR-0009](0009-model-catalog-borrow-not-embed.md)。

**不变式（硬）：原始上游数据只在构建期被读，永不进请求执行路径，也不进任何随扩展分发的文件。** 抓的是 `https://models.dev/api.json`（本次实测 5,317,336 B / 200+ provider），随产物走的只有编译结果：

| 域 | 产物 | 形态 | 大小 |
|---|---|---|---|
| UI 目录 | `extension/ai/catalog/models-dev-catalog.generated.ts` | 12 家上游 / 578 个模型的展示字段（`reasoning` / `input` / `contextWindow` / `maxTokens`） | 103,453 B |
| 请求塑形 | `extension/ai/catalog/models-dev-thinking.generated.ts` | 值集常量表 `VALUESETS` + 模型→值集指派 `ASSIGNMENTS`（另带别名表 / deprecated 名单） | 31,171 B |

两份都是零 `import` 的叶子（静态与动态都没有），只导出纯数据与纯查表函数。请求塑形产物由 `ai/thinking-profiles.ts` 显式引入（档位「怎么落请求体」仍归 adapter 与 `ai/thinking-wire-map.ts`）；UI 目录产物只被 `ai/model-catalog.ts` 静态引入，且 `ai/model-catalog` 无人静态引用，UI 侧经 `ui/lazy-model-catalog.ts` 动态 `import()`。`scripts/build.js` 的 `assertBackgroundStaticGraphSlim` 把两个产物与 `ai/model-catalog.ts` 一并列为 SW 静态图禁区。

**0009 的反例证据不复制，只引用**：「不内置上游运行时」的全部论据（体积实测与语义叠加清单）在 [ADR-0009](0009-model-catalog-borrow-not-embed.md)「反例证据（2026-09-23 实测）」一节里，本条照旧**以引用方式**沿用——那些是**否决内置运行时**的理由，与数据源是哪一家无关；换源不使其失效，故本条不重写、不复制。

## 决定

1. **数据源 = models.dev**（`https://models.dev/api.json`）：既不用 pi-ai 的 vendor 快照（它本身是 pi-ai 发版时从 models.dev 重新生成的转手快照，隔了两层转发），也不用 ZCode 的 `config/provider/zcode-builtin.json`。构建期脚本直连源头，本仓因此只剩一次转发（`scripts/sync-models-dev-catalog.mjs` / `scripts/sync-models-dev-thinking.mjs`）。
2. **pin 内容，不 pin 版本**：上游没有版本号——`api.json` 无顶层元数据，HTTP 只有弱 `ETag` 与 `Cache-Control: public, must-revalidate, max-age=0`，无 `Last-Modified`。产物头因此记 `source` + **裁剪后子集的 `contentHash`**（UI 目录 `sha256:aa0a8c55…`、思考事实 `sha256:ae2114b4…`）+ **逐家上游的 `doc` URL 与模型数**（`UPSTREAM_CATALOG_SOURCE.upstreams`，12 条）。`contentHash` 口径 = 12 家子集的字节级 sha256，与 `scripts/check-models-dev-catalog.mjs` 的裁剪逐字节等效，所以「上游还是不是同一份」可判定；12 家之外的其余 provider 变了不算漂移。**重开条件**：①需要运行时刷新上游（拿新鲜度换掉构建期快照——要先论证它如何成为该事实的唯一主人，并接受扩展从此多出第一条跨域运行时数据依赖）；②上游出现版本号或稳定内容标识，使「pin 内容」不再是唯一可判定口径。
3. **身份两层，不混为一层**：
   - **平台定线格式方言**：`PRESETS[].catalogProvider`（`extension/core/presets.ts`）是 preset → 上游 provider 的唯一映射（12 家，`minimax` 是人工裁定的「同一平台异端点」），`protocol` 与 baseUrl 都不参与查表；「档位怎么落请求体」仍由平台层持有，`MESSAGES_TIER_VOCABULARY` 降级为平台侧归一化层、不引入新词汇。
   - **`canonical_model_id` 定档位词表**：网关自己的目录缺 `reasoning_options` 时按 `canonical_model_id` 借原生 provider 的词表。实证：`opencode-go` 的 `mimo-v2.6-pro` 没有词表，而 `xiaomi` 的同名模型有 `{"type":"toggle"}`。12 家 415 个 `reasoning: true` 模型里 352 个直接有词表，63 个缺口里 7 个按 canonical / 别名借到，其余 56 个标「未知词表」——**查不到即不发参**，不回落猜测值。
4. **冲突裁决：上游胜（用户裁定 Q1=B）**。逐格比对（`catalog:check` 的 `upstream-wins` 类）发现手写表三处真冲突且上游更对：`glm-5.2`（本仓记 off 可用；上游 `[effort high/max]`，无 toggle）、`glm-5.3`（本仓记永远思考；上游 `[effort low/high/max]`）、`kimi-k3`（本仓记永远思考；上游 `[toggle, effort low/high/max]`）。反向也有一条：`qwen3-max` 的 low/high 都发 `budget_tokens: 2048` 看着像塌陷缺陷，上游却是 `[toggle, budget_tokens max 81920]`——没有 effort，塌陷是上游唯一支持的形状（手写表把两件事混成了一件）。手写表的分歧条目按 04 号票删除。
5. **分歧必须可见**：上游胜不等于可以默默对齐。`pnpm catalog:check` 只报告不改动，每次打印三类分区——`upstream-wins`（删除候选）/ `upstream-new` / `hand-only`（上游缺口、手写表保留）——加漂移结论与逐家差异；退出码 0 = 与产物同一份上游（**分歧清单仍可能有内容**，那是要人核对的，不是失败）、1 = 漂移、2 = 硬错。目录数据仍然**只读**：不落盘、不进 `AiProvider` 存储，`lookupCatalogMeta` 只有查表函数、无写入口。

## 考虑过的方案

- **继续用 pi-ai 快照**（否决）：它是「上游的下游」，隔两层转发；换源前逐对比已证明它落后（如 `~moonshotai/kimi-latest` 的 output `131072 → 943718`、`deepseek/deepseek-v4.1-flash` 的 `384000 → 943718`），且它的 7 家覆盖不到本仓的 12 家。
- **ZCode 的 `zcode-builtin.json` + RestrictedCEL**（否决）：180,680 B / 478 条规则 / `revision: 30` 的那份文件在公开仓库里只有 1 个提交（2026-09-20 开源投放）、从未被编辑，仓库 3 个提交 / 7060 个文件里只有 4 个测试，`packages/model-option-map` 零测试——**没有可依赖的测试面**。它的新鲜度来自服务端（`GET {endpointOrigin}/api/v1/client/configs` 取 `builtin_provider_config_json`，`revision` 比大小决定覆盖，每 60 秒轮询、成功 TTL 1 小时），**更新通道不可迁移**：vendor 它的文件只会得到一份永不更新的快照，照搬轮询又要在扩展里复制它的服务端契约。867 行 RestrictedCEL 的能力也不够：输入只有 option 自己的值，**表达不了 `stream` / `probe` / `offUnavailable` 这类跨条件与产品语义**。本仓因此不引入表达式引擎。
- **运行时 fetch 上游目录**（否决）：见决定 2 的重开条件；元数据是「搭建时看的」、变化极慢，静态 vendor 足够，而运行时取数要碰 `web_accessible_resources` + 失败降级 + SW 中转。
- **只换 UI 目录、请求塑形留在手写表**（否决）：那正是「同一模型两个事实源」的 bug 类型（0009 已把「不拿目录数据回填 `thinking-profiles.ts`」写成红线）；本次手写表的三处真冲突是它的实证。

## 后果

- **ADR-0009 的悬置条件已兑现**：0009 的重开条件原文是「目录需要参与请求塑形（那要先论证它如何成为该事实的唯一主人）」。本次的论证就是**分域**——上游成为「模型 → 档位词表」这一事实的唯一主人（值集 + 指派），线格式方言仍是平台层的；原始数据仍不进请求链，进请求链的是编译产物（常量表）。
- 上游升级 = 重跑 `pnpm catalog:sync:upstream` / `pnpm catalog:sync:thinking` + 提交产物 diff；可读性靠产物头的 `contentHash` 与逐家 `doc`，产物幂等（同一份上游数据重跑 `git diff` 为空）。
- **集合变化是已接受的后果**（用户 2026-10-04 裁定，不做 deprecated 保留标记）：切源后共有 355（image 位翻转 0）/ 只 pi 消失 80（图 72）/ 只上游出现 109（图 47）；贴图提示面 消失 8 / 新增 62。冻结数字与 8 条丢失清单见 commit e255e64 的 `tests/ai/model-catalog.test.ts`；11 号票删掉 pi-ai 快照后该逐格比较不再可执行，该文件只保留一份 pi 数据无关的「后果冻结」用例（`zhipu` → `zhipuai` 的登记值、8 条消失 id 在新目录查不到）。
- 无上游身份的 2 家（`ollama` 本地 / `custom` 用户自填端点，`NO_CATALOG_PRESETS`）永远查不到元数据，UI 整栏静默隐藏、不显示占位。
- 架构评审（含 AI 代理）不得再提议：把**原始**上游数据接进请求链或运行时；用 **UI 目录产物**回填 `thinking-profiles.ts`；让 `protocol` 参与目录查表。重开条件见决定 2。
- 借来的设计参照仍然算数：`extension/ai/compat-vocab.ts` 的 `compat` 开关词表命名与语义（[ADR-0009](0009-model-catalog-borrow-not-embed.md)「借」清单）不因删依赖而回退；0009「不借」清单里的 `dsh-llm-pi-ai` 外来 assistant 消息降级 / replay 机制照样不借。
