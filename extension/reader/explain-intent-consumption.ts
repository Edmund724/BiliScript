import { formatClock } from "../shared/clock-text.js";
import {
  clearPendingExplainIntent,
  consumePendingExplainIntent,
  peekPendingExplainIntent,
  type ReaderExplainIntent
} from "./explain-intent.js";

const ACTIVE_TURN_INTENT_NOTICE = "当前对话正在生成，待本轮结束后可继续追问或发送。";

export function createExplainIntentConsumption({
  card,
  autoSendPrompt,
  isTurnActive,
  onNotice,
  onFocusInput
}: {
  card: HTMLElement | null;
  autoSendPrompt: (text: string) => Promise<boolean>;
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
  }

  function buildFollowUpPrompt(question: string): string {
    const intent = peekPendingExplainIntent();
    if (!intent || !intent.explanation || !intent.content) {
      return question;
    }
    const stamp = formatClock(intent.from, { hours: "auto" });
    const target = intent.selection
      ? `选区「${intent.selection}」（出自字幕「${intent.content}」，${stamp}）`
      : `字幕「${intent.content}」（${stamp}）`;
    return `针对${target}的已有解释：\n${intent.explanation}\n\n追问：${question}`;
  }

  function completePendingFollowUp(): void {
    const intent = peekPendingExplainIntent();
    if (intent?.explanation) {
      consumePendingExplainIntent();
      hide();
    }
  }

  async function consumeIfPending(): Promise<void> {
    const intent = peekPendingExplainIntent();
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
    const sent = await autoSendPrompt(buildPrompt(intent));
    if (sent) {
      consumePendingExplainIntent();
      hide();
    }
  }

  return { consumeIfPending, cancel, hide, buildFollowUpPrompt, completePendingFollowUp };
}
