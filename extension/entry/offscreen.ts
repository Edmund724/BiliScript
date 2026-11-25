import { getErrorMessage } from "../shared/error-helpers.js";
import { logWarn, registerDebugGate } from "../shared/logging.js";
import { safePostMessage, sendRuntimeMessage } from "../shared/messaging.js";
import { createOffscreenLifetime, type OffscreenCloseRequest } from "./offscreen-lifecycle.js";
import { ASR_DECODE_PORT_NAME, ASR_DECODE_ACTION, ASR_PROBE_ACTION, ASR_MSG_ERROR, ASR_MSG_PROBE_RESULT } from "../asr/protocol.js";
import { createSubtitleBodySlot } from "./offscreen-subtitle-slot.js";
import { attachOffscreenChatPort } from "./offscreen-chat-port.js";
import { createLazyLoader } from "../shared/lazy-import.js";
import type { OffscreenAsrPortMessage } from "../shared/messaging-protocol.js";
import { OFFSCREEN_CHAT_PORT_NAME } from "../chat/protocol.js";
import { MOSS_LIVE_PORT_NAME } from "../live/moss-live-protocol.js";
import { attachMossLivePort } from "../live/offscreen-moss-port.js";
import { PROVIDER_HTTP_OFFSCREEN_PORT_NAME, attachProviderHttpPort } from "../core/provider-http-offscreen.js";
import type { AgentBridgeOffscreenFrameMessage } from "../agent-bridge/protocol.js";

let debugGateEnabled = false;
registerDebugGate(() => debugGateEnabled);

chrome.runtime.onMessage.addListener((rawMessage: unknown) => {
  const type = (rawMessage as { type?: unknown } | null)?.type;
  if (type === "debug-log-gate-changed") {
    debugGateEnabled = Boolean((rawMessage as { enabled?: unknown }).enabled);
  } else if (type === "offscreen-bilibili-tabs-empty") {
    lifetime.notifyAllBilibiliTabsClosed();
  }
  return false;
});

chrome.runtime.onMessage.addListener((rawMessage: unknown, _sender, sendResponse) => {
  if ((rawMessage as { type?: unknown } | null)?.type !== "agent-bridge-offscreen-frame") return false;
  const message = rawMessage as AgentBridgeOffscreenFrameMessage;
  void lifetime.withTask(
    async () => {
      try {
        const { captureAgentBridgeFrames } = await import("../agent-bridge/frame.js");
        sendResponse({ ok: true, result: await captureAgentBridgeFrames(message) });
      } catch (error) {
        sendResponse({ ok: false, error: getErrorMessage(error) });
      }
    },
    { heavy: true }
  );
  return true;
});

void (async () => {
  try {
    const resp = await sendRuntimeMessage({ type: "get-debug-log-gate" });
    if (resp?.ok) {
      debugGateEnabled = Boolean(resp.enabled);
    }
  } catch {
  }
})();

const subtitleSlot = createSubtitleBodySlot();

const lifetime = createOffscreenLifetime({
  closeSelf: (request) => {
    void requestSelfClose(request);
  }
});

const asrHandlerLoader = createLazyLoader(async () => {
  const { createAsrDecodeHandler, createAsrProbeHandler } = await import("./offscreen-asr.js");
  const deps = { onTaskTerminal: lifetime.noteAsrTerminal };
  return {
    decode: createAsrDecodeHandler(deps),
    probe: createAsrProbeHandler(deps)
  };
});

const mossLiveLoader =
  typeof __BILISCRIPT_TARGET__ === "string" && __BILISCRIPT_TARGET__ === "firefox"
    ? null
    : createLazyLoader(async () => {
        const { OffscreenMossLiveClient } = await import("../live/offscreen-moss-client.js");
        return OffscreenMossLiveClient;
      });

const geminiLiveLoader =
  typeof __BILISCRIPT_TARGET__ === "string" && __BILISCRIPT_TARGET__ === "firefox"
    ? null
    : createLazyLoader(async () => {
        const { OffscreenGeminiLiveClient } = await import("../live/offscreen-gemini-live-client.js");
        return OffscreenGeminiLiveClient;
      });

const ladderLoader = createLazyLoader(async () => {
  const { runLadderChat } = await import("../ai/ladder.js");
  return runLadderChat;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === ASR_DECODE_PORT_NAME) {
    lifetime.trackAsrPort(port);
    port.onMessage.addListener((rawMsg) => {
      const msg = rawMsg as OffscreenAsrPortMessage;
      if (!msg) return;
      if (msg.action === ASR_PROBE_ACTION) {
        dispatchAsrProbeTask(msg.task || {}, port);
        return;
      }
      if (msg.action !== ASR_DECODE_ACTION) return;
      dispatchAsrDecodeTask(msg.task || {}, port);
    });
    return;
  }
  if (port && port.name === PROVIDER_HTTP_OFFSCREEN_PORT_NAME) {
    lifetime.trackPort(port);
    attachProviderHttpPort(port);
    return;
  }
  if (
    !(typeof __BILISCRIPT_TARGET__ === "string" && __BILISCRIPT_TARGET__ === "firefox") &&
    port &&
    port.name === MOSS_LIVE_PORT_NAME
  ) {
    lifetime.trackMediaPort(port);
    attachMossLivePort(port, {
      loadClient: async (providerType) => {
        if (providerType === "gemini-live") {
          const GeminiClientClass = await geminiLiveLoader!.load();
          return (opts) => new GeminiClientClass(opts);
        }
        const MossClientClass = await mossLiveLoader!.load();
        return (opts) => new MossClientClass(opts);
      },
      postMessage: safePostMessage
    });
    return;
  }

  if (!port || port.name !== OFFSCREEN_CHAT_PORT_NAME) {
    return;
  }
  lifetime.trackPort(port);
  attachOffscreenChatPort(port, {
    subtitleSlot,
    loadLadder: () => ladderLoader.load()
  });
});

async function dispatchAsrDecodeTask(task: unknown, port: chrome.runtime.Port) {
  let handlers;
  try {
    handlers = await asrHandlerLoader.load();
  } catch (error) {
    logWarn("[BILISCRIPT] offscreen-asr.js load failed", { error: getErrorMessage(error) });
    safePostMessage(port, {
      type: ASR_MSG_ERROR,
      error: "ASR 模块加载失败：" + getErrorMessage(error)
    });
    lifetime.noteAsrTerminal(port);
    return;
  }
  handlers.decode(task, port);
}

async function dispatchAsrProbeTask(task: unknown, port: chrome.runtime.Port) {
  let handlers;
  try {
    handlers = await asrHandlerLoader.load();
  } catch (error) {
    logWarn("[BILISCRIPT] offscreen-asr.js load failed (probe)", { error: getErrorMessage(error) });
    safePostMessage(port, {
      type: ASR_MSG_PROBE_RESULT,
      ok: false,
      error: "ASR 模块加载失败：" + getErrorMessage(error)
    });
    lifetime.noteAsrTerminal(port);
    return;
  }
  handlers.probe(task, port);
}

async function requestSelfClose(request: OffscreenCloseRequest): Promise<void> {
  try {
    const resp = await sendRuntimeMessage({
      type: "offscreen-request-close",
      reason: request.reason,
      ...(request.onlyIfNoBilibiliTabs ? { onlyIfNoBilibiliTabs: true } : {})
    });
    if (resp && !resp.ok) {
      logWarn("[BILISCRIPT] offscreen closeDocument after asr task failed", {
        error: resp.error || "offscreen-request-close 被拒绝"
      });
    }
  } catch {
  }
}
