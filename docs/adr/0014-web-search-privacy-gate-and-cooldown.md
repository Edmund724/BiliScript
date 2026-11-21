# ADR-0014：联网搜索隐私授权闸、哈希缓存跨上下文共享与 SW 持久化冷却

> 状态：有效

联网搜索模块（`extension/search/`）会将视频外检索词发往第三方搜索引擎，且运行于随时可能休眠回收的后台上下文，故确立**显式隐私授权与跃迁退订清理**、**查询哈希缓存跨上下文共享**及**存储态引擎健康冷却与付费门控**三项边界。

## 已定决策

### 1. 强交互隐私授权闸与 `true -> false` 跃迁清理

- 首次启用联网搜索必须经显式授权确认弹窗（`search/opt-in-notice.ts`）：弹窗取消或随视图卸载时不写入拒签偏好；若用户已明确拒签，忽略调用方传来的陈旧 `enabled = true`。
- 缓存与排序孤儿 ID 清理（`search/search-opt-out.ts`、`search-provider-deletion.ts`）仅在 `webSearchEnabled` 发生 **`true -> false` 状态跃迁**或用户删除搜索平台记录时触发，避免无关的全量设置保存误清空有效缓存。

### 2. 查询词哈希落盘与跨上下文缓存共享（`extension/search/search-cache.ts`）

- 搜索结果缓存在后台按规范化查询词哈希建键，**磁盘不持久化明文搜索词**，且跨搜索引擎共享命中结果。
- `search-cache` 与 `search-health` 消息**刻意不列入 `OFFSCREEN_ONLY_MESSAGE_TYPES`**：除了 Offscreen 内的 AI 对话工具循环外，页面 Content Script 内的划词选区解释卡也复用同一套搜索执行器，开放给页面与 Offscreen 双端可避免在内容脚本侧重复建设第二份缓存与健康账本。

### 3. 存储态无内存冷却机与显式付费门控（`extension/search/search-health.ts`、`search-chain.ts`）

- 搜索引擎的冷却截止时间与指数退避等级持久化在 `chrome.storage` 中并经后台设置快照双通道失效驱动（见 [ADR-0018](0018-layered-storage-and-extension-idb.md)），不依赖进程内 `Map`（防止 MV3 Service Worker 休眠唤醒后冷却状态清零导致反复撞击故障引擎）。同一预设的多条记录共享健康度；冷却期内被动跳过不累加退避等级，请求恢复成功后归零。
- 智能回退链受链级总超时预算与 `allowPaidSearchProviders`（默认关闭）双重约束：未开启付费开关时付费引擎（如 DeepSeek Search）绝不进入自动回退链；用户手动**单选**付费引擎本身构成显式付费意图，不受该开关阻断且失败不回退。设置页单点连通性探针直测目标引擎，不走回退链、不写搜索缓存、不改动冷却计数。

## 考虑过的方案

- **用后台内存 `Map` 维护引擎熔断状态**：Service Worker 空闲 30 秒回收后退避记录丢失，长对话间隔提问会反复卡在已挂引擎的 15 秒超时上。
- **将 `search-cache` 锁入 `OFFSCREEN_ONLY` 来源白名单**：切断页面侧划词解释卡的缓存读写路径，迫使两套上下文各自发重复请求。
