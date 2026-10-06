// extension/core/provider-http-offscreen.ts
// 概览链的平台请求代发：content script 发起 → offscreen 文档执行
//（overview-offscreen-transport）。与 core/provider-http.ts（content → service
// worker 代发）同形，差别在「谁来发这一跳 + 超时/取消策略 + 回吐形态」：
// - SW 代发硬编码 15s 超时（provider-http.ts:72）且有 MV3 service worker 生命
//   周期上限，服务的是探针/选区解释这类短请求；
// - 概览是分钟级长请求，宿主取 offscreen（entry/offscreen.ts 头注：长 AI 请求
//   的既定宿主）。扩展源 fetch 只受 host 权限约束，**不过网页 CORS 预检**——
//   content 直发会撞网关预检白名单（实测 ModelScope 的 Anthropic 端点拒
//   anthropic-version / x-api-key）。
// 概览的模型调用走 SSE 流式（实测网关对非流式长请求整体超时：12.4 万字素材
// 19 分钟后回 HTTP 500 "Request timed out"，同一素材流式正常），故端口约定
//「一律分块回吐」：不论上游是 SSE 还是普通 JSON，offscreen 都按到达顺序回吐
// 响应头 → 正文分片 → done，content 侧合成带 ReadableStream body 的 Response
// ——非流式调用方（.json()/.text()）行为不变，流式调用方（response.body）拿增量。
//
// 两端同文件（照 provider-http.ts 的组织）：
// - 发送端 providerFetchViaOffscreen 在 content script 里跑，合成标准 Response；
// - 接收端 attachProviderHttpPort 在 offscreen 里跑。一请求一端口（概览分段路径
//   有并发，免 id 关联；端口断连即 abort 在飞请求），对齐 asr-decode 一任务一端口。
// 传输层的公共件（URL / Headers / 中止形状 / 接收端预检与 fetch init / 出向载荷）
// 单源在 core/provider-http-shared.ts，与 SW 代发共用。
//
// host 权限预检在 content 侧做（offscreen 只有 chrome.runtime，没有
// chrome.permissions，见 host-permissions.ts 对 content 侧的同款记录）：经
// hasHostPermissionViaBackground 走 SW 代查一跳，未授权即以可操作文案失败、不连
// 端口——与 SW 代发通道（provider-http.ts 的 hasHostPermission 预检）同口径，
// 免得权限缺失只表现为「网络错误：Failed to fetch」。URL 合法性预检保留，与
// provider-http.ts 一致。
// 不加超时：与改动前的 content 直发同口径（那时也没有），避免误杀长视频生成；
// 流式本身不再有「整体超时」问题。面板内的出口是生成中状态条的「取消」键
//（reader/overview.ts），首字节前的等待计时只提示、不中断。
//
// 派发确认（ADR-0010「不设超时」的射程外）：不设超时针对的是**平台慢**，不能用来
// 兜**通道根本没被接管**——ASR 终态自关（entry/offscreen.ts 的 maybeCloseSelfAfterAsr
// 在聊天端口与在飞代发端口都为 0 时关文档）与同一个 subtitle-ready 触发的概览请求
// 撞车时，connect 出的端口可能落到 SW 的保活 onConnect 上（entry/background.ts 对
// 不认识的端口名只 return、不 disconnect），于是既不回吐也不断连：面板永久停在
// 「正在等待平台响应…（已等待 N 秒）」，取消成了唯一出口。故 offscreen 收到请求
// 消息即回一条 { ok:true, accepted:true }，content 侧据「确认是否到达」区分「端口已
// 被接管」与「端口没人服务」：没确认（或首条回吐前就断连）即断端口重连一次
//（等待 DISPATCH_RETRY_DELAY_MS 给上一轮 closeDocument 收尾），仍不成才以可读错误
// 上浮——概览落错误条带「重试」，不再无限挂着。

import { safePostMessage, sendRuntimeMessage } from "../shared/messaging.js";
import { extractOriginFromBaseUrl, hasHostPermissionViaBackground, HOST_PERMISSION_HINT } from "./host-permissions.js";
import {
  buildProviderFetchInit,
  buildProviderRequestPayload,
  errorText,
  isRequestAborted,
  makeAbortError,
  normalizeResponseStatus,
  resolveRequestTarget
} from "./provider-http-shared.js";
import type {
  OffscreenProviderHttpPortMessage,
  OffscreenProviderHttpPortReply
} from "../shared/messaging-protocol.js";

