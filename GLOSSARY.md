# BiliScript 词表

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
同一个视频可以有多条轨：B 站 AI 多语言轨的 `lan` 形如 `ai-en`，一条原语言、其余为译文。用户可在字幕工具条里手动切轨——切轨是当前视频的会话态，不落全局语言偏好。轨道身份取接口的 `id_str`（接口的 `id` 是大于 2^53 的 JSON 数字，取它会在解析阶段丢精度）。本扩展自配平台转写出的轨（`lan` = `asr-zh`）与 B 站轨同列一张表。
同一个视频可以同时显示两路字幕（双语）：主轨 + 副轨，两行同属**一条**字幕条目（一段两行，主行在上、副行在下）。副轨由全局偏好选择（开关 + 目标语言），跨视频按语言重新匹配；本视频没有该语言的轨时，列表静默退回单轨、副列出空态说明。副轨装载中 / 失败只在副行出占位文案（重试入口在选轨弹层的副列），此时复制与导出仍只写主轨、与单轨态逐字节相同。副轨可对照的语言轨只有 `subtitleUrl` 非空的真轨；ASR 伪轨只作主轨兜底，不进副列。
代码名：`subtitleBody` / `subtitle` / `subtitle/fetcher.js` / `subtitleLang` / `subtitleList` / `updateReadingSubtitleTailSpacer` / `ReadingSubtitleItem` / `data-biliscript-reader-subtitle-visible` / `clip.secondarySubtitle`（副轨槽，带自己的 `idle|loading|ready|error` 装载态）/ `bilingualSubtitles` / `secondarySubtitleLang`（全局偏好）/ `findTrackByPreferredLang`（两级匹配的共享叶子）/ `secondaryContentFor`（两轨配对投影）/ `reader/secondary-subtitle.js`（副轨目标解析 + 装载事务的唯一落点：`resolveSecondaryTarget` 纯判定（偏好 × 轨列 × 主轨身份 → 目标 / 三态空态 reason）、`ensureSecondarySubtitleLoaded` 事务（守卫 → ensureSummarizeChain → loadSecondarySubtitle；在飞登记唯一一份）、`isSecondarySubtitleLoadInFlight`——自动装载 / 开关打开 / 副列改选 / 重试四入口都经它，目标轨语言 `lanDoc || lan` 只有这一个解析点、不落槽）/ `subtitle/body.js`（取体深 module：`loadTrackBody(请求, 钩子)`——缓存键装配 / 命中与时长校验 / 坏缓存清键 / 网络取体 / 落缓存与写失败上浮的唯一一份，出口（主轨接受事务 / 副轨乐观写槽）由调用壳注入，两条接受事务仍在 commit.js 并列；asr/fallback 的取体因键身份快照、转写管线边界、孤儿清理后置等真实差异保持独立）——字幕列表常驻 文摘面板「字幕」标签，transcript 词根已对齐字幕。
_Avoid_: 转录、transcript、把副轨说成「第二条字幕」或「第三路轨」（两行是一条字幕条目）、把副轨与主轨写成同一份 body 或同一个装载态

**章节**:
视频自带的分段 `{from, to, title}`。
代码名：`chapters` / `normalizeChapters`
_Avoid_: 目录、分段、集

**时刻文本**:
视频时间「秒 ↔ 时刻文本」的唯一换算约定：展示格式统一不补零（`2:30`，小时位同理），解析容错与是否带小时段（withHours 政策）单源收口。提示词教学格式与 UI 渲染格式必须出自同一实现，禁止两套约定靠注释对齐。
代码名：`formatAnalysisClock` / `formatCompactTimestamp`（统一后退役并入时刻文本单源模块）/ `parseTimestampSeconds`
_Avoid_: 补零/不补零双约定并存、各处手写 withHours 启发式、第三套解析器

**字幕接受**:
一段字幕成为当前视频生效字幕的唯一事务：稳定排序（from 升序，读路径二分依赖）→ 写 state → `fetchState="ready"` → 清 `noSubtitleReason` 与 `noSubtitleDetail` → 拉热评 → 通知 reader（`subtitle-ready`，emit 单点在事务内——调用方补发通知或直调渲染即双渲染）。派生内容（Markdown/SRT/TXT）已改为惰性构建，不由事务刷新。四个写入点（CC 缓存命中/网络新抓/ASR 缓存命中/转写完成）与无字幕出口（逆事务：清空 + `empty` + 原因）都必须经此收口，禁止手抄序列。事务带可选 runId 代次自检（M23 runId 协调）：调用方传入自己的抓取代次，写 state 前与 `fetchRunId` 比对，代次已被 URL 变化编排递增/新一轮抓取推进则抛 STALE_RUN 让位——旧视频字幕不得写进已重置的 state。递增单点在 URL 变化编排（`handleUrlChange` 感知 clip 签名变化处）同步先行，早于 reset 与新视频 refreshClip 的动态装载链；未传 runId（ASR 收尾路径，自有 isStale 视频键门控）不校验。
副轨有**自己并列的**接受事务（`acceptSecondarySubtitle`，同文件同形：runId 自检先于首写 → 整组写 → 发通知）与**自己的**通知 kind（`secondary-subtitle-ready`，只驱动重渲）；两条事务不是一条——副轨事务的副作用集不含 `subtitleFetchState` / 无字幕原因 / 热评 / 派生内容，也不碰主轨 selected 三项，主轨事务的副作用集照旧不变。
代码名：`subtitle/commit.js`（接受与无字幕出口的唯一入口；DOM 渲染回调由 fetcher 注入，保持静态图无环）/ `runId` 自检（`AcceptSubtitleArgs.runId` / `CommitNoSubtitleArgs.runId`）/ `acceptSecondarySubtitle`
_Avoid_: 落账、提交、写入字幕、手抄接受序列、reset 内递增 fetchRunId（须同步先行于装载链，否则新视频抓取可能被迟到的递增误杀）、把主副两条接受事务写成一条

**原始字幕缓存**:
按时间戳/章节切好的原始字幕段，可随取随用；仅在压缩摘要之外的细节追问时按需检索注入。宿主注记（arch-review-2026-09/05）：storage 真实宿主是 SW，offscreen（Map-Reduce/追问链）经 `segment-cache` 消息族读写——offscreen 侧唯一出站点 `ai/segment-cache-proxy.ts`，SW 端 `ai/segment-cache-handler.ts` 直调 segment-cache 单源（键位装配在 SW 完成）。写单元注记（段缓存写聚合 ticket 重构）：写路径是 run-scoped 写会话（`createSegmentCacheWriteSession`，一次编排运行一个、跨溢出重跑两轮共用），saveRaw 只入会话缓冲、不声明 per-op 成败（返回 void），随 saveSummary 合成 `save-summary-raw` 合并 op（写路径 3N→2N，SW 侧每段 2get+4set→1get+3set，两族索引/manifest 打包一次 set）；会话收尾统一 close 落盘残留 raw（正常 done / 停止 abort / idle 超时 / 异常上抛都经编排收尾统一 close），port 断开 / offscreen 自关不 close、会话随文档销毁废弃。失败通道 = awaited saveSummary 的 `{ok:false}` + close 的 onWriteError（编排层去重后只提示一次）。出站点载荷按 SW 键位字段投影收窄（context 只带 bvid/cid/字幕轨三元组；load-stored-raw 另带 chapters 供命中段预过滤），整份 AiContext 的 subtitleBody 不再过线。
代码名：`ai/segment-cache.js`（`biliscript_lvs_raw_*`）/ `ai/raw-retrieval.js` / `ai/segment-cache-key-fields.js`（键位字段清单零依赖叶，候选 5：SW 装配 / offscreen 出站点 / 协议载荷类型 / 概览键位四方同源）
_Avoid_: 长记忆、向量库

