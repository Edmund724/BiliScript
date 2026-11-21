# ADR-0035：联网搜索隐私授权闸、无状态冷却机与多协议适配边界

> 状态：有效

在联网搜索降级链（`extension/search/`）及多 AI 协议统一适配（`extension/ai/protocol-adapter.ts`、`extension/ai/compat-vocab.ts`）中，我们决定实行 **强交互授权门禁与显式退订清理**、**持久化在 `chrome.storage` 中的无状态冷却状态机**，以及 **编译期封闭 `PlatformKey` 与稀疏 `PLATFORM_QUIRKS` 双键空间隔离**。

## 背景与动机

1. **联网搜索隐私风险与 SW 休眠丢失冷却状态**：联网搜索会将视频外补充检索词发往第三方搜索服务商，未经明确授权或用户已退订时绝不可静默发起请求或重复弹窗；同时 MV3 SW 随时可能被浏览器休眠回收，内存中的引擎熔断/退避计数会随休眠丢失。
2. **多搜索引擎混跑成本与延迟失控**：6–7 个备选引擎若每个都走满 15s SW 超时，最坏回退耗时接近两分钟；且付费引擎不能在未授权时被智能降级链自动消耗额度。
3. **跨平台协议方言与怪癖键空间不重合**：AI 预设词表（含 `custom`）、思考档位支持平台表（`PlatformKey`，含 `siliconflow` 等）和协议怪癖稀疏表（`PLATFORM_QUIRKS`）三者既存在交集又互不相等，混用单一枚举或运行期手写字符串映射极易遗漏字段或触发原型链误判。

## 已定决策

### 1. 隐私授权门禁、`true -> false` 退订清理与加密查询缓存

- `search/opt-in-notice.ts` 在弹窗卸载或取消时严禁写入拒绝偏好，且用户已拒绝过时忽略调用方传入的陈旧 `enabled=true`；`search/search-opt-out.ts` 与 `search/search-provider-deletion.ts` 仅在 `webSearchEnabled` 由 `true -> false` 跃迁或删除服务商时清理搜索缓存与自定义排序中的孤儿 ID，避免日常无关全量设置保存误清缓存。
- `search/search-cache.ts` 在 SW 侧按查询哈希建键（磁盘不落明文搜索词），跨引擎共享命中，且不将其放入 `OFFSCREEN_ONLY_MESSAGE_TYPES` 以允许页面内划词解释卡片共享同一运行期缓存与健康上报。

### 2. SW 无内存状态冷却机（`search-health.ts`）与总预算隔离降级链

- 所有搜索引擎冷却时间与退避等级持久化于存储并经 SW 快照失效驱动（不依赖内存态），同一预设引擎的多条用户记录共享冷却健康度，处于冷却期内的被动跳过不叠加退避次数，恢复正常后归零。
- `search/search-chain.ts` 在智能降级链中强制受 `allowPaidSearchProviders` 开关约束（显式单选特定搜索引擎仍放行），并对整条降级链施加总时间预算防止串联超时；单条命中摘要统一截取至 500 字符上限。

### 3. 双键空间隔离、7 操作协议适配器与跨协议无副作用扩展头

- `ai/protocol-vocab.ts` 与 `ai/platform-identity-vocab.ts` 将 `AiProtocol` 词表与 `PlatformKey` 封闭键表独立为无运行时依赖的纯叶模块；`ai/platform-quirk-id.ts` 专门面向稀疏的 `PLATFORM_QUIRKS`（先查 `presetId` 再经 `core/preset-host-index.ts` 回退域名，排除 `protocolBaseUrls` 防污染规范身份），并用自有属性检查拦截原型键。
- `ai/protocol-adapter.ts` 将 OpenAI / Anthropic / Gemini 的端点、鉴权头、请求体、错误提取、流消费、响应解析与模型拉取收敛于 7 个统一接口操作与结构化 `ProtocolCapabilities`，并由单测双向核对每个适配器的 `CompatQuirk` 消费声明；`preset-headers.ts` 用 `FNV-1a` 把 `sessionId` 确定性映射为 UUIDv4（无状态调用用 `crypto.getRandomValues` + `Math.random` 兜底，规避非 HTTPS 页缺失 `crypto.randomUUID`）。

## 考虑过的备选

- **把搜索引擎健康度放进内存 Map 并把缓存消息限死为 `OFFSCREEN_ONLY`**：前者在 MV3 SW 休眠后立刻清零失效，后者会把内容脚本划词卡片逼入单独复制一份缓存逻辑，均予以否决。
- **合并 `PlatformKey`、`presetId` 与 `PLATFORM_QUIRKS` 为同一枚举**：会迫使无怪癖或无思考参数的平台写入大量空占位，破坏静态不可达语义，予以否决。

## 后果

- 任何新增第三方搜索或 AI 平台必须先对齐 `SEARCH_PROVIDER_PRESETS` / `PlatformKey` / `ProtocolCapabilities` 的编译期约束与单测双向对账守卫。
- 搜索服务商测试探针必须单点直测指定目标，禁止触发降级链、污染缓存或改动冷却计数。