// 宿主 connect 与 offscreen onConnect 同址判定用的端口名，禁止手写字面量。
export const PROVIDER_HTTP_OFFSCREEN_PORT_NAME = "provider-http-offscreen" as const;

// 端口断连（offscreen 文档未就绪 / 被回收）的可读文案：落定前拒绝、落定后
// error 掉读流共用——中途截断不能被当成成功。
const PORT_DISCONNECTED_MESSAGE = "代发通道已断开（offscreen 文档未就绪或被回收），请重试";

// 没等到派发确认（端口被收下却没人服务）的可读文案：见模块头注「派发确认」。
const DISPATCH_UNCLAIMED_MESSAGE = "代发通道无人接管（offscreen 文档未就绪或被回收），请重试";

// 派发确认的等待上限：确认由 offscreen 收到消息即回，属本机一跳，2s 足够宽裕；
// 超过即判该端口没人服务（与「平台慢」无关，故不违背 ADR-0010 的不设超时）。
const DISPATCH_ACK_TIMEOUT_MS = 2000;

// 重连前的等待：给上一轮 offscreen 文档的 closeDocument 收尾留时间——撞车窗口里
// ensure 的「文档已存在」判定（getContexts / createDocument 报已存在）会短暂说谎。
const DISPATCH_RETRY_DELAY_MS = 400;

// 派发尝试上限（首次 + 重连一次）：再多只是重复撞同一个竞态。
const DISPATCH_MAX_ATTEMPTS = 2;

// 派发失败标记（house style 类型化标记，消费方查标记分流）：两种都发生在「首条
// 回吐之前」，即请求还没拿到任何上游响应，重发不会重复计费到已生成的正文上。
function makeUnclaimedPortError(): Error & { dispatchUnclaimed: true } {
  const error = new Error(DISPATCH_UNCLAIMED_MESSAGE) as Error & { dispatchUnclaimed: true };
  error.dispatchUnclaimed = true;
  return error;
}

function makeDisconnectedPortError(): Error & { portDisconnected: true } {
  const error = new Error(PORT_DISCONNECTED_MESSAGE) as Error & { portDisconnected: true };
  error.portDisconnected = true;
  return error;
}

// 可重连的派发失败：端口没被接管（无确认）或首条回吐前断连。落定后的中途失败、
// 中止、offscreen 侧回的错误都不在此列（那些要么已经拿到响应，要么不该重发）。
function isRetryableDispatchFailure(error: unknown): boolean {
  const marked = error as { dispatchUnclaimed?: unknown; portDisconnected?: unknown } | null;
  return Boolean(marked?.dispatchUnclaimed || marked?.portDisconnected);
}

// 重连前的等待：可被中止打断（取消不该等满延迟），到点或中止都兑现。
function sleepBeforeDispatchRetry(signal?: AbortSignal | null): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    timer = setTimeout(finish, DISPATCH_RETRY_DELAY_MS);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

// ===== 发送端（content script 域）：fetch 兼容实现 =====

// 供 ai/analysis-orchestrate 作为 chatCompletion 的 fetchImpl 注入：把 offscreen
// 的分块回吐合成标准 Response——status/ok 在响应头到达时即可用，正文经
// response.body 读（流式）或 .text()/.json() 收全（非流式调用方行为不变）。
//
// 取消语义：init.signal 中止时以 AbortError 名字拒绝（completion 据此转
// makeAbortedError），并断开端口——offscreen 侧据断连 abort 在飞请求，请求不
// 白跑（与 provider-http.ts「已在飞的 SW 请求无法撤回」不同：端口断连可传达到）。
export async function providerFetchViaOffscreen(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const payload = buildProviderRequestPayload(input, init);
  // 已中止时不发消息（调用方已不关心结果，白跑一趟 offscreen 无意义）
  if (isRequestAborted(init?.signal)) {
    throw makeAbortError();
  }
  // host 权限预检（content 语境经 SW 代查）：未授权时连 offscreen 文档都不必建，
  // 更不发注定失败的跨域请求。文案与 SW 代发通道一致（completion 包装后成
  // 「网络错误：<HOST_PERMISSION_HINT>」落进概览错误条）。
  if (!(await hasHostPermissionViaBackground(payload.url))) {
    throw new Error(HOST_PERMISSION_HINT);
  }

  // 文档不存在时 connect 连上即断（chat/offscreen-ensure.ts 的既有事实），故先经
  // SW 幂等 ensure；ensure 失败不阻断 connect（对齐 reader/chat-tab.ts 的
  // connectPort），由断连错误回执兜底。重连轮同样 ensure：上一轮文档可能正在关闭，
  // 幂等 ensure 才会真建一个新的（见模块头注「派发确认」）。
  let attempt = 0;
  for (;;) {
    attempt += 1;
    await sendRuntimeMessage({ type: "ensure-offscreen-chat" }).catch(() => null);
    if (isRequestAborted(init?.signal)) {
      throw makeAbortError();
    }
    const port = chrome.runtime.connect({ name: PROVIDER_HTTP_OFFSCREEN_PORT_NAME });
    try {
      return await openProviderStream(port, { action: "provider-http", ...payload }, init?.signal);
    } catch (error) {
      // 只在「首条回吐之前就没接住」时重连一次；已中止、已拿到响应、offscreen
      // 侧回的错误一律原样上浮（概览据错误条给「重试」出口）。
      if (attempt >= DISPATCH_MAX_ATTEMPTS || !isRetryableDispatchFailure(error) || isRequestAborted(init?.signal)) {
        throw error;
      }
      await sleepBeforeDispatchRetry(init?.signal);
    }
  }
}