**字幕轨身份**:
一条字幕轨在缓存键里的身份，封闭判别联合四态：`track`（B 站轨 id）/ `url`（轨地址）/ `lang`（槽语言）/ `asr`（自配平台转写：provider + model + 语言）。三字段原始输入（id / url / lang）的优先级 id > url > lang 与 URL 归一只有一处裁定；编码产物是缓存 source key 的字节面（`id_*` / `url_*` / `lang_*` / `id_asr:<p>:<m>:<l>`），字节形状是对已落盘缓存的兼容面：逐字节不变、零迁移。
「这是不是 ASR 变体键」这个判据与编码**同根**：变体前缀由叶内唯一根常量派生，判据即前缀匹配——ASR 伪轨的组键侧（显式传 asr 身份）与识别侧（孤儿清理的匹配前缀）因此出自同一处，改编码时判据跟着改，不可能各写一套拼写而悄悄漂移。
与「字幕」的分工：本词条只管轨在缓存键里的身份；字幕正文的取体、接受事务与选轨全在「字幕」——缓存键入口收身份，主轨调用点显式构造身份，ASR 侧显式传 asr 身份（不再手拼字符串走 id 分支）。与「原始字幕缓存」的分工：三族键位（bvid + cid + 本身份 + 段序号 / 签名）由各族自己拼装，本词条只产出其中的 source key 分量。
代码名：`subtitle/source-key.js`（`TrackIdentity` / `trackIdentity`（三字段 → 身份）/ `subtitleSourceKey`（身份 → source key）/ `buildSubtitleSourceKey`（位置参数便捷形，缓存族注入面与直取用）/ `isAsrVariantSourceKey` + `ASR_SOURCE_KEY_PREFIX`）/ 消费方 `subtitle/cache.js`（缓存键入口收身份、孤儿清理前缀由此派生）/ `subtitle/body.js`、`ai/context-resolver.js`（主轨调用点）/ `asr/fallback.js`（组键显式传 asr 身份）/ `ai/segment-cache.js`、`ai/analysis-orchestrate.js`（缓存族注入）
_Avoid_: 把身份写成三个散字段、在调用点手拼 `asr:<provider>:<model>:<lang>` 再去走 id 分支、另写一处 `id_asr:` 前缀、复制第二份 URL 归一（削 query 那份住在 `bilibili/native-payload.js`）

**缓存宿主**:
缓存族落在哪个进程的判据：由**消费方进程的 storage 可达性**决定，与缓存数据的重要性/大小无关。offscreen 文档没有 chrome.storage（平台只开放 chrome.runtime）→ offscreen 消费的缓存族一律 SW 宿主、经消息族读写；content/reader 有完整 storage 权限 → 消费处直写。四族现状对照：字幕缓存（`biliscript_subtitle_cache_*`）content 直写；原始字幕缓存/分段小结（`biliscript_lvs_*`）SW 宿主、offscreen 经 `segment-cache` 消息族（机制见「原始字幕缓存」）；概览缓存（按 bvid/cid/轨/签名落盘）content 直写；查询缓存（`biliscript_search_cache`）SW 宿主，offscreen 与 content 都经 `search-cache` 消息族读写。淘汰/LRU 布局与宿主判据正交，单源 `core/cache-lru.js` 族工厂（两进程共用同一纯叶）。本判据只管 chrome.storage.local 上的可淘汰缓存族；provider/设置存储（sync+local 分层）不受管辖（见「激活平台」「设置快照」）。
代码名：`core/cache-lru.js`（族工厂）/ `ai/segment-cache-proxy.js`（SW 宿主族的 offscreen 出站点，读半边 `segmentCacheProxy` + 写会话工厂 `createSegmentCacheWriteSession`）/ `subtitle/cache.js` / `ai/analysis-orchestrate.js`（content 直写两族）
_Avoid_: 凭缓存数据重要性/大小选宿主、offscreen 侧引入 storage 垫片

**字幕预抓取**:
进入视频页即起跑的字幕抓取，不等用户打开文摘面板或点 AI 键。起跑点两处：content script 载入与 SPA 换片；起跑时序与既有自动抓取同一语义（先等视频元数据，再经总结链装载发刷新请求），复用的是「字幕接受」同一条事务链。字幕列表请求兼作可用性探测：无字幕的视频只多这一次列表请求，不进入 ASR 转写（ASR 保持用户触发）。是否起跑由共享守卫「字幕在手或在飞」判定：字幕体已落账且视频身份匹配当前页，或抓取相位为 loading / ready 时不起跑；失败静默，不写页面提示。抓取失败留下的 error 态由发送闸在发送前重试一次，仍失败则拦截发送。
代码名：`ensureSubtitlePrefetch` / `startSubtitlePrefetch`（entry/message-handler.ts）/ `isSubtitleInHandOrInFlight`（subtitle/subtitle-in-hand.ts）
_Avoid_: 预热、预取（quick-prompts 的 warmUpInitialQuickPrompts 已占用「预热」）；把预抓取当成会触发 ASR 的路径；给预抓取单开设置开关（见 ADR-0017）

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
文摘面板进入与退出阅读形态的唯一事务。按意图三档（open 进入 / restore 恢复 / chat 进对话）执行「先挂阅读样式表、再翻 body/html 属性」的无闪变时序，含摘除播放器快捷按钮、suppress 抑制窗口与 restore 档的 shell 完好性自查；退出为逆事务（摘样式表、翻回呈现属性，**不拆壳根**——域叶子在模块求值时解析并长期持有壳内节点引用，重建会让引用静默失效，故 `ensureUiReady` 的 `forceRecreate` 只服务壳根首建前的清场）。生命周期由四态状态机收口（closed/entering/open/exiting，单源 `core/state.ts` 的 `transitionReaderShell`，`readingViewOpen` 是其派生投影）：进入与退出事务同队列串行（entering 中收到 close 顺延），失败回退合法边（entering→closed / exiting→open）。全部入口（按钮/编排触发、恢复、进对话）与关闭出口都必须经此收口，禁止手抄序列。
代码名：`enterReaderShell` / `exitReaderShell`（intent 三档）/ `reader/shell.ts`；承载消息 `reader-enter` / `reader-restore` / `reader-close`——页面内 文摘按钮与工具栏图标点击共用同一 `reader-enter` 事务，无 popup / Side Panel 入口。
_Avoid_: popup- 词根消息名、进入阅读模式手抄序列

**播放器快捷按钮**:
播放器控制条上唤起 AI 快捷追问的按钮（player-ai 链）。宿主门（`.bpx-player-container` 优先链）过即挂正式位，不等字幕控件——字幕控件门自 2026-09 起软化为校准信号：控件首次就绪只触发一次性位置复校（防控制条水合改变容器几何导致漂移），复校只跑一次；挂早被 B 站水合冲掉走现有自愈链（容器 observer → rAF 快车道 → 退避兜底）重挂，不新增降级位（用户不接受按钮位置跳变）。
代码名：`player-ai.ts` / `findPlayerAiQuickActionHost` / `findPlayerSubtitleControlNode`（校准探针，非定位/行为依赖）/ `playerAiSubtitleControlCalibrated`
_Avoid_: 把字幕控件门当硬门回退、降级位先挂后迁移

**明暗模式**:
浅色 / 深色两档：`light` | `dark`，由面板 header 的主题按钮切换，从未手选时按 `prefers-color-scheme` 定初始档。明暗与色板是两根正交的轴：切明暗不动色板，换色板不动明暗。
代码名：`readerTheme` / `normalizeReaderTheme` / `readingTheme` / `setTheme`
_Avoid_: 用「主题」单字指明暗档位、把 `flyme` 当明暗档位（它是色板名，不是档位）

**外观色板**:
蓝雾玻璃 / 数字刊物两档：`flyme` | `editorial`，设置抽屉「外观」分区下拉选择、随「保存设置」落盘，跨标签页经 storage 监听自动同步；缺失/非法存储值归一回落 `flyme`。默认档 `flyme` 是蓝雾分层玻璃色系；`editorial` 数字刊物为暖纸感（浅：暖纸底 `#FAF7F2` + 赤陶 `#B85435`；深：暖炭黑 `#171513` + 暖赤陶 `#E07A5F`），明暗两档各出一份完整令牌（表面/卡片/文字/强调/边框），关闭蓝雾径向光斑，概览章节标题与金句正文走衬线字型栈。
代码名：`readerPalette` / `normalizeReaderPalette` / `readingPalette` / `setPalette`（呈现属性表 `palette` 字段：`data-biliscript-reader-palette` / `data-palette`）
_Avoid_: 把色板当明暗的第三档、在明暗按钮链路上改色板

