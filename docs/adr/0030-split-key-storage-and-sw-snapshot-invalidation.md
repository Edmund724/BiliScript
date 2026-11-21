# ADR-0030：密钥与配置分离存储、SW 只读快照双失效及分片原子缓存索引

> 状态：有效

在设置项、服务商配置、API 密钥与跨模块缓存管理中，我们决定实行 **配置与明文密钥分域存储（`sync` vs `local`）**、**官方凭据单源引用**、**SW 读多写少只读快照缓存配强制双通道失效**，以及 **基于冒号分键的原子 LRU 缓存索引**，从而兼顾跨设备同步体验、明文密钥安全、SW 高并发读写一致性与存储配额边界。

## 背景与动机

1. **同步配额与密钥暴露风险**：`chrome.storage.sync` 存在严格的总容量与单项字节上限，既不能容纳每视频数 KB 的高亮/标签/视图状态，也不应存储用户的明文 API Key。
2. **并发写覆盖与读后写不一致**：SW 热路径（对话、ASR、联网搜索）每次都要读取 6 组以上设置与服务商列表；若采用直透写（write-through）或全量反序列化修改后整包回写，并发请求会互相覆盖丢键。此外，`chrome.storage.onChanged` **不会在执行写入的同一上下文（及测试桩）内回发**。
3. **跨家族重复录入 API Key**：联网搜索 DeepSeek 与实时伴看 Gemini Live 都依赖用户已有的官方 AI 平台凭据，若让用户在三个设置面板重复粘贴 Key 会显著恶化维护与轮换体验。

## 已定决策

### 1. 配置进 `sync`、密钥与设备本地状态留 `local`

- `core/provider-store.ts` 将服务商元数据（名称、端点、模型列表）存放在 `chrome.storage.sync`，而明文 `apiKey` 严格隔离于 `chrome.storage.local`（列表读出仅暴露 `hasSavedKey: boolean`）；更新保存空 Key 时保留既有本地 Key，删除服务商时同步清理对应本地 Key。
- `notes/highlights-store.ts`（每视频高亮文本）与 `reader/script-tab-persistence.ts`（设备本地激活标签页位置）显式隔离在 `chrome.storage.local`，不占用 `sync` 配额，且读取异常永不阻断阅读进入。

### 2. 跨家族官方凭据单源引用（`ai-credential-reference.ts`）

- 搜索与实时伴看消费方不自持明文密钥副本，而是按官方 HTTPS 严格域名（强制 `https:`、默认端口 443、主机名全等匹配）动态解析 `aiProviders` 里的官方记录，防止 AI Key 意外泄露至第三方中转代理端点。

### 3. SW 只读快照缓存（无写透）与强制双通道失效

- `core/settings-snapshot.ts` 由单一事实表 `SNAPSHOT_STORAGE_KEYS` 统一派生失效域、写入区域路由（`writeSnapshotKeys`）与监听订阅。
- **不采用 write-through**：写入方通过 `invalidatingWrite` / `writeSnapshotKeys` 在写库成功后**同步执行本进程内联失效**（弥补同上下文不触发 `onChanged` 的盲区），同时通过 `watchStorageKeys` 监听跨上下文/跨设备 `chrome.storage.onChanged` 事件触发失效；AI 家族更新时单向级联失效 Search 家族快照（覆盖 DeepSeek 凭据引用）。
- 快照按只读引用返回，所有热路径消费者严禁原地篡改返回对象。

### 4. 分键原子 LRU 索引与最长前缀归属（`core/cache-lru.ts`）

- 针对 `chrome.storage` 缺乏原子追加能力导致的并发 Map-Reduce 丢更新问题，LRU 索引采用 `:` 分隔的逐键独立条目（缓存键本身不含 `:`）记录写入；总清单仅作为启发式排序与短路提示（修剪时可自愈）。
- 匹配缓存家族时按前缀长度降序匹配，防止 `biliscript_lvs_analysis_final_*` 被较短的段缓存前缀误判而提前淘汰；优先使用 `StorageArea.getKeys()` 避免枚举时全量反序列化大值，Chrome 120–129 回落单次 `get(null)`。

## 考虑过的备选

- **将 API Key 与配置同存 `chrome.storage.sync` 或仅依赖 `onChanged` 刷新 SW 缓存**：前者带来明文密钥跨端扩散风险且易撞 8KB 单项限制；后者在 SW 同上下文写后立即读时必然命中陈旧缓存，均予以否决。
- **在单个 JSON 清单键内维护全局 LRU 数组**：并发写多段分析摘要时会发生典型的 read-modify-write 丢失更新，予以否决。

## 后果

- 任何修改 `SNAPSHOT_STORAGE_KEYS` 所辖存储键的 SW 写入口必须走 `invalidatingWrite` / `writeSnapshotKeys`，由 `tests/core/settings-snapshot-write.types.ts` 与 `tests/core/settings-normalizer-keys.test.ts` 提供编译期与单测守卫。
- 快照返回共享引用要求调用方自觉维持不可变性；历史测试兼容中仍存在的少量只读绕过入口已记入技术债追踪。
