# BiliScript 上下文

BiliScript（B 站视频文摘）浏览器扩展的领域词表。统一代码、讨论、issue 里的命名，避免同义词漂移。

## 术语

### 内容与载体

**视频**:
B 站上的一条视频，由 `bvid` 与分P `cid` 唯一标识。
代码名：`state.clip` / `bvid` / `bilibili/video-id-shared.js`
_Avoid_: 稿件、作品

**分P**:
一个视频下的多段内容单元，以 `cid` 标识。
代码名：`pageIndex` / `pageTitle` / `pickPageFromPages`（reader/page-context.js）——自有抽象沿用 B 站 API 的 page 词根，Avoid 只约束中文行文与新增抽象。
_Avoid_: Part、页、集数

**字幕**:
视频的一条字幕轨；整理后每条字幕是 `{from, to, content}`（秒级时间戳 + 文本）。无字幕轨时经语音识别（ASR）生成，仍是字幕。
代码名：`subtitleBody` / `subtitle` / `subtitle/fetcher.js` / `subtitleLang` / `subtitleList` / `updateReadingSubtitleTailSpacer` / `ReadingSubtitleItem` / `data-biliscript-reader-subtitle-visible`——字幕列表常驻 文摘面板「字幕」标签，transcript 词根已对齐字幕。
_Avoid_: 转录、transcript

**章节**:
视频自带的分段 `{from, to, title}`。
代码名：`chapters` / `normalizeChapters`
_Avoid_: 目录、分段、集

**时刻文本**:
视频时间「秒 ↔ 时刻文本」的唯一换算约定：展示格式统一不补零（`2:30`，小时位同理），解析容错与是否带小时段（withHours 政策）单源收口。提示词教学格式与 UI 渲染格式必须出自同一实现，禁止两套约定靠注释对齐。
代码名：`formatAnalysisClock` / `formatCompactTimestamp`（统一后退役并入时刻文本单源模块）/ `parseTimestampSeconds`
_Avoid_: 补零/不补零双约定并存、各处手写 withHours 启发式、第三套解析器

**字幕接受**:
一段字幕成为当前视频生效字幕的唯一事务：稳定排序（from 升序，读路径二分依赖）→ 写 state → `fetchState="ready"` → 清 `noSubtitleReason` → 刷新派生内容（Markdown/SRT/TXT）→ 通知 reader（`subtitle-ready`，emit 单点在事务内——调用方补发通知或直调渲染即双渲染）。四个写入点（CC 缓存命中/网络新抓/ASR 缓存命中/转写完成）与无字幕出口（逆事务：清空 + `empty` + 原因）都必须经此收口，禁止手抄序列。事务带可选 runId 代次自检（M23 runId 协调）：调用方传入自己的抓取代次，写 state 前与 `fetchRunId` 比对，代次已被 URL 变化编排递增/新一轮抓取推进则抛 STALE_RUN 让位——旧视频字幕不得写进已重置的 state。递增单点在 URL 变化编排（`handleUrlChange` 感知 clip 签名变化处）同步先行，早于 reset 与新视频 refreshClip 的动态装载链；未传 runId（ASR 收尾路径，自有 isStale 视频键门控）不校验。
代码名：`subtitle/commit.js`（接受与无字幕出口的唯一入口；DOM 渲染回调由 fetcher 注入，保持静态图无环）/ `runId` 自检（`AcceptSubtitleArgs.runId` / `CommitNoSubtitleArgs.runId`）
_Avoid_: 落账、提交、写入字幕、手抄接受序列、reset 内递增 fetchRunId（须同步先行于装载链，否则新视频抓取可能被迟到的递增误杀）

