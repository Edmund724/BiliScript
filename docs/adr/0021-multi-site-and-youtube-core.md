# ADR-0021：多站点抽象边界、YouTube 首期能力范围与跨站存储键兼容策略

> 状态：有效

BiliScript 从 B 站单站扩展演进为多站点视频文摘扩展（`bilibili | youtube`），首期在 Chromium（120+）与桌面端 Firefox（153+）同步交付 YouTube 核心文摘闭环；采用**常驻清单显式域名声明 + 站点适配器懒加载 + 编码安全存储键（零迁移兼容 B 站存量）+ YouTube 同源主世界三级字幕采集**架构。

## 已定决策

### 1. 常驻权限声明、双端同步交付与首期能力边界

- **显式常驻域名与注入兜底**：在 [extension/manifest.json](../../extension/manifest.json) 直接声明 `https://www.youtube.com/*`（`content_scripts` 匹配 `https://www.youtube.com/watch*`，配合后台 `tabs.onUpdated` 兜底从首页、搜索或频道页经 SPA 导航切入 `/watch`；`host_permissions` 与 `web_accessible_resources` 显式加入 `https://www.youtube.com/*`，严禁通配符）。桌面端 Firefox（153+）构建通过 `scripts/firefox-manifest.js` 同步派生，守卫继续遵循 [ADR-0017](0017-firefox-desktop-compatibility.md)。
- **YouTube 首期页面范围**：仅覆盖桌面端 `https://www.youtube.com/watch*` 非直播视频（含播放列表 `&list=` 与已结束直播回放），排除 `/shorts/*`、直播中页面、`/embed/*` 与 `m.youtube.com`。
- **核心功能与站点门控**：
  - **已支持**：文摘面板三标签（字幕 / 概览 / AI 对话）、面板双语字幕（YouTube 站点禁用原生双轨配对，统一复用 `Index-Translate` 免 Key 或自定义 AI 翻译链，不合成 YouTube `tlang` 虚拟轨）、播放器内实时字幕翻译叠层（挂载于 `#movie_player` 与 `.ytp-right-controls`，YouTube 站点直接走扩展翻译并隐藏原生双轨配对入口，开启时接管并隐藏原生 `.ytp-caption-window-container`）、热门评论抓取（读取主世界 `ytInitialData` 评论区 continuation token 并通过同源真实 `WEB` `youtubei/v1/next` 拉取热门评论，接入概览评论目录、上下文装配与 AI 对话 `fetch_hot_comments` 工具）、本地 Agent 桥接（覆盖已打开 YouTube 标签页的 `tabs` / `fetch` / `subtitles` / `comments` 与当前帧 `frame`，拒绝未打开 URL 后台直拉、历史时间点截帧与无字幕 ASR）、独立窗口（[ADR-0020](0020-detached-reader-window.md)）、播放器右侧快捷 AI 按钮（挂载于 `#movie_player`，点击一键触发 AI 总结并自动退出原生全屏）、当前帧截帧、字幕搜索/高亮/导出、联网搜索、快捷提问、选区解释卡与 Chromium 对话朗读 TTS。
  - **显式门控与后续排期**：通过站点能力表（`SiteCapabilities`）在 YouTube 页及设置抽屉隐藏未移植能力入口——
    - **后续评估**：无字幕 ASR 语音转写（低优/待评估，YouTube 原生自动字幕覆盖率高且音频流受反爬与条款约束）。
    - **暂缓排期**：实时伴看（视频页浮窗与直播间）。
    - **不做**：
      - 历史三帧截帧：YouTube Web 端自适应流已切换为 SABR 二进制协议（`application/vnd.yt-ump`），渐进式 MP4 覆盖不全且受反爬门控；在不做协议逆向与不扰动主播放器进度的前提下无稳定高清历史帧来源，而 `storyboards` 雪碧图最高档仅 `320×180` 且中长视频帧间隔达 10 秒，不足以支撑 AI 对话识别细节画面。YouTube 统一使用当前帧高清截帧。
      - 3x/4x 扩展倍速：YouTube 原生 3x 属于 Premium 会员权益，避免侵权及服务条款风险。
