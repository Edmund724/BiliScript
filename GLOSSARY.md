# BiliScript 核心词表

BiliScript（覆盖 B 站与 YouTube）根级高频术语索引。详细域级契约与代码锚点按需查阅 `docs/glossary/` 分卷；架构裁决与审查红线见 [docs/adr/README.md](docs/adr/README.md)。

## 域分卷导航

| 域分卷 | 覆盖范围 |
| --- | --- |
| [docs/glossary/subtitle.md](docs/glossary/subtitle.md) | 字幕与双语副轨、接受事务、轨身份、预抓取、ASR 音频分片与 IDB v4 字幕缓存 |
| [docs/glossary/ai.md](docs/glossary/ai.md) | 总结阶梯、KV 前缀锁、25s Contextual BM25 + RRF、多协议与思考档位、模型双层存储、搜索与 IDB v4 会话懒水合 |
| [docs/glossary/live.md](docs/glossary/live.md) | 实时伴看、伴看浮窗、直播间伴看、伴看音频、实时字幕翻译与 `"live-text-tool"` 伴看记录 |
| [docs/glossary/reader.md](docs/glossary/reader.md) | 文摘面板、独立窗口跨文档宿主、阅读壳、色板与排版、面板控件、对话离屏隔离与 `note_highlights` |

## 全局核心术语

- **站点（`SiteId`）**：视频托管平台封闭枚举 `bilibili | youtube`（缺省 `bilibili`），隔离视频身份与能力门控（[ADR-0021](docs/adr/0021-multi-site-and-youtube-core.md)）。_Avoid_: 平台（专指 AI/ASR/搜索/伴看服务商）。
- **视频**：站点单条内容单元——B 站 `(bilibili, bvid, cid)`，YouTube `(youtube, 11 位 videoId, 单单元)`。界面、URL 与导出只用原始外部 ID。_Avoid_: 稿件、把 YouTube ID 称 `bvid`。
- **视频存储键**：IDB 与本地缓存的跨站键编码——B 站沿用 `(bvid, cid)`，YouTube 使用不含 `_` / `:` 的确定性编码键与单单元 `cid`，严禁泄漏至 UI 或导出。
- **分P**：B 站多段内容单元（以 `cid` 标识）；YouTube 映射为单单元。_Avoid_: Part、集数。
- **字幕**：时间轴字幕轨（`{from, to, content}`），支持主/副轨双语与 `bilingualDisplayOrder` 语序。_Avoid_: 转录、transcript。
- **平台自动字幕**：站点自身机器轨（B 站 `ai-*` 标 `（B 站 AI）`，YouTube `kind: "asr"` 标 `（YouTube 自动）`），与扩展自配 `asr` 伪轨严格隔离。
- **章节** / **时刻文本**：视频分段 `{from, to, title}` 与不补零时间戳格式（如 `2:30`，单源 `extension/shared/clock-text.ts`）。
- **文摘面板**：阅读模式承载主体，含「字幕 / 概览 / AI 对话」三标签，支持页内面板与独立窗口双宿主（[ADR-0003](docs/adr/0003-light-dom-script-panel.md)）。_Avoid_: 整页接管、播放器槽。
- **独立窗口**：文摘面板跨文档同源搬移形态（[ADR-0020](docs/adr/0020-detached-reader-window.md)），隐藏退出键且系统 `×` 统一归位，含 **置顶画中画（`pip`）**（Document PiP，不支持时回落普通窗口）与 **普通窗口（`popup`）**（`window.open`，支持分屏并与原生视频画中画并存）。_Avoid_: 浮窗、弹窗、小窗。
- **概览** / **金句**：全片简介、章节列表与带时间戳的佳句。_Avoid_: 总览、摘抄。
- **实时伴看** / **伴看浮窗**：视频页与 B 站直播间播放器内的低延迟音画双工浮窗，独立于文摘面板生命周期（[ADR-0016](docs/adr/0016-live-companion-overlay-hosts.md)）。_Avoid_: 语音对话、伴看面板。
- **明暗模式** / **外观色板**：正交双轴——明暗 `light | dark`，色板 `flyme` / `editorial`。_Avoid_: 把 `flyme` 当明暗档位。
- **凭据引用**：搜索 DeepSeek 与伴看 Gemini Live 单向实时借用 AI 族官方端点启用记录的 Key（`extension/core/ai-credential-reference.ts`）。