// 打开一次代发请求：offscreen 侧的派发确认（见模块头注）→ 首条回吐（响应头 /
// 失败）落定 promise，其后的分片写入 ReadableStream、done 关闭、中途失败 error 掉
// 读流。端口在终态（关闭 / 出错 / 消费方放弃 / 中止）断开并摘掉中止监听，不留悬挂
// 监听；确认超时（端口没人服务）同样进终态并以可重连错误拒绝。
function openProviderStream(
  port: chrome.runtime.Port,
  payload: OffscreenProviderHttpPortMessage,
  signal?: AbortSignal | null
): Promise<Response> {
  const encoder = new TextEncoder();

  return new Promise<Response>((resolve, reject) => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    // 首条回吐是否已落定（响应头已合成 Response）
    let settled = false;
    // 流是否已进终态（关闭 / 出错 / 消费方放弃）：重复回吞入的消息一律丢弃
    let streamDone = false;
    // 派发确认计时器（见模块头注「派发确认」）
    let ackTimer: ReturnType<typeof setTimeout> | null = null;

    const clearAckTimer = (): void => {
      if (ackTimer !== null) {
        clearTimeout(ackTimer);
        ackTimer = null;
      }
    };
    const releasePort = (): void => {
      clearAckTimer();
      signal?.removeEventListener("abort", onAbort);
      try {
        port.disconnect();
      } catch {
        // 已断连（回吐前的断连路径）：忽略
      }
    };
    const closeStream = (): void => {
      if (streamDone) {
        return;
      }
      streamDone = true;
      releasePort();
      streamController.close();
    };
    const failStream = (message: string): void => {
      if (streamDone) {
        return;
      }
      streamDone = true;
      releasePort();
      streamController.error(new Error(message));
    };
    // 中止：落定前拒绝（offscreen 据断连撤在飞请求）；落定后一并 error 掉读流
    //——挂起的 reader.read() 不等 onDisconnect 回执也能立刻收束（completion 按
    // signal.aborted 转中止错误，静默丢弃）。
    const onAbort = (): void => {
      if (!settled) {
        settled = true;
        releasePort();
        reject(makeAbortError());
        return;
      }
      failStream("请求已中止");
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      cancel() {
        // 消费方主动放弃读流（releaseLock 除外）：同样通知 offscreen 停工。
        if (!streamDone) {
          streamDone = true;
          releasePort();
        }
      }
    });

    port.onMessage.addListener((raw) => {
      const reply = raw as OffscreenProviderHttpPortReply;
      // 任何回吐都证明端口已被服务：撤掉派发确认计时器（扩展重载后仍在的旧
      // offscreen 文档不认 ack 字段，它的首条回吐同样是活着的凭据）。
      clearAckTimer();
      if (reply?.accepted) {
        // 派发确认：只证明 offscreen 已接管本端口，不是响应头——不得据此合成
        // Response（否则消费方拿到一个没有正文的空响应）。
        return;
      }
      if (!reply?.ok) {
        // 抛出的 message 经 completion 的网络错误包装后落到「网络错误：<message>」
        // 文案（与本地 fetch 抛错同形）；响应头已发时表示中途失败，读流整体抛错。
        const message = reply?.error || "请求失败";
        if (settled) {
          failStream(message);
          return;
        }
        settled = true;
        releasePort();
        reject(new Error(message));
        return;
      }
      if (!settled) {
        // 响应头到达即落定：非流式调用方据此读 status/text，流式调用方开始读 body。
        settled = true;
        resolve(new Response(stream, { status: normalizeResponseStatus(reply.status) }));
        return;
      }
      if (streamDone) {
        // 流已终态（done / 失败 / 消费方放弃）后迟到的回吐：丢弃，避免对已关闭
        // 的流 enqueue 抛 TypeError。
        return;
      }
      if (reply.chunk) {
        streamController.enqueue(encoder.encode(String(reply.chunk)));
        return;
      }
      if (reply.done) {
        closeStream();
      }
    });
    port.onDisconnect.addListener(() => {
      if (!settled) {
        settled = true;
        releasePort();
        reject(makeDisconnectedPortError());
        return;
      }
      failStream(PORT_DISCONNECTED_MESSAGE);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    // 确认计时器：超时即判「端口被收下却没人服务」（既不回吐也不断连的悬挂端口），
    // 进终态并以可重连错误拒绝——由 providerFetchViaOffscreen 断端口重连一次。
    ackTimer = setTimeout(() => {
      ackTimer = null;
      if (settled || streamDone) {
        return;
      }
      settled = true;
      streamDone = true;
      releasePort();
      reject(makeUnclaimedPortError());
    }, DISPATCH_ACK_TIMEOUT_MS);
    port.postMessage(payload);
  });
}