**原始字幕缓存**:
按时间戳/章节切好的原始字幕段，可随取随用；仅在压缩摘要之外的细节追问时按需检索注入。宿主注记（arch-review-2026-09/05）：storage 真实宿主是 SW，offscreen（Map-Reduce/追问链）经 `segment-cache` 消息族读写——offscreen 侧唯一出站点 `ai/segment-cache-proxy.ts`，SW 端 `ai/segment-cache-handler.ts` 直调 segment-cache 单源（键位装配在 SW 完成）。写单元注记（段缓存写聚合 ticket 重构）：写路径是 run-scoped 写会话（`createSegmentCacheWriteSession`，一次编排运行一个、跨溢出重跑两轮共用），saveRaw 只入会话缓冲、不声明 per-op 成败（返回 void），随 saveSummary 合成 `save-summary-raw` 合并 op（写路径 3N→2N，SW 侧每段 2get+4set→1get+3set，两族索引/manifest 打包一次 set）；会话收尾统一 close 落盘残留 raw（正常 done / 停止 abort / idle 超时 / 异常上抛都经编排收尾统一 close），port 断开 / offscreen 自关不 close、会话随文档销毁废弃。失败通道 = awaited saveSummary 的 `{ok:false}` + close 的 onWriteError（编排层去重后只提示一次）。出站点载荷按 SW 键位字段投影收窄（context 只带 bvid/cid/字幕轨三元组；load-stored-raw 另带 chapters 供命中段预过滤），整份 AiContext 的 subtitleBody 不再过线。
代码名：`ai/segment-cache.js`（`biliscript_lvs_raw_*`）/ `ai/raw-retrieval.js`
_Avoid_: 长记忆、向量库

**缓存宿主**:
缓存族落在哪个进程的判据：由**消费方进程的 storage 可达性**决定，与缓存数据的重要性/大小无关。offscreen 文档没有 chrome.storage（平台只开放 chrome.runtime）→ offscreen 消费的缓存族一律 SW 宿主、经消息族读写；content/reader 有完整 storage 权限 → 消费处直写。四族现状对照：字幕缓存（`biliscript_subtitle_cache_*`）content 直写；原始字幕缓存/分段小结（`biliscript_lvs_*`）SW 宿主、offscreen 经 `segment-cache` 消息族（机制见「原始字幕缓存」）；概览缓存（按 bvid/cid/轨/签名落盘）content 直写；查询缓存（`biliscript_search_cache`）SW 宿主，offscreen 与 content 都经 `search-cache` 消息族读写。淘汰/LRU 布局与宿主判据正交，单源 `core/cache-lru.js` 族工厂（两进程共用同一纯叶）。本判据只管 chrome.storage.local 上的可淘汰缓存族；provider/设置存储（sync+local 分层）不受管辖（见「激活平台」「设置快照」）。
代码名：`core/cache-lru.js`（族工厂）/ `ai/segment-cache-proxy.js`（SW 宿主族的 offscreen 出站点，读半边 `segmentCacheProxy` + 写会话工厂 `createSegmentCacheWriteSession`）/ `subtitle/cache.js` / `ai/analysis-orchestrate.js`（content 直写两族）
_Avoid_: 凭缓存数据重要性/大小选宿主、offscreen 侧引入 storage 垫片

**文摘面板**:
阅读模式的唯一呈现形态：右栏固定定位面板，三标签（字幕 / 概览 / AI 对话）。不接管页面、不搬播放器；贴栏 rect 由锚点链决定，失败逐级降级（贴播放器 → 居中浮层）。ADR-0006。当前激活标签的唯一状态位在 `reader/state.ts`（DOM 三通道只是投影，写手单点 = `reader/script-tab-activation.ts` 的 `activateScriptTab`：状态位 → 持久化写穿 → `project-tab` 投影命令 → 二级激活，同处一条串行队列；壳侧 `setReaderScriptTab` 只做 DOM 投影）。
代码名：`#biliscript-reading-view` / `#biliscript-reading-script-panel` / `reader/script-host.ts` / `--biliscript-script-*` / `data-biliscript-script-float` / `readingActiveScriptTab` / `activateScriptTab` / `project-tab` / `reportTabIntent`
口语同义词：侧边栏（仅兼容用户说法；README 统一为文摘阅读面板，代码与 ADR 沿用 文摘面板）
_Avoid_: 阅读视图整页接管、播放器槽、rail/stage、剪枝、反解 DOM class 取当前标签

**右栏锚点**:
文摘面板贴栏定位的参考节点，按优先级串行试探的右栏候选链（新版 `.right-container-inner` 起，旧版 `#reco_list` 止），有效判据 = 存在 + 宽度 ≥ 280 + 未滚出视口。唯一随 B 站改版会坏的面板依赖；坏的表现是降级跑位，不是功能失效。
代码名：`ANCHOR_SELECTORS` / `findScriptAnchor`（reader/script-host.ts）
_Avoid_: 宿主、播放器宿主（那是 video-probe 的概念）