- **懒加载与包体预算**：常驻内容包仅保留轻量站点判据与路由分派，各站点适配器（页面探测、字幕抓取、按钮锚点与提示词规则）按活跃站点动态 `import()` 懒加载，继续守住 [ADR-0004](0004-content-two-round-build-and-reader-gate.md) 首帧 2 请求 / 40 KB 常驻预算与 [ADR-0001](0001-background-no-runtime-lazy.md) 后台 256 KB 上限。

### 2. 多站视频身份、编码安全存储键与跨站历史契约

- **站点字段与写纪律**：在 `extension/core/state.ts`（`state.clip`）与 `AiContextRef` 新增只读 `site: "bilibili" | "youtube"`（存量缺省视为 `"bilibili"`），遵守 [ADR-0002](0002-state-bag-write-discipline.md) 原位增补、不搬迁或拆散既有状态袋字段。
- **外部 ID 与视频存储键分离**：严格区分**原始外部视频 ID**（展示、URL、剪贴板、导出模板 `{{videoId}}` 与兼容别名 `{{bvid}}`）与持久化**视频存储键**。B 站存量 `(bvid, cid)` 键保持字节级不变、零数据迁移；YouTube 视频采用不含 `_` 与 `:` 分隔符的确定性命名空间编码键（对 11 位 ID 中的 `_` 做无歧义转义并带站点前缀）配固定单单元 `cid = "yt"`，且字幕缓存与 AI 产物写入路径（`extension/subtitle/idb-store.ts`、`extension/subtitle/ai-artifact-cache.ts`）直接传递结构化 `{ bvid, cid }`，消除 YouTube ID 含 `_` 撞坏既有 `_`/`:` 字符串切分解析器的问题。对外渲染与导出严禁泄漏内部转义存储键。
- **平台自动字幕与本扩展 `asr` 严格拆分**：将视频站点自带机器字幕归为**平台自动字幕**（B 站 `bili-ai` 标 `（B 站 AI）`，YouTube `kind: "asr"` 标 `（YouTube 自动）`），与本扩展自配平台转写伪轨 `asr` 彻底解耦，避免 YouTube 自动字幕污染 `id_asr:` 缓存命名空间与孤儿清理；无标点断句（`extension/subtitle/segmentation.ts`）与双语精翻（[ADR-0010](0010-bilingual-secondary-subtitle-and-translation.md)）对平台自动字幕统一走无标点断句与 `boundary-v3` 协议。
- **跨站共享与历史水合边界**：AI 平台、通用设置与历史会话列表跨站共享；历史条目展示简洁站点标识；B 站分P水合（`hydrateConversationPage`）仅对 `site === "bilibili"` 触发；跨页点击 YouTube 历史优先读取扩展源 IDB（[ADR-0018](0018-layered-storage-and-extension-idb.md)）既有缓存续聊，若缓存已被 LRU 淘汰，仍保留完整只读历史浏览并在用户发起新追问时提示打开原 YouTube 视频页重抓字幕。

### 3. YouTube 同源主世界三级采集路线

- **主世界实时读取**：视频元数据、官方/自动章节与字幕轨道列表通过轻量页面主世界（`MAIN` world）桥读取实时播放器对象（`movie_player.getPlayerResponse()` / `ytInitialPlayerResponse` / `ytInitialData`），零额外网络请求、天然跟随 SPA 换片与用户登录态。
- **字幕正文三级采集链**：
  1. 优先请求 `timedtext&fmt=json3`（无 `pot` 门控或复用页面自身已产生的合法 `pot`，保留完整起止时间与逐词信息）；
  2. 命中 `exp=xpe` 返回空正文时，同源回落至携带页面真实 `WEB` 上下文与 `engagementPanels` 参数的 `youtubei/v1/get_transcript`；
  3. 双路均不可得时给出清晰用户引导（如提示开启页面原生字幕开关后重试），**严禁伪装 `ANDROID` / `IOS` 等移动端 InnerTube 客户端绕过反爬校验**。

