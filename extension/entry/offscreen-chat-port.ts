import { bgFetchJson } from "../bilibili/gateway-core.js";
import { fetchHotCommentsJson } from "../bilibili/hot-comments.js";
import { logInfo, shouldDebugLog } from "../shared/logging.js";
import { consumeRuntimeLastError, safePostMessage } from "../shared/messaging.js";
import { detectSiteFromUrl, getSiteCapabilities, normalizeSiteId } from "../shared/site.js";
import {
  checkHostPermissionFromOffscreen,
  HOST_INVALID_ORIGIN_HINT,
  HOST_PERMISSION_HINT
} from "../core/host-permissions.js";
import {
  resolveWebSearchRuntime,
  SEARCH_NOT_CONFIGURED_NOTICE,
  type WebSearchRuntimeResolution
} from "../search/search-runtime.js";
import type { ChatMsg } from "../ai/ladder.js";
import type { CapturedVideoFrame } from "../ai/types.js";
import type { ChatPortMessage } from "../chat/protocol.js";
import type {
  OffscreenChatPortMessage,
  ResolveAiProviderResponse
} from "../shared/messaging-protocol.js";
import type { createSubtitleBodySlot } from "./offscreen-subtitle-slot.js";

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 90_000;

interface PostMessagePort {
  postMessage(message: unknown): void;
}

export interface AttachOffscreenChatPortDeps {
  subtitleSlot: ReturnType<typeof createSubtitleBodySlot>;
  loadLadder: () => Promise<typeof import("../ai/ladder.js").runLadderChat>;
  streamIdleTimeoutMs?: number;
}

function withCachedContextKey<T extends ChatPortMessage>(port: PostMessagePort, contextKey: string) {
  return {
    postMessage: (data: T): void => {
      safePostMessage(port, { ...data, cachedContextKey: contextKey } as T);
    }
  };
}

