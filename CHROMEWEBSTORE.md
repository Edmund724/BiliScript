# Chrome Web Store Listing — BiliScript｜B站视频文摘

> Last Updated: 2026-09-24
>
> Status: Draft. Do not submit until tickets #01 through #06 are complete, the real Chrome checks pass, and the 2.2.0 release archive is rebuilt.

## Store Listing

**Extension Name**: BiliScript｜B站视频文摘

**Short Description**: 在 B 站视频页阅读带时间戳字幕，生成摘要与 AI 对话。

**Detailed Description**:

BiliScript 在 B 站视频页右侧打开文摘阅读面板，让你一边看视频，一边读取逐句字幕、章节和 AI 摘要。点击视频播放器下方的文摘按钮，或点击浏览器工具栏上的扩展图标——两个入口完全等价，打开的是同一个页面内阅读面板。设置、字幕、概览和 AI 对话都在这个面板内。

你可以按时间跳转字幕，搜索当前句，复制或下载 Markdown、SRT 和 TXT。概览会整理章节和重点引用。AI 对话能围绕当前视频追问，并使用你配置的模型；选中字幕后，可以继续请求讲解、翻译或润色。可选开启联网搜索后，模型在需要视频之外的信息时可自行查询，回答中给出搜索时间线、来源链接与内联引用；该功能默认关闭，需要用户自行配置搜索平台（Tavily / Exa / Brave Search）。

视频没有字幕轨时，语音识别回退可以把音频转成带时间戳的字幕。只有开启无字幕回退且当前视频确实没有字幕时，扩展才会抓取音频。

API Key 由你自己配置。扩展直接连接你选择的 AI、语音识别和搜索服务，不经过本项目开发者。

需要帮助或报告问题，请访问 https://github.com/Edmund724/Bilibili-Summary/issues。

**Category**: Productivity

**Single Purpose**: 在 B 站视频页内整理可跳转字幕和摘要。

**Primary Language**: 简体中文

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|---|---|---|---|
| Store Icon | 128x128 PNG | Ready | `extension/icons/icon128.png` |
| Screenshot 1 | 1280x800 or 640x400 | Needs update | `docs/images/demo-subtitle.png` |
| Screenshot 2 | 1280x800 or 640x400 | Needs update | `docs/images/demo-overview.png` |
| Screenshot 3 | 1280x800 or 640x400 | Needs update | `docs/images/demo-ai-chat.png` |
| Screenshot 4 | 1280x800 or 640x400 | Not created | |
| Screenshot 5 | 1280x800 or 640x400 | Not created | |
| Small Promo Tile | 440x280 | Not created | |
| Marquee Promo Tile | 1400x560 | Not created | |

### Screenshot Notes

Refresh the screenshots after the toolbar entry and compatibility fixes are complete. The first screenshot should show the timestamped subtitle list next to an active video. The second should show the overview with chapter navigation, and the third should show a real AI answer without exposing an API Key or private conversation.

## Permissions Justification

| Permission | Type | Justification |
|---|---|---|
| `storage` | permissions | Save API keys, notes, conversations, subtitles, summaries, settings, and cache entries locally. |
| `unlimitedStorage` | permissions | Exempt local stores — subtitle, segment-summary, and overview caches, AI conversation sessions, and raw transcripts — from Chrome's normal storage quota; the cache families keep the 3 most recent videos per family with no byte limit, so saved transcripts and summaries are not evicted. |
| `scripting` | permissions | Run the reading interface and player controls on supported Bilibili video pages. |
| `offscreen` | permissions | Decode audio and process AI or ASR streams in a background document while the user continues browsing the video page. |
| `declarativeNetRequest` | permissions | Add short-lived session rules that set the Referer/Origin headers for requests to Bilibili's audio CDN while an active speech-recognition task is running, then remove those rules when the task finishes. |
| `https://www.bilibili.com/*` | host_permissions | Read supported video and watch-later pages so the extension can add the 文摘 button and reading interface. |
| `https://api.bilibili.com/*` | host_permissions | Fetch video metadata and subtitle data while the user is reading or summarizing a Bilibili video. |
| `https://*.hdslb.com/*` | host_permissions | Fetch subtitle files (subtitle-body JSON) hosted on Bilibili's CDN. |
| `https://*.bilivideo.com/*` | host_permissions | Download the audio track from Bilibili's CDN only when the speech-recognition fallback is enabled and the current video has no subtitle track. |
| `https://api.tavily.com/*` | host_permissions | Send a model-generated query to Tavily and return results, only while the user has enabled web search and selected Tavily as the search provider. |
| `https://api.exa.ai/*` | host_permissions | Send a model-generated query to Exa and return results, only while the user has enabled web search and selected Exa as the search provider. |
| `https://api.search.brave.com/*` | host_permissions | Send a model-generated query to Brave Search and return results, only while the user has enabled web search and selected Brave Search as the search provider. |
| `http://*/*`, `https://*/*` | optional_host_permissions | Connect to an AI or speech-recognition endpoint that the user explicitly adds, including a local Whisper service or a self-hosted/intranet HTTP endpoint of a custom AI platform. Chrome may request this access when the user saves a matching provider. |

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?**: Yes. Data is processed to provide the video reading, note, AI, and speech-recognition features. The project developer does not operate an account system or receive this data.

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|---|---|---|---|---|
| Personally identifiable info | No | No | Not required. | No |
| Health info | No | No | Not required. | No |
| Financial info | No | No | Not required. | No |
| Authentication info | Yes, user-provided API keys | Yes, to the provider selected by the user | Authenticate the user's chosen AI, speech-recognition, or search provider. | Only with that selected provider |
| Personal communications | Yes, AI conversation text and images the user pastes into chat | Yes, to the selected AI provider | Answer questions about the current video. | Only with that selected provider |
| Location | No | No | Not required. | No |
| Web history | No | No | The extension reads only the active supported Bilibili video and the watch-later page. | No |
| User activity | Yes | Yes, when a user requests AI analysis or speech recognition | Store notes and settings, and provide requested analysis or speech recognition. | Only with the selected AI or speech-recognition provider |
| Website content | Yes, current video metadata, subtitles, selected text, comments used for analysis, and audio only when speech-recognition fallback is enabled | Yes, based on the user's requested feature and provider settings; web-search queries go to the selected search provider only while the user enables web search | Create summaries, explanations, translations, notes, conversations, timestamped speech-to-text results, and web-search results. | Bilibili requests go directly between the user's browser and Bilibili; feature content is sent only to the selected provider |

