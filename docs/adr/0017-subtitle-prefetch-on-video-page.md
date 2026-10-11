# ADR-0017：字幕预抓取——进视频页即抓，替代完全懒加载

> 状态：有效

一键总结链路（点播放器 AI 键 → 进入阅读壳 chat 档 → 对话 tab 自动发送首条消息 → 发送闸等上下文就绪）里，最后一段等待此前的成因是结构性的：字幕抓取**完全懒加载**——只有打开文摘面板（`reader/lifecycle.ts` 的 `maybeRefreshReaderSubtitleInBackground`，且抓取前先 `waitForVideoMetadata`）、reader 模式 SPA 换片、或发送时 `subtitleFetchState === "idle"` 才起跑；而 `subtitle/fetcher.ts` 的 `refreshClip` 把 `forceRefresh` 硬编码为 `true`，`subtitle/body.ts` 的 `loadTrackBody` 见此直接跳过缓存——**热缓存缩短不了任何一条自动路径**，字幕列表请求与字幕体 CDN 请求每轮都走网络。新视频页秒点 AI 键，抓取必然还没起跑，用户观感是「卡了但没有任何提示」。本篇记的裁决是：把抓取的起跑点从用户动作**前移**到进页，并给这段不可避免的等待补上可见反馈。

## 决定

1. **预抓取：所有 B 站视频页，content script 载入即起跑 + SPA 换片起跑，无设置开关。**

    两个起跑点分别是 `entry/content.ts` 的 `init()`（支持的视频页；URL watcher 首次载入不派发 `biliscript:urlchange`，首载必须自己起跑）与 `entry/message-handler.ts` 的 plain-page URL 变化分支（原分支只有一句引导「刷新抓取」按钮的死文案——该按钮已随经典侧栏壳删除，这句同时被替换）。不加设置项：仓里没有可借用的总开关（Script 按钮本就无设置门，唯一相关设置是 AI 键自己的开关），为一件默认行为单开设置项是设置面通胀。

2. **起跑时序与复用管线：`waitForVideoMetadata()` → `ensureSummarizeChain()` → `requestSubtitleRefresh()`，复用的是 `refreshClip` 同一条事务。**

    先等元数据不是可选优化：`resolveClipMeta` 的时长守卫拿不到 `video.duration` 直接抛错，`waitForVideoMetadata`（150ms 轮询、5s 上限）与既有两条自动路径同一时机语义。不为预抓取写「只列轨 + 抓 body、不动热评与通知」的轻量分支：省一次热评请求，造一条会与正链路漂移的第二管线。失败静默（`logWarn`），不写 plain page 的状态行——面板没开，任何页面内提示都是打扰；用户后续动作（打开面板 / 发送）本就会重试。

3. **「有字幕才抓」的落地 = 字幕列表请求兼作可用性探测；无字幕视频不进入 ASR。**

    不存在比 `x/player/wbi/v2`（`bilibili/gateway.ts` 的 `fetchSubtitleBundleInner`）更早的可用性信号：全仓没有字幕 DOM 控件探测，`__INITIAL_STATE__` 只被读 aid 与分P。所以「有字幕的视频进页就抓」只能实现为「进页就发列表请求，有轨（`subtitleUrl` 非空）才抓 body」。无字幕视频只多这一次列表请求，**不触发 ASR 转写**——分钟级到小时级的转写不是进页该付的代价，ASR 保持用户触发（本次范围外，其反馈链路已存在）。

4. **去重守卫「字幕在手或在飞」替代原「在手」判定。**

    `reader/reader-bus.ts` 的 `requestSubtitleRefresh` 是无在飞去重的纯转发：并发起跑会各起一轮 `refreshClip`（各推进 `fetchRunId`，旧轮提交时被 `STALE_RUN` 顶掉），结果正确但请求翻倍。预抓取把起跑点前移后，「秒点 AI 键 / 秒开面板」与预抓取撞车的窗口从罕见变成常见，因此守卫从 `hasSubtitleForCurrentVideo`（body 非空 + bvid 匹配）扩为 `isSubtitleInHandOrInFlight`（再加 `fetchState ∈ {loading, ready}`）。reader-open 分支不经守卫——`resetClipState` 之后守卫恒 false，换视频必须重抓。

