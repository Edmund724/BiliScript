# 概览链的平台请求改由 offscreen 代发（content 发起、offscreen 执行）

> 状态：有效｜输出预算部分已由 ADR-0012 收口

概览是唯一还在 **bilibili 页面源**直发的 AI 链（`reader/overview.ts` 动态 import `ai/analysis.js`，`analysis-orchestrate` 不传 `fetchImpl` → `completion.ts` 的 `globalThis.fetch`），因此要先过平台网关的 CORS 预检，而预检白名单是平台单方面定的。2026-09-24 实测（OPTIONS `https://api-inference.modelscope.cn/v1/messages`，Origin `https://www.bilibili.com`，阿里云网关）：`Access-Control-Allow-Headers` 固定为 `…,Content-Type,Range,Authorization`，**不含 `x-api-key` 与 `anthropic-version`**——Anthropic 适配器必须发这两个头，于是概览在 ModelScope 的 Anthropic 端点上必然失败（`net::ERR_FAILED` / Failed to fetch），而对话（offscreen 直发）、探针/选区解释/联网搜索（SW 代发）都因扩展源免 CORS 而正常。

**决策**：概览链的每一次平台请求经 **content 发起 → offscreen 文档执行**的代发通道（`core/provider-http-offscreen.ts`，端口 `provider-http-offscreen`，一请求一端口，两端同文件）；一律代发，不按协议分叉。

**不变式（硬）**：概览的请求不得回落页面源直发——`analysis-orchestrate` 的 `requestValidatedPart` 把 `fetchImpl` 钉在 `providerFetchViaOffscreen`（单次路径、空正文重试、分段路径共用该函数，一处覆盖；回归由 `tests/ai/analysis.test.ts` 的逐调用断言看守）。两条代发通道按请求时长分工：

- **SW 代发**（`core/provider-http.ts`）：探针 / 选区解释 / 联网搜索三链；硬编码 15s 超时、受 MV3 service worker 生命周期约束，只服务短请求。
- **offscreen 代发**（`core/provider-http-offscreen.ts`）：概览链；无超时、端口断连即 abort，服务分钟级长请求（2026-09-24 修订后为流式分块回吐，见文末）。

## 与既有决议的关系

原 `protocol-vocab-leaf` 议题的两条决议「offscreen 链改直发被否决」「不动各链路的 fetch 发起方」在本条上**被显式推翻**：那两条针对的是「offscreen 客户端自己直发平台」与「为探针/模型列表改道 ensure-offscreen」（后者换取 2-7KB 体积、每条消息多一跳，收益风险倒挂，仍被否决）。概览的场景不同——请求时长以分钟计，SW 代发的 15s 超时与 SW 生命周期两条都不可用，而 offscreen 本就是仓库既定的长 AI 请求宿主（`entry/offscreen.ts` 头注）。

## 考虑过的方案

- **SW 代发放宽超时**（否决）：15s 是探针语义的一部分，且分钟级请求挂在 service worker 上会撞 MV3 生命周期上限（Chrome 只在事件 handler 的 promise 挂起期限内保活），把请求正确性押在平台保活行为上不可接受。
- **改鉴权头形状适配平台**（否决）：ModelScope 的放行表同时不含 `x-api-key`，等于为单个平台定制一份头；且换 `Authorization: Bearer` 是否被该端点接受需重测，治不了同类网关（固定白名单的中转站是一整类）。
- **失败回落直发**（否决）：造第二条路径，等于把「哪条路会成」的不确定性留给运行时。
- **content 直发 + 声明式网络规则**（否决）：`declarativeNetRequest` 能改请求头，但改不了浏览器侧的 CORS 判定——预检不过，请求根本发不出去。

## 后果

- 概览请求的发起方从 content 变为 offscreen，message 载荷经端口多一跳（请求体最大 200k 字符级，端口结构化克隆可承受）。
- **已知限制（有意接受）**：offscreen 侧不做 host 权限预检（offscreen 只有 `chrome.runtime`，无 `chrome.permissions`），权限缺失仍表现为「网络错误：Failed to fetch」；通道不设超时（与改动前的直发同口径）。平台侧完全不发字节时面板停在生成中，**出口是生成中状态条的「取消」键**（2026-09-29 修订补入；此前无面板内出口——`重试` 只在失败/部分失败条上，关阅读模式又不取消在飞请求）；首字节等待超过 10s 状态条改显等待计时但不中断请求。
- offscreen 文档在概览期间常驻（ASR 终态自关判定已把「有在飞代发端口」计入保留条件），与既有聊天链同量级。
- 概览请求不再受**任何**平台网关预检白名单影响；协议适配器（`anthropic.ts` 的 `x-api-key` / `anthropic-version`）维持原样，不为单个平台定制。

