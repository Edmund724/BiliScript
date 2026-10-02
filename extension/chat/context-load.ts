// extension/chat/context-load.ts — 上下文状态加载编排壳（候选5 自
// sidepanel.ts 迁出，PR5 自 pages/sidepanel-context-load.ts 迁入 chat 域并
// 改造；PR5c 随 sidepanel 摘除，chat/* 为对话内核唯一宿主）：
// loadContextState（拉上下文 → 按策略动作执行编排副作用）。
// 分支判定收敛在 ./context-policy.ts（纯函数，继续直 import），本模块只负责
// 拉数据、按动作执行。（头部标题 chip 已于 2026-10 删除：updateContextChip 与
// 只服务它的 isBoundConversationMismatched 一并下线，上下文装载链不变。同一时期
// 下线的还有跳转编排 openCurrentContextUrl 与只服务它的 getActiveTab transport：
// sidepanel 退役后生产已无调用方，reader 壳的时间戳跳转走自己的 contextUrl 路径。）
//
// arch-slim/07 装配收口：「拉数据」的 ContextFetch 策略（扩展页消息链 /
// 进程内直读 / pinned 补水身份短路）连同 AiContext 装配知识一并迁往
// core/context-assembly.ts（core/context-payload 锚定的唯一装配链），本模块
// 退为纯编排壳——按信封动作执行副作用，不持有任何装配知识。生产组合根
//（reader/chat-tab.ts）注入进程内直读策略；测试可注入消息链策略。
//
// 依赖方向（无环）：共享可变状态（contextData / currentContextKey /
// liveContextData / liveContextKey / liveTabUrl / currentConversationMeta）经
// chat-state 的只读视图读、经其意图原语写；上下文组装策略（fetchContext）经工厂
// deps 注入；
// 渲染/编排回调（renderHistoryList、resetConversationView、
// restartChat、renderSuggestions、restoreLatest、流式守卫判定 isStreaming /
// hasPendingUserPrompt 惰性互引 chatRuntime 实例）同样经 deps 注入。本模块
// 不 import 组合根。
import { LOAD_CONTEXT_ACTION, isPinnedContextStrict, resolveLoadContextAction, resolveNoTabPlan } from "./context-policy.js";
import {
  applyContextSnapshot,
  applyLiveContextSnapshot,
  chatSessionState,
  clearMainContext,
  noteLiveTabUrl,
  resetLiveContext
} from "./chat-state.js";
import type { ChatSessionContextSnapshot } from "./chat-state.js";
import type { ContextFetch, ContextFetchOutcome } from "../core/context-assembly.js";
import type { LoadContextStateOptions } from "./conversation-store.js";

// ===========================================================================
// loadContextState 编排壳（「按动作执行副作用」骨架与迁移前一致）
// ===========================================================================

export interface CreateContextLoadDeps {
  // 上下文组装策略（core/context-assembly 的 createInProcessContextFetch）
  fetchContext: ContextFetch;
  renderHistoryList: () => void;
  renderInitialState: () => void;
  renderSuggestions: () => void;
  resetConversationView: (stateHtml?: string) => void;
  restartChat: (opts?: { keepContext?: boolean; preserveInput?: boolean }) => void;
  restoreLatest: () => Promise<boolean>;
  // 惰性互引（组装点以箭头函数接线，回调执行时 chatRuntime 实例已存在）
  isStreaming: () => boolean;
  hasPendingUserPrompt: () => boolean;
}

export interface ContextLoad {
  loadContextState: (opts?: LoadContextStateOptions) => Promise<boolean>;
}