### Data Use Certification

- [x] Data is not sold to third parties.
- [x] Data is not used for creditworthiness or lending purposes.
- [x] Data is not used for advertising, analytics, behavior tracking, or any purpose unrelated to the core features.

## Privacy Policy

**Privacy Policy URL**: https://github.com/Edmund724/Bilibili-Summary/blob/main/PRIVACY.md

The policy and the store disclosure must be checked together before submission. `chrome.storage.sync` sends non-sensitive settings through the user's Chrome account. API keys, notes, conversations, and caches remain in `chrome.storage.local`.

## Distribution

**Visibility**: Public

**Regions**: All regions

## Developer Info

**Publisher Name**: [Required before submission and must match the Google Play publisher account]

**Contact Email**: [Required before submission; use a monitored public support address]

**Support URL / Email**: https://github.com/Edmund724/Bilibili-Summary/issues

**Homepage URL**: https://github.com/Edmund724/Bilibili-Summary#readme

## Version History

| Version | Date | Changes | Status |
|---|---|---|---|
| 2.2.2 | 2026-09-24 | Chat accepts pasted images (compressed locally to WebP, long edge ≤1568px, up to 4 per message) on the OpenAI and Anthropic protocols; the provider editor shows a read-only model catalog with context window and reasoning/image badges; truncated chat answers now carry a persistent badge and retry once at double the output budget when the model returns no text; more presets register their Anthropic endpoints and DeepSeek defaults to the Anthropic protocol; the Responses protocol adapter and the OpenAI preset were removed. | Draft |
| 2.2.1 | 2026-09-18 | AI provider setup gains a protocol selector with three adapters: OpenAI, Anthropic, and Responses; background service worker size reduced (-26%) via protocol vocabulary split; settings snapshot and segment-cache write aggregation improve hot-path performance; reader panel header deduplicated. | Draft |
| 2.2.0 | 2026-09-14 | Optional web search for AI chat and selection explanations (Tavily / Exa / Brave) with a search timeline, source links, and inline citations; Mermaid rendering in AI answers limited to flowcharts and sequence diagrams; the note player embed can be turned off; provider model lists, in-panel confirmation dialogs, and a batch of streaming, cache, and bundle-size optimizations. | Draft |
| 2.1.0 | 2026-09-09 | Chrome 120 baseline, one Digest entry behavior from both the page button and toolbar icon, restricted Offscreen message flow, bounded ASR audio permissions, and updated compatibility and data-use notes. | Draft |

## Review Notes

### Known Issues / Limitations

Before submission:

- Implementation tickets #01 through #05 are merged; ticket #06 (chrome-runtime-acceptance) must pass before submission.
- Update the support screenshots to show the current in-page 文摘 panel with both entry points (page 文摘 button and toolbar icon).
- Confirm that the extension name and Bilibili references comply with the Chrome Web Store trademark policy.
- Fill in the publisher name and a monitored contact email.
- Verify that the GitHub-hosted privacy policy URL is public and matches the completed code.
- Rebuild the 2.2.0 archive from the verified final source with `pnpm run build` and `pnpm run build:release`; do not submit an archive built from an earlier revision.

### Rejection History

None recorded.