### 面板控件

**图标键**:
文摘面板里无框、纯图标的按钮统称：静止态透明无底色，存在感只由悬停反馈底色与点按缩放承担（`border: 0`）。面板动作键（主题切换 / 设置 / 退出）、标签行对话工具键（历史对话 / 开启新会话）、字幕工具条复制/导出、金句卡与 AI 对话消息区的复制键同属这一视觉语言；带框文字键（`mini-btn` 母题）不是图标键。
代码名：`.biliscript-reading-icon-btn`（34×34 母题）/ `.chat-msg-copy-btn`（32×32）/ `.biliscript-reading-ov-quote-copy`（28×28）
_Avoid_: 把带框文字键与图标键混为一谈、给图标键加回边框

**带框图标开关**:
有边框、纯图标、带选中态的开关（联网搜索 pill 母题）：两个静止态的字形完全相同，选中与否只由描边与底色表达，方向等语义变化由切换动画承担。与无框的图标键不同族，也不是带框文字键。
代码名：`.chat-web-search-pill`（28×28 圆；开启态 `is-active` = accent 描边 + accent-soft 底；切换动画 `is-spinning-left` / `is-spinning-right`）
_Avoid_: 把带框图标开关并进图标键、拿字形区分开关的两个静止态

**复制键**:
把一段文本写入剪贴板的图标键：成功后状态行出「…已复制到剪贴板。」（5s 自动收起），失败分支静默（三处一致）。三处——字幕工具条（复制字幕，transcript 纯文本）、金句卡（复制该金句，文本形如 `时刻 「金句」`）、AI 对话消息区（复制回复，回复原文）。
代码名：`copySubtitleTranscript` / `data-overview-action="copy-quote"`（`copyQuoteToClipboard`）/ `chat-msg-copy-btn`；复制图标常量单源 `ui/reading-icons.ts` 的 `READING_COPY_ICON`
_Avoid_: 三处各存一份复制图标字面量、各配一套尺寸/描边

**悬停反馈**:
图标键在指针悬停或键盘焦点下显示的底色反馈：令牌 `--biliscript-reader-fill-hover`（亮色面黑 6%、暗色面白 10% 一档半透明，明暗两档各一份）。可聚焦的图标键 `:hover` 与 `:focus-visible` 同底；不可聚焦的复制键（金句卡的 `span[role=button]`）只做 hover。
代码名：`--biliscript-reader-fill-hover` / `:hover` / `:focus-visible`（reader-gate.css 主题色板段）
_Avoid_: 用 surface-2 换底充当悬停反馈（层级差太弱）、只做 hover 不做键盘焦点

### 总结流程

**成稿笔记**:
AI 总结阶梯（ADR-0001）的内部中间产物——素材在预算内一次成稿、超预算经「分段 + 归并」后成稿的完整 Markdown 总结，用于追问时的常驻压缩上下文，不是面向用户的笔记功能。产品已无笔记功能（原 Frontmatter 笔记导出 2026-09 删除）；`notes/` 目录仅承担字幕导出渲染（Markdown/SRT/TXT）。
代码名：`ai/followup-context.js` 的 `hasFinalNote`（判定已成稿）/ `notes/render.js` 的 `buildMarkdown`（导出渲染）
_Avoid_: 总结、摘要、回答；也不要再引入「保存笔记 / 笔记库」这类用户功能命名

**音频分片**:
长音频按固定时长切出的上传单元（5 分钟/片，WAV）。与「分段小结」互不相干：分片是 ASR 的上传/转写单元，小结是字幕的压缩产物。
代码名：`asr/chunker.js` / `decideChunks` / `ASR_MSG_CHUNK_RESULT` / `mergeChunkResults`
_Avoid_: 与「分段小结」混用

片级失败摘要：一次转写尝试里代表性失败的三个字段——类别、状态码、截断报文。**类别是唯一存在判据**：类别缺失 / 非字符串 / 空串 ⇒ 整条摘要缺席，状态码与报文不得脱离类别存在；状态码与报文用「有则带键」表达（`0` 与空串都算携带，不凭空多出 `undefined` 键）。域形态用 `kind / status / detail`，wire 形态（port DONE 消息与页面侧宿主结果）用 `failedKind / failedStatus / failedDetail`，改名只发生在判定与投影两个函数内部。
代码名：`AsrFailureSummary` / `AsrFailureFields` / `readAsrFailureSummary`（唯一判定）/ `projectAsrFailureSummary`（唯一投影）/ `AsrAttemptOutcome`（尝试结果，pipeline 上报、fallback 消费）
_Avoid_: 与管线级失败类别（`ERROR.kind`：音轨下载 / 解码 / 切片等整体失败）混称；也不要把它当成给用户看的错误消息——病因 / 补救 / 详情文案的单源是 `core/asr-failure-notice.js`

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
代码名：`ai/ladder.js` / `runLadderChat`（deps 注入面为测试 seam——每条缺省缝均有测试 adapter 驱动真实分支，2026-10-02 已裁定保留，勿再提议拆缝；详见 `extension/ai/ladder.ts` 头注）
_Avoid_: 降级、回退

**概览**:
文摘面板三大标签之一（对应 YouTube Digest 的 Overview）：章节列表（逐章带简介）+ 金句。分章来源优先级：视频简介/热门评论里的时间戳目录 > B 站官方章节（`view_points`）> AI 自由分章（前两者都没有时，最后一章须过 75% 后段门槛）。前两者按目录照抄标题与边界，模型只补每章简介。
代码名：`ai/analysis.js`（`runOverviewAnalysis`）/ `shared/chapter-outline.js`（`resolveChapterSource`）
_Avoid_: 总览

**分章计划**:
概览分章政策的唯一解释点：把 `resolveChapterSource` 的裁定（时间轴目录 / 官方章节 / AI 自由分章）一次翻译成管线要用的全部事实——系统提示词三选一、越界过滤后的给定章节、用户提示词变量、预算切段输入与产物 graft。末章界（视频时长与字幕末条时间戳取大）只推导一次、由 `graft` 闭包捕获，单发与分段路径统一调 `plan.graft(modelChapters)`（两套推导就此合一）。graft 语义：有给定章节时标题与边界照抄清单、模型只贡献 summary（时间轴来源 summary 一律空串）；无给定章节时原样返回模型章节。`budgetChapters` 是官方章节专用的切段输入，刻意用**未过滤**的 signatureChapters（与给定章节的越界过滤口径不同，行为冻结）。
代码名：`resolveChapterPlan` / `ChapterPlan`（`titlesOnly` / `hasGivenChapters` / `givenChapters` / `promptVars` / `budgetChapters` / `graft`，`ai/chapter-plan.js`）/ `applyGivenChapters`（同模块私有）
_Avoid_: 在编排层再判一次 `chapterSource.kind`、单发与分段各推一次末章界

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
AI 平台对外说话用的线格式族，开放注册表（spec multi-protocol-ai，落地三种）：OpenAI compatible（chat completions）、Anthropic（messages）、Gemini 原生（generateContent / streamGenerateContent，见 [ADR-0018](docs/adr/0018-gemini-native-protocol.md)）。每个 AI 平台记录带一个协议字段，存量记录缺省读作 OpenAI compatible。
代码名：`AiProtocol`（`"openai" | "anthropic" | "gemini"`）/ provider 的 `protocol` 字段；唯一读路径 `resolveAdapter`（`PROTOCOL_ADAPTERS` 注册表），缺字段/未知值兜底 openai，不得旁路直读 protocol 字段
_Avoid_: API 格式、接口类型；与扩展内部消息协议（messaging-protocol 词根）混用