**阅读壳**:
文摘面板进入与退出阅读形态的唯一事务。按意图三档（open 进入 / restore 恢复 / chat 进对话）执行「先挂阅读样式表、再翻 body/html 属性」的无闪变时序，含摘除播放器快捷按钮、suppress 抑制窗口与 restore 档的 shell 完好性自查；退出为逆事务。生命周期由四态状态机收口（closed/entering/open/exiting，单源 `core/state.ts` 的 `transitionReaderShell`，`readingViewOpen` 是其派生投影）：进入与退出事务同队列串行（entering 中收到 close 顺延），失败回退合法边（entering→closed / exiting→open）。全部入口（按钮/编排触发、恢复、进对话）与关闭出口都必须经此收口，禁止手抄序列。
代码名：`enterReaderShell` / `exitReaderShell`（intent 三档）/ `reader/shell.ts`；承载消息 `reader-enter` / `reader-restore` / `reader-close`——页面内 文摘按钮与工具栏图标点击共用同一 `reader-enter` 事务，无 popup / Side Panel 入口。
_Avoid_: popup- 词根消息名、进入阅读模式手抄序列

**播放器快捷按钮**:
播放器控制条上唤起 AI 快捷追问的按钮（player-ai 链）。宿主门（`.bpx-player-container` 优先链）过即挂正式位，不等字幕控件——字幕控件门自 2026-09 起软化为校准信号：控件首次就绪只触发一次性位置复校（防控制条水合改变容器几何导致漂移），复校只跑一次；挂早被 B 站水合冲掉走现有自愈链（容器 observer → rAF 快车道 → 退避兜底）重挂，不新增降级位（用户不接受按钮位置跳变）。
代码名：`player-ai.ts` / `findPlayerAiQuickActionHost` / `findPlayerSubtitleControlNode`（校准探针，非定位/行为依赖）/ `playerAiSubtitleControlCalibrated`
_Avoid_: 把字幕控件门当硬门回退、降级位先挂后迁移

**主题族**:
整套色板的归属：`bilibili`（B 站原生配色）| `flyme`（Flyme 设计语言浅色系）。与明暗模式正交的第二轴，在设置抽屉里手选。存量三值制里写进 `readerTheme` 的 `"flyme"` 由归一化迁移到此键。
代码名：`readerThemeFamily`（默认 `bilibili`）/ `readingThemeFamily` / `setThemeFamily`
_Avoid_: 把 `readerTheme` 当主题族、用「主题」单字同时指两轴

**明暗模式**:
浅色 / 深色两档：`light` | `dark`。header 主题按钮切换与系统跟随（从未手选时按 `prefers-color-scheme` 定初始档）只驱动它，不换主题族。
代码名：`readerTheme` / `normalizeReaderTheme` / `readingTheme` / `setTheme`
_Avoid_: 用 `readerTheme` 表示主题族、把 `flyme` 当第三档明暗

### 总结流程

**成稿笔记**:
AI 总结阶梯（ADR-0001）的内部中间产物——素材在预算内一次成稿、超预算经「分段 + 归并」后成稿的完整 Markdown 总结，用于追问时的常驻压缩上下文，不是面向用户的笔记功能。产品已无笔记功能（原 Frontmatter 笔记导出 2026-09 删除）；`notes/` 目录仅承担字幕导出渲染（Markdown/SRT/TXT）。
代码名：`ai/followup-context.js` 的 `hasFinalNote`（判定已成稿）/ `notes/render.js` 的 `buildMarkdown`（导出渲染）
_Avoid_: 总结、摘要、回答；也不要再引入「保存笔记 / 笔记库」这类用户功能命名

**音频分片**:
长音频按固定时长切出的上传单元（5 分钟/片，WAV）。与「分段小结」互不相干：分片是 ASR 的上传/转写单元，小结是字幕的压缩产物。
代码名：`asr/chunker.js` / `decideChunks` / `ASR_MSG_CHUNK_RESULT` / `mergeChunkResults`
_Avoid_: 与「分段小结」混用

**分段小结**:
把一段字幕忠实压缩成的中间产物，保留事实、时间点与前后关系，供归并与追问检索。（与「音频分片」区分：分片是上传单元，小结是压缩产物。）
代码名：`buildSegmentPrompt` / `formatSegmentItem` / `ai/segment-cache.js`（`biliscript_lvs_summary_*`）/ `SEGMENT_SUMMARY_CHARS`
_Avoid_: 小总结、chunk 摘要

**归并**:
把多段小结按下一条「素材预算」合并成更接近成稿材料的层叠操作。
代码名：`ai/reduce.js` / `shouldReduce` / `buildReduceGroups` / `buildReducePrompt` / `reduceSummaries` / `REDUCE_GROUP_INPUT_CHARS` / `REDUCE_TRIGGER_CHARS`——归并 = Map-Reduce 的 Reduce 阶段（ADR-0001）。
_Avoid_: 合并、merge

