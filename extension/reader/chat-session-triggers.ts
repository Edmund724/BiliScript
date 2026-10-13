// extension/reader/chat-session-triggers.ts — 阅读模式「AI 对话」的会话级触发源。
//
// 「属会话」与「常驻」是对话组合根的一对 interface 事实：会话级触发源（字幕相位
// 总线 / URL 变化 / clip 落定 / 存储变更 / 预热落定 / 外点关闭注册槽 / Esc）随激活
// 挂载、随会话收尾摘除；常驻监听（元素级 bindEvents 与窗口 resize）另在组合根里
// 一次性接好、永不摘除。本模块只承重前者的生命周期，声明处就是下面 deps 的字段名。
//
// 摘挂在同一实现内闭合：activate 逐项登记每个触发源返回的摘除器，deactivate 逆序
// 摘除——挂载列表与摘除列表不再各写一份（两列表一旦不同步，泄漏的监听只会在下一次
// 激活时变成双份）。重复 activate 幂等（已激活即 no-op），deactivate 后各源可再次
// activate（摘除器是挂载的闭合逆操作，不依赖上一次的状态）。
//
// 挂载顺序即下面 deps 的声明顺序（deactivate 逆序）；各项之间无依赖，顺序只记录
// 激活次序本身。
//
// 依赖方向：本模块零 import、零 DOM 知识——组合根以「每源一个 attach：挂载 →
// 返回它的摘除器」注入，事件目标、handler 身份与守卫条件都留在组合根（那里连着
// sendGate / popovers / 页面级编排）。

/** 一次挂载的摘除器（挂载的闭合逆操作）。 */
export type SessionTriggerTeardown = () => void;

// 会话级触发源清单：每项 = 一次挂载（返回它的摘除器）。字段名即「哪类触发源属
// 会话」的声明，缺一项是类型错误，不给「登记了却忘了摘」留形状。
export interface ReaderChatSessionTriggersDeps {
  /** 字幕相位总线（sendGate 的绑/摘一对）。 */
  statusBus: () => SessionTriggerTeardown;
  /** URL 变化（`biliscript:urlchange`）：强刷上下文对账。 */
  urlChange: () => SessionTriggerTeardown;
  /** presenter 的 `subtitle-ready`（clip 身份与字幕体原子落定）：弱档对账。 */
  clipSettle: () => SessionTriggerTeardown;
  /** sync / local 存储变更：外部设置改动后刷新平台与偏好。 */
  storageWatcher: () => SessionTriggerTeardown;
  /** 快捷问题预热落定：建议区就地换成本视频的生成结果。 */
  quickPrompts: () => SessionTriggerTeardown;
  /** 文档级外点关闭委托的注册槽（chat-tab-bridge，同一时刻至多一个注册者）。 */
  outsideClick: () => SessionTriggerTeardown;
  /** Esc 关闭弹层（window keydown）。 */
  escapeKey: () => SessionTriggerTeardown;
}

export interface ReaderChatSessionTriggers {
  /** 挂载全部会话级触发源（已激活时无操作）。 */
  activate: () => void;
  /** 逆序摘除全部已挂载的触发源（未激活时无操作）。 */
  deactivate: () => void;
  /** 当前是否有已挂载的触发源。 */
  isActive: () => boolean;
}

// 激活次序（= 声明次序）；摘除走逆序。
const TRIGGER_ORDER: ReadonlyArray<keyof ReaderChatSessionTriggersDeps> = [
  "statusBus",
  "urlChange",
  "clipSettle",
  "storageWatcher",
  "quickPrompts",
  "outsideClick",
  "escapeKey"
];

export function createReaderChatSessionTriggers(deps: ReaderChatSessionTriggersDeps): ReaderChatSessionTriggers {
  // 已挂载触发源的摘除器，按挂载次序存放（末位 = 最近挂载的一个）。
  const teardowns: SessionTriggerTeardown[] = [];

  function activate(): void {
    if (teardowns.length) {
      return;
    }
    TRIGGER_ORDER.forEach((source) => {
      // 逐项登记（不先攒完再赋值）：挂到第 n 项失败时，前 n-1 项的摘除器仍在手里，
      // deactivate 照常摘得干净。
      teardowns.push(deps[source]());
    });
  }

  function deactivate(): void {
    // pop 先摘出再调用：某一项的摘除抛错时，剩下的项仍在列表里，下一次 deactivate
    // 继续收尾（不留下摘不掉的尾巴）。
    while (teardowns.length) {
      teardowns.pop()!();
    }
  }

  return {
    activate,
    deactivate,
    isActive: () => teardowns.length > 0
  };
}
