# ADR-0002：状态袋维持页面单例与 `Readonly` 写门禁

> 状态：有效

内容脚本侧的核心状态袋 `extension/core/state.ts`（`reader` / `clip` / `ui` 命名空间 + `settings`）、单写者内聚切片 `extension/ai/player-ai-state.ts` 与对话会话状态袋 `extension/chat/chat-state.ts` 统一采用 **模块级页面单例 + 公开类型 `Readonly` + 意图级 setter / 原语门禁**（完整字段清单、白名单与生命周期归属见 [`docs/state-contract.md`](../state-contract.md)）。我们决定：**除完全内聚且仅单一业务写者的切片（如 `playerAiState`）外，状态袋不做散字段跨目录搬迁或全域收敛，也不将模块级单例改为构造注入（DI）**。

## 理由与考虑过的方案

- **按目录美学拆碎 `reader`/`clip`/`ui` 或 `chat-state` 散字段**（否决）：业务字段已在公开类型上标 `Readonly`，袋外直写在 `tsc --noEmit` 编译期即失败；`ui` 等弱聚合字段跨多模块读写、无单一属主，强拆只会退化为多个单字段状态袋或把「误写面」换成「逐字段白名单漂移面」。`clip` 的真耦合点在渲染侧读依赖，不在写面（生效字幕与副轨写入已由接受事务收口）。
- **将模块级单例改为构造注入（DI）**（否决）：Content Script 在每个标签页天然运行于独立的 Isolated World JS realm，不存在同页多会话并存隔离需求；测试隔离已由专用重置与脚手架出口（`resetChatSessionStateForTests` / `chatSessionStateForTests`）覆盖，引入 DI 只会让全链路子模块函数签名膨胀。
- **运行期 `Proxy` 写拦截**（否决）：`tsc` 已覆盖公开字段，运行期代理只会干扰内部白名单字段直写语义并增加打包负担。

## 后果

- 架构评审（含 AI 代理）不得再提议 `reader` / `clip` / `ui` 或 `chat` 散字段的归属搬迁、全域收敛或「模块级单例 → 构造注入」改造。
- 重开条件：同一标签页内出现并存多份独立阅读或对话会话实例的真实产品需求，或深层数组原地改写引发实际误写事故。