**素材预算**:
单次请求允许塞给模型的原视频文字量上限。溢出（err.overflow）时的编排级兜底：入口侧预算（单段输入 / 归并组输入）按 0.5 倍收紧整轮重跑一次，仍溢出才报错；段小结缓存 key 按预算档隔离（`_b50` 后缀），段边界漂移不串内容。
代码名：`ai/budgeter.js`（`MATERIAL_BUDGET_CHARS`）/ `buildMaterial` / `buildBudgetPlan` 的 options / `OVERFLOW_RETRY_BUDGET_SCALE`
_Avoid_: 窗口、配额、限额

**阶梯**:
素材在预算内直接一次成稿；超出预算才进入「分段 + 归并」。分派实现在 ai/ladder.js。
代码名：`ai/ladder.js` / `runLadderChat`
_Avoid_: 降级、回退

**概览**:
文摘面板三大标签之一（对应 YouTube Digest 的 Overview）：章节列表（逐章带简介）+ 金句。分章来源优先级：视频简介/热门评论里的时间戳目录 > B 站官方章节（`view_points`）> AI 自由分章（前两者都没有时，最后一章须过 75% 后段门槛）。前两者按目录照抄标题与边界，模型只补每章简介。
代码名：`ai/analysis.js`（`runOverviewAnalysis`）/ `shared/chapter-outline.js`（`resolveChapterSource`）
_Avoid_: 总览

**金句**:
AI 从字幕中挑选的佳句，收录在概览页章节下方，带时间戳。
_Avoid_: 名句、摘抄

**压缩摘要**:
追问时常驻上下文的有界形式（分段小结 + 成稿笔记），取代把原始字幕整篇重发。
代码名：`compressedSummaryMarkdown` / `buildCompressedSummary` / `ai/followup-context.js`
_Avoid_: 缓存摘要、记忆、上下文摘要

### 平台与密钥

**激活平台**:
「当前选中的 AI 平台 + 其 API Key」的唯一解析：providerId 给定 = 精确匹配（AI 对话链），缺省 = 设置 defaultModel → 首个启用平台回落（概览/选区解释链）。requiresKey 平台密钥缺失在解析期即报可读错误。概览、选区解释、AI 对话三条链共用一条 `resolve-ai-provider` 单趟消息，禁止再手抄 providers-list + provider-key 的多趟解析链。
代码名：`resolveActiveProvider`（content 侧消费壳）/ `resolveProviderWithKey`（offscreen 消费壳）/ `createAiResolvedProviderHandler`（SW 处理器，策略单源）
_Avoid_: 手抄多趟解析链、第二份解析实现

**平台协议**:
AI 平台对外说话用的线格式族，开放注册表（spec multi-protocol-ai，落地两种）：OpenAI compatible（chat completions）、Anthropic（messages）。每个 AI 平台记录带一个协议字段，存量记录缺省读作 OpenAI compatible。
代码名：`AiProtocol`（`"openai" | "anthropic"`）/ provider 的 `protocol` 字段；唯一读路径 `resolveAdapter`（`PROTOCOL_ADAPTERS` 注册表），缺字段/未知值兜底 openai，不得旁路直读 protocol 字段
_Avoid_: API 格式、接口类型；与扩展内部消息协议（messaging-protocol 词根）混用；把第四种协议（Gemini 等）的实现纳入本次范围

**协议适配器**:
把平台协议差异收敛在唯一 fetch 点一侧的翻译单元：编排层（阶梯/归并/工具循环）只面对统一的 `ChatMessage[]` 入参与 `StreamChatEvent` 出参，SSE 事件差异（Anthropic 的 message_start/content_block_delta）、tool use 双向翻译（编排层保持 OpenAI tools 风格）、探针（probe）、错误归一化（归一为现有错误形状并前缀协议名）都在适配器内。一个协议一个适配器。合法值清单拆在词表叶（纯叶零依赖）：词表消费者（normalize 校验、设置 UI）只 import 词表叶，SW 静态图与协议栈脱钩；分发表键以 `Record<AiProtocol, ...>` 强制覆盖词表叶，单源；唯一读路径 `resolveAdapter` 不变。
代码名：`ProtocolAdapter` / `PROTOCOL_ADAPTERS` 注册表 / `AI_PROTOCOLS` 词表叶（`protocol-vocab.ts`）
_Avoid_: 每条协议复制编排链、编排层感知协议