**协议适配器**:
把平台协议差异收敛在唯一 fetch 点一侧的翻译单元：编排层（阶梯/归并/工具循环）只面对统一的 `ChatMessage[]` 入参与 `StreamChatEvent` 出参，SSE 事件差异（Anthropic 的 message_start/content_block_delta、Gemini 的 parts/thought/functionCall）、tool use 双向翻译（编排层保持 OpenAI tools 风格，Gemini 侧转换为 functionDeclarations + parametersJsonSchema 与 1:1 配对）、探针（probe）、错误归一化（归一为现有错误形状并前缀协议名）都在适配器内。一个协议一个适配器。合法值清单拆在词表叶（纯叶零依赖）：词表消费者（normalize 校验、设置 UI）只 import 词表叶，SW 静态图与协议栈脱钩；分发表键以 `Record<AiProtocol, ...>` 强制覆盖词表叶，单源；唯一读路径 `resolveAdapter` 不变。
代码名：`ProtocolAdapter` / `PROTOCOL_ADAPTERS` 注册表 / `AI_PROTOCOLS` 词表叶（`protocol-vocab.ts`）
_Avoid_: 每条协议复制编排链、编排层感知协议

**平台怪癖词表**:
协议线格式层面的平台差异（请求体字段名、思考词汇、消息历史要求、会话头、流式哨兵）的**唯一主人**：稳定键 + 语义 + 适用协议 + 线格式取值，借 pi-ai `compat` 的命名与语义设计、**不借其数据**（[ADR-0009](docs/adr/0009-model-catalog-borrow-not-embed.md)「借」清单；ADR 换代后该清单由 [ADR-0013](docs/adr/0013-upstream-model-facts-borrow-not-embed.md) 沿用）。纯叶零 import（只 type-import 词表叶 `AiProtocol`），不拖入分发表与 adapters。「该平台开哪些怪癖」在 `PLATFORM_QUIRKS` 一处声明；「该协议 adapter 接纳哪些怪癖」由 `ProtocolAdapter.consumes` 自陈（「接纳」= 该协议线格式栈对怪癖负责，兑现形态三种：adapter 内实现 / 卫星模块 thinking-profiles·thinking-wire-map·plan-thinking·preset-headers 实现 / 显式登记的有意缺口），两侧由 `validateCompatVocab` 在测试期对账——声明了没人接纳（死声明）与接纳了没声明（漏登记）都报错；平台侧另查平台 id 是真实 AI 预设、怪癖绑定的协议该平台登记了端点（否则是构造性死声明）。**校验不进运行时**。对账只到「端点存不存在」，**不按记录当前选的协议收窄**——设置 UI 的协议下拉对任何预设都无条件渲染三种协议，绑在另一条通道上的怪癖只是不生效、不是违规。**查表口径统一**经 `ai/platform-quirk-id.ts` 的 `resolvePlatformQuirkId`（presetId 主路径、baseUrl host 兜底，对 custom/直填 baseUrl 的平台也认得出；键成员资格 = `PLATFORM_QUIRKS` 的键）——识别器在词表叶外，词表叶的零 import 契约不破；不得拿 thinking 的 `resolveThinkingProviderId` 当词表识别口径（键空间不同：`PROVIDERS ⊋ PLATFORM_QUIRKS`，siliconflow 有思考档位但无怪癖声明）。模型血统事实（哪档发什么字段）不在词表：三层分工里词表只占**名词层**——档位事实（某模型有哪些档位）的第一事实源是构建期编译产物 `ai/catalog/models-dev-thinking.generated.ts`（`VALUESETS` 值集表 / `ASSIGNMENTS` 指派表 / `MODEL_ID_ALIASES` 别名表，查表入口 `lookupThinkingFact`），由 `ai/thinking-profiles.ts` 解析成本仓档位规则、并补产品语义与上游未覆盖处的兜底（`thinkingClass`、off 级联、`streamOnly`、UNKNOWN 哨兵不发参；指派表查不到该 id（用户自填 / 上游缺口 / 非 reasoning）时用手写 `EXCEPTIONS` / `TAXONOMY` / `unknownClass` 兜底产出档位），这套词汇在本协议请求体里的写法是 `ai/thinking-wire-map.ts`（线格式映射表），组装（取档位事实 → 按本协议算行入参 → 取表）的落点是思考装配边 `ai/plan-thinking.ts`，adapter 只把边产出并入请求体，词表只登记它们与协议栈之间的缝隙，不复制事实、不承载写法。
代码名：`COMPAT_QUIRKS` / `PLATFORM_QUIRKS` / `hasPlatformQuirk` / `quirkWireValue` / `validateCompatVocab`（`ai/compat-vocab.ts`）/ `resolvePlatformQuirkId`（`ai/platform-quirk-id.ts`）/ `ProtocolAdapter.consumes`（`ai/protocol-adapter.ts`）
_Avoid_: 在 adapter 注释里回抄怪癖语义（只指键名）、给 pi-ai 的 compat 值开运行时入口、把模型血统事实搬进词表、词表叶里 value-import 协议栈、拿 thinking 的 `resolveThinkingProviderId` 查词表

**线格式映射表**:
思考档位三层事实里的**写法层**：回答「事实层给出的那套中转词汇（封闭判别联合 `ThinkingVocabulary`：`reasoningEffort` / `enableThinking` / `thinkingType` 三个载荷成员 + `noFields` / `unknown` 两个哨兵，定义在 `ai/thinking-profiles.ts`）在本协议请求体里落成哪个字段、值怎么算」。按协议索引（键以 `Record<AiProtocol, …>` 强制覆盖，沿协议适配器的既有纪律），入参**按协议分型**（公共部分是中转词汇；`OpenAiWireInput` = 词汇 + token 上限参数名事实，`AnthropicWireInput` = 词汇 + probe + 平台识别 + 是否只认 effort 词汇，`GeminiWireInput` = 词汇 + probe + 模型名 + 平台识别；出参 = 该协议的线上字段与该协议的 token 上限参数名）。**线格式词汇字面量（`reasoning_effort` / `enable_thinking` / `thinking:{type}` / `output_config` / `thinkingConfig`）只在本表出现**；`openai` 行 = `openaiVocabularyFields` 恒等投影（中转词汇 → OpenAI 词汇字段，token 参数名随血统事实）；`anthropic` 行写出 Messages 通道的全部写法：探针早退（`probeOmitsThinking`）、按 `vocabulary.kind` 分四态（off 归一为关词 / effort 档位词透传 / 开关型裸开档 / 两哨兵不发——不再嗅探字段字面量）、off 三词汇的出口逐格登记在 `MESSAGES_OFF_EXIT`（键 = `PROVIDERS` 键空间全覆盖，四态 `native` / `word` / `silent` / `unresearched`，每格带 provenance；默认 Anthropic 原生显式 `thinking:{type:"disabled"}`——`thinkingDisabledMustBeExplicit`；`stepfun` / `amd` 两格声明怪癖 `effortVocabMessages` 为 `owner`，判据取该怪癖的活值即不发）、effort 档位的出口逐格登记在 `MESSAGES_TIER_EXIT`（同键空间全覆盖、同 provenance 形状：`effort` / `effort-bare` / `reasoning-effort` 三态 + `unresearched`「没人研究过 → 裸 `output_config.effort`」，未研究过与有依据地只发档位字段必须在类型/静态对账上可区分）、严格 effort 词汇平台（`effortVocabMessages`）改写为 `output_config.effort`、**effort 档位按 `MESSAGES_TIER_EXIT` 逐格落线**（`output_config.effort` + 开思考开关 / 裸档位词 / 顶层 `reasoning_effort`），开关型血统只有开/关两态、low 与 high 同为裸开档（**开词也逐格登记**在 `MESSAGES_ON_EXIT`：同键空间全覆盖、三态 `native` / `word` / `unresearched` + provenance；默认 Anthropic 原生 `thinking:{type:"enabled"}`，`minimax` 一格是平台自己的 `adaptive`——该端点的 enum 只有 `disabled` / `adaptive`，硬写 `enabled` 就是替平台发明词）；`gemini` 行写出 Gemini 原生协议的双轨思考与上限参数：离散 `thinkingLevel`（3 系 / flash-latest / gemma-4）与数值 `thinkingBudget`（2.5 系及未识别动态），输出 `generationConfig.thinkingConfig` 与 `maxOutputTokens`；三张 Messages 出口表对 non-messages 协议声明 `kind: "non-messages"` 与 provenance「构造性不适用」。**硬规则：Messages 各行任何一格都不发 `budget_tokens`**（官方没有 effort→预算的换算表，自造预算会挤占 `max_tokens`）。装配（取档位事实 → 按本协议算行入参 → 取本表）的落点是思考装配边 `ai/plan-thinking.ts`——唯一入口 `planThinkingWire(原始请求事实) → { fields, tokenParam }`，以协议为键分发（新增协议漏登记即编译期红），**输出上限参数名的唯一主人就是本表出参**；adapter 只做「取装配边产出 → 并入请求体」，不再 if 着改写；三层分工 = 怪癖词表给名词（有哪些怪癖）/ 档位事实归构建期编译产物 `ai/catalog/models-dev-thinking.generated.ts`（某模型有哪些档位，出口是封闭词汇）/ 本表给写法（这套词汇在本协议长什么样）。三层无重叠主人由静态对账钉住（Messages 线格式字面量只在本表出现、`budget_tokens` 在 `extension/ai` 的代码里零出现）；「思考词汇字面量只出现在本表」这条自封闭词汇改造起由联合的封闭性 + seam 类型（tsc）钉住，不再扫 adapter 源码文本。纯叶零 import（只 type-import 词表叶与血统表类型）。**不引入表达式引擎**：线格式是代码不是字符串——受类型检查，且表达得了依赖 probe 等事实的跨 option 条件。
代码名：`THINKING_WIRE_MAPS` / `ThinkingWireInput`（公共入参）/ `OpenAiWireInput` / `AnthropicWireInput` / `GeminiWireInput`（逐协议入参）/ `ThinkingWireOutput` / `openaiVocabularyFields`（`ai/thinking-wire-map.ts`）/ `ThinkingVocabulary` / `reasoningEffort` / `enableThinking` / `thinkingType` / `NO_FIELDS` / `UNKNOWN_VOCABULARY`（中转词汇，定义在 `ai/thinking-profiles.ts`）/ `MessagesTierExitKind` / `MESSAGES_TIER_EXIT` / `messagesTierExitCell` / `MESSAGES_OFF_EXIT` / `messagesOffExitCell` / `MessagesOnExitKind` / `MESSAGES_ON_EXIT` / `messagesOnExitCell`（档位出口表 / off 出口表 / 开词出口表是其内部单源，三表共用 `MessagesExitProvenance` 的出处形状）/ `ai/platform-identity-vocab.ts`（平台身份键词表叶，候选 6：`PlatformKey` 封闭键集，PROVIDERS 与三张出口表一律 `Record<PlatformKey, …>`，缺一格 / 孤儿键 = tsc 红）/ `ThinkingResolution.effectiveLevel`（**本次请求真正落线的档**的唯一承载者 = applyClassRule 里那一次 clamp 的结果；off 写点本次不可用时可用集剔 off 再 clamp，级联目标与字段同值；显示面 `resolveThinkingAdjustment` 只投影不复算；`null` 仅 unknown 哨兵）/ `planThinkingWire` / `ThinkingRequestFacts`（思考装配边 `ai/plan-thinking.ts`：取档位事实 → 按本协议算行入参 → 取本表，装配与输出上限参数名的唯一入口）
_Avoid_: 在 adapter 里回抄线格式取值、让血统表输出协议字段名、把线格式写成字符串表达式（表达式引擎）、在血统表里按协议分支、在 Messages 通道发 `thinking.budget_tokens`（本扩展一律不自造思考预算）

