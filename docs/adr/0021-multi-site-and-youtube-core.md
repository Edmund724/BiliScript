# ADR-0021：多站点抽象边界、YouTube 能力门控与跨站存储键兼容策略

> 状态：有效

BiliScript 支持多站点视频文摘（`bilibili | youtube`），在 Chromium（120+）与桌面端 Firefox（153+）同步交付 YouTube 桌面端 `/watch` 页能力；采用**显式常驻域名声明 + 按需经典 IIFE 站点适配器 + 编码安全存储键（零迁移兼容 B 站存量）+ YouTube 同源主世界三级字幕采集**架构。

## 已定决策

### 1. 显式常驻域名、页面范围与 `SiteCapabilities` 能力门控

- **显式域名与 SPA 注入兜底**：在 [extension/manifest.json](../../extension/manifest.json) 声明 `https://www.youtube.com/*`（`content_scripts` 匹配 `https://www.youtube.com/watch*`，配合后台 `tabs.onUpdated` 兜底从首页/频道页 SPA 切入 `/watch`；`host_permissions` 显式加入 `https://www.youtube.com/*`，`web_accessible_resources` 不含 YouTube，见 [ADR-0004](0004-content-two-round-build-and-reader-gate.md)）。Firefox 派生清单由 `scripts/firefox-manifest.js` 同步生成（[ADR-0017](0017-firefox-desktop-compatibility.md)）。
- **YouTube 页面范围与能力门控（`extension/shared/site.ts`）**：仅覆盖桌面端 `https://www.youtube.com/watch*` 非直播视频（排除 `/shorts/*`、直播中、`/embed/*` 与 `m.youtube.com`）。视频文摘核心闭环（含面板双语翻译与播放器翻译叠层、热评采集、独立窗口、本地 Agent 桥接已打开标签页、无字幕 ASR 与历史三帧截帧，后两项详见 [ADR-0022](0022-youtube-sabr-asr-pipeline.md)）均已对齐；通过 `SiteCapabilities` 在 YouTube 显式隐藏**实时伴看**（暂缓排期）与**3x/4x 扩展倍速**（YouTube 原生 3x 属 Premium 会员权益，不做），且禁用原生双轨配对（统一走 `Index-Translate` 或自定义 AI 翻译，不合成 `tlang` 虚拟轨）。
- **包体预算**：常驻内容包仅保留轻量站点判据与路由分派，站点适配器与网关按 [ADR-0004](0004-content-two-round-build-and-reader-gate.md) 归入按需经典 IIFE 分组（`g-buttons` / `g-subtitle` / `g-app`），守住 `45 KB` 常驻内容包与 `256 KB` 后台上限。

### 2. 多站视频身份、编码安全存储键与平台自动字幕隔离

- **原位增补 `site` 字段**：在 `extension/core/state.ts`（`state.clip`）与 `AiContextRef` 增补只读 `site: "bilibili" | "youtube"`（存量缺省视为 `"bilibili"`），遵守 [ADR-0002](0002-state-bag-write-discipline.md) 不拆散状态袋。
- **外部 ID 与视频存储键分离**：严格区分**原始外部视频 ID**（展示、URL、剪贴板、导出模板 `{{videoId}}` 与兼容别名 `{{bvid}}`）与持久化**视频存储键**。B 站存量 `(bvid, cid)` 字节不变、零迁移；YouTube 视频采用不含 `_` 与 `:` 分隔符的确定性转义命名空间键配固定单单元 `cid = "yt"`，且 IDB 写入直接传递结构化 `{ bvid, cid }`，防止 YouTube 11 位 ID 中的 `_` 撞坏既有分隔解析器。对外渲染与导出严禁泄漏内部转义键。
- **平台自动字幕与本扩展 `asr` 隔离**：将站点自带机器字幕归为平台自动字幕（`bili-ai` 与 YouTube `kind: "asr"`），与本扩展自配 ASR 伪轨 `asr` 彻底解耦，避免污染 `id_asr:` 缓存命名空间与孤儿清理；两者均走无标点断句与 `boundary-v3` 精翻协议（[ADR-0010](0010-bilingual-secondary-subtitle-and-translation.md)）。
- **跨站历史与提示词**：AI 平台、设置与历史会话跨站共享；B 站分 P 水合仅对 `site === "bilibili"` 触发；跨页打开 YouTube 历史优先读扩展源 IDB（[ADR-0018](0018-layered-storage-and-extension-idb.md)）缓存续聊，淘汰后仍保留只读历史浏览。内置提示词与默认导出模板按站点参数化（用户自定义模板原样保留），主题同步泛化支持 YouTube `<html dark>`。

### 3. YouTube 同源主世界三级字幕采集路线

- **主世界实时读取**：经轻量 `MAIN` world 桥读取 `movie_player.getPlayerResponse()` / `ytInitialPlayerResponse` / `ytInitialData` 获取元数据、章节与轨道列表，零额外请求并跟随 SPA 与登录态。
- **字幕正文三级采集链**：
  1. 优先同源请求 `timedtext&fmt=json3`（无 `pot` 门控或复用已捕获的合法 `pot`）；
  2. CC 关闭态命中 `exp=xpe` 返回空正文时，同源回落至真实 `WEB` 上下文的 `youtubei/v1/get_panel`（零副作用、兼容冷开暂停态与 `kind:"asr"`；不可得再回落 `get_transcript`）；
  3. 切轨、开启播放器翻译叠层或 `get_panel` 不可用且已起播时，经 `world: "MAIN"` 临时隐藏原生字幕容器静默触发一次字幕加载捕获 `pot` 并立即复原 CC 状态、Storage 与 `PREF` Cookie，同视频后续切轨直接复用 `pot`；
  4. 全路径不可得时给出明确提示（并允许空态手动触发 ASR），**严禁伪装 `ANDROID` / `IOS` 客户端绕过 PO Token 校验，不引入第三方字幕外发服务**。

## 考虑过的方案

- **可选权限（`optional_host_permissions`）+ 动态注册脚本**：增加首次使用授权摩擦并打破「点击图标直开面板」模型，否决。
- **升级 IDB v3 并全仓重命名 `bvid` / `cid`**：波及面大、引入迁移风险且违反 ADR-0002 原位演进约束，否决。
- **伪装 `ANDROID` / `IOS` 客户端绕过 PO Token，或合成 `tlang=` 机翻虚拟轨**：前者反爬风控风险高，后者翻译质量弱于 `Index-Translate` + `boundary-v3` 且增加虚拟轨状态复杂度，否决。

## 后果

- **审查红线**：
  - 不得将未编码的原始 YouTube 视频 ID（含 `_`）直接拼入以下划线/冒号切分的存储键，也不得将内部转义键泄漏至 UI、URL 或导出模板。
  - 不得将 YouTube `kind: "asr"` 平台自动字幕归入本扩展 `asr` 伪轨或写入 `id_asr:` 缓存命名空间。
  - 不得伪装 `ANDROID` / `IOS` 客户端绕过 YouTube `timedtext` PO Token 校验。
  - 二期立项前不得在 YouTube 页面暴露未验收的实时伴看或 3x/4x 扩展倍速入口。