**平台怪癖词表**:
协议线格式层面的平台差异（请求体字段名、思考词汇、消息历史要求、会话头、流式哨兵）的**唯一主人**：稳定键 + 语义 + 适用协议 + 线格式取值，借 pi-ai `compat` 的命名与语义设计、**不借其数据**（ADR-0009）。纯叶零 import（只 type-import 词表叶 `AiProtocol`），不拖入分发表与 adapters。「该平台开哪些怪癖」在 `PLATFORM_QUIRKS` 一处声明；「该协议 adapter 接纳哪些怪癖」由 `ProtocolAdapter.consumes` 自陈（「接纳」= 该协议线格式栈对怪癖负责，兑现形态三种：adapter 内实现 / 卫星模块 thinking-profiles·preset-headers 实现 / 显式登记的有意缺口），两侧由 `validateCompatVocab` 在测试期对账——声明了没人接纳（死声明）与接纳了没声明（漏登记）都报错；平台侧另查平台 id 是真实 AI 预设、怪癖绑定的协议该平台登记了端点（否则是构造性死声明）。**校验不进运行时**。对账只到「端点存不存在」，**不按记录当前选的协议收窄**——设置 UI 的协议下拉对任何预设都无条件渲染两种协议，绑在另一条通道上的怪癖只是不生效、不是违规。模型血统事实（哪档发什么字段）不在词表：那是 `thinking-profiles.ts` 的单一事实源，词表只登记它与协议栈之间的缝隙。
代码名：`COMPAT_QUIRKS` / `PLATFORM_QUIRKS` / `hasPlatformQuirk` / `quirkWireValue` / `validateCompatVocab`（`ai/compat-vocab.ts`）/ `ProtocolAdapter.consumes`（`ai/protocol-adapter.ts`）
_Avoid_: 在 adapter 注释里回抄怪癖语义（只指键名）、给 pi-ai 的 compat 值开运行时入口、把模型血统事实搬进词表、词表叶里 value-import 协议栈

**平台请求代发**:
扩展上下文代 content script 发起平台 HTTP 请求的通道总称——content script 的跨域 fetch 服从**网页** CORS，而平台网关的预检白名单常拒扩展自带的鉴权头（实测 ModelScope 的 Anthropic 端点拒 `x-api-key` / `anthropic-version`）。两条通道按请求时长分工：**SW 代发**（探针 / 选区解释 / 联网搜索三链）单档 15s 覆盖整段请求（响应头 + 正文）且超时真中止，受 MV3 service worker 生命周期约束，只服务短请求；**offscreen 代发**（概览链，一请求一端口、无超时、一律分块回吐）服务分钟级流式长请求（ADR-0010）。联网搜索的链级预算 30s，由链持有。两端同文件组织 = 发送端在 content 用分块回吐合成标准 Response（响应头先落定，status/ok 立即可用；`.json()`/`.text()` 与流式读 body 同一形状），接收端在承载上下文执行 fetch 并按到达顺序回吐响应头 / 正文分片 / done。
代码名：`providerFetchViaBackground` / `handleProviderHttpRequest`（SW 代发）；`providerFetchViaOffscreen` / `attachProviderHttpPort` / `PROVIDER_HTTP_OFFSCREEN_PORT_NAME`（offscreen 代发）
_Avoid_: 把「content 发起、offscreen 执行」与「offscreen 客户端直发平台」混为一谈（后者仍被否决）；让概览回落页面源直发

**搜索平台**:
联网搜索平台（spec keyless-web-search，**六预设**（Tavily/Exa + Firecrawl/豆包/AnySearch/Parallel），其中四条零 Key 引擎 + 两条免费额度引擎构成零成本组，成员的接入与额度形态见「零成本组」，不做自定义）。Provider/Key 存储仿 ASR 走 `createProviderStore`（`searchProviders` 进 sync、Key 明文只进 `searchProviderKeys` local）；设置标量 `activeSearchProviderId`（= **链首**，手选平台排链最前，空 = 无链首，链即零成本组按预设顺序）/ `webSearchEnabled` / `webSearchMaxToolCalls` 走 save-settings。搜索 HTTP 由 SW 经 `provider-http` 通道发起 fetch：key 经消息中转（SW → offscreen 内存 →（消息 header）→ SW），SW 只做 fetch 发起方，key 不落 offscreen 存储/日志（protocol-vocab-leaf 文档语义修正，替代旧「密钥不出 SW」表述）；Tavily / Exa 沿用常驻 host 权限，新增 Firecrawl / 豆包 / AnySearch / Parallel，删 Brave。Key 对 `keyless` 预设可选（不再是「Key 前置」）；`resolve-search-provider` 解析的是**链**（有序候选 + 各自 Key）。适配器统一映射为 `{title,url,snippet}[]`（snippet 解析期截断 500）。
代码名：`searchProviderStore`（extension/search/search-provider-store.js）/ `normalizeSearchProvider` / `SEARCH_PROVIDER_PRESETS`（core/presets.js）/ 适配器 `extension/search/adapters/`
_Avoid_: Key 进 sync、自定义预设、offscreen 直发搜索请求

