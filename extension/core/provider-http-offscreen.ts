// extension/core/provider-http-offscreen.ts
// 概览链的平台请求代发：content script 发起 → offscreen 文档执行
//（overview-offscreen-transport）。与 core/provider-http.ts（content → service
// worker 代发）同形、结果形状同源（ProviderHttpRequestResult），差别只在
// 「谁来发这一跳 + 超时/取消策略」：
// - SW 代发硬编码 15s 超时（provider-http.ts:56）且有 MV3 service worker 生命
//   周期上限，服务的是探针/选区解释这类短请求；
// - 概览是分钟级非流式请求（analysis-orchestrate 两条路径都不开 stream），宿主
//   取 offscreen（entry/offscreen.ts 头注：长 AI 请求的既定宿主）。扩展源 fetch
//   只受 host 权限约束，**不过网页 CORS 预检**——content 直发会撞网关预检白名单
//   （实测 ModelScope 的 Anthropic 端点拒 anthropic-version / x-api-key）。
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
// 不加超时：与改动前的 content 直发同口径（那时也没有），避免误杀长视频生成。

import { safePostMessage, sendRuntimeMessage } from "../shared/messaging.js";
import { extractOriginFromBaseUrl } from "./host-permissions.js";
import type { OffscreenProviderHttpPortMessage } from "../shared/messaging-protocol.js";
import type { ProviderHttpRequestResult } from "./provider-http.js";

// 宿主 connect 与 offscreen onConnect 同址判定用的端口名，禁止手写字面量。
export const PROVIDER_HTTP_OFFSCREEN_PORT_NAME = "provider-http-offscreen" as const;

// ===== 发送端（content script 域）：fetch 兼容实现 =====

// 供 ai/analysis-orchestrate 作为 chatCompletion 的 fetchImpl 注入；只覆盖概览
// 用到的面——非流式一次性请求 + 响应 status/text（adapter 非流式路径读 json，
// 由合成 Response 提供）。流式请求（response.body.getReader）不适用。
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
  const receipt = await waitForReceipt(
    port,
    { action: "provider-http", url, method: String(init?.method || "GET"), headers, body: typeof init?.body === "string" ? init.body : undefined },
    init?.signal
  );
  if (!receipt?.ok) {
    // 抛出的 message 经 completion 的网络错误包装后落到「网络错误：<message>」文案
    //（与本地 fetch 抛错同形）。
    throw new Error(receipt?.error || "请求失败");
  }
  return new Response(receipt.body ?? "", { status: Number(receipt.status) || 200 });
}

// 发一次请求并等第一条回执：回执 / 断连 / 中止三者先到先算，落定后断开端口并
// 摘掉中止监听（不留悬挂监听）。
function waitForReceipt(
  port: chrome.runtime.Port,
  payload: OffscreenProviderHttpPortMessage,
  signal?: AbortSignal | null
): Promise<ProviderHttpRequestResult> {
  return new Promise<ProviderHttpRequestResult>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      try {
        port.disconnect();
      } catch {
        // 已断连（回执前的断连路径）：忽略
      }
      settle();
    };
    const onAbort = (): void => finish(() => reject(makeAbortError()));

    port.onMessage.addListener((raw) => {
      finish(() => resolve(raw as ProviderHttpRequestResult));
    });
    port.onDisconnect.addListener(() =>
      finish(() => reject(new Error("代发通道已断开（offscreen 文档未就绪或被回收），请重试")))
    );
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
// 「收请求 → fetch → 回执」与「断连即 abort」。
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
      safePostMessage(port, await runProviderRequest(message, controller.signal));
    } finally {
      inflight.delete(controller);
    }
  });
}

// 一次代发的执行与结果归一（约定：一请求一端口；多条消息各自独立 controller）。
async function runProviderRequest(
  message: OffscreenProviderHttpPortMessage,
  signal: AbortSignal
): Promise<ProviderHttpRequestResult> {
  const target = String(message.url || "").trim();
  if (!extractOriginFromBaseUrl(target)) {
    return { ok: false, error: "请求地址不合法" };
  }
  try {
    const resp = await fetch(target, {
      method: String(message.method || "GET"),
      headers: message.headers,
      body: message.body == null ? undefined : message.body,
      signal
    });
    // 响应体以文本回传（概览只读正文；流式响应不走本通道）
    return { ok: true, status: resp.status, body: await resp.text() };
  } catch (error) {
    return { ok: false, error: (error as Error | undefined)?.message || String(error) };
  }
}
