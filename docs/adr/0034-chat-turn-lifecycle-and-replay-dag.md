# ADR-0034：对话回合生命周期、发送闸单向等待 DAG 与流式上下文隔离

> 状态：有效

在 AI 对话标签页（`extension/chat/`）与 Offscreen 流式执行内核（`extension/entry/offscreen-chat-port.ts`、`extension/ai/client.ts`、`extension/ai/tool-loop.ts`）中，为彻底消除历史回放、发送闸、切换/停止与长时流式传输间的死锁与状态撕裂，我们决定实行 **严格单向等待 DAG**、**`contextData` / `liveContextData` 双轨冻结隔离**，以及 **Offscreen 字幕单槽缓存与 30–50ms 令牌合帧协议**。

## 背景与动机

1. **异步等待环与孤立挂起回合**：发送消息的 `send-gate` 需要等待正在进行的历史消息回放（`replay.inFlight`）；历史切换需要等待上一回合流式落定（`settled()`）；若 `replay` 内部反向等待 `settled()` 或发送闸，就会产生死锁。同时，在 `send-gate` 或 `connectPort` 挂起期间用户点击「停止」，由于尚无活跃 `Port` 或远端尚未登记 `activeGeneration`，提前下发的 `stop` 消息会被 Offscreen 静默忽略，导致 `settled()` 永久挂起。
2. **流式冻结与后台轮询饥饿冲突**：流式回复或置顶会话期间必须冻结主对话区绑定视频的 `contextData`；但同一面板内的字幕等待轮询和取消置顶回填仍需要观测当前标签页的实时最新视频与字幕状态。
3. **长对话多模态与跨端口结构化克隆瓶颈**：多 MB 字幕正文在每次追问重复通过 `runtime.Port` 传递、或逐 Token 发送 IPC 消息会导致主线程与 Offscreen 序列化开销剧增；而历史消息里附带的截图若每轮原样重传会引发重复计费和超出存储上限。

## 已定决策

### 1. 发送闸—回放—回合生命周期单向等待 DAG 与延迟停止协议

- `chat/replay.ts` 保持零等待（wait-free）且以 50ms 帧预算分片异步渲染（通过 `scheduler.yield()` / `setTimeout(0)` 让出主线程，并在每次让出后校验单调递增的 `generation`）；历史点击入口先 `await turnLifecycle.settled()` 再切换会话；`send-gate` 仅等待 `replay.inFlight`，绝不逆向成环。
- `chat/turn-lifecycle.ts` 将发送前挂起期间到达的 `stop()` 记为 `stopWhenPortReady`，并在 `port.postMessage({ type: "chat" })` 发出后**严格紧随其后**刷新发送 `stop`，配合 4 秒 `settled()` 看门狗兜底 Chrome 意外回收 Offscreen 导致的丢断开事件。
- `chat/tab-domain.ts` 固定 `store -> contextLoad -> sendGate -> runtime -> replay` 的实例化序并以懒箭头闭包避免 ESM 循环引用 TDZ 错误；所有视图清空/错误/首配切换通过声明式 `ViewResetIntent` 联合类型收敛。

### 2. 双轨上下文隔离（`contextData` vs `liveContextData`）与发送态草稿保全

- `chat/chat-state.ts` 与 `chat/context-load.ts` 将主对话消费的 `contextData` 与实时标签页快照 `liveContextData` 物理分离：流式期间与置顶状态下 `contextData` 冻结不变，而 `liveContextData` 持续追踪当前标签页最新快照，支撑 `subtitle-wait` 轮询和取消置顶后瞬时回填。
- 因发送闸触发同视频或新视频 `context-follow` 重启时强制透传 `preserveInput: true`，并在字幕等待期间允许用户继续向草稿粘贴图片（通过快照消费分离实现）。

### 3. Offscreen 字幕单槽协议、令牌批传与工具轮静默降级

- `entry/offscreen-subtitle-slot.ts` 缓存最近一次字幕正文供同一视频追问免克隆复用，但**严格拒绝跨键猜测回退**（缺失时返回显式 `subtitle-body-missing` 令发送端补传一次），防止多标签并发串片。
- `ai/token-batcher.ts` 在 Offscreen 侧按 30–50ms 合并 `token` 帧并在非 token 事件前强刷保序（降低 ≥90% Port 结构化克隆频率）；`ai/client.ts` 以递增 `generation` 隔离 `stream-reset` 重试前后的工具活动事件。
- `ai/types.ts` 与 `chat/conversation.ts` 保持 `ChatMessage.content` 纯字符串并通过侧车 `ImagePart[]` 承载附图（仅在存储层保留最近一张附图、发送组装层对早期轮次替换为轻量文本占位防止重复计费）。
- `ai/tool-loop.ts` 遇到非可重试 4xx（400/404）不支持函数调用的端点时自动剥离工具重发一次；`chat/search-sources.ts` 对持久化截断至 2,000 字符的工具 JSON 采用大括号深度扫描抢救完整来源条目。

## 考虑过的备选

- **统一让 `contextData` 实时覆写并在历史回放中直接调用视图重置**：会导致流式中切标签破坏当前对话上下文，或 `replay` 与 `send-gate` 产生相互等待死锁，予以否决。
- **把图片 base64 直接嵌入 `ChatMessage.content` 数组并每轮全量发送**：会破坏纯文本消费路径与单调历史体积控制，予以否决。

## 后果

- `chat/` 领域所有涉及会话切换、新会话起跑与置顶解除的功能扩展必须显式指明消费 `contextData` 还是 `liveContextData` 并维护等待 DAG 单向性。
- 因发送闸中仍存在少量面向旧测试桩的兼容旁路参数，已归入测试桩清理技术债。