**平台请求代发**:
扩展上下文代 content script 发起平台 HTTP 请求的通道总称——content script 的跨域 fetch 服从**网页** CORS，而平台网关的预检白名单常拒扩展自带的鉴权头（实测 ModelScope 的 Anthropic 端点拒 `x-api-key` / `anthropic-version`）。两条通道按请求时长分工：**SW 代发**（探针 / 选区解释 / 联网搜索三链）单档 15s 覆盖整段请求（响应头 + 正文）且超时真中止，受 MV3 service worker 生命周期约束，只服务短请求；**offscreen 代发**（概览链，一请求一端口、无超时、一律分块回吐）服务分钟级流式长请求（ADR-0010）。联网搜索的链级预算 30s，由链持有。两端同文件组织 = 发送端在 content 用分块回吐合成标准 Response（响应头先落定，status/ok 立即可用；`.json()`/`.text()` 与流式读 body 同一形状），接收端在承载上下文执行 fetch 并按到达顺序回吐响应头 / 正文分片 / done。
代码名：`providerFetchViaBackground` / `handleProviderHttpRequest`（SW 代发）；`providerFetchViaOffscreen` / `attachProviderHttpPort` / `PROVIDER_HTTP_OFFSCREEN_PORT_NAME`（offscreen 代发）；两条通道共用的公共件叶 `provider-http-shared.ts`（URL 提取 / Headers 归一 / 中止形状 / 接收端预检与 fetch init / 出向载荷单源，零运行时依赖）
_Avoid_: 把「content 发起、offscreen 执行」与「offscreen 客户端直发平台」混为一谈（后者仍被否决）；让概览回落页面源直发

**搜索平台**:
联网搜索平台（spec keyless-web-search，**七预设**（Tavily/Exa + Firecrawl/豆包/AnySearch/Parallel + DeepSeek），其中四条零 Key 引擎 + 两条免费额度引擎构成零成本组（成员的接入与额度形态见「零成本组」），DeepSeek 为付费平台（见「付费平台」），不做自定义）。DeepSeek 搜索记录无自有 Key 字段，Key 经「凭据引用」取自 AI 族。Provider/Key 存储仿 ASR 走 `createProviderStore`（`searchProviders` 进 sync、Key 明文只进 `searchProviderKeys` local）；设置标量 `activeSearchProviderId`（= **模式选择 + 单选目标**：记录 id = **单选**（只用该家、无回退），哨兵 `SMART_SEARCH_ACTIVE_ID` 或空串 = **智能**（链按 `searchProviderOrder` 归一序 > `DEFAULT_SEARCH_PROVIDER_ORDER` 内置默认序回退），见「链首平台」词条）/ `webSearchEnabled` / `webSearchMaxToolCalls` 走 save-settings。搜索 HTTP 由 SW 经 `provider-http` 通道发起 fetch：key 经消息中转（SW → offscreen 内存 →（消息 header）→ SW），SW 只做 fetch 发起方，key 不落 offscreen 存储/日志（protocol-vocab-leaf 文档语义修正，替代旧「密钥不出 SW」表述）；Tavily / Exa 沿用常驻 host 权限，新增 Firecrawl / 豆包 / AnySearch / Parallel，删 Brave。Key 对 `keyless` 预设可选（不再是「Key 前置」）；`resolve-search-provider` 解析的是**链**（有序候选 + 各自 Key）。适配器统一映射为 `{title,url,snippet}[]`（snippet 解析期截断 500）。
代码名：`searchProviderStore`（extension/search/search-provider-store.js）/ `normalizeSearchProvider` / `SEARCH_PROVIDER_PRESETS`（core/presets.js）/ 适配器 `extension/search/adapters/`
_Avoid_: Key 进 sync、自定义预设、offscreen 直发搜索请求

**零成本组**:
搜索时按固定顺序逐家尝试的平台集合——零 Key 引擎无条件入组，免费额度引擎配了 Key 才入组；付费平台（`paid`）永不入组，仅在付费开关打开时进入智能链（见「付费平台」）。顺序 = `searchProviderOrder` 归一序 > `DEFAULT_SEARCH_PROVIDER_ORDER`（内置默认序；预设表序只管预设目录）。它的**执行形态**称「回退链」：组内前一家失败（超时 / 网络 / 额度耗尽，分类见 spec §6.4 的三等映射表）即试下一家，全组无果才提示用户。词表作「零 Key」、UI 文案作「免 Key」。
代码名：`SearchProviderAccess` / `SEARCH_PROVIDER_PRESETS` / `DEFAULT_SEARCH_PROVIDER_ORDER`
_Avoid_: 把回退理解成「任何平台之间互相兜底」；用「免 Key」当组的定义（配 Key 的豆包也在组内）

