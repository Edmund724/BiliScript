# 状态袋写纪律：Readonly 切片 + 意图级 setter，不做全域化

本 ADR 是同一条纪律在两个状态袋上的适用记录：`core/state.ts`（reader/clip/ui 三命名空间 + settings）与 `extension/chat/chat-state.ts`（对话域 14 字段袋，sidepanel 时代的模块级可变量迁入 chat 域时收拢而成）。纪律本身只有一条：**状态袋不做全域化收敛、不做归属搬迁，只把完全内聚的切片收进「Readonly 业务字段 + setter 白名单」**。

## 共同判断

- **编译期只读契约已兜底误写面**：TS `Readonly` 业务字段 + setter 白名单使直接写业务字段在
  `tsc --noEmit` 即失败。域归属搬迁或全域拆分并不能进一步缩小误写面，收益只剩「文件归属美学」。
- **只动内聚切片**：写方能整组收进意图级原语的切片才收；写方跨文件、粒度混写的字段不硬收——
  要写出一一对应的 setter 白名单，等于把「误写面」换成「白名单漂移面」，比现状更难维护。
- **不采纳的通用手段**：只加注释不落类型（纪律落在注释上仍是纪律真空）；Proxy 运行期拦截
  （只对白名单外字段增加覆盖，还改变既有直写行为与打包产物）。

## 适用范围一：core/state.ts——只做 playerAi 单切片迁出

core/state.ts 以「Readonly 业务字段 + setter 白名单」的状态袋聚合 reader/clip/ui（原 playerAi）
命名空间（见 docs/state-contract.md）。曾有提案将其按域全部拆出（reader 归 reader/、clip 归
subtitle/ 等）。裁决：**只把完全内聚的 playerAi 单切片迁出**——迁至
`extension/ai/player-ai-state.ts`，其余命名空间维持现状。理由：

- **ui 命名空间是弱聚合、无属主**：7 个字段散布 8 个文件读写，没有单一域可承载；拆出去只会
  变成 N 个单字段状态袋，聚合本身消失，比现状更差。
- **clip 的真解耦点在读面不在写面**：写面已被字幕接受事务收口（subtitle/commit.js 的
  acceptSubtitle 是 subtitleFetchState → "ready" 的唯一写入点，无字幕原因经逆事务
  commitNoSubtitle 写入）；真正的耦合是 reader/lifecycle 对 clip 15 个字段的渲染读依赖。
- **reader 命名空间迁出会牵动 Settings 接口的跨进程归属**：options 页与 background 也读
  reader 相关设置，命名空间搬迁会把这些跨进程读写一并卷入，超出状态袋议题的边界。
- **playerAi 是唯一的例外**：全仓只有 `ai/player-ai.ts` 一个业务读写方，外加一处
  `setSuppressedUntil`；它是纯内聚切片，迁出零牵连（defaults.ts 零改动），放着不迁只是留下
  一处「core 袋里住着 ai 域私有状态」的错位。

## 适用范围二：chat/chat-state.ts——只补会话身份切片（原 ADR-0011）

ADR-0005 原只管到 `core/state.ts` 本身，chat 域的状态袋一直处在纪律真空里：生产写点
（`conversation-store.ts` / `chat-runtime.ts`）逐字段直写，编译期一道约束都没有。裁决沿用
共同判断：**只给内聚的会话身份切片补纪律，不做全域收敛，也不搬迁**。切片专属理由：

- **误写代价是会话复活或串话**：会话身份三件套（`currentConversationId` /
  `currentConversationMeta` / `chatHistory`）与 `savedConversations` 是「拆除会话」「落盘」
  「在途写回」三条事务共用的同一份状态（`tests/chat/conversation-store-detach.test.ts` 锁的
  「断流先于身份清空」就是这条不变式的承重断言）。
- **切片写方收得干净**：身份三件套 + 存档列表的写方（`conversation-store` 的
  apply/persist/hydrate/commitSaved 与 `chat-runtime` 的三处）能整组表达意图；其余 10 个字段
  的写方跨 3 个文件（`context-load.ts` / `providers.ts` / `reader/chat-tab.ts` /
  `chat-runtime.ts`）且粒度混写（有的整体替换、有的局部改写子对象），不具备这个条件。

## 后果

core/state.ts 侧：

- core/state.ts 收敛为三命名空间（reader/clip/ui）+ settings；playerAi 命名空间由
  `ai/player-ai-state.ts` 提供（同构的 Readonly + setter 形状），`state.playerAi` /
  `playerAiState`（core 版）别名移除。
- player-AI 的袋外写入走意图级 `suppressUntil(timestamp)`，ai 域外的调用方不接触具体槽位；
  player-ai 动态 chunk 的 S3 分层不受影响（message-handler 仍只静态依赖状态微模块，不依赖
  player-ai.js 本体）。

chat/chat-state.ts 侧：

- `ChatSessionState` 公开类型对身份三件套与 `savedConversations` 为 `Readonly`，内部 writable
  实例只在 `chat-state.ts` 内可见。
- 意图级写入原语（成组而非逐字段，与 `suppressUntil` / `transitionReaderShell` 同一先例）：
  `applyConversationIdentity({ id, meta, history? })`、`detachConversationIdentity()`、
  `clearConversationIdentity()`、`ensureConversationId(id)`、`appendChatHistory(...messages)`、
  `setSavedConversations(next)`。生产写点全部改走原语：conversation-store 的
  detachCurrent / apply / persistCurrent / hydratePinned / commitSaved，chat-runtime 的
  失配守卫 / id 物化 / 在途写回。「断流先于身份清空」的时序逐字保持。
- 测试侧的 beforeEach 字段重置块塌缩为单点注入口 `resetChatSessionStateForTests()`（仅供测试，
  对照 `core/state.ts` 为脚手架保留的 `readingViewOpen` force-set）。

共同约束：

- 架构评审（含 AI 代理）不得再提议 reader/clip/ui 或 chat 散字段的归属搬迁与全域收敛。
- 重开条件：clip 的正确切入点是 lifecycle 渲染的数据来源（参数注入/快照传递），而非状态归属
  搬迁；chat 的 B 档散字段（`contextData` / `currentContextKey` / `aiPrefs` 及 live/杂项标志）
  先有一轮写方归并，再谈 setter 白名单。

## 修订（2026-09-12：suppressUntil 写入方搬迁）

playerAi 单切片迁出的结论不变；`core/message-handler.ts` 对 player-AI 的唯一写入
（`setSuppressedUntil`）已随阅读壳唯一事务搬走，**`suppressUntil(timestamp)` 的唯一生产调用点
现为 `reader/shell.ts`**（enterReaderShell 八步无闪变时序第 1 步，`shell.ts` 内
`suppressUntil(Date.now() + 2500)`）；message-handler 只剩经 `ai/lazy-player-ai.js` 的动态
装载触达（`loadPlayerAi` / `isPlayerAiLoaded`），不触 player-AI 状态槽位。docs/state-contract.md
的写入方陈述（reader/shell.ts 经意图级 helper 写入）已与此一致。

## 修订（2026-09-28：ADR-0011 并入本条，编号退役）

原 `0011-chat-state-write-discipline.md` 与本条同源同形（其自身亦声明「不推翻 ADR-0005，
判断原样适用」），分篇维护只会互相解释范围关系；合并为本条的「适用范围二」，0011 编号退役
不复用。两袋的实质决策、原语清单与 B 档记录均未改动。
