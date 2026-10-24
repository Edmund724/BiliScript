// offscreen.js — 隐藏后台页面，负责 SSE 流式请求，避免 Side Panel 被冻结。
// 同时是 "asr-decode" 端口的接线层：ASR 音频「下载 → 解码 → 切片 → 转写」
// 全链路在 ./offscreen-asr.js（service worker 无 AudioContext，解码 + 重采样
// 在本 context 用 OfflineAudioContext 完成；转写引擎与适配器也加载在本
// context——音频字节与 API Key 都不出 offscreen，跨 port 只回传转写文本结果）。
// 本文件只保留端口接线与分发、聊天通道、空闲超时，以及自关闭动作的注入
//（三通道存活簿记与终态判决在 ./offscreen-lifecycle.js）。
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
import { logInfo, logWarn, registerDebugGate, shouldDebugLog } from "../shared/logging.js";
import { safePostMessage, sendRuntimeMessage } from "../shared/messaging.js";
import { createOffscreenLifetime } from "./offscreen-lifecycle.js";
import { ASR_DECODE_PORT_NAME, ASR_DECODE_ACTION, ASR_PROBE_ACTION, ASR_MSG_ERROR, ASR_MSG_PROBE_RESULT } from "../asr/protocol.js";
// 候选5：聊天字幕体单槽缓存（纯逻辑在 ./offscreen-subtitle-slot.js，可测）。
import { createSubtitleBodySlot } from "./offscreen-subtitle-slot.js";
// 候选04：ASR / AI 两族任务链的懒加载器工厂（promise 缓存、失败可重试）。
import { createLazyLoader } from "../shared/lazy-import.js";
import type {
  OffscreenAsrPortMessage,
  OffscreenChatPortMessage,
  ResolveAiProviderResponse
} from "../shared/messaging-protocol.js";
import type { ChatMsg } from "../ai/ladder.js";
// 联网搜索运行时解析器（spec §2.3/§2.4）：resolve-search-provider 往返 + executeSearch
// 闭包组装收口单源（search/search-runtime.ts，选区解释链同走此解析）。
import {
  resolveWebSearchRuntime,
  SEARCH_NOT_CONFIGURED_NOTICE,
  type WebSearchRuntimeResolution
} from "../search/search-runtime.js";
// 出向回吐协议单源（chat/protocol.ts，ticket 08）：聊天端口名常量收口两处
// 裸写（本文件 onConnect 判定与宿主 connect），withCachedContextKey 包装的
// postMessage 入参从 Record<string, unknown> 收为协议联合——下游
// ladder/streamChat/map-reduce 构造的联合成员获得编译期约束。
import { OFFSCREEN_CHAT_PORT_NAME } from "../chat/protocol.js";
// 概览链的平台请求代发（overview-offscreen-transport）：端口名常量与两端同址
// 在 core/provider-http-offscreen.ts；本文档只认领端口并按活跃端口集簿记生命周期。
import { PROVIDER_HTTP_OFFSCREEN_PORT_NAME, attachProviderHttpPort } from "../core/provider-http-offscreen.js";
import { hasHostPermissionFromOffscreen, HOST_PERMISSION_HINT } from "../core/host-permissions.js";
import type { ChatPortMessage } from "../chat/protocol.js";
// 调试日志门三宿主接线（shared/logging 的 registerDebugGate 消费方）
import { registerDebugLogGate } from "../shared/debug-log-gate.js";

// 调试日志门（工单 03）：offscreen 文档没有 chrome.storage（平台只开放
// chrome.runtime），初始开关与变更感知都走 runtime 消息——SW 是 storage 的
// 独占读者（get-debug-log-gate 回当前开关；sync.enableDebugLogs 变化时广播
// debug-log-gate-changed）。消息失败/无接收方时门维持缺省关：调试日志是诊断
// 辅助，接线本身绝不致命。
let debugGateEnabled = false;
registerDebugGate(() => debugGateEnabled);