**链首平台**:
**单选模式**下用户手选的搜索平台（`activeSearchProviderId` = 某条记录 id）：它是链里**唯一一家**、**无回退**，该家失败即整链无果。**智能模式**（哨兵 `SMART_SEARCH_ACTIVE_ID` 或空串）下无手选链首——链 = 零成本组按 `searchProviderOrder` 归一序 > `DEFAULT_SEARCH_PROVIDER_ORDER` 回退，链序第一家 ≠ 链首。
代码名：`activeSearchProviderId`（沿用代码名，语义收缩为「模式选择 + 单选目标」）/ `SMART_SEARCH_ACTIVE_ID` / `resolveSearchMode`（core/search-mode.ts，spec §12.1）
_Avoid_: 把链首理解成「排链最前、失败自动回退下一家」（无回退是它的定义）；把智能模式的链序第一家也称作链首

**付费平台**:
搜索平台的第三种接入形态（`SearchProviderAccess` 词表 `keyless | free-quota | paid` 的第三类）：无免费额度、按成功请求次数计费，现有唯一成员 DeepSeek Search（¥5/1000 次成功请求，失败与空结果不计费）。智能模式下仅当付费开关 `allowPaidSearchProviders`（默认关——花钱必须是显式动作）打开时才入回退链，默认排链末位（免费平台全挂才轮到它；想优先用可拖拽提位或单选）；**单选**付费平台不受开关限制——单选本身是显式付费意图。付费行为必须可审计：智能链命中付费平台成功，来源列表该项带「付费」徽标；付费平台失败（余额不足 402 / 限速 429 / 超时等）按链序回退，来源区顶部标注「DeepSeek 搜索不可用（原因），已回退至 XX」。DeepSeek Search 请求固定 `need_content: false`（按次计费与返回量无关，正文徒增体积），喂模型用 `summary` 字段（官方定位为给模型阅读，600-800 字符）。
代码名：`SearchProviderAccess` 的 `"paid"`（core/presets.ts）/ `allowPaidSearchProviders`（设置标量，默认 false）/ 适配器 `extension/search/adapters/deepseek.ts`
_Avoid_: 拆「智能（免费）/智能（含付费）」两个虚拟行（付费准入是正交开关，不是第二种智能模式）、付费平台进零成本组、付费失败静默回退、toast 式付费提示

**凭据引用**:
跨族读 Key 的唯一例外：搜索侧 DeepSeek 记录不设 Key 输入框，发请求时实时读 AI 族「第一条启用、`presetId` 为 `deepseek` 且通过「官方端点判定」的记录」的 Key（`aiProviderKeys`）。单一真源：AI 侧改 Key 搜索立即跟随，删掉该记录搜索侧自动降级为链中跳过；不提供搜索侧覆盖 Key（「只想用 DeepSeek 搜索」的用户在 AI 平台加一条记录即可）。方向单向（搜索读 AI，绝不回写）；三族存储（`aiProviderKeys` / `asrProviderKeys` / `searchProviderKeys`）隔离不变式的其余部分照旧。
代码名：取 Key 与判定收口在共享 helper，搜索链候选装配处消费 / 搜索行状态文案「已复用 AI 平台 Key」「请先在 AI 平台添加官方 DeepSeek 记录」
_Avoid_: 把 Key 复制进 `searchProviderKeys`（双写腐化：AI 侧改/删后搜索侧那份静默过期）、搜索侧覆盖 Key 输入框

**官方端点判定**:
凭据引用的前置判据：AI 记录当前生效协议对应的 baseUrl 规范化（去尾斜杠、小写）后 host 严格等于 `api.deepseek.com`。中转 / 反代 / 克隆站一律不通过（这些端点多半不转发 `/v1/tools/search`，Key 有效也会 404）；不通过时搜索行显示「AI 平台 Key 指向非官方端点」、链中跳过——诚实失败，不静默 404。判定为共享 helper 单点，设置 UI 状态与搜索链消费同一处。
代码名：共享 helper（host 严格判等）/ 官方 host 常量 `api.deepseek.com`
_Avoid_: `includes("deepseek")` 子串匹配、跟随 AI 记录的自定义 baseUrl 发搜索请求

**工具循环**:
AI 对话链与选区解释链共用的联网搜索执行管线（function calling，spec §2.3）：`runToolLoop` 包住 chatCompletion 多轮调用——finish_reason=tool_calls 时回填 assistant(tool_calls)+tool 消息续跑，单条 tool call 计入 `webSearchMaxToolCalls` 配额；搜索配置经 `resolve-search-provider` 单趟消息解析**回退链**（有序候选 + 各自 Key + 单轮上限），解析单点 `resolveWebSearchRuntime`（search/search-runtime.ts，offscreen 与解释卡同走，无 chrome.storage）。port 回吐单源在 streamChat（TokenBatcher/flush 纪律不变）；搜索执行单点 `executeWebSearch`（extension/search/search-executor.ts）。**链内失败静默**，整链无果才一条 notice，回答不中断；额度类与超时/网络类分两条文案，且单轮调用次数的「本轮的搜索次数已达上限」与平台侧的「搜索额度已用尽」在措辞上分开（同名收口，§6.4）。平台不支持 tools（不可重试 4xx）摘除重发一次；Map-Reduce 归约轮静默禁用 + notice。tool 轮消息持久化进会话历史（tool 内容截 2,000，完整结果只活在当轮请求）。解释链（非流式）取 runToolLoop 返回值为最终文本，工具定义经 `webSearchTool` 变体（不带 [n] 引用要求）。
代码名：`runToolLoop` / `WEB_SEARCH_TOOL` / `webSearchTool`（ai/tool-loop.ts）/ `executeWebSearch`（search/search-executor.ts）/ `resolveWebSearchRuntime`（search/search-runtime.ts）/ `resolve-search-provider`（background handler）/ `tool-status` / `tool-turn`（chat/protocol.ts port 事件）
_Avoid_: 手抄第二份循环、offscreen 读 chrome.storage、tool 结果全文进历史

**设置快照**:
四个热路径读 handler（resolve-ai-provider / resolve-search-provider / get-asr-runtime-config / get-settings）读设置/平台存储的唯一读路径（sw-settings-snapshot 票；设置 UI 的 `*-providers-list` / `get-*-provider-key` 低频 CRUD 读维持直读 provider-store，不入快照）：settings 归一化产物 + 三 providerStore（ai/asr/search）normalize + hasSavedKey 装配产物各缓存一份，命中时热路径（每条聊天消息）storage 读降为 0。失效双通道：SW 内写消息 handler 落盘 await 完成后 inline 按 storage 键失效（onChanged 不在写入方上下文触发，inline 失效是「写后读」语义的唯一保证）；`storage.onChanged` 订阅兜底其它扩展上下文与跨设备 sync 变更。写路径纪律：快照只服务读路径，load-modify-write 继续直读存储不经快照；interface 不提供 write-through 写（缓存条目只由读路径建立，加 write-through 须先解决并发写交错丢 Key），提供的是落盘入口（落盘 + 按键域失效，不写快照缓存）。
代码名：`settingsSnapshot`（extension/core/settings-snapshot.js）/ `getSettingsSnapshot()`（SW 侧归一快照读；内容侧同名语义的那份是 `core/runtime.getSettings`，两者不再同名） / `getProviderStore(family)` / `invalidate(keys)` / `invalidatingWrite`（包住调用方落盘动作的写入口：落盘 → inline 失效 → 透传返回值）/ `writeSnapshotKeys(changes)`（裸落盘入口，候选 7：调用方只交「键 → 新值」，区由 `SNAPSHOT_STORAGE_KEYS` 的 area 反查、落盘后按键域失效，写点不再报区）/ `SNAPSHOT_STORAGE_KEYS`（键→域→区单源表，`invalidate` 判据、onChanged 订阅键面与裸写落区都由它派生）/ `PROVIDER_FAMILY_STORAGE_KEYS`（族键面，从单表 `PROVIDER_FAMILY_KEY_PAIRS` 派生）；失效粒度 = storage 键（settings 键面 = DEFAULT_SETTINGS 键集 = 归一步骤表键 `SETTINGS_NORMALIZER_KEYS` ∪ 透传名单 `SETTINGS_PASSTHROUGH_KEYS`，两张名单互不相交、并集即键面全集，对账测试 `tests/core/settings-normalizer-keys.test.ts` 钉住——加键忘写归一步即红；族键面键字面量真源 = 各族 store 模块导出的 `*_PROVIDERS_STORAGE`（list，sync）/ `*_PROVIDER_KEYS_STORAGE`（keys，local）常量）
_Avoid_: 热路径 handler 直读 storage、给快照加 write-through 写面、写点自己报区（或绕过落盘入口直调 `chrome.storage.*.set`）、绕过快照手抄第二次归一化