**零成本组**:
搜索时按固定顺序逐家尝试的平台集合——零 Key 引擎无条件入组，免费额度引擎配了 Key 才入组；顺序 = 预设表顺序。它的**执行形态**称「回退链」：组内前一家失败（超时 / 网络 / 额度耗尽，分类见 spec §6.4 的三等映射表）即试下一家，全组无果才提示用户。词表作「零 Key」、UI 文案作「免 Key」。
代码名：`SearchProviderAccess` / `SEARCH_PROVIDER_PRESETS`
_Avoid_: 把回退理解成「任何平台之间互相兜底」；用「免 Key」当组的定义（配 Key 的豆包也在组内）

**链首平台**:
用户手选的搜索平台，排在回退链最前；未手选即无链首。
代码名：`activeSearchProviderId`（沿用代码名，语义收缩）
_Avoid_: 把链首理解成「只有它会被使用」

**工具循环**:
AI 对话链与选区解释链共用的联网搜索执行管线（function calling，spec §2.3）：`runToolLoop` 包住 chatCompletion 多轮调用——finish_reason=tool_calls 时回填 assistant(tool_calls)+tool 消息续跑，单条 tool call 计入 `webSearchMaxToolCalls` 配额；搜索配置经 `resolve-search-provider` 单趟消息解析**回退链**（有序候选 + 各自 Key + 单轮上限），解析单点 `resolveWebSearchRuntime`（search/search-runtime.ts，offscreen 与解释卡同走，无 chrome.storage）。port 回吐单源在 streamChat（TokenBatcher/flush 纪律不变）；搜索执行单点 `executeWebSearch`（extension/search/search-executor.js）。**链内失败静默**，整链无果才一条 notice，回答不中断；额度类与超时/网络类分两条文案，且单轮调用次数的「本轮的搜索次数已达上限」与平台侧的「搜索额度已用尽」在措辞上分开（同名收口，§6.4）。平台不支持 tools（不可重试 4xx）摘除重发一次；Map-Reduce 归约轮静默禁用 + notice。tool 轮消息持久化进会话历史（tool 内容截 2,000，完整结果只活在当轮请求）。解释链（非流式）取 runToolLoop 返回值为最终文本，工具定义经 `webSearchTool` 变体（不带 [n] 引用要求）。
代码名：`runToolLoop` / `WEB_SEARCH_TOOL` / `webSearchTool`（ai/tool-loop.ts）/ `executeWebSearch`（search/search-executor.ts）/ `resolveWebSearchRuntime`（search/search-runtime.ts）/ `resolve-search-provider`（background handler）/ `tool-status` / `tool-turn`（chat/protocol.ts port 事件）
_Avoid_: 手抄第二份循环、offscreen 读 chrome.storage、tool 结果全文进历史

**设置快照**:
四个热路径读 handler（resolve-ai-provider / resolve-search-provider / get-asr-runtime-config / get-settings）读设置/平台存储的唯一读路径（sw-settings-snapshot 票；设置 UI 的 `*-providers-list` / `get-*-provider-key` 低频 CRUD 读维持直读 provider-store，不入快照）：settings 归一化产物 + 三 providerStore（ai/asr/search）normalize + hasSavedKey 装配产物各缓存一份，命中时热路径（每条聊天消息）storage 读降为 0。失效双通道：SW 内写消息 handler 落盘 await 完成后 inline 按 storage 键失效（onChanged 不在写入方上下文触发，inline 失效是「写后读」语义的唯一保证）；`storage.onChanged` 订阅兜底其它扩展上下文与跨设备 sync 变更。写路径纪律：快照只服务读路径，load-modify-write 继续直读存储不经快照；interface 不提供写（write-through 须先解决并发写交错丢 Key）。
代码名：`settingsSnapshot`（extension/core/settings-snapshot.js）/ `getSettings()` / `getProviderStore(family)` / `invalidate(keys)`；失效粒度 = storage 键（settings 键面 = DEFAULT_SETTINGS 键集，族键面 = `xxxProviders`（sync）+ `xxxProviderKeys`（local））
_Avoid_: 热路径 handler 直读 storage、给快照加写接口、绕过快照手抄第二次归一化

