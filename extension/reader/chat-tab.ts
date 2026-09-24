// extension/reader/chat-tab.ts — 阅读模式「AI 对话」tab 组合根（PR5）。
//
// sidepanel.ts 的 reader 等价物：工厂组装 + init 时序 + bindEvents + 页面级编排。
// 四个页面级编排函数（syncLiveContextState / ensureCurrentContextForSend /
// restartChat / renderInitialState）**整段迁自 extension/pages/sidepanel.ts**，
// 只换宿主 DOM 引用（readingChat* id）与两处 reader 语境适配（见各自函数头注），
// 分支顺序/时序咬合逐字保持——subtitle-wait 轮询、no-subtitle 拦截、pinned
// 补水、流式守卫在侧栏版被时序咬合得很紧（context-policy.ts :58-61 两个 pinned
// 谓词的疑义记录仍在），按新 UI 心态重写必引入行为漂移（盘点报告风险 4）。
//
// 组装面（与 sidepanel.ts 同构；内核链五件自 arch-review-2026-09/08 起收进
// ../chat/tab-domain.ts 的 createChatTabDomain 单一深入口，本文件 chat 域
// import 面 10→1）：
//   conversation-store（pinned 补水的 context 解析 dep 接复合适配器：会话
//     contextRef 与当前 clip 身份一致 → 进程内快照装配（工单 04 短路，零网络
//     解析）；未命中走 ai/context-resolver 的 bgFetchJson 通道，content script
//     可用）+ context-load（编排壳）+ 装配链（createInProcessContextFetch /
//     createInProcessPinnedContextResolver：AiContext 装配唯一入口，工单 07
//     收口到 core/context-assembly，锚定 context-payload 的形状/签名单源；
//     工单 08 三事已配测试）+ providers + presets +
//     subtitle-wait + no-subtitle + notices/lists/popovers（三壳重建于
//     reader/chat-{notices,lists,popovers}.ts，逻辑照抄）。URL 变化的实时上下文
//     同步调度（原 chat/context-sync.ts 的防抖状态机，工单 05 并回为本地闭包）
//     由 biliscript:urlchange 触发，reader 打开/关闭的恢复折叠进本组合根的激活路径。
//   - offscreen 连接：chrome.offscreen/getContexts 仅扩展上下文可用，content
//     script 经 "ensure-offscreen-chat" 消息委托 background 幂等 ensure，再
//     connect "offscreen-chat" 端口——sidepanel.ts connectPort 的自愈设计照搬。
//   - subtitleWaiter.kick 的触发源：content script 收不到自己的
//     biliscript-subtitle-status 广播（PR3 已核实），改订阅 shared/subtitle-status-bus
//     的进程内相位（asr-transcribing/done/failed），语义与侧栏广播监听一致。
//   - 外点关闭：popovers 的 handleDocumentClick 经 chat-tab-bridge 注册槽并入
//     ui-renderer 的单一文档级委托（风险 6，不双监听）。
//
// 生命周期（懒加载 + 会话收尾，工单 08 决议）：
//   - 二级惰性：本模块经 reader/lazy-chat-tab.ts 动态装载，首次切到对话 tab（或
//     解释卡片「去对话追问」/概览笔记按钮触达 seam）才 init；
//   - 关闭阅读模式即断流（closeReadingView → closeChatSession：resetStreamState
//     断 port、pending 的 subtitle-wait 立即失效、摘全局触发源）；重开从会话
//     历史恢复（激活路径 loadContextState → restoreLatest → renderInitialState）；
//     对话 tab 的流式中关闭不做后台续跑（connectPort 的 closed 闸兜底）。
//
// 测试注意：els 在模块求值时解析（对话 tab 只在面板壳存在后装载，与 sidepanel
// 的页面加载时序同构）；模块级单例状态（chatSessionState + 本文件闭包）在测试里
// 靠 vi.resetModules 换纪元重置。
//
// 拆分（opt-backlog-2026-09/12）：本文件为逐名再导出壳 + 模块顶样式挂载，导出面
// 与导入路径零变化（lazy-chat-tab 等消费方零改动）。编排层拆三片：
//   chat-tab-dom.ts（els/requireShell/widthEls 状态袋）
//     ↑
//   chat-tab-core.ts（实例装配 + 发送重放/上下文同步内核）→ chat-tab-lifecycle.ts
//     （初始化时序/事件绑定/激活收尾；sessionClosed 读侧回边见 core 片头注）

// 对话分区表模块顶兜底挂载（arch-slim-4/07，settings-panel.ts 顶挂载同款先例）：
// 主点在 ui-renderer setReaderScriptTab 的 chat 分支（盖住现役三入口），此处盖
// 住未来新入口——本模块被动态装载即样式在场；ensure 内部 mounted Map 去重。
import { ensureReaderChatStyles } from "../shared/style-injector.js";
// 先于 lifecycle 求值组合根内核片（保持拆分前的模块遍历序，稳住压缩命名分配）。
import "./chat-tab-core.js";

ensureReaderChatStyles();

export { closeChatSession, ensureChatTabActivated, runQuickActionPrompt } from "./chat-tab-lifecycle.js";
