# chat-state 状态袋补写纪律——会话身份切片 Readonly+setter

`extension/chat/chat-state.ts` 的 `chatSessionState` 是对话域的状态袋（14 字段，sidepanel 时代的模块级可变量在 PR5 迁入 chat 域时收拢而成）。ADR-0005 定了 `core/state.ts` 的「Readonly 业务字段 + setter 白名单」纪律、也只管到 `core/state.ts` 本身——chat 域的状态袋一直处在纪律真空里：生产写点（`conversation-store.ts` / `chat-runtime.ts`）逐字段直写，编译期一道约束都没有。本 ADR 决定：**只给内聚的会话身份切片补纪律，不做全域收敛，也不搬迁**。

## 理由

- **编译期只读契约兜底误写面**：会话身份三件套（`currentConversationId` / `currentConversationMeta` / `chatHistory`）与 `savedConversations` 是「拆除会话」「落盘」「在途写回」三条事务共用的同一份状态，误写的代价是会话复活或串话（`tests/chat/conversation-store-detach.test.ts` 锁的「断流先于身份清空」就是这条不变式的承重断言）。`Readonly` 让 `chatSessionState.xxx = y` 在 `tsc --noEmit` 即失败。
- **搬迁收益只剩美学**：与 ADR-0005 同一判断——chat 状态袋已经住在 chat 域内，搬去别处并不缩小误写面，只改文件归属。
- **只动内聚切片**：身份三件套 + 存档列表的写方收得干净（`conversation-store` 的 apply/persist/hydrate/commitSaved 与 `chat-runtime` 的三处），能整组表达意图；其余字段不具备这个条件（见下）。

## 考虑过的方案

- **14 字段一次性全收**：剩下 10 个字段的写方跨 3 个文件（`context-load.ts` / `providers.ts` / `reader/chat-tab.ts` / `chat-runtime.ts`）且粒度混写（有的整体替换、有的局部改写子对象），要写出一一对应的 setter 白名单，等于把「误写面」换成了「白名单漂移面」——比现状更难维护。
- **只加注释不落类型**：纪律落在注释上就仍是纪律真空，下一个人照样直写。
- **改用 Proxy 运行期拦截**：同 ADR-0005 的取舍——只对白名单外的字段增加覆盖，还会改变它们既有的直写行为与打包产物。

## 后果

- `ChatSessionState` 公开类型对身份三件套与 `savedConversations` 为 `Readonly`，内部 writable 实例只在 `chat-state.ts` 内可见。
- 新增意图级写入原语（成组而非逐字段，先例 `core/state.ts` 的 `suppressUntil` / `transitionReaderShell`）：`applyConversationIdentity({ id, meta, history? })`、`detachConversationIdentity()`、`clearConversationIdentity()`、`ensureConversationId(id)`、`appendChatHistory(...messages)`、`setSavedConversations(next)`。
- 生产写点全部改走原语：conversation-store 的 detachCurrent / apply / persistCurrent / hydratePinned / commitSaved，chat-runtime 的失配守卫 / id 物化 / 在途写回。「断流先于身份清空」的时序逐字保持。
- 测试侧的 beforeEach 字段重置块塌缩为单点注入口 `resetChatSessionStateForTests()`（仅供测试，对照 `core/state.ts` 为脚手架保留的 `readingViewOpen` force-set）。
- B 档散字段（`contextData` / `currentContextKey` / `aiPrefs` 及 live/杂项标志）暂不收敛：写方跨 3 文件、粒度混写，是独立议题；重开条件是先有一轮写方归并，再谈 setter 白名单。

## 与既有决策的关系

本 ADR **不推翻 ADR-0005**：0005 的结论与范围都只针对 `core/state.ts` 的 reader/clip/ui（及当时 playerAi 的迁出），从未覆盖 `chat/chat-state.ts`。两者同源同形（Readonly 切片 + 意图级 setter + 白名单），0005 里「编译期只读契约已兜底误写面、搬迁收益只剩美学」的判断在这里原样适用。