### 模型目录（model-catalog）

设置页平台编辑 Modal 里的**只读**模型元数据（上下文窗口 / 是否支持思考 / 是否收图）。数据来自构建期从 `@earendil-works/pi-ai`（MIT，devDependency 精确 pin）目录裁剪出的零依赖叶子产物，不是运行时依赖；决策与反例证据见 [ADR-0009](docs/adr/0009-model-catalog-borrow-not-embed.md)。

六条不变式（每条都能当判据用，锚点是实际实现/测试位置）：

1. **pi-ai 只作数据来源与设计参照，永不进入请求执行路径。** 上游只在构建期被读（`scripts/sync-pi-ai-catalog.mjs`）；`provider-http.ts → completion.ts → adapters/*` 那条链上没有任何目录代码。
2. **目录数据只读**：不落盘、不进 `AiProvider` 存储、不参与请求体构造。`ai/model-catalog.ts` 只有查表函数、无写入口；"写"只发生在 UI 的 DOM（`ui/provider-editor-catalog.ts` 的 `fillMetaSlot`）。
3. **目录对协议无感**：查表键是 `(piProvider, modelId)`，`protocol` 不参与。`resolvePiProvider` 的两段识别都不读协议字段；实证在 `tests/ai/model-catalog.test.ts`（「同名模型在不同 provider 下各归各的登记值」与「presetId 优先于 host」）。
4. **查不到即 `null`，UI 静默隐藏，不回落猜测值。** `lookupModelMeta` 对未知键与非字符串入参一律 `null`；UI 侧 `[data-model-meta]` 置 `hidden` 整栏不占位（无 "—"、无「暂无数据」）——`tests/ui/model-catalog-meta.test.ts` 的隐藏用例。
5. **产物是零 `import` 的叶子模块，且只能懒加载，不得进 SW 静态图。** `extension/ai/catalog/pi-ai-catalog.generated.ts` 零 `import`（`tests/ai/model-catalog.test.ts` 叶子用例）；只被 `ai/model-catalog.ts` 静态引用、`ai/model-catalog` 无人静态引用（同文件静态边用例）；SW 侧由 `scripts/build.js` 的 `assertBackgroundStaticGraphSlim` 兜底，content 常驻侧由 `scripts/build-content.js` 的「主包不得静态引用 chunks/」兜底。
6. **不拿外部数据补 `thinking-profiles.ts`**——那张表是单一事实源。产物刻意不带 `compat` / `thinkingLevelMap`；线格式与平台怪癖事实只活在 `ai/thinking-profiles.ts` 与两个 adapter（`adapters/openai.ts` / `adapters/anthropic.ts`）。

配套约束（同源，别越过）：`AiProviderPreset.piProvider` 与无数据白名单 `NO_CATALOG_PRESETS` 同源在 `core/presets.ts`（新增预设漏配即测试红，`tests/ai/model-catalog.test.ts` 的覆盖/反向用例）；`preset → piProvider` 是显式映射，host 只兜底 `custom`/未知预设；无数据平台（`qwen` / `stepfun` / `modelscope` / `amd` / `sensenova` / `ollama` / `custom`）永远没有元数据。

代码名：`PI_AI_CATALOG` / `lookupModelMeta`（`ai/catalog/pi-ai-catalog.generated.ts`，生成产物）/ `resolvePiProvider` / `lookupCatalogMeta`（`ai/model-catalog.ts`）/ `piProvider`（preset 字段）/ `ui/lazy-model-catalog.ts`（唯一懒加载入口）/ `pnpm catalog:sync`
_Avoid_: 把 pi-ai 接进请求链、用目录数据补 `thinking-profiles.ts`、让 `protocol` 参与查表、给目录加写路径/落盘、在对话界面塞模型元数据

### AI 对话