## 2026-09-24 修订：概览调用改流式，代发端口改分块回吐

同日实测暴露了上方「服务分钟级非流式请求」这条口径的后果（ModelScope + `deepseek-ai/DeepSeek-V4.1-Flash`，Anthropic 协议）：

- 长视频（字幕 124,505 字，`max_tokens` 8192，非流式）：网关把请求挂了约 19 分钟后回 `HTTP 500 {"detail":"Request timed out."}`。
- 短视频（字幕约 700 字，`max_tokens` 2048 → 空正文重试 4096，非流式）：每次约 50 秒返回 200 但正文为空串（该模型在 ModelScope 上默认思考、思考计入 `max_tokens`；Anthropic 线上「关思考」表现为不发字段，于是平台默认生效），面板报「模型没有返回正文（输出预算可能被思考过程占满）」。
- 同端点、同模型、同一份 12.4 万字素材，**对话链走 SSE 流式正常**。

**修订**：概览的模型调用（单发与分段两条路径共用的 `requestValidatedPart`）改 `stream: true`，正文从 token 事件聚合、`onStreamReset` 归零（避免读流中断重试的两代流拼接）；代发端口改为**一律分块回吐**——响应头 `{ok,status}` → 正文分片 `{ok,chunk}` → `{done:true}`，中途失败只回 `{ok:false,error}`，content 侧据此合成带 `ReadableStream` body 的 `Response`（截断不得当作成功）。于是：

- 非流式长请求的网关**整体超时**不再触发（连接持续有字节流动）；
- 单发路径的正文增量经 `onProgress` 进面板（「正在生成概览…（已接收 N 字）」/「模型正在思考…」，1s 节流）；分段路径的「正在整理第 x/y 段」不受影响。

上方「平台侧挂起时面板停在正在生成概览…」**有意保留**：通道仍不设超时（流式下没有整体超时问题，但网关完全不发字节时仍会静默等待）。本轮**不动** `max_tokens` 预算（`estimateOutputTokens` 的 ceiling 与空正文重试的加倍上限）——思考吃预算导致的空正文是同一根因的第二个出口，留作独立议题（**已由 [ADR-0012](0012-output-budget-wide-default-retreat-learned-cap.md) 收口**：封顶与协议兜底同源、超上限退回保守值、会话内记住平台上限，概览链补截断重跑）。

## 修订（2026-09-29：生成中补取消与等待计时，通道仍不设超时）

「后果」原句「用户可用重试或关闭页面收场」与事实不符，已就地改写：`重试` 只在失败 / 部分失败条上，生成中没有任何按钮，关阅读模式又不取消在飞请求——面板内没有出口。本轮（`reader/overview.ts`）：

- 生成中状态条加「取消」键：abort 本通道既有的 signal 链（content 断端口 → offscreen abort 在飞 fetch，`core/provider-http-offscreen.ts`），转 `cancelled` 态并给出「重新生成」（走 forceRefresh，段缓存照常复用）。**不落回 idle**：idle 会被「切到概览 tab 即自动生成」立即重跑一次刚被取消的请求，取消等于无效。
- 首字节前等待超 10s，状态条改显「正在等待平台响应…（已等待 N 秒）」，每秒**就地刷新文案节点**而不重建整块 DOM（重试场景屏上已有旧产物的章节/金句，重建会丢滚动位置与选区）；一旦收到管线进度就交回管线文案，不叠加计时。
- **仍不设硬超时**：等待计时只提示、不中断。中途无新数据的提示与首字节阈值定值，留到有首字节实测分布之后再定（现有实测只有「非流式 19 分钟后 500 Request timed out」，流式首字节无数据）。
- 关闭阅读模式仍不取消在飞请求（不变式未变）。中止句柄按视频身份保活到编排落定，重开同视频时与按 finalKey 复用的编排 promise 一起复用——否则重开后的取消键取消的是一个没人听的信号。
- 旧编排在取消后被新一轮取代时，迟到回执按 slot 身份丢弃（与既有 `generatedFor` 过期丢弃同一处守卫），不覆盖新一轮状态。
