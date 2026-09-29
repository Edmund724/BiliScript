// extension/chat/replay.ts — 历史回放事务（CONTEXT.md 词条「历史回放」）。
//
// 把当前会话历史整段重建进消息区的分片渲染事务：世代号作废过期分片（清场/
// 新轮）、50ms 帧预算让出主线程、发送路径经 inFlight 等待在途回放让位。
// 唯一事务，chat 域内组装（tab-domain.ts），编排壳经 render/invalidate/inFlight
// 三件持有——事务从 reader/chat-tab.ts 抽出（arch-review-2026-09 候选 1），
// 世代号/预算/让出语义逐字保持。
//
// 回放世代号：每次重建消息区（重渲/清场）自增。让出点据此判定本轮是否已被
// 更新的一轮取代（切会话、新消息上屏、清场）——过期分片直接丢弃，不写进
// 已重建的消息区，杜绝交错 append。
import { chatSessionState } from "./chat-state.js";
import { collectHistorySearchTurns, type HistorySearchTurn } from "./search-sources.js";

// 回放分片预算：单帧同步渲染上限 50ms——长会话（数百条 markdown + 时间戳
// linkify）一次性同步 append 会把主线程占满，期间输入/滚动全部卡住。超过预算
// 即让出（scheduler.yield 优先，setTimeout 0 兜底），让浏览器处理输入与重绘后
// 继续，末尾仍统一 scrollToBottom。
const REPLAY_FRAME_BUDGET_MS = 50;

// 回放渲染窄门面：只含本事务消费的五件 chat-runtime 方法（实例级互引由组装
// 方经惰性箭头解决，本文件不 import chat-runtime）。
export interface ConversationReplayRenderer {
  appendUserMessage: (text: string, shouldScroll: boolean) => void;
  // 参数形状对齐 chat-runtime 的实现签名（node 可为 null 是历史遗留宽口，本
  // 事务恒传非 null div；raw 原样透传未知类型由实现侧 String 化——保持调用
  // 点与原 chat-tab 逐字一致）。
  renderAssistantMessage: (
    node: HTMLDivElement,
    raw: unknown,
    opts?: { userPrompt?: string; sources?: HistorySearchTurn["sources"] }
  ) => void;
  buildSearchTimelineCard: (turn: HistorySearchTurn) => HTMLElement;
  setAutoScroll: (value: boolean) => void;
  scrollToBottom: (force?: boolean, opts?: { instant?: boolean }) => void;
}

export interface CreateConversationReplayDeps {
  messages: HTMLElement;
  renderer: ConversationReplayRenderer;
  // 布局状态（紧凑输入判定）与空历史整页清场：编排壳回调，组合根注入。
  updateLayout: () => void;
  resetView: (stateHtml: string) => void;
  // 回放重建消息区时同步清掉建议区引用（编排壳的模块级 suggestionsNode）。
  clearSuggestions: () => void;
}

export interface ConversationReplay {
  /** fire-and-forget 开跑一轮回放：首片同步上屏，其余在让出点续跑。 */
  render: () => void;
  /** 作废进行中的回放分片（清场/新轮开跑前调用）。 */
  invalidate: () => void;
  /** 进行中的回放（让出点未落定时非 null）：发送路径先 await 它再 append。 */
  readonly inFlight: Promise<void> | null;
}