export function attachOffscreenChatPort(
  port: chrome.runtime.Port,
  deps: AttachOffscreenChatPortDeps
): void {
  const streamIdleTimeoutMs = deps.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;

  let currentChatGeneration = 0;
  let activeGeneration = 0;
  let activeAbortController: AbortController | null = null;
  let pendingCostGuard: { resolve: (value: boolean) => void; generation: number } | null = null;
  let pendingVideoFrame: {
    requestId: string;
    generation: number;
    port: PostMessagePort;
    resolve: (frame: CapturedVideoFrame | CapturedVideoFrame[]) => void;
    reject: (error: Error) => void;
  } | null = null;
  let idleTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let idleTimeoutGeneration = 0;

  function clearIdleTimeout(generation?: number): void {
    if (generation !== undefined && generation !== idleTimeoutGeneration) {
      return;
    }
    if (idleTimeoutId) {
      clearTimeout(idleTimeoutId);
      idleTimeoutId = null;
    }
    idleTimeoutGeneration = 0;
  }

  function abortActiveRequest(): void {
    if (pendingCostGuard) {
      const resolve = pendingCostGuard.resolve;
      pendingCostGuard = null;
      resolve(false);
    }
    if (pendingVideoFrame) {
      const pending = pendingVideoFrame;
      pendingVideoFrame = null;
      safePostMessage(pending.port, { type: "video-frame-cancel", requestId: pending.requestId });
      pending.reject(new Error("截图请求已中止"));
    }
    if (activeAbortController && !activeAbortController.signal.aborted) {
      activeAbortController.abort();
    }
    activeAbortController = null;
    activeGeneration = 0;
    clearIdleTimeout();
  }

  function armIdleTimeout(
    generation: number,
    abortController: AbortController,
    targetPort: PostMessagePort
  ): void {
    if (generation !== activeGeneration || abortController.signal.aborted) {
      return;
    }
    clearIdleTimeout(generation);
    idleTimeoutGeneration = generation;
    idleTimeoutId = setTimeout(() => {
      if (generation === activeGeneration && !abortController.signal.aborted) {
        abortActiveRequest();
        targetPort.postMessage({
          type: "error",
          error: "请求超时（90 秒未返回任何数据），已自动中断"
        });
      }
    }, streamIdleTimeoutMs);
  }

  function clearActiveRequestState(generation?: number): void {
    if (generation !== undefined && generation !== activeGeneration) {
      return;
    }
    activeAbortController = null;
    activeGeneration = 0;
  }

  function askCostGuard(targetPort: PostMessagePort, message: string, generation: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      pendingCostGuard = { resolve, generation };
      targetPort.postMessage({ type: "cost-guard", data: { message } });
    });
  }

  function requestVideoFrame(
    targetPort: PostMessagePort,
    generation: number,
    targetTime?: number
  ): Promise<CapturedVideoFrame | CapturedVideoFrame[]> {
    return new Promise((resolve, reject) => {
      if (generation !== activeGeneration || activeAbortController?.signal.aborted || pendingVideoFrame) {
        reject(new Error("当前无法发起截图请求"));
        return;
      }
      const requestId = `video-frame-${generation}-${Date.now()}`;
      pendingVideoFrame = { requestId, generation, port: targetPort, resolve, reject };
      try {
        targetPort.postMessage({
          type: "video-frame-request",
          requestId,
          ...(targetTime !== undefined ? { targetTime } : {})
        });
      } catch (error) {
        pendingVideoFrame = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async function resolveSearchRuntime(signal?: AbortSignal | null): Promise<WebSearchRuntimeResolution> {
    return resolveWebSearchRuntime(signal ?? activeAbortController?.signal ?? null);
  }

  async function resolveProviderWithKey(
    targetPort: PostMessagePort,
    providerId: string | undefined,
    generation?: number
  ) {
    const resp = (await chrome.runtime.sendMessage({
      type: "resolve-ai-provider",
      providerId
    })) as ResolveAiProviderResponse | null;
    if (generation !== undefined && generation !== activeGeneration) {
      return { error: true as const };
    }
    if (!resp?.ok || !resp.provider) {
      targetPort.postMessage({ type: "error", error: resp?.error || "解析 AI 平台配置失败" });
      return { error: true as const };
    }
    const apiKey = String(resp.apiKey || "").trim();
    return { provider: { ...resp.provider, apiKey }, apiKey };
  }

  port.onMessage.addListener(async (rawMsg) => {
    const msg = rawMsg as OffscreenChatPortMessage;
    if (!msg) return;
    if (msg.action === "stop") {
      abortActiveRequest();
      return;
    }
    if (msg.action === "cost-guard-confirm") {
      if (pendingCostGuard) {
        const { resolve, generation } = pendingCostGuard;
        pendingCostGuard = null;
        resolve(generation === activeGeneration ? msg.ok !== false : false);
      }
      return;
    }
    if (msg.action === "video-frame-result") {
      if (pendingVideoFrame?.requestId === msg.requestId) {
        const pending = pendingVideoFrame;
        pendingVideoFrame = null;
        if (pending.generation !== activeGeneration) {
          pending.reject(new Error("截图请求已过期"));
        } else if (msg.error) {
          pending.reject(new Error(msg.error));
        } else if (
          Array.isArray(msg.frames) &&
          msg.frames.every((frame) => frame.image?.mime && frame.image.data && Number.isFinite(frame.currentTime))
        ) {
          pending.resolve(msg.frames);
        } else if (msg.image?.mime && msg.image.data && Number.isFinite(msg.currentTime)) {
          pending.resolve({ image: msg.image, currentTime: msg.currentTime! });
        } else {
          pending.reject(new Error("截图回执缺少图片或播放时间"));
        }
      }
      return;
    }
    if (msg.action !== "chat") return;

    const settled = deps.subtitleSlot.settle(msg);
    if (!settled.ok) {
      safePostMessage(port, { type: "error", error: settled.error, code: settled.code });
      return;
    }
    const ackedPort = withCachedContextKey<ChatPortMessage>(port, settled.contextKey!);

    abortActiveRequest();
    const generation = ++currentChatGeneration;
    const requestController = new AbortController();
    activeAbortController = requestController;
    activeGeneration = generation;

    try {
      const webSearchRequested = (msg as ChatMsg).webSearchEnabled === true;
      const [resolved, runLadderChat, searchResolution] = await Promise.all([
        resolveProviderWithKey(ackedPort, msg.providerId, generation),
        deps.loadLadder(),
        webSearchRequested ? resolveSearchRuntime(requestController.signal) : Promise.resolve(undefined)
      ]);
      if (generation !== activeGeneration || requestController.signal.aborted) {
        return;
      }
      const searchRuntime: WebSearchRuntimeResolution["runtime"] = searchResolution?.runtime;
      if (resolved.error) {
        clearActiveRequestState(generation);
        return;
      }
      if (webSearchRequested && !searchRuntime) {
        ackedPort.postMessage({
          type: "notice",
          data: searchResolution?.notice ?? SEARCH_NOT_CONFIGURED_NOTICE
        });
      }
      const { provider, apiKey } = resolved;

      const permission = await checkHostPermissionFromOffscreen(provider?.baseUrl);
      if (!permission.granted) {
        throw new Error(permission.status === "invalid-origin" ? HOST_INVALID_ORIGIN_HINT : HOST_PERMISSION_HINT);
      }

      if (generation !== activeGeneration || requestController.signal.aborted) {
        return;
      }

      armIdleTimeout(generation, requestController, ackedPort);

      if (shouldDebugLog()) {
        const chatBody = (msg as ChatMsg).context?.subtitleBody;
        const materialChars = ((chatBody || []) as Array<{ content?: unknown }>).reduce((sum, item) => {
          const text = String(item?.content ?? "").trim();
          return sum + text.length;
        }, 0);
        logInfo("[BILISCRIPT] AI chat material chars:", materialChars);
      }

      const chatContext = (msg as ChatMsg).context;
      const chatSite = normalizeSiteId(
        chatContext?.site ?? (chatContext?.url ? detectSiteFromUrl(chatContext.url) : undefined)
      );
      const chatCaps = getSiteCapabilities(chatSite);

      await runLadderChat(
        {
          msg: msg as ChatMsg,
          provider: {
            ...provider,
            apiKey,
            ...(msg.model ? { model: String(msg.model) } : {}),
            ...(msg.conversationId ? { sessionId: String(msg.conversationId) } : {})
          },
          port: ackedPort,
          signal: requestController.signal,
          ...(searchRuntime ? { webSearch: searchRuntime } : {}),
          ...(msg.videoFrameToolEnabled === true && chatCaps.supportsCurrentFrameCapture
            ? { captureCurrentVideoFrame: (targetTime?: number) => requestVideoFrame(ackedPort, generation, targetTime) }
            : {}),
          ...(chatCaps.supportsHotComments && chatSite === "bilibili" && String(chatContext?.aid || "").trim()
            ? { fetchHotComments: () => fetchHotCommentsJson(bgFetchJson, String(chatContext?.aid), 20) }
            : chatCaps.supportsHotComments && chatSite === "youtube" && Array.isArray(chatContext?.hotComments)
              ? { fetchHotComments: async () => chatContext.hotComments ?? [] }
              : {})
        },
        {
          askCostGuard: (costPort, message) => askCostGuard(costPort, message, generation),
          onActivity: () => {
            armIdleTimeout(generation, requestController, ackedPort);
          },
          pauseIdleTimeout: () => {
            clearIdleTimeout(generation);
          }
        }
      );
    } catch (e) {
      if (generation !== activeGeneration || requestController.signal.aborted) {
        return;
      }
      ackedPort.postMessage({ type: "error", error: String((e as Error | undefined)?.message || e) });
    } finally {
      clearIdleTimeout(generation);
      clearActiveRequestState(generation);
    }
  });

  port.onDisconnect.addListener(() => {
    consumeRuntimeLastError();
    if (pendingCostGuard) {
      const resolve = pendingCostGuard.resolve;
      pendingCostGuard = null;
      resolve(false);
    }
    abortActiveRequest();
    clearIdleTimeout();
    clearActiveRequestState();
  });
}