### 4. YouTube 页面呈现、主题同步与提示词去 B 站化

- **Light DOM 锚点与页内按钮**：沿用 [ADR-0003](0003-light-dom-script-panel.md) Light DOM 面板。YouTube 默认布局贴靠 `#secondary` 右栏；窄屏、剧场模式（`ytd-watch-flexy[theater]` / `[full-bleed-player]`）或 `#secondary` 顶边落于播放器下方时跳过贴栏并降级居中浮层，监听布局切换自动重排。页内「文摘」按钮挂载于视频下方 `#actions` 操作栏，采用适配 YouTube 亮/暗外观的胶囊样式（不沿用 B 站粉）；`autoOpenReader` 对普通 `/watch?v=...` 生效、对含 `&list=` 播放列表页排除。
- **主题检测泛化**：`extension/shared/host-theme.ts` 补齐对 YouTube `<html dark>` 布尔属性的检测与变更观察；设置界面「跟随 B 站」文案泛化为「跟随当前站点」，底层存储值保持向后兼容。
- **提示词、分章与截帧门控**：内置 AI 系统提示词、概览/解释提示词、描述清洗与未自定义导出默认模板按站点参数化（用户自定义 `aiSystemPrompt` 与自定义导出模板保持原样）；概览分章维持 `extension/shared/chapter-outline.ts` 优先级（简介时间戳目录 > 站点官方/自动章节 > AI 自由分章）；对话工具循环（`extension/ai/tool-loop.ts`）与阶梯探测（`extension/ai/ladder.ts`）依据站点能力门控在 YouTube 仅注册 `capture_current_video_frame` 并关闭历史三帧自动探测。

## 考虑过的方案

- **可选权限（`optional_host_permissions`）+ 动态注册脚本**：虽能避免一次升级权限弹窗，但增加首次在 YouTube 使用的授权摩擦并打破当前「无 popup、点击工具栏图标直开面板」的交互模型，故不采用。
- **升级 IDB v3 并全仓重命名 `bvid` / `cid`**：概念更纯粹，但波及 60 余处文件且存在存量缓存数据迁移风险，同时冲击 [ADR-0002](0002-state-bag-write-discipline.md) 对 `state.clip` 散字段的原位约束，故选用编码安全存储键零迁移方案。
- **伪装 `ANDROID` / `IOS` 客户端绕过 PO Token**：对抗反爬存在较高的协议失效与风控风险，首期坚持页面同源真实 `WEB` 上下文路线。
- **在 YouTube 禁用 `Index-Translate` 并额外合成 `tlang=` 机翻虚拟轨**：YouTube 逐句机翻缺少上下文断句与术语表，翻译质量明显弱于 35B 模型 + `boundary-v3` 管线，且增加首期虚拟轨道与缓存降级复杂度；首期直接复用既有 `Index-Translate` 与自定义 AI 翻译链，二期可视外部接口稳定性按需再评估 `tlang`。

## 后果

- **真机验收门槛**：实现阶段须通过 Chromium `browser-harness` 新增 YouTube 核心场景（离线 DOM 几何、真网主世界字幕采集与当前帧截帧）及桌面端 Firefox 153+ `web-ext lint` + `smoke:firefox`（验证主世界桥 `XrayWrapper` 兼容与样式注入）。
- **审查红线**：
  - 不得将未编码的原始 YouTube 视频 ID（含 `_`）直接拼入以下划线/冒号切分的存储键，也不得将内部转义存储键泄漏至用户界面、URL 或导出模板。
  - 不得将 YouTube `kind: "asr"` 平台自动字幕归入本扩展转写伪轨 `asr` 类别或写入 `id_asr:` 缓存命名空间。
  - 不得采用伪装 `ANDROID` / `IOS` 客户端的方式绕过 YouTube `timedtext` PO Token 校验。
  - 不得在 YouTube 页面暴露未验收的 ASR 转写、实时伴看、扩展倍速或历史三帧截帧入口。