try {
  chrome.runtime.onMessage.addListener((rawMessage: unknown) => {
    if ((rawMessage as { type?: unknown } | null)?.type === "debug-log-gate-changed") {
      debugGateEnabled = Boolean((rawMessage as { enabled?: unknown }).enabled);
    }
    return false;
  });
} catch {
  // 无 onMessage 的极端 stub 环境：门维持缺省关
}

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

let currentChatGeneration = 0;
let activeGeneration = 0;
let activeAbortController: AbortController | null = null;
let pendingCostGuard: { resolve: (value: boolean) => void; generation: number } | null = null;
let idleTimeoutId: ReturnType<typeof setTimeout> | null = null;
let idleTimeoutGeneration = 0;
var STREAM_IDLE_TIMEOUT_MS = 90000;

// 候选5：聊天字幕体单槽缓存。SP 侧只在 lastAckedContextKey 变化时随消息携带
// 全量 subtitleBody，后续追问由本槽补齐；槽随本文档生灭，文档被回收后 SP 的
// port 断连会重置其 lastAcked，时序缝隙里漏网的缺失消息走 settle 的错误回执。
const subtitleSlot = createSubtitleBodySlot();

// 同一文档三通道（聊天 / asr-decode / 概览代发）的存活簿记与 asr 终态自关判决
// 收口在 ./offscreen-lifecycle.js：端口入集出集、自身端口排除、三条件判定都在
// 模块内；本文档只注入关闭动作（自关经 runtime 消息委托 SW 执行）。概览代发在飞
// 时不得自关（回执通道会被吞掉）。
const lifetime = createOffscreenLifetime({
  closeSelf: () => {
    void requestSelfClose();
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
const ladderLoader = createLazyLoader(async () => {
  const { runLadderChat } = await import("../ai/ladder.js");
  return runLadderChat;
});

interface PostMessagePort {
  postMessage(message: unknown): void;
}

function armIdleTimeout(generation: number, abortController: AbortController, port: PostMessagePort) {
  if (generation !== activeGeneration || abortController.signal.aborted) {
    return;
  }
  clearIdleTimeout(generation);
  idleTimeoutGeneration = generation;
  idleTimeoutId = setTimeout(function () {
    if (generation === activeGeneration && abortController && !abortController.signal.aborted) {
      abortController.abort();
      // 超时中断只 abort：原始段缓冲的落盘已收口到 map-reduce 写会话的收尾
      // close（本次 abort 令编排走 abort 收束，close 随该轮 finally 落盘）
      port.postMessage({
        type: "error",
        error: "请求超时（90 秒未返回任何数据），已自动中断"
      });
    }
  }, STREAM_IDLE_TIMEOUT_MS);
}

function clearIdleTimeout(generation?: number) {
  if (generation !== undefined && generation !== idleTimeoutGeneration) {
    return;
  }
  if (idleTimeoutId) {
    clearTimeout(idleTimeoutId);
    idleTimeoutId = null;
  }
  idleTimeoutGeneration = 0;
}

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
    lifetime.trackProviderPort(port);
    attachProviderHttpPort(port);
    return;
  }
  if (!port || port.name !== OFFSCREEN_CHAT_PORT_NAME) {
    return;
  }
  // 聊天通道计数：asr-decode 终态自关判定的输入（见 lifetime.noteAsrTerminal）
  lifetime.trackChatPort(port);

  port.onMessage.addListener(async (rawMsg) => {
    const msg = rawMsg as OffscreenChatPortMessage;
    if (!msg) return;
    if (msg.action === "stop") {
      // 只 abort：Map-Reduce 的写会话在该轮收束（abortReturn）的 finally 里 close
      // 落盘残留原始段，供跨会话追问复用
      abortActiveRequest();
      return;
    }
    if (msg.action === "cost-guard-confirm") {
      if (pendingCostGuard) {
        const { resolve, generation } = pendingCostGuard;
        pendingCostGuard = null;
        if (generation === activeGeneration) {
          resolve(msg.ok !== false);
        } else {
          resolve(false);
        }
      }
      return;
    }
    if (msg.action !== "chat") return;

    // 候选5：先结算字幕体。SP 侧 lastAckedContextKey 命中时消息不带
    // subtitleBody，由单槽缓存补写进 msg.context；槽缺失/key 不匹配直接回
    // 错误且不带 cachedContextKey——SP 据此重置 lastAcked，让下一条消息重发
    // 全文（本条不自动重发，避免失败风暴）。
    const settled = subtitleSlot.settle(msg);
    if (!settled.ok) {
      safePostMessage(port, { type: "error", error: settled.error, code: settled.code });
      return;
    }
    // 自此所有 chat 回执都附带 cachedContextKey（槽内已确认的 key）：SP 读它
    // 推进 lastAckedContextKey，后续追问省略 subtitleBody。包装只劫持
    // postMessage，端口事件监听不受影响；下游 ladder/streamChat/map-reduce
    // 只经 port.postMessage 回吐，包装对它们透明。
    const ackedPort = withCachedContextKey<ChatPortMessage>(port, settled.contextKey!);

    abortActiveRequest();
    const generation = ++currentChatGeneration;
    const requestController = new AbortController();
    activeAbortController = requestController;
    activeGeneration = generation;

    try {
      // 候选04/10-6：首次聊天并行拉取两件互不依赖的前置——provider 解析
      //（resolve-ai-provider 单趟往返）与 AI 半边动态装载（ladderLoader.load，
      // 拉 ../ai/ladder.js）。串行会多等一轮「往返 + module 解析」，改
      // Promise.all 并行。任一侧失败照旧走原分支：装载失败抛错进下方既有
      // catch 通道回报（{ type: "error" }），语义与 runLadderChat 抛错一致，
      // 不崩文档；provider 解析出错短路并清理活动请求态。联网开关开启时并行
      // 解析搜索配置（resolve-search-provider 单趟往返，spec §2.3/§2.4）。
      const webSearchRequested = (msg as ChatMsg).webSearchEnabled === true;
      const [resolved, runLadderChat, searchResolution] = await Promise.all([
        resolveProviderWithKey(ackedPort, msg.providerId, generation),
        ladderLoader.load(),
        webSearchRequested ? resolveSearchRuntime(requestController.signal) : Promise.resolve(undefined)
      ]);
      if (generation !== activeGeneration || requestController.signal.aborted) {
        return;
      }
      // runtime 缺省 = 本轮不联网（未配置 / 解析失败）；notice 文案随解析产物单源给出
      //（空链两类归因，spec §12.7 第 6 条翻案）。
      const searchRuntime: WebSearchRuntimeResolution["runtime"] = searchResolution?.runtime;
      if (resolved.error) {
        clearActiveRequestState(generation);
        return;
      }
      if (webSearchRequested && !searchRuntime) {
        // 开关开启但无可用链：如实提示后走原无工具路径（搜索是增强，缺失不阻塞
        // 对话）。文案单源在解析侧——真未配置 / 智能链全冷却两类归因分文案
        //（spec §12.7 第 6 条翻案：全冷却不是未配置）。
        ackedPort.postMessage({
          type: "notice",
          data: searchResolution?.notice ?? SEARCH_NOT_CONFIGURED_NOTICE
        });
      }
      const { provider, apiKey } = resolved;

      // host 权限预检（ADR-0010 收口）：对话链的平台请求也在本文档内直发
      //（ai/completion.ts 的默认 globalThis.fetch），而 offscreen 查不了
      // chrome.permissions——经 SW 代查一跳，未授权先给可操作文案，免得权限缺失只
      // 表现为「网络错误：Failed to fetch」。SW 代发 / 概览代发两条通道一直有此预检。
      if (!(await hasHostPermissionFromOffscreen(provider?.baseUrl))) {
        throw new Error(HOST_PERMISSION_HINT);
      }

      if (generation !== activeGeneration || requestController.signal.aborted) {
        return;
      }

      armIdleTimeout(generation, requestController, ackedPort);

      // 核数打点（调试日志门默认关，门关时连计数都跳过）：素材字符数与 budgeter
      // totalChars 同口径（trim 后非空 content），供长视频「单发/分段」路径核数
      // 与字幕膨胀排查。
      if (shouldDebugLog()) {
        const chatBody = (msg as ChatMsg).context?.subtitleBody;
        const materialChars = ((chatBody || []) as Array<{ content?: unknown }>).reduce((sum, item) => {
          const text = String(item?.content ?? "").trim();
          return sum + text.length;
        }, 0);
        logInfo("[BILISCRIPT] AI chat material chars:", materialChars);
      }

      // 阶梯分派策略（预算内单次流式 → 超预算 Map-Reduce → 追问压缩/成本护栏）
      // 在 ai/ladder.js（策略模块由 ladder 自行引入默认实现）；此处只接线：
      // 注入依赖本文件簿记的 askCostGuard 与空闲超时回调。abort controller、
      // 空闲超时与 cost-guard 的 Promise 簿记仍留在本文件。
      await runLadderChat(
        {
          msg: msg as ChatMsg,
          // 选中模型覆盖（multi-model-catalog）：chat 模型选择器一模型一选项，
          // 消息携带具体模型 id；未携带（旧宿主）回落解析平台记录的目录首项
          // （resolveProviderWithKey 回包已归一化）。
          provider: {
            ...provider,
            apiKey,
            ...(msg.model ? { model: String(msg.model) } : {}),
            // 平台会话头取值来源（Opencode Go 的 x-opencode-session，见
            // ai/preset-headers.ts）：宿主带的会话身份挂进本轮 provider，阶梯下
            // 游（ladder/streamChat/map-reduce/tool-loop）原样透传，本轮所有请求
            // 因此共用一个会话标识；未携带（旧宿主）不填，preset-headers 现造一个。
            ...(msg.conversationId ? { sessionId: String(msg.conversationId) } : {})
          },
          port: ackedPort,
          signal: requestController.signal,
          // 联网运行时（spec §2.3）：toggle 开启且已配置时注入工具循环。
          ...(searchRuntime ? { webSearch: searchRuntime } : {})
        },
        {
          askCostGuard: (costPort, message) => askCostGuard(costPort, message, generation),
          onActivity: function () {
            armIdleTimeout(generation, requestController, ackedPort);
          },
          pauseIdleTimeout: function () {
            clearIdleTimeout(generation);
          }
        }
      );
    } catch (e) {
      if (generation !== activeGeneration || requestController.signal.aborted) {
        return;
      }
      // 异常路径同样由编排收尾的会话 close 落盘残留原始段（不随本次失败丢弃）
      ackedPort.postMessage({ type: "error", error: String((e as Error | undefined)?.message || e) });
    } finally {
      clearIdleTimeout(generation);
      clearActiveRequestState(generation);
    }
  });

  port.onDisconnect.addListener(() => {
    if (pendingCostGuard) {
      const resolve = pendingCostGuard.resolve;
      pendingCostGuard = null;
      resolve(false);
    }
    abortActiveRequest();
    clearIdleTimeout();
    clearActiveRequestState();
    // 段缓存写会话不在此 close：会话随 offscreen 文档销毁废弃（文档可被回收，
    // 断连时无法保证落盘——丢弃语义的显式化，见 ai/segment-cache-proxy.js 头注）
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

function abortActiveRequest() {
  if (pendingCostGuard) {
    const resolve = pendingCostGuard.resolve;
    pendingCostGuard = null;
    resolve(false);
  }
  if (activeAbortController && !activeAbortController.signal.aborted) {
    activeAbortController.abort();
  }
  activeAbortController = null;
  activeGeneration = 0;
  clearIdleTimeout();
}

// SW 代执行的自关闭请求。成功关闭时本文档随之销毁、回包可能永远不到
// （"message port closed" 类传输失败）——传输层失败不算关闭失败，静默即可；
// SW 明确回 ok:false（非 offscreen 发送者被拒 / closeDocument 抛错）才记日志，
// 与旧直调 closeDocument 的「异步失败仅记录」口径对齐。
async function requestSelfClose(): Promise<void> {
  try {
    const resp = await sendRuntimeMessage({ type: "offscreen-request-close" });
    if (resp && !resp.ok) {
      logWarn("[BILISCRIPT] offscreen closeDocument after asr task failed", {
        error: resp.error || "offscreen-request-close 被拒绝"
      });
    }
  } catch {
    // 回包丢失（文档已在关闭中）/ 无接收方：静默
  }
}

function clearActiveRequestState(generation?: number) {
  if (generation !== undefined && generation !== activeGeneration) {
    return;
  }
  activeAbortController = null;
  activeGeneration = 0;
}

// 向侧边栏弹成本护栏确认，等待其回复 { action: "cost-guard-confirm", ok: boolean }。
// 断连时 resolve(false)（视为取消）。
function askCostGuard(port: PostMessagePort, message: string, generation: number) {
  return new Promise<boolean>((resolve) => {
    pendingCostGuard = { resolve, generation };
    port.postMessage({ type: "cost-guard", data: { message } });
  });
}

// 候选5：给 port 的出站消息统一附带 cachedContextKey（本侧单槽缓存当前确认
// 持有的字幕体 key）。SP 从任意一条 chat 回执读它推进 lastAckedContextKey，
// 后续追问省略 subtitleBody。只包装 postMessage 一个入口；事件监听器仍挂
// 在原 port 上（本包装只作为下游回吐的发送通道）。T 为协议出向联合
//（chat/protocol.ts，ticket 08）：下游回吐点入参获得编译期约束；运行时只
// 展开展开属性并附 cachedContextKey（联合上本就可选，附加不改变成员形状）。
function withCachedContextKey<T extends ChatPortMessage>(port: PostMessagePort, contextKey: string) {
  return {
    postMessage: (data: T): void => {
      // 断连后的迟到回执由 safePostMessage 统一吞掉（口径单源，见
      // shared/messaging.js），否则会在 async 消息监听器里抛成 unhandled rejection。
      safePostMessage(port, { ...data, cachedContextKey: contextKey } as T);
    }
  };
}

// 取联网搜索运行时（spec §2.3/§2.4）：委托 search/search-runtime.ts 的共享解析
//（resolve-search-provider 往返 + executeSearch 闭包，选区解释链同源）；中止
// 复用本次聊天的 abort controller，停止可中断在途搜索。runtime 缺省（未配置 /
// 全冷却 / 解析失败）时另带 notice 文案，调用方 notice 后走原无工具路径——搜索是
// 增强，缺失不阻塞对话。
async function resolveSearchRuntime(signal?: AbortSignal | null): Promise<WebSearchRuntimeResolution> {
  return resolveWebSearchRuntime(signal ?? activeAbortController?.signal ?? null);
}

// 取「选中的平台 + 其 API Key」：走 resolve-ai-provider 合成消息单趟往返
//（arch-slim-3/09，解析策略与密钥校验单源在 core/provider-handlers.ts 处理器，
// 与 content 侧 ai/active-provider.ts 同走此消息；providerId 给定 = 精确匹配档）。
// 任一缺失（平台不存在 / key 读取失败 / 需要 key 但未配置）返回带 error 的对象；
// 成功返回 { provider, apiKey }（apiKey 合并进 provider 副本，沿用下游消费形状）。
// 响应形状引用协议单源（arch-slim-2/02）：本 context 保留 Promise 风格直发
//（MV3 无回调签名，见 tests/entry/offscreen-asr-skip.test.ts 的 stub 说明），
// await 的 unknown 回包在传输边界收窄为协议响应类型——与 shared/messaging.ts
// 内部的单点 cast 同性质。
async function resolveProviderWithKey(port: PostMessagePort, providerId: string | undefined, generation?: number) {
  const resp = (await chrome.runtime.sendMessage({
    type: "resolve-ai-provider",
    providerId
  })) as ResolveAiProviderResponse | null;
  if (generation !== undefined && generation !== activeGeneration) {
    return { error: true };
  }
  if (!resp?.ok || !resp.provider) {
    port.postMessage({ type: "error", error: resp?.error || "解析 AI 平台配置失败" });
    return { error: true };
  }
  const apiKey = String(resp.apiKey || "").trim();
  return { provider: { ...resp.provider, apiKey }, apiKey };
}
