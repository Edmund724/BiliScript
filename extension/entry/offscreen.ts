// offscreen.js — 隐藏后台页面，负责 SSE 流式请求，避免 Side Panel 被冻结。
// 同时承载 ASR 音频「下载 → 解码 → 切片 → 转写」与 Agent 后台历史截帧：
// 音频解码在本 context 用 OfflineAudioContext 完成，截帧使用独立隐藏视频；
// 音频字节与 API Key 不出 offscreen，跨通道只回传文本或 JPEG。
// 本文件保留端口接线与分发、聊天通道、空闲超时、Agent 截帧消息入口，以及
// 自关闭动作的注入（三通道存活簿记与终态判决在 ./offscreen-lifecycle.js）。
//
// 候选04：两族任务链按需动态装载。AI 半边（../ai/ladder.js → map-reduce →
// … → notes/render 渲染器）与 ASR 半边（./offscreen-asr.js → engine /
// adapters / chunker …）互不相干，静态全量打包会让每次任务冷启动都解析
// ~100KB 用不上的模块。offscreen 是页面环境，动态 import() 完全合法
// （ADR-0003 只约束 service worker），两族各自经 shared/lazy-import.js 的
// promise 缓存懒加载器按需拉取：
//   - ASR 族：首个 asr-decode 任务消息到达时装载，loadFn 内一次性装配任务
//     执行器（工厂只跑一次）；promise 缓存保证并发首连只加载一次，失败清
//     缓存可重试（如扩展刚更新后旧 chunk 404 的过渡窗口）。
//   - AI 族：首条 "chat" 消息到达时装载 runLadderChat（模块级无状态函数，
//     拉到即用）。
// 装载失败的错误沿各自既有消息通道回报（ASR：ASR_MSG_ERROR；聊天：
// { type: "error" }），不崩文档。文档自关闭簿记不感知装载状态：asr-decode
// 端口与聊天端口在 onConnect 时即入集（./offscreen-lifecycle.js 的 lifetime，
// 同步，先于任何消息），而装载只能由某个端口的任务消息触发——触发装载的端口
// 必已入集，故任一分支「装载中」期间其他任务的终态判定都会因端口计数 / 条件
// 非空保留文档，不会被提前关闭。
import { getErrorMessage } from "../shared/error-helpers.js";
import { logWarn, registerDebugGate } from "../shared/logging.js";
import { safePostMessage, sendRuntimeMessage } from "../shared/messaging.js";
import { createOffscreenLifetime, type OffscreenCloseRequest } from "./offscreen-lifecycle.js";
import { ASR_DECODE_PORT_NAME, ASR_DECODE_ACTION, ASR_PROBE_ACTION, ASR_MSG_ERROR, ASR_MSG_PROBE_RESULT } from "../asr/protocol.js";
// 候选5（多槽扩展）：聊天字幕体有界多槽缓存（纯逻辑在 ./offscreen-subtitle-slot.js，可测）。
import { createSubtitleBodySlot } from "./offscreen-subtitle-slot.js";
import { attachOffscreenChatPort } from "./offscreen-chat-port.js";
// 候选04：ASR / AI 两族任务链的懒加载器工厂（promise 缓存、失败可重试）。
import { createLazyLoader } from "../shared/lazy-import.js";
import type { OffscreenAsrPortMessage } from "../shared/messaging-protocol.js";
// 出向回吐协议单源（chat/protocol.ts，ticket 08）：聊天端口名常量收口两处
// 裸写（本文件 onConnect 判定与宿主 connect）。
import { OFFSCREEN_CHAT_PORT_NAME } from "../chat/protocol.js";
import { MOSS_LIVE_PORT_NAME } from "../live/moss-live-protocol.js";
import { attachMossLivePort } from "../live/offscreen-moss-port.js";
// 概览链的平台请求代发（overview-offscreen-transport）：端口名常量与两端同址
// 在 core/provider-http-offscreen.ts；本文档只认领端口并按活跃端口集簿记生命周期。
import { PROVIDER_HTTP_OFFSCREEN_PORT_NAME, attachProviderHttpPort } from "../core/provider-http-offscreen.js";
import type { AgentBridgeOffscreenFrameMessage } from "../agent-bridge/protocol.js";

// 调试日志门（工单 03）：offscreen 文档没有 chrome.storage（平台只开放
// chrome.runtime），初始开关与变更感知都走 runtime 消息——SW 是 storage 的
// 独占读者（get-debug-log-gate 回当前开关；sync.enableDebugLogs 变化时广播
// debug-log-gate-changed）。消息失败/无接收方时门维持缺省关：调试日志是诊断
// 辅助，接线本身绝不致命。
let debugGateEnabled = false;
registerDebugGate(() => debugGateEnabled);