**消息入口守卫**:
SW 的 `chrome.runtime.onMessage` 入口在**路由之后、处理器执行之前**的拒绝闸：只拦形状明显非法/来源不合法的请求，业务归一仍归处理器；被拒请求明确回 `{ ok:false, error }`（不静默吞、不让调用方空等）且**零副作用**。两项检查：①**来源标签**——注册表登记了 `sender` 标签的 2 个类型（`segment-cache` / `offscreen-request-close`，标签 = `offscreen`）要求发送者是 offscreen 文档本身（扩展级副作用能力只开放给 offscreen，即 SW 代执行的另一面），其余消息**默认放行**（发送者含 content，search-cache / search-health 显式在名单外；标签无对应判据时同样放行）；②**payload 最小 schema**——save-settings 的对象形状、三家 providers-save 的数组形状、player-ai-quick-action 的 tabId 有限数，只是形状判据，不替代处理器内的业务校验。
代码名：`createMessageRouter`（core/message-router.ts，路由 / 来源守卫 / 形状守卫 / 派发 / 回包口径的单点；零 chrome——判据本体与 handler 本体都在各自域，entry/background.ts 只注入 handler 表、来源判据与拒绝文案，监听器一行委派）/ `BACKGROUND_MESSAGE_REGISTRY`（shared/messaging-protocol.ts，SW 消息注册表：**一条消息一处登记**——声明 + 形状判据 + 回包口径 + 来源标签，守卫的两项检查与 `ResponseOf` 由它派生）/ `OFFSCREEN_ONLY_MESSAGE_TYPES`（同上，名单**单源**——由注册表逐条的 `sender` 标签派生，归属协议层：来源语义属协议契约）/ `isOffscreenDocumentSender`（asr/offscreen-bridge.bg.ts，只判来源、不持名单；组合根按 `offscreen` 标签注入 router）/ `ASR_OFFSCREEN_REJECTION_MESSAGE`（asr/protocol.ts，拒绝文案单源，守卫与关闭执行器共用）
_Avoid_: 把「offscreen 会发」当「只准 offscreen 发」（已删的 `OffscreenRuntimeRequest` 是「offscreen 发出的请求」事实枚举，被误读成来源守卫名单）；在 core/message-router 回抄消息类型字面量或按 type 手写形状清单（源码结构锁在 tests/core/message-router.test.ts）；默认拒绝式白名单（名单外的 content 发信方会被拦掉）

### 模型目录（model-catalog）

设置页平台编辑 Modal 里的**只读**模型元数据（上下文窗口 / 是否支持思考 / 是否收图）。数据来自**构建期**从 models.dev（`https://models.dev/api.json`）抓取并裁剪出的零依赖叶子产物（12 家上游 / 578 个模型；产物头记裁剪子集的 `contentHash` 与逐家 `doc` + 模型数），不是运行时依赖；决策、pin 口径与反例证据见 [ADR-0013](docs/adr/0013-upstream-model-facts-borrow-not-embed.md)（取代 ADR-0009）。

六条不变式（每条都能当判据用，锚点是实际实现/测试位置）：

1. **原始上游数据只在构建期被读，永不进请求执行路径。** 抓取/裁剪在 `scripts/sync-models-dev-catalog.mjs`（请求塑形事实侧是 `scripts/sync-models-dev-thinking.mjs`）；`provider-http.ts → completion.ts → adapters/*` 那条链上没有任何目录代码。pi-ai devDependency 已随 11 号票删除。
2. **目录数据只读**：不落盘、不进 `AiProvider` 存储、不参与请求体构造。`ai/model-catalog.ts` 只有查表函数、无写入口；"写"只发生在 UI 的 DOM（`ui/provider-editor-catalog.ts` 的 `fillMetaSlot`）。
3. **目录对协议无感**：查表键是 `(catalogProvider, modelId)`，`protocol` 不参与。`resolveCatalogProvider` 的两段识别都不读协议字段；实证在 `tests/ai/model-catalog.test.ts`（「presetId 优先于 host」与「host 兜底：custom / 未知 presetId」）。
4. **查不到即 `null`，UI 静默隐藏，不回落猜测值。** `lookupCatalogMeta` 对未知键与非字符串入参一律 `null`；UI 侧 `[data-model-meta]` 置 `hidden` 整栏不占位（无 "—"、无「暂无数据」）——`tests/ui/model-catalog-meta.test.ts` 的隐藏用例。
5. **产物是零 `import` 的叶子模块，且只能懒加载，不得进 SW 静态图。** `extension/ai/catalog/models-dev-catalog.generated.ts` 零 `import`（`tests/ai/model-catalog.test.ts` 叶子用例）；只被 `ai/model-catalog.ts` 静态引用、`ai/model-catalog` 无人静态引用（同文件静态边用例）；SW 侧由 `scripts/build.js` 的 `assertBackgroundStaticGraphSlim` 兜底（两个 models.dev 产物与 `ai/model-catalog.ts` 都在禁区清单里），content 常驻侧由 `scripts/build-content.js` 的「主包不得静态引用 chunks/」兜底。
6. **UI 目录产物不得回填请求塑形事实。** 「某模型有哪些档位」的第一事实源是另一份编译产物 `ai/catalog/models-dev-thinking.generated.ts`（02 号票；`ai/thinking-profiles.ts` 显式引入，档位「怎么落请求体」归 `ai/thinking-wire-map.ts` 与 adapter），它的产物刻意不带 `compat` / `thinkingLevelMap`，UI 目录产物更不带。

配套约束（同源，别越过）：`AiProviderPreset.catalogProvider` 与无数据白名单 `NO_CATALOG_PRESETS` 同源在 `core/presets.ts`（新增预设漏配即测试红，`tests/ai/model-catalog.test.ts` 的覆盖/反向用例）；`preset → catalogProvider` 是显式映射（12 家），host 只兜底 `custom`/未知预设；无数据平台只有 `ollama`（本地）与 `custom`（用户自填端点，无身份）**2 家**，永远没有元数据。

代码名：`UPSTREAM_CATALOG` / `UPSTREAM_CATALOG_SOURCE` / `lookupUpstreamModelMeta`（`ai/catalog/models-dev-catalog.generated.ts`，生成产物）/ `resolveCatalogProvider` / `lookupCatalogMeta`（`ai/model-catalog.ts`）/ `catalogProvider`（preset 字段）/ `ui/lazy-model-catalog.ts`（唯一懒加载入口）/ `pnpm catalog:sync:upstream`
_Avoid_: 把原始上游数据接进请求链或运行时、用 UI 目录数据补 `thinking-profiles.ts`、让 `protocol` 参与查表、给目录加写路径/落盘、在对话界面塞模型元数据、复制第二份 preset → 上游 provider 映射

**预设登记覆盖**:
新增一个 AI 平台的登记欠账的只读派生视图：按 presetId（或全量枚举）一次列出六个登记面的现状——预设行（`PRESETS`）、目录身份（`catalogProvider` / `NO_CATALOG_PRESETS`，两者并存也算欠账）、协议端点（`protocolBaseUrls`，含 `/v1` 拼重隐患）、怪癖（`PLATFORM_QUIRKS`，稀疏面、空声明合法）、三张 Messages 出口表逐格（kind + provenance 原样带出）、构建期序位（`UPSTREAM_PRESET_ORDER`）。五态互不吞并：`registered` / `intentional-gap`（有意缺口，不是欠账）/ `missing`（欠账）/ `not-applicable` / `unchecked`（事实源未注入，绝不等于已登记）。纪律：纯只读派生、零缓存、不合并三套键空间（PROVIDERS ⊋ PLATFORM_QUIRKS ⊋ presetId）、protocol 不参与任何事实查表、不进请求执行链与 SW 静态图。它是「新增平台要登记几处」的答案入口，不是新的事实主人。