**图片输入**:
用户在 AI 对话里经剪贴板粘贴发给模型的图片。消息形状为路线 B：`content` 保持 string，图片并列挂在 `ChatMessage.images`（`{mime, data}`，base64 不带前缀）；发送前在 content script 统一压成 WebP q0.9、长边 ≤1568px，单条 ≤4 张、单张 ≤1MB。历史重发只保留最近一条用户消息的图（更早的替换为文本占位），落盘每会话最多留最近一张。门控乐观放行：目录明确不收图只提示不阻断，查不到静默交给平台 400。
代码名：`ImagePart` / `ChatMessage.images`（ai/types.js）/ `chat/image-compress.js` / `chat/chat-input-images.js` / `chat/image-support.js` / `retainLatestImage` / `normalizeImageParts`
_Avoid_: 附件图片、贴图、content parts 升级（被否的路线 A）、文件选择器/拖拽/视频帧入口（非目标）

**拆除会话**:
把「当前会话」从对话视图与存储中摘除的唯一事务：断流通知先于任何 await 与落盘 → 清会话 id/meta/历史 → 需要时做 live 上下文回填。删除单个会话、清空全部、恢复最新、开启新会话、发送前上下文失配各出口都必须经此收口，禁止手抄序列（与「字幕接受」「阅读壳」同款收口纪律）。
代码名：`detachCurrent` / `repopulateLive`（conversation-store 内部原语）
_Avoid_: 清会话、重置对话、手抄拆除序列

**上下文装载**:
一次 `loadContextState` 调用：拉当前标签页上下文 → 纯函数策略给出动作计划 → 编排壳按 action 执行副作用。两个决策点：no-tab 在消息往返之前（`resolveNoTabPlan`），其余五个在往返之后按响应分类（`resolveLoadContextAction`），优先级自上而下 no-tab → skip-unchanged → error → apply-pinned → blocked-streaming → apply-live（pinned 优先于流式守卫，skip-unchanged 短路优先于两者）。分层纪律：判定全在 policy 纯函数（无 I/O、不写状态、不渲染），效果全在编排壳（按 action 分派，不自行复判守卫）；pinned / 流式守卫只落地 live 快照，apply-live 才进主上下文。唯一例外是拆除事务的绕过点：新会话（reader 壳的 `startNewConversation`）在策略调用后有意做一次 live 兜底同步，不经 action 分派。
代码名：`extension/chat/context-policy.ts`（判定纯函数：`resolveNoTabPlan` / `resolveLoadContextAction` / `LOAD_CONTEXT_ACTION` / `LoadContextPlan`）/ `extension/chat/context-load.ts`（效果壳：`createContextLoad` / `loadContextState`）/ `ContextFetch`（`extension/core/context-assembly.ts` 注入的装配策略）
_Avoid_: 在效果壳重判流式守卫、按计划字段而非 action 反推是否进主上下文、给计划加无消费方的字段（`clearTabUrl` / `applyToMainContext` 已因零消费删除）

**发送闸**:
发送一条 AI 对话消息前确保上下文就绪的有序守卫序列：pinned 补水短路 → 上下文读取 → 主动起跑字幕抓取 → 字幕等待闸 → 放行前重取 → 无字幕拦截 → 回放让位，全部放行才受理发送。chat 域内组装的唯一事务，受理结论是显式接口返回值而非副作用推断：`sendMessage` 返回 `SendVerdict`（accepted / blocked / ignored，blocked = 被平台或闸拦下），闸本身返回 `GateOutcome`（`{pass:true}` / `{pass:false,kind:"read-failed"|"no-subtitle"}`，取代字符串哨兵）；回放让位在两条放行路径（G1 提前返回与直通）统一 await。
代码名：`extension/chat/send-gate.ts`（`createSendGate` / `GateOutcome`）/ `ensureCurrentContextForSend`（chat-runtime 的 deps 缝，发送闸对编排壳的唯一出口）/ `SendVerdict`（chat-runtime 的 `sendMessage` 返回）
_Avoid_: 发送前检查、发送前置条件散落各调用点、按输入框是否清空反推受理

**历史回放**:
把当前会话历史整段重建进消息区的分片渲染事务：世代号作废过期分片（清场/新轮）、50ms 帧预算让出主线程、发送路径先等待在途回放让位再追加消息。唯一事务，chat 域内组装，编排壳经 render/invalidate/inFlight 三件持有。
代码名：`extension/chat/replay.ts`（`createConversationReplay`）/ `render` / `invalidate` / `inFlight`
_Avoid_: 重渲消息区、逐条 append 重建、绕过世代号直接清场
