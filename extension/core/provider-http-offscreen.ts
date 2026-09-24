// extension/core/provider-http-offscreen.ts
// 概览链的平台请求代发：content script 发起 → offscreen 文档执行
//（overview-offscreen-transport）。与 core/provider-http.ts（content → service
// worker 代发）同形，差别在「谁来发这一跳 + 超时/取消策略 + 回吐形态」：
// - SW 代发硬编码 15s 超时（provider-http.ts:56）且有 MV3 service worker 生命
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
//
// 不做 host 权限预检：offscreen 只有 chrome.runtime（无 chrome.permissions，见
// host-permissions.ts:101-103 对 content 侧的同款记录），与既有 offscreen 聊天链
//（completion.ts 默认 fetch）同口径；权限缺失仍表现为「网络错误：Failed to fetch」。
// URL 合法性预检保留，与 provider-http.ts 一致。
// 不加超时：与改动前的 content 直发同口径（那时也没有），避免误杀长视频生成；
// 流式本身不再有「整体超时」问题。

import { safePostMessage, sendRuntimeMessage } from "../shared/messaging.js";
import { extractOriginFromBaseUrl } from "./host-permissions.js";
import type {
  OffscreenProviderHttpPortMessage,
  OffscreenProviderHttpPortReply
} from "../shared/messaging-protocol.js";

// 宿主 connect 与 offscreen onConnect 同址判定用的端口名，禁止手写字面量。
export const PROVIDER_HTTP_OFFSCREEN_PORT_NAME = "provider-http-offscreen" as const;

// 端口断连（offscreen 文档未就绪 / 被回收）的可读文案：落定前拒绝、落定后
// error 掉读流共用——中途截断不能被当成成功。
const PORT_DISCONNECTED_MESSAGE = "代发通道已断开（offscreen 文档未就绪或被回收），请重试";

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
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url || "");
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    headers[key] = value;
  });
  // 已中止时不发消息（调用方已不关心结果，白跑一趟 offscreen 无意义）
  if (init?.signal?.aborted) {
    throw makeAbortError();
  }

  // 文档不存在时 connect 连上即断（chat/offscreen-ensure.ts 的既有事实），故先经
  // SW 幂等 ensure；ensure 失败不阻断 connect（对齐 reader/chat-tab-core 的
  // connectPort），由断连错误回执兜底。
  await sendRuntimeMessage({ type: "ensure-offscreen-chat" }).catch(() => null);

  const port = chrome.runtime.connect({ name: PROVIDER_HTTP_OFFSCREEN_PORT_NAME });
  return openProviderStream(
    port,
    {
      action: "provider-http",
      url,
      method: String(init?.method || "GET"),
      headers,
      body: typeof init?.body === "string" ? init.body : undefined
    },
    init?.signal
  );
}

// 打开一次代发请求：首条回吐（响应头 / 失败）落定 promise，其后的分片写入
// ReadableStream、done 关闭、中途失败 error 掉读流。端口在终态（关闭 / 出错 /
// 消费方放弃 / 中止）断开并摘掉中止监听，不留悬挂监听。
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

    const releasePort = (): void => {
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
        resolve(new Response(stream, { status: Number(reply.status) || 200 }));
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
        reject(new Error(PORT_DISCONNECTED_MESSAGE));
        return;
      }
      failStream(PORT_DISCONNECTED_MESSAGE);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    port.postMessage(payload);
  });
}

// 中止即拒绝（name="AbortError"，与浏览器 fetch 的中止形状一致）：completion 的
// fetch 失败分支按名字识别中止，转 makeAbortedError 让调用方静默丢弃。
function makeAbortError(): Error {
  const error = new Error("请求已中止");
  error.name = "AbortError";
  return error;
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
  const target = String(message.url || "").trim();
  if (!extractOriginFromBaseUrl(target)) {
    safePostMessage(port, { ok: false, error: "请求地址不合法" });
    return;
  }
  let resp: Response;
  try {
    resp = await fetch(target, {
      method: String(message.method || "GET"),
      headers: message.headers,
      body: message.body == null ? undefined : message.body,
      signal
    });
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

function errorText(error: unknown): string {
  return (error as Error | undefined)?.message || String(error);
}