**新增协议的登记点清单（第三种协议新增，四处编译期强制 + 两处词表 + 构建守卫）：**
1. `ai/protocol-vocab.ts`: `AI_PROTOCOLS` 词表叶加入新协议字面量；
2. `ai/adapters/<protocol>.ts`: 实现 `ProtocolAdapter` 六件事（endpoint / authHeaders / buildBody / extractErrorDetail / drainStream / parseResponse），`consumes` 自陈；
3. `ai/protocol-adapter.ts`: `PROTOCOL_ADAPTERS` 开放注册表登记适配器实例；
4. `ai/protocol-adapter.ts`: `PROTOCOL_OPTIONS` 协议下拉选项补齐；
5. `ai/thinking-wire-map.ts`: `ThinkingWireInputs` 联合扩展该协议入参 + `THINKING_WIRE_MAPS` 分发表补行；
6. `ai/plan-thinking.ts`: `PLANNING_ROWS` 思考装配边补装配行；
7. `scripts/build.js`: `assertBackgroundStaticGraphSlim` 将新模块加入 SW 静态图禁止清单（防静态引用导致 service worker 体积膨胀）。

代码名：`ai/preset-registration-view.ts`（`presetRegistrationView` / `registrationCoverageReport` / `REGISTRATION_FACES`）/ `ai/platform-identity-vocab.ts`（平台身份键空间词表叶，候选 6 起 messagesExits 面的键集判据由 `Record<PlatformKey, …>` 类型接管，本视图只投影）
_Avoid_: 在视图里复制任何事实、把 unchecked 当已登记、把有意缺口记成欠账、拿它当运行时查表入口

### AI 对话

**图片输入**:
用户在 AI 对话里经剪贴板粘贴发给模型的图片。消息形状为路线 B：`content` 保持 string，图片并列挂在 `ChatMessage.images`（`{mime, data}`，base64 不带前缀）；发送前在 content script 统一压成 WebP q0.9、长边 ≤1568px，单条 ≤4 张、单张 ≤1MB。历史重发只保留最近一条用户消息的图（更早的替换为文本占位），落盘每会话最多留最近一张。门控乐观放行：目录明确不收图只提示不阻断，查不到静默交给平台 400。清场边界：附件只由发送受理时的 `takeInputImages`（读+清一次）消费，被闸拦下不消费；发送闸调用链上的上下文重启（apply-live → restartChat）是上下文跟随，带 `preserveInput` 不清输入框与附件区（否则闸后才消费的图片被静默吞掉、正文照发），用户主动「新会话」与其它上下文切换路径照旧清场。
代码名：`ImagePart` / `ChatMessage.images`（ai/types.js）/ `chat/image-compress.js` / `chat/chat-input-images.js` / `chat/image-support.js` / `retainLatestImage` / `normalizeImageParts` / `preserveInput`（LoadContextStateOptions / HydratePinnedOptions → restartChat）
_Avoid_: 附件图片、贴图、content parts 升级（被否的路线 A）、文件选择器/拖拽/视频帧入口（非目标）

**拆除会话**:
把「当前会话」从对话视图与存储中摘除的唯一事务：断流通知先于任何 await 与落盘 → 清会话 id/meta/历史 → 需要时做 live 上下文回填。删除单个会话、清空全部、恢复最新、开启新会话、发送前上下文失配各出口都必须经此收口，禁止手抄序列（与「字幕接受」「阅读壳」同款收口纪律）。
代码名：`detachCurrent` / `repopulateLive`（conversation-store 内部原语）
_Avoid_: 清会话、重置对话、手抄拆除序列

**上下文装载**:
一次 `loadContextState` 调用：拉当前标签页上下文 → 纯函数策略给出动作计划 → 编排壳按 action 执行副作用。两个决策点：no-tab 在消息往返之前（`resolveNoTabPlan`），其余五个在往返之后按响应分类（`resolveLoadContextAction`），优先级自上而下 no-tab → skip-unchanged → error → apply-pinned → blocked-streaming → apply-live（pinned 优先于流式守卫，skip-unchanged 短路优先于两者）。分层纪律：判定全在 policy 纯函数（无 I/O、不写状态、不渲染），效果全在编排壳（按 action 分派，不自行复判守卫）；pinned / 流式守卫只落地 live 快照，apply-live 才进主上下文。流式守卫的判据（`isStreaming` + `hasPendingUserPrompt` 两键）**刻意窄于**「回合在途」（`isTurnActive`，含受理窗口）：发送闸自身也走 `loadContextState`，判据并宽会在受理窗口内把闸自己的装载判成 blocked-streaming、转写完成后发出的消息带空字幕（锚点测试 chat-tab「转写中发送被挂起…」）。唯一例外是拆除事务的绕过点：新会话（reader 壳的 `startNewConversation`）在策略调用后有意做一次 live 兜底同步，不经 action 分派。
代码名：`extension/chat/context-policy.ts`（判定纯函数：`resolveNoTabPlan` / `resolveLoadContextAction` / `LOAD_CONTEXT_ACTION` / `LoadContextPlan`）/ `extension/chat/context-load.ts`（效果壳：`createContextLoad` / `loadContextState`）/ `ContextFetch`（`extension/core/context-assembly.ts` 注入的装配策略）
_Avoid_: 在效果壳重判流式守卫、按计划字段而非 action 反推是否进主上下文、给计划加无消费方的字段（`clearTabUrl` / `applyToMainContext` 已因零消费删除）

**发送闸**:
发送一条 AI 对话消息前确保上下文就绪的有序守卫序列：pinned 补水短路 → 上下文读取 → 主动起跑字幕抓取 → 字幕等待闸 → 放行前重取 → 无字幕拦截 → 回放让位，全部放行才受理发送。chat 域内组装的唯一事务，受理结论是显式接口返回值而非副作用推断：`sendTurn` 返回 `SendVerdict`（accepted / blocked / ignored，blocked = 被平台或闸拦下），闸本身返回 `GateOutcome`（`{pass:true}` / `{pass:false,kind:"read-failed"|"no-subtitle"}`，取代字符串哨兵）；回放让位在两条放行路径（G1 提前返回与直通）统一 await。等待方向单向：发送等回放让位，回放不等任何东西；回合终结的两个维度的标志必须成对收口——`sendInFlight` 与 `activePort`（`isTurnActive()` 的判据）在 blocked 提前返回、异常与终态三条出口都复位，否则此后发送被入口判 ignored（静默发不出去）。
代码名：`extension/chat/send-gate.ts`（`createSendGate` / `GateOutcome`）/ `ensureCurrentContextForSend`（chat-runtime 的 deps 缝，发送闸对编排壳的唯一出口）/ `SendVerdict`（`extension/chat/turn-lifecycle.ts` 的 `createTurnLifecycle` / `TurnLifecycle` / `TURN_SETTLE_FALLBACK_MS`——回合生命周期深 module；chat-runtime 的受理入口 `sendTurn`）
_Avoid_: 发送前检查、发送前置条件散落各调用点、按输入框是否清空反推受理

**历史回放**:
把当前会话历史整段重建进消息区的分片渲染事务：世代号作废过期分片（清场/新轮）、50ms 帧预算让出主线程、发送路径先等待在途回放让位再追加消息。唯一事务，chat 域内组装，编排壳经 render/invalidate/inFlight 三件持有。回放本身不感知在途回合（方向纪律：单向等待，回放不等任何东西）——流式中点历史项（或点同一会话重放）由点击接缝先 `await runtime.settleTurn()`：在途时发停流、等 stopped/done/error 终态落定（终态路径把在途一问一答含 partial 正文写回**原**会话并落盘）后才 `store.applyById`；不在途时零延迟零行为差。拆除类入口（删除/清空/新对话/关闭会话）不经此接缝，维持有意断流。
代码名：`extension/chat/replay.ts`（`createConversationReplay`）/ `render` / `invalidate` / `inFlight` / `settleTurn`（= turn-lifecycle 的 `settled`）/ `isTurnActive`（chat-runtime 返回面）
_Avoid_: 重渲消息区、逐条 append 重建、绕过世代号直接清场、让回放等待在途回合（结构死锁方向）