export function createConversationReplay(deps: CreateConversationReplayDeps): ConversationReplay {
  let generation = 0;
  let inFlight: Promise<void> | null = null;

  // 让出主线程：优先 scheduler.yield（续跑排到队列前部），无 scheduler 的浏览器
  // 退回 setTimeout 0（续跑排到队尾，仅作兜底，语义仍是「先让浏览器喘一口气」）。
  function yieldToMainThread(): Promise<void> {
    const schedulerApi = (globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (typeof schedulerApi?.yield === "function") {
      return schedulerApi.yield();
    }
    return new Promise((resolve) => window.setTimeout(resolve, 0));
  }

  async function renderConversationMessages(): Promise<void> {
    const task = runConversationReplay();
    inFlight = task;
    try {
      await task;
    } finally {
      if (inFlight === task) {
        inFlight = null;
      }
    }
  }

  // 历史回放时找该助手消息的前一条用户消息（注入 renderAssistantMessage 的 userPrompt）
  function findPreviousUserPrompt(index: number): string {
    for (let i = Number(index) - 1; i >= 0; i -= 1) {
      const item = chatSessionState.chatHistory[i];
      if (item?.role === "user" && typeof item.content === "string") {
        return item.content;
      }
    }
    return "";
  }

  function invalidateReplay(): void {
    generation += 1;
  }

  async function runConversationReplay(): Promise<void> {
    deps.updateLayout();
    deps.messages.innerHTML = "";
    deps.clearSuggestions();
    if (!chatSessionState.chatHistory.length) {
      deps.resetView("");
      return;
    }
    invalidateReplay();
    const replayGeneration = generation;
    const history = chatSessionState.chatHistory;
    // 联网搜索回合（spec §4）：历史中的 assistant(tool_calls) + tool 消息聚合为
    // 搜索回合，按回答消息下标对位——时间线卡插在回答前，来源随正文重建成
    // [n] 内联引用；tool 消息本体（含 JSON 结果）不作为消息渲染。
    const searchTurnByAssistantIndex = new Map(
      collectHistorySearchTurns(history).map((turn) => [turn.assistantIndex, turn])
    );
    // 与原 forEach 同语义：只遍历开跑时的长度，渲染期间新追加的消息不在此列
    //（流式写回走各自的 append 路径）。
    const total = history.length;
    let deadline = performance.now() + REPLAY_FRAME_BUDGET_MS;
    for (let index = 0; index < total; index += 1) {
      if (replayGeneration !== generation) {
        return;
      }
      const message = history[index];
      if (message.role === "user") {
        deps.renderer.appendUserMessage(message.content, false);
      } else if (message.role === "tool" || (Array.isArray(message.tool_calls) && message.tool_calls.length && !String(message.content || "").trim())) {
        // 工具轮消息（spec §2.5）：查询与结果由回合回答消息上的搜索时间线卡
        // 承载，消息本体不渲染（assistant(tool_calls) 无正文，tool 是 JSON）；
        // 带正文 + tool_calls 的混合消息照常渲染（正文不丢）。
        continue;
      } else {
        const node = document.createElement("div");
        node.className = "chat-msg chat-msg-assistant";
        const searchTurn = searchTurnByAssistantIndex.get(index);
        deps.renderer.renderAssistantMessage(node, String(message.content || ""), {
          userPrompt: findPreviousUserPrompt(index),
          ...(searchTurn ? { sources: searchTurn.sources } : {})
        });
        deps.messages.appendChild(node);
        if (searchTurn) {
          // 卡片插在回答节点之前（先 append 节点再插卡——insertBefore 的参照
          // 节点必须已在 DOM 内）。
          deps.messages.insertBefore(deps.renderer.buildSearchTimelineCard(searchTurn), node);
        }
      }
      if (performance.now() >= deadline) {
        await yieldToMainThread();
        if (replayGeneration !== generation) {
          return;
        }
        deadline = performance.now() + REPLAY_FRAME_BUDGET_MS;
      }
    }
    if (replayGeneration !== generation) {
      return;
    }
    deps.renderer.setAutoScroll(true);
    // instant（同发送路径，见 chat-stream-render scrollToBottom 注释）：回放
    // 渲染的历史消息全部带 c-v 块，平滑动画扫过时估算块逐块弹回真实高，视口
    // 突跳且动画终点落后于真实底部，终点距底会被 scroll-sync 判定读成关闭
    // 自动跟随——回放后追问流式不跟随。
    deps.renderer.scrollToBottom(true, { instant: true });
  }

  return {
    render: () => {
      void renderConversationMessages();
    },
    invalidate: invalidateReplay,
    get inFlight() {
      return inFlight;
    }
  };
}
