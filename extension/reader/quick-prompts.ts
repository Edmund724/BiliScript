import { buildContextKey } from "../ai/conversation.js";
import { resolveActiveProvider } from "../ai/active-provider.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { logWarn } from "../shared/logging.js";
import {
  QUICK_PROMPT_MAX_TOKENS,
  buildQuickPromptExcerpt,
  buildQuickPromptMessages,
  normalizePromptList,
  parseQuickPrompts
} from "../chat/quick-prompts.js";
import { readCachedQuickPrompts, writeCachedQuickPrompts } from "../chat/quick-prompt-cache.js";

export interface QuickPromptSource {
  bvid?: unknown;
  cid?: unknown;
  aid?: unknown;
  title?: unknown;
  subtitleBody?: unknown;
}

const inflight = new Map<string, Promise<void>>();

export function warmUpInitialQuickPrompts(source: QuickPromptSource): Promise<void> {
  const key = buildContextKey({ bvid: source?.bvid, cid: source?.cid, aid: source?.aid });
  const body = Array.isArray(source?.subtitleBody) ? source.subtitleBody : [];
  if (!key || !body.length) {
    return Promise.resolve();
  }
  if (readCachedQuickPrompts(key)) {
    return Promise.resolve();
  }
  const running = inflight.get(key);
  if (running) {
    return running;
  }
  let task: Promise<void>;
  task = generate(key, String(source?.title || ""), body)
    .catch(() => null)
    .then(() => {
      if (inflight.get(key) === task) {
        inflight.delete(key);
      }
    });
  inflight.set(key, task);
  return task;
}

async function generate(key: string, title: string, body: unknown[]): Promise<void> {
  try {
    const settings = await sendRuntimeMessage({ type: "get-settings" }).catch(() => null);
    if (!settings?.ok) {
      return;
    }
    if (normalizePromptList(settings.settings?.aiInitialQuickPrompts).length) {
      return;
    }
    const provider = await resolveActiveProvider();
    const [{ chatCompletion }, { providerFetchViaOffscreen }] = await Promise.all([
      import("../ai/completion.js"),
      import("../core/provider-http-offscreen.js")
    ]);
    let text = "";
    await chatCompletion({
      provider,
      messages: buildQuickPromptMessages({ title, excerpt: buildQuickPromptExcerpt(body) }),
      stream: true,
      thinkingLevel: "off",
      maxTokens: QUICK_PROMPT_MAX_TOKENS,
      retries: 0,
      onEvent: (event) => {
        if (event.type === "token") {
          text += event.data;
        }
      },
      onStreamReset: () => {
        text = "";
      },
      fetchImpl: providerFetchViaOffscreen
    });
    const prompts = parseQuickPrompts(text);
    if (prompts.length) {
      writeCachedQuickPrompts(key, prompts);
    }
  } catch (error) {
    logWarn("[BILISCRIPT] quick prompt generation failed", { error });
  }
}
