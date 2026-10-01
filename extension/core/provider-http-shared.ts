// extension/core/provider-http-shared.ts
// 平台请求代发两通道的公共件叶：把「同契约且逐字同实现」的传输层零件收成单源
//（CONTEXT.md「平台请求代发」词条）。两通道：
// - SW 代发（core/provider-http.ts）：content 发送端 + SW 接收端；
// - offscreen 代发（core/provider-http-offscreen.ts）：content 发送端 + offscreen 接收端。
//
// 收在这里的 9 组件（抽叶前两侧逐字相同）：URL 提取 / Headers 归一 / 已中止短路
// 判据 / errorText / Response status 归一 / makeAbortError（search-chain 的第三份
// 同形实现一并收编）/ 接收端 URL 预检判据 / 接收端 fetch init 构造 / 出向载荷核心。
//
// 不抽的（同契约、不同机制或不同形状，留在各侧）：承载（runtime 消息 vs 端口）、
// 超时（SW 15s vs offscreen 无）、中止机制（raceWithAbort vs onAbort + 端口释放）、
// 回吐形态（一次性 { ok,status,body } vs 分块回吐 + Response 合成）。
//
// 叶子纪律：零运行时依赖——不 import 任何运行时模块（至多 import type），零
// chrome.* 触达。两个推论：
// - 判据类的校验器一律由调用方注入：接收端 URL 预检的 http(s)/origin 提取归
//   core/host-permissions.ts（它自身带运行时依赖），本叶只收「裁剪 + 判非法」的
//   判据骨架（resolveRequestTarget），回吐形状各侧自留；
// - 本叶被 SW 图、content 懒区与 offscreen 文档三处消费：任何一条运行时 import
//   都会把某个语境的依赖拖进另外两侧。结构不变量见
//   tests/core/provider-http-shared.test.ts 的「叶子纪律」用例。

// 出向载荷核心的四字段（信封键 type / action 由各侧自包，不进本叶）。
export interface ProviderRequestPayload {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

// 接收端 fetch init 的入参（两侧的请求形状：发件侧载荷）。
export interface ProviderFetchInitInput {
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
}

// URL 提取：RequestInfo | URL 三形态（字符串 / URL 实例 / Request 形）→ 目标 URL。
export function extractRequestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url || "");
}

// Headers 归一：键统一小写（浏览器 fetch 语义同款），值不动。
export function normalizeRequestHeaders(headers?: HeadersInit): Record<string, string> {
  const normalized: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    normalized[key] = value;
  });
  return normalized;
}

// 已中止短路判据：调用方已不关心结果时连一跳都不发。
export function isRequestAborted(signal?: AbortSignal | null): boolean {
  return signal?.aborted === true;
}

// 错误文案归一：Error 取 message，非 Error 走 String（落到探针的「无法连接：…」/
//「网络错误：…」包装里）。
export function errorText(error: unknown): string {
  return (error as Error | undefined)?.message || String(error);
}

// Response status 归一：缺省 / 0 / 非数一律回 200（合成的 Response 只接受 200–599
// 的整数）。
export function normalizeResponseStatus(status: unknown): number {
  return Number(status) || 200;
}

// 中止即拒绝（name="AbortError"，与浏览器 fetch 的中止形状一致）：completion 按
// name 识别中止并转 makeAbortedError，让调用方静默丢弃。
export function makeAbortError(): Error {
  const error = new Error("请求已中止");
  error.name = "AbortError";
  return error;
}

// 接收端 URL 预检判据（判据骨架单源，回吐形状各侧自留）：裁剪后交给注入的校验器
// ——合法回裁剪后的目标串，不合法回 null。校验器由调用方传
// core/host-permissions.ts 的 extractOriginFromBaseUrl（探针/概览两通道同判据：
// URL 必须是 http(s)，避免通道被当成任意 URL 的通用代理）。
export function resolveRequestTarget(url: unknown, isValidTarget: (target: string) => unknown): string | null {
  const target = String(url || "").trim();
  return isValidTarget(target) ? target : null;
}

// 接收端 fetch init 构造：signal 作参数传入（SW 侧是超时 controller，offscreen 侧
// 是端口断连 controller——机制不同，形状同源）。
export function buildProviderFetchInit(input: ProviderFetchInitInput, signal: AbortSignal): RequestInit {
  return {
    method: String(input.method || "GET"),
    headers: input.headers,
    body: input.body == null ? undefined : input.body,
    signal
  };
}

// 出向载荷核心：url / method（缺省 GET）/ headers（归一后）/ body（只认字符串，
// 其余形态不走本通道）。各侧以 { type: "provider-http", ...payload } 或
// { action: "provider-http", ...payload } 自包信封。
export function buildProviderRequestPayload(input: RequestInfo | URL, init?: RequestInit): ProviderRequestPayload {
  return {
    url: extractRequestUrl(input),
    method: String(init?.method || "GET"),
    headers: normalizeRequestHeaders(init?.headers),
    body: typeof init?.body === "string" ? init.body : undefined
  };
}
