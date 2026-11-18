// 待解释意图契约与控制器：字幕侧「去对话追问」与 AI 对话 tab 之间的交接面。
//
// 生产方：解释卡片（reader/explain-card.ts）底部的「去对话追问」按钮——把选中片段、
// 所在整句（以及已生成的解释正文）记入本模块单槽 pending 后切到 AI 对话 tab。
// 消费方：对话 tab 经 createExplainIntentController 驱动引用卡渲染、回合在途守卫、
// 发送/取消按钮绑定、追问提示词拼接与受理后消费。
//
// 单槽 pending（后写覆盖先写）：仅保留最新一条待解释意图。
import { formatClock } from "../shared/clock-text.js";
import type { InteractionAnchorHint } from "../ai/chat-hybrid-retrieval.js";

const ACTIVE_TURN_INTENT_NOTICE = "当前对话正在生成，待本轮结束后可继续追问或发送。";

export interface ReaderExplainIntent {
  from: number;
  content: string;
  selection?: string;
  explanation?: string;
  createdAt: number;
}

let pendingIntent: ReaderExplainIntent | null = null;

// 记录或覆盖待解释意图；selection 与整句相同或为空白时不落字段，explanation 仅保留非空文本。
export function setPendingExplainIntent(intent: ReaderExplainIntent): void {
  const content = String(intent?.content || "");
  const selection = String(intent?.selection || "").trim();
  const explanation = typeof intent?.explanation === "string" ? intent.explanation.trim() : "";
  pendingIntent = {
    from: Number(intent?.from) || 0,
    content,
    createdAt: Number(intent?.createdAt) || Date.now()
  };
  if (selection && selection !== content) {
    pendingIntent.selection = selection;
  }
  if (explanation) {
    pendingIntent.explanation = explanation;
  }
}

export function clearPendingExplainIntent(): void {
  pendingIntent = null;
}

function peekPending(): ReaderExplainIntent | null {
  return pendingIntent ? { ...pendingIntent } : null;
}

export function createExplainIntentController({
  card,
  sendPrompt,
  isTurnActive,
  onNotice,
  onFocusInput
}: {
  card: HTMLElement | null;
  sendPrompt: (text: string, options?: { interactionAnchor?: InteractionAnchorHint }) => Promise<boolean>;
  isTurnActive?: () => boolean;
  onNotice?: (message: string, autoHideMs?: number) => void;
  onFocusInput?: () => void;
}) {
  function buildPrompt(intent: ReaderExplainIntent): string {
    const stamp = formatClock(intent.from, { hours: "auto" });
    if (intent.selection) {
      return `请结合视频上下文解释我选中的词句：「${intent.selection}」。它出自字幕句「${intent.content}」（${stamp}）。说明它的含义、背景，以及在这句话里指什么。`;
    }
    return `请结合视频上下文解释这句字幕：「${intent.content}」（${stamp}）。说明它的含义、背景，以及与前后文的关系。`;
  }

  function render(intent: ReaderExplainIntent): void {
    if (!card) {
      return;
    }
    const title = card.querySelector<HTMLElement>(".biliscript-reading-chat-intent-title");
    if (title) {
      title.textContent = intent.explanation ? "基于当前解释继续追问" : "待解释的字幕句";
    }
    const quote = card.querySelector<HTMLElement>(".biliscript-reading-chat-intent-quote");
    if (quote) {
      quote.textContent = intent.selection ? `「${intent.selection}」｜${intent.content}` : `「${intent.content}」`;
    }
    const stamp = card.querySelector<HTMLElement>(".biliscript-reading-chat-intent-time");
    if (stamp) {
      stamp.textContent = formatClock(intent.from, { hours: "auto" });
    }
    const sendBtn = card.querySelector<HTMLButtonElement>('[data-chat-intent-action="send"]');
    if (sendBtn) {
      sendBtn.hidden = Boolean(intent.explanation);
    }
    card.hidden = false;
  }

  function hide(): void {
    if (card) {
      card.hidden = true;
    }
  }

  function cancel(): void {
    clearPendingExplainIntent();
    hide();
    onFocusInput?.();
  }

  function buildFollowUpPrompt(question: string): string {
    const intent = peekPending();
    if (!intent || !intent.explanation || !intent.content) {
      return question;
    }
    const stamp = formatClock(intent.from, { hours: "auto" });
    const target = intent.selection
      ? `选区「${intent.selection}」（出自字幕「${intent.content}」，${stamp}）`
      : `字幕「${intent.content}」（${stamp}）`;
    return `针对${target}的已有解释：\n${intent.explanation}\n\n追问：${question}`;
  }

  function buildAnchor(intent: ReaderExplainIntent): InteractionAnchorHint {
    return {
      kind: "explain-selection",
      from: intent.from,
      ...(intent.content ? { lineContent: intent.content } : {}),
      ...(intent.selection ? { selection: intent.selection } : {})
    };
  }

  function getPendingFollowUpAnchor(): InteractionAnchorHint | undefined {
    const intent = peekPending();
    if (!intent || !intent.explanation || !intent.content) {
      return undefined;
    }
    return buildAnchor(intent);
  }

  function completePendingFollowUp(): void {
    if (pendingIntent?.explanation) {
      pendingIntent = null;
      hide();
    }
  }

  async function consumeIfPending(): Promise<void> {
    const intent = peekPending();
    if (!intent || !intent.content) {
      hide();
      return;
    }
    render(intent);
    if (intent.explanation) {
      if (isTurnActive?.()) {
        onNotice?.(ACTIVE_TURN_INTENT_NOTICE, 4000);
      }
      onFocusInput?.();
      return;
    }
    if (isTurnActive?.()) {
      onNotice?.(ACTIVE_TURN_INTENT_NOTICE, 4000);
      return;
    }
    const prompt = buildPrompt(intent);
    if (!prompt.trim()) {
      return;
    }
    const currentSlot = pendingIntent;
    const sent = await sendPrompt(prompt, { interactionAnchor: buildAnchor(intent) });
    if (sent && pendingIntent === currentSlot) {
      pendingIntent = null;
      hide();
    }
  }

  card?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const actionBtn = target?.closest<HTMLElement>("[data-chat-intent-action]");
    if (!actionBtn) {
      return;
    }
    const action = actionBtn.dataset.chatIntentAction;
    if (action === "cancel") {
      cancel();
    } else if (action === "send") {
      void consumeIfPending();
    }
  });

  return { consumeIfPending, cancel, hide, buildFollowUpPrompt, getPendingFollowUpAnchor, completePendingFollowUp };
}