// ===== 接收端（offscreen 域）=====

// offscreen 侧接线：声明本端口后由 entry/offscreen.ts 在 onConnect 里调用。端口
// 生命周期完全由调用方簿记（活跃端口集决定 ASR 终态是否自关文档），本函数只管
//「收请求 → fetch → 分块回吐」与「断连即 abort」。
export function attachProviderHttpPort(port: chrome.runtime.Port): void {
  const inflight = new Set<AbortController>();
  port.onDisconnect.addListener(() => {
    for (const controller of inflight) {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    }
    inflight.clear();
  });

  port.onMessage.addListener(async (rawMsg) => {
    const message = rawMsg as OffscreenProviderHttpPortMessage;
    if (!message || message.action !== "provider-http") {
      return;
    }
    // 派发确认：收到请求消息即回，先于 URL 预检与 fetch——确认的是「本端口已被本文档
    // 接管」，与请求成败无关（非法 URL 也要回，否则 content 侧会把一次正常失败读成
    // 死通道并重连）。见模块头注「派发确认」。
    safePostMessage(port, { ok: true, accepted: true });
    const controller = new AbortController();
    inflight.add(controller);
    try {
      await forwardProviderRequest(port, message, controller.signal);
    } finally {
      inflight.delete(controller);
    }
  });
}

// 一次代发的执行（约定：一请求一端口；多条消息各自独立 controller）：URL 预检
// → fetch → 分块回吐。失败回一条 { ok:false, error }——响应头未发是整体失败、
// 已发是中途失败，content 侧据 settled 分流（拒绝 / error 掉读流）。
async function forwardProviderRequest(
  port: chrome.runtime.Port,
  message: OffscreenProviderHttpPortMessage,
  signal: AbortSignal
): Promise<void> {
  const target = resolveRequestTarget(message.url, extractOriginFromBaseUrl);
  if (!target) {
    safePostMessage(port, { ok: false, error: "请求地址不合法" });
    return;
  }
  let resp: Response;
  try {
    resp = await fetch(
      target,
      buildProviderFetchInit({ method: message.method, headers: message.headers, body: message.body }, signal)
    );
  } catch (error) {
    safePostMessage(port, { ok: false, error: errorText(error) });
    return;
  }
  // 响应头先落地：content 侧据此立刻合成 Response（status/ok 可用）并开始读流。
  safePostMessage(port, { ok: true, status: resp.status });
  const body = resp.body;
  if (!body) {
    safePostMessage(port, { ok: true, status: resp.status, done: true });
    return;
  }
  // 字节按到达顺序解码回吐：TextDecoder 的 stream 模式负责多字节字符跨分片
  //（半截字符缓冲到下一片，不吐替换字符），因此空分片跳过不占端口消息。
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      const chunk = decoder.decode(value, { stream: true });
      if (chunk) {
        safePostMessage(port, { ok: true, status: resp.status, chunk });
      }
    }
    const tail = decoder.decode();
    if (tail) {
      safePostMessage(port, { ok: true, status: resp.status, chunk: tail });
    }
  } catch (error) {
    // 中途失败（读流中断 / 断连 abort）：响应头已发，content 侧据此 error 掉读流。
    safePostMessage(port, { ok: false, error: errorText(error) });
    return;
  }
  safePostMessage(port, { ok: true, status: resp.status, done: true });
}
