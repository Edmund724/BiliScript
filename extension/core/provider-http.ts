// extension/core/provider-http.ts
// 平台请求代发：content script 的跨域 fetch 服从**网页** CORS——平台网关不
// 支持浏览器预检时（OPTIONS 返回 404 且无 Access-Control-Allow-*，如 sensenova），
// 带 Authorization 的 POST 一律以「无法连接：Failed to fetch」失败，与配置无关。
// 模型列表能跑通只是因为它在 SW 里发（SW fetch 只受 host 权限约束）；本模块让
// 探针的传输层走同一条路，探针的请求构造（思考档位 / token 上限规则）仍单源在
// ai/completion.ts，不因语境换路而分叉。
//
// 两端同文件（host-permissions.ts 的 requestProviderOrigins 与其跨语境代申请
// 同款组织）：
// - 接收端 handleProviderHttpRequest 在 SW 里跑（entry/background.ts 路由）；
// - 发送端 providerFetchViaBackground 在 content script 里跑，合成标准 Response。

import { sendRuntimeMessage } from "../shared/messaging.js";
import { withTimeout } from "../shared/error-helpers.js";
import { extractOriginFromBaseUrl, HOST_PERMISSION_HINT, hasHostPermission } from "./host-permissions.js";

export interface ProviderHttpRequestMessage {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface ProviderHttpRequestResult {
  ok: boolean;
  status?: number;
  body?: string;
  error?: string;
}

// ===== 接收端（SW 域）：代发一次请求 =====

// 代发通道只服务扩展自身的平台探针：URL 必须是 http(s) 且已获 host 权限，
// 否则拒绝——避免这条通道被当成任意 URL 的通用代理。
export async function handleProviderHttpRequest({
  url,
  method,
  headers,
  body
}: ProviderHttpRequestMessage): Promise<ProviderHttpRequestResult> {
  const target = String(url || "").trim();
  if (!extractOriginFromBaseUrl(target)) {
    return { ok: false, error: "请求地址不合法" };
  }
  if (!(await hasHostPermission(target))) {
    return { ok: false, error: HOST_PERMISSION_HINT };
  }
  try {
    const resp = await withTimeout(
      fetch(target, {
        method: String(method || "GET"),
        headers,
        body: body == null ? undefined : body
      }),
      15000,
      new Error("请求超时，请检查 baseUrl 或稍后重试")
    );
    // 响应体以文本回传（探针只读状态码与报错正文；流式响应不走本通道）
    return { ok: true, status: resp.status, body: await resp.text() };
  } catch (error) {
    return { ok: false, error: (error as Error | undefined)?.message || String(error) };
  }
}

// ===== 发送端（content script 域）：fetch 兼容实现 =====

// 供 ai/provider-test 与 ai/explain 作为 chatCompletion 的 fetchImpl 注入；只
// 覆盖两者用到的面——非流式一次性请求 + 响应 status/text/json（探针判
// response.ok 不读流；解释读 json）。流式请求（response.body.getReader）不适用。
//
// 取消语义：init.signal 中止时以 AbortError 名字拒绝，completion 据此转
// makeAbortedError（解释卡片换选区/关闭时的中止路径）。已在飞的 SW 请求无法
// 撤回（消息无取消通道），取消只作用于本端等待——请求会安静跑完并被丢弃。
export async function providerFetchViaBackground(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url || "");
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    headers[key] = value;
  });
  // 已中止时不发消息（中止意味着调用方已不关心结果，白跑一趟 SW 无意义）
  if (init?.signal?.aborted) {
    throw makeAbortError();
  }
  const resp = await raceWithAbort(
    sendRuntimeMessage({
      type: "provider-http",
      url,
      method: String(init?.method || "GET"),
      headers,
      body: typeof init?.body === "string" ? init.body : undefined
    }),
    init?.signal
  );
  if (!resp?.ok) {
    // 抛出的 message 经 completion 的网络错误包装后落到探针的
    //「无法连接：<message>」文案（与本地 fetch 抛错同形）。
    throw new Error(resp?.error || "请求失败");
  }
  return new Response(resp.body ?? "", { status: Number(resp.status) || 200 });
}

// 中止即拒绝（name="AbortError"，与浏览器 fetch 的中止形状一致）：已中止的
// signal 同步拒绝，进行中的挂监听、落定后摘除（不留悬挂监听）。
function raceWithAbort<T>(pending: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) {
    return pending;
  }
  if (signal.aborted) {
    return Promise.reject(makeAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(makeAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function makeAbortError(): Error {
  const error = new Error("请求已中止");
  error.name = "AbortError";
  return error;
}
