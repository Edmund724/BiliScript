# ADR-0013：对话回合单向等待 DAG、延迟停止看门狗与双轨上下文隔离

> 状态：有效

在 AI 对话域（`extension/chat/`）与 Offscreen 流式端口协作中，为根除历史回放、发送闸、停止指令与标签页切换之间的异步死锁及跨视频串片，实行**单向等待 DAG**、**建连期延迟停止配 4 秒看门狗**与 **`contextData` / `liveContextData` 双轨快照隔离**。

## 已定决策

### 1. 发送闸—回放—回合单向等待 DAG

三者异步依赖方向严格固定，严禁逆向成环：

- **历史切换等回合落定**：点击历史会话入口先 `await turnLifecycle.settled()`（在途流先发停流并将半截问答落盘回原会话），再切换会话状态与视图；拆除类操作（删除/清空/新对话）不经此等待，直接断流清场。
- **发送闸等回放让位**：`chat/send-gate.ts` 在放行前单向 `await replay.inFlight`。
- **历史回放零等待（Wait-Free）**：`chat/replay.ts` 内部绝不等待 `turnLifecycle` 或 `sendGate`；以 50ms 帧预算分片让出主线程，并在每次恢复时核对单调递增的 `generation` 代次以作废过期分片。

### 2. 建连窗口延迟停止与 4 秒 `settled()` 看门狗（`extension/chat/chat-runtime.ts`）

- 用户在发送闸等待（见 [ADR-0011](0011-subtitle-prefetch-and-asr-isolation.md)）或 `runtime.connect` 尚未就绪期间点击「停止」时，标记 `stopWhenPortReady`，并在 `port.postMessage({ type: "chat" })` 发出后**紧随其后同步补发 `stop`**，避免远端尚未登记活跃生成而静默丢弃停止指令。
- `settled()` 内置 `TURN_SETTLE_FALLBACK_MS`（4 秒）看门狗超时兜底，防止 Offscreen 文档被浏览器异常回收且未派发 `Port.onDisconnect` 时导致对话面板永久锁死在在途态。

### 3. `contextData` 与 `liveContextData` 双轨隔离及单槽严配

- `chat/chat-state.ts`（写门禁见 [ADR-0002](0002-state-bag-write-discipline.md)）将主对话绑定的 `contextData` 与实时标签页快照 `liveContextData` 物理分离：流式生成期间与会话置顶（pinned）状态下冻结 `contextData` 防切片串话；`liveContextData` 持续追踪当前标签页最新视频与字幕状态，支撑后台字幕就绪轮询与取消置顶瞬时回填。发送闸触发上下文跟随时透传 `preserveInput: true` 保全用户输入与粘贴图片草稿。
- Offscreen 字幕单槽缓存（`entry/offscreen-subtitle-slot.ts`）供同视频多轮追问免重复结构化克隆，但**严格按视频与轨道键精确匹配**，失配时返回显式 `subtitle-body-missing` 令发送端补传一次正文，严禁跨键猜测回退导致多标签并发串片。

## 考虑过的方案

- **单一 `contextData` 实时覆写并在 `replay` 内反向等待在途回合**：流式中切标签会立刻污染当前问答上下文，且 `sendGate -> replay -> turnLifecycle` 交叉触发时形成死锁环。
- **Offscreen 字幕槽在键失配时回退最近一份缓存**：在双开视频标签页交替追问时会静默串入另一视频的字幕。
