import { buildContextKey } from "../ai/conversation.js";
import { resolveActiveProvider } from "../ai/active-provider.js";
import { state } from "../core/state.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { logWarn } from "../shared/logging.js";
import {
  isEncodedYoutubeStorageBvid,
  normalizeSiteId,
  YOUTUBE_UNIT_CID,
  type SiteId
} from "../shared/site.js";
import {
  QUICK_PROMPT_MAX_TOKENS,
  buildQuickPromptExcerpt,
  buildQuickPromptMessages,
  normalizePromptList,
  parseQuickPrompts
} from "../chat/quick-prompts.js";
import { readCachedQuickPrompts, writeCachedQuickPrompts } from "../chat/quick-prompt-cache.js";

export interface QuickPromptSource {
  site?: SiteId;
  bvid?: unknown;
  cid?: unknown;
  aid?: unknown;
  title?: unknown;
  subtitleBody?: unknown;
}

const inflight = new Map<string, Promise<void>>();

function resolveQuickPromptSite(source: QuickPromptSource): SiteId {
  if (source?.site !== undefined) {
    return normalizeSiteId(source.site);
  }
  if (String(source?.cid ?? "").trim() === YOUTUBE_UNIT_CID || isEncodedYoutubeStorageBvid(source?.bvid)) {
    return "youtube";
  }
  const sourceBvid = String(source?.bvid ?? "").trim();
  if (sourceBvid && sourceBvid === String(state.clip.bvid || "").trim()) {
    return normalizeSiteId(state.clip.site);
  }
  return "bilibili";
}

export function warmUpInitialQuickPrompts(source: QuickPromptSource): Promise<void> {
  const site = resolveQuickPromptSite(source);
  const keyInput = { site, bvid: source?.bvid, cid: source?.cid, aid: source?.aid };
  const key = buildContextKey(keyInput);
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
  task = generate(key, site, String(source?.title || ""), body)
    .catch(() => null)
    .then(() => {
      if (inflight.get(key) === task) {
        inflight.delete(key);
      }
    });
  inflight.set(key, task);
  return task;
}

async function generate(key: string, site: SiteId, title: string, body: unknown[]): Promise<void> {
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
      messages: buildQuickPromptMessages({ site, title, excerpt: buildQuickPromptExcerpt(body) }),
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