export function createContextLoad(deps: CreateContextLoadDeps): ContextLoad {
  async function loadContextState({ forceRefresh = false, silent = false, preserveInput = false }: LoadContextStateOptions = {}): Promise<boolean> {
    const hasPinnedConversation = isPinnedContextStrict(chatSessionState.currentConversationMeta);
    // 上下文组装策略注入点（PR5）。ifSignature 沿用迁移前口径：上次全量快照
    // 的签名；liveContextData 为空（首次/此前失败）时签名为空串，策略必走全量。
    const outcome = await deps
      .fetchContext({ forceRefresh, ifSignature: String(chatSessionState.liveContextData?.signature || "") })
      .catch((error: unknown) => ({ kind: "error", error: (error as Error)?.message }) as ContextFetchOutcome);

    if (outcome.kind === "no-tab") {
      // 决策点一：无可用标签页，按计划做失败清理（文案/清上下文/
      // 重置视图的取舍全部来自策略计划）。
      const plan = resolveNoTabPlan({ hasPinnedConversation, silent });
      resetLiveContext();
      if (plan.clearContext) {
        clearMainContext();
      }
      if (plan.resetView) {
        deps.resetConversationView(plan.message as string);
      }
      return plan.returnValue;
    }

    // no-tab 之外的分支都刷新 liveTabUrl（error 亦然——迁移前行为：往返
    // 结束后即使失败也写入 tab.url）。
    noteLiveTabUrl(outcome.tabUrl || "");

    // 决策点二（消息往返之后）：「输入 → 动作」映射全部交给策略模块。unchanged
    // 信封折算成 policy 的响应形态；forceRefresh 只随策略透传，不参与动作判定；
    // isStreaming / hasPendingUserPrompt 是 chat-runtime 的纯闭包读取，此处
    // 取值时点不改变可观察行为。
    const resp = outcome.kind === "error"
      ? { ok: false as const, error: outcome.error }
      : { ok: true as const, payload: outcome.payload };

    const plan = resolveLoadContextAction({
      response: resp,
      hasPinnedConversation,
      silent,
      isStreaming: deps.isStreaming(),
      hasPendingUserPrompt: deps.hasPendingUserPrompt()
    });

    // 候选5：content 状态未变 → 保持现状不动（不 applyContextPayload、不重渲染、
    // 不刷新 live 快照、不转 spinner）。liveContextData 仍持有带 signature 的
    // 上次全量 payload：既是下一轮 ifSignature 的来源，也是等待轮询
    //（subtitle-wait）的判定数据源——返回 true 让轮询按旧快照继续判 pending，
    // ASR 完成时签名必然变化（subtitleFetchState/body.length），全量快照自然到位。
    if (plan.action === LOAD_CONTEXT_ACTION.SKIP_UNCHANGED) {
      return plan.returnValue;
    }

    if (plan.action === LOAD_CONTEXT_ACTION.ERROR) {
      applyLiveContextSnapshot(null);
      if (plan.clearContext) {
        clearMainContext();
      }
      if (plan.resetView) {
        deps.resetConversationView(plan.message as string);
      }
      return plan.returnValue;
    }

    // 三个成功动作（pinned / 流式守卫 / live）的公共前缀：live 快照照常落地，
    // 保证轮询与补水的数据源不断供。
    applyLiveContextSnapshot(resp.payload as ChatSessionContextSnapshot);

    // pinned 与流式守卫的执行体逐字节相同：只落地 live 快照，不进主上下文。
    if (
      plan.action === LOAD_CONTEXT_ACTION.APPLY_PINNED ||
      plan.action === LOAD_CONTEXT_ACTION.BLOCKED_STREAMING
    ) {
      deps.renderHistoryList();
      return plan.returnValue;
    }

    // apply-live：正常路径，上下文变化时恢复最近对话并重渲染初始态。
    const contextChanged = applyContextPayload(resp.payload as ChatSessionContextSnapshot | null, preserveInput);
    deps.renderHistoryList();
    if (contextChanged) {
      await deps.restoreLatest();
      deps.renderInitialState();
    }
    return plan.returnValue;
  }

  function applyContextPayload(payload: ChatSessionContextSnapshot | null, preserveInput: boolean): boolean {
    // 写入半（落地 + key 重算 + 写前变化判定）已归并进 chat-state 的
    // applyContextSnapshot 原语；本壳只留变化后的编排副作用。
    const contextChanged = applyContextSnapshot(payload);

    // 不再重判流式守卫：能走到这里只有 APPLY_LIVE——策略层选中它即蕴含「非流式
    // 且无待发 prompt」（apply-pinned / blocked-streaming 已按 action 提前返回，
    // 只落地 live 快照）。守卫由策略层单独承重，context-policy.ts 的
    // isStreaming / hasPendingUserPrompt 是唯一判定点。
    if (contextChanged) {
      // preserveInput（发送闸调用链，见 LoadContextStateOptions）：闸内重启是
      // 上下文跟随，不是用户语义上的「新会话」——不清输入框与附件区，否则闸后
      // 才消费的 takeInputImages 拿不到随本条消息附的图片（正文照发、图片静默
      // 吞掉）。用户主动「新会话」的 restartChat 不带该标志，仍照旧清场。
      deps.restartChat({ keepContext: true, preserveInput });
    } else {
      deps.renderSuggestions();
    }
    return contextChanged;
  }

  return { loadContextState };
}