5. **失败路径：预抓失败留 `error` 态，发送侧必须自己会重试与拦截。**

    这是补一个既有洞：`isNoSubtitleEmptyContext` 只拦 `empty`，G3 起跑门跳过一切非 `idle`——`error` 态下点 AI 键会放行空字幕上下文，模型凭标题 + 热评编造「无公开字幕」的总结（该洞在懒加载时代就能复现，预抓取只是让 `error` 变常见）。裁决：起跑门扩为「`idle` 或 `error` 才起跑」（瞬时网络失败重试一次）；仍失败则 G6 拦截扩到 `error`，`GateOutcome` 新增 kind `fetch-error`（消费方 `chat-runtime` 只判 `pass`，加 kind 不波及调用面），文案「字幕抓取失败，请稍后重试。」——明确失败，不发空上下文。

6. **等待反馈三件：通知条即时显示 + spinner；等待期发送键禁用；字幕就绪 kick 等待闸。**

    通知条的显示时点从「轮询首拍见 pending」前移到「闸判定要等待即显示」（G3 之后 clip 为 `loading` 且 body 空即显示，ready/empty 不显示——避免闪现），并加 spinner。等待期间发送键禁用、输入框 placeholder 换「正在抓取字幕…」但**保持可编辑**（可选中复制、可为下一条消息改稿；本次发送以受理时捕获的文本为准，等待期内的修改不进入本条）。尾窗：字幕落定经 `subtitle/commit.ts` 的接受事务发布 `subtitle-ready` 相位（`shared/subtitle-status-bus.ts`），发送闸的相位订阅据此 `kick` 等待闸——消灭「字幕已就绪还空等最多一个 4s 轮询拍」。该相位**只驱动 chat 等待闸，不驱动任何渲染**。

## 被否决的备选

- **hover / 聚焦 AI 键预取**：浪费近零，但救不了「秒点」——正是要消灭的那个窗口。
- **轻量预抓分支**（只列轨 + body，不动热评 / 通知）：省一次热评请求，造第二条会漂移的管线（决定 2）。
- **无字幕视频进页即起 ASR**：分钟级转写不是进页该付的代价，且反馈量级完全不同（决定 3）。
- **预抓取加设置开关**：无可借用的总开关；为默认行为加设置项是设置面通胀（决定 1）。
- **起跑门只堵 `error` 不即时显示通知**：反馈仍然迟到，「卡住不动」的观感只治了一半（决定 6）。

## 后果（必须一并接受的代价）

- **每个视频页多一次 view API + 一次 player v2 列表请求，有字幕再加字幕体 + 热评。** 这是明确接受的后台流量代价；若 B 站签名接口因此触限流，重开条件见下。
- `error` 态从罕见到常见，发送闸必须自带重试与拦截（决定 5）——`GateOutcome` 从两个 kind 变三个。
- `isSubtitleInHandOrInFlight` 的语义是「在手或在飞」：在飞即跳过面板打开触发的抓取。代价是「抓取进行中打开面板」不再触发第二轮（正确性不变：抓取落定后 `reconcileReaderAfterSubtitleFetch` 按 state 对账重渲），但若未来出现「抓取永远不落定」的悬挂态，面板打开不再是一个新的起跑点——那时该修的是悬挂态本身。
- plain-page 的 URL 变化分支从「写死文案」变为起跑预抓取；`resetClipState` 里引导已删除按钮的同款死文案一并替换。SPA 换片最坏晚一个 1000ms 轮询拍起跑（url-watcher 兜底），可接受。
- `subtitle-status-bus` 的相位集合从 3 个变 4 个；新增订阅方必须记住它是**状态**不是事件流（迟到订阅方读 `getSubtitleStatusPhase()` 恢复，不会补收广播）。
- 首次预抓取会触发 `ensureSummarizeChain()` 与 reader 域两个动态 chunk 的装载（均不进 content 静态图，一次性成本）。

## 重开条件

- **预抓取触发 B 站接口限流**：回到 hover 预取或加设置开关，二选一。
- **出现比 player v2 更早的稳定可用性信号**（如官方字幕控件可无歧义探测）：列表请求可从「必发」降为「按信号发」。
- **副轨 / 多 track 需要不同的起跑时机**：本篇的守卫与复用管线只描述主轨；副轨装载保持主轨就绪后并行装载的现状。