try {
  chrome.runtime.onMessage.addListener((rawMessage: unknown) => {
    const type = (rawMessage as { type?: unknown } | null)?.type;
    if (type === "debug-log-gate-changed") {
      debugGateEnabled = Boolean((rawMessage as { enabled?: unknown }).enabled);
    } else if (type === "offscreen-bilibili-tabs-empty") {
      lifetime.notifyAllBilibiliTabsClosed();
    }
    return false;
  });
} catch {
  // 无 onMessage 的极端 stub 环境：门维持缺省关
}

chrome.runtime.onMessage?.addListener((rawMessage: unknown, _sender, sendResponse) => {
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
    // SW 未就绪/读失败：维持缺省关，不抛未处理拒绝
  }
})();

// 候选5（多槽扩展）：聊天字幕体有界多槽 LRU 缓存。发起侧只在 lastAckedContextKey
// 变化时随消息携带全量 subtitleBody，后续追问由本缓存按 contextKey 补齐；槽随
// 本文档生灭，文档被回收后发起侧 port 断连会重置其 lastAcked。
const subtitleSlot = createSubtitleBodySlot();

// 同一文档多通道（轻量：聊天 / 概览代发；重型：ASR / 实时伴看 / 视频截帧）的
// 存活簿记与分级空闲回收判决收口在 ./offscreen-lifecycle.js；本文档只注入关闭动作
// （经 runtime 消息委托 SW 串行执行）。
const lifetime = createOffscreenLifetime({
  closeSelf: (request) => {
    void requestSelfClose(request);
  }
});

// ASR 族懒加载：load() 返回「已注入 onTaskTerminal 的两个任务执行器」（解码与
// 连通性探针）——动态 import 与工厂装配都在 loadFn 内，工厂只执行一次。任务终态
// （断连取消 / done / error / 探针回执）经 onTaskTerminal 回调交回 lifetime 的
// 自关判决。
const asrHandlerLoader = createLazyLoader(async () => {
  const { createAsrDecodeHandler, createAsrProbeHandler } = await import("./offscreen-asr.js");
  const deps = { onTaskTerminal: lifetime.noteAsrTerminal };
  return {
    decode: createAsrDecodeHandler(deps),
    probe: createAsrProbeHandler(deps)
  };
});

// AI 族懒加载：首条 "chat" 消息到达时拉 ../ai/ladder.js 的 runLadderChat。

// MOSS-LIVE 客户端懒加载器
const mossLiveLoader = createLazyLoader(async () => {
  const { OffscreenMossLiveClient } = await import("../live/offscreen-moss-client.js");
  return OffscreenMossLiveClient;
});

const geminiLiveLoader = createLazyLoader(async () => {
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
      // 同一端口两类任务：解码（asr-decode）与连通性探针（asr-probe，协议见
      // asr/protocol.js）。探针不解码不切片，只以静音 WAV 走一次真适配器。
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
    // 概览代发端口：入集即算「文档有承载」（ASR 终态不关本文档），请求执行与
    // 断连 abort 全在 attachProviderHttpPort 内；本文件只经 lifetime 簿记生命周期。
    lifetime.trackPort(port);
    attachProviderHttpPort(port);
    return;
  }
  if (port && port.name === MOSS_LIVE_PORT_NAME) {
    lifetime.trackMediaPort(port);
    attachMossLivePort(port, {
      loadClient: async (providerType) => {
        if (providerType === "gemini-live") {
          const GeminiClientClass = await geminiLiveLoader.load();
          return (opts) => new GeminiClientClass(opts);
        }
        const MossClientClass = await mossLiveLoader.load();
        return (opts) => new MossClientClass(opts);
      },
      postMessage: safePostMessage
    });
    return;
  }

  if (!port || port.name !== OFFSCREEN_CHAT_PORT_NAME) {
    return;
  }
  // 聊天通道计数：asr-decode 终态自关判定的输入（见 lifetime.noteAsrTerminal）
  lifetime.trackPort(port);
  attachOffscreenChatPort(port, {
    subtitleSlot,
    loadLadder: () => ladderLoader.load()
  });
});

// asr-decode 任务分发：懒装载 ASR 半边后交任务执行器执行。装载失败沿既有
// ASR_MSG_ERROR 通道回报（页面按普通 ASR 失败展示，不崩文档），并按「error
// 终态」语义交回自关判定——与 handler 内部 catch 的收尾一致（终态消息发完
// 才判定；port 已断开时 postMessage 抛错被吞、判定照走，Set.delete 幂等，
// 两种时序都正确）。
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

// asr-probe 任务分发：与解码同一懒装载、同一终态簿记，回执走 probe-result 通道
// （页面只等这一条；装载失败同样以可读文案回执，绝不把「没等到」留成静默）。
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

// SW 代执行的自关闭请求。成功关闭时本文档随之销毁、回包可能永远不到
// （"message port closed" 类传输失败）——传输层失败不算关闭失败，静默即可；
// SW 明确回 ok:false（非 offscreen 发送者被拒 / closeDocument 抛错）才记日志，
// 与旧直调 closeDocument 的「异步失败仅记录」口径对齐。
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
    // 回包丢失（文档已在关闭中）/ 无接收方：静默
  }
}
