import { formatClock } from "../shared/clock-text.js";
import {
  clearPendingExplainIntent,
  consumePendingExplainIntent,
  peekPendingExplainIntent,
  type ReaderExplainIntent
} from "./explain-intent.js";

export function createExplainIntentConsumption({
  card,
  autoSendPrompt
}: {
  card: HTMLElement | null;
  autoSendPrompt: (text: string) => Promise<boolean>;
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
    const quote = card.querySelector<HTMLElement>(".biliscript-reading-chat-intent-quote");
    if (quote) {
      quote.textContent = intent.selection ? `「${intent.selection}」｜${intent.content}` : `「${intent.content}」`;
    }
    const stamp = card.querySelector<HTMLElement>(".biliscript-reading-chat-intent-time");
    if (stamp) {
      stamp.textContent = formatClock(intent.from, { hours: "auto" });
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

  async function consumeIfPending(): Promise<void> {
    const intent = peekPendingExplainIntent();
    if (!intent || !intent.content) {
      hide();
      return;
    }
    render(intent);
    const sent = await autoSendPrompt(buildPrompt(intent));
    if (sent) {
      consumePendingExplainIntent();
      hide();
    }
  }

  return { consumeIfPending, cancel, hide };
}
