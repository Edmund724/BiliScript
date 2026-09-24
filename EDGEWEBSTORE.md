# Edge 加载项上架清单 — BiliScript｜B站视频文摘

> 状态：准备稿。按 Partner Center 的六个页面组织，每节内容可直接粘贴。
> 事实与风险基线见 `.scratch/tickets/edge-store-publishing/spec.md`。

## 0. 提交前阻塞项

- [x] 重做截图到 **1280×800**（三张已就绪：`docs/images/store/01~03`）
- [x] 生成 **300×300** 商店 logo（`docs/images/store/logo-300.png`）
- [x] 生成 **440×280** 小促销图（`docs/images/store/promo-440x280.png`，产品实拍方向）
- [ ] 确认 `PRIVACY.md` 已去掉浏览器绑定表述（本轮已改）
- [ ] 备好发布者显示名与受监控的支持邮箱
- [ ] 定稿 Notes for certification（见 §6，这条做不好会以"无法测试"被拒）

## 1. Packages

直接上传 zip，不需要任何 manifest 改动：

- 包内**无 `update_url`**（这是 Edge 移植文档唯一要求删除的字段，本仓库本来就没有）
- `minimum_chrome_version` 是 Edge 官方字段列表中的受支持字段，保留
- 无远程代码，无竞品商店链接

包可以复用 `pnpm run build:release` 的产物，文件名 `bilibili-summary-v<版本>-edge.zip`（原 `-chrome.zip` 已改，避免 "chrome" 字样显示在 Partner Center 包列表里）。

## 2. Availability

| 字段 | 取值 |
|---|---|
| Visibility | **Hidden** |
| Markets | 全选（默认） |

Hidden 的含义：不出现在商店搜索与浏览结果里，任何拿到 listing 链接的人都能安装；已安装用户照常收到更新。Edge 没有 Chrome 那种「私密 / 仅测试者」模式。

## 3. Properties

| 字段 | 取值 |
|---|---|
| Category | Productivity（**只能选 1 个**） |
| Website URL | `https://github.com/Edmund724/BiliScript` |
| Support | `https://github.com/Edmund724/BiliScript/issues` |
| Mature content | 否 |

## 4. Privacy

### 4.1 Single purpose（单一用途）

> 在 B 站视频页内提供带时间戳的字幕阅读面板，并按用户请求生成摘要、笔记与 AI 问答。

### 4.2 Permission justification（逐权限）

Edge 表单会把 manifest 里的每个权限单独列出并配一个输入框。

| 权限 | 理由 |
|---|---|
| `storage` | 在本机保存 API Key、笔记、对话、字幕、摘要与设置。 |
| `unlimitedStorage` | 字幕、分段小结、概览缓存的缓存族不设字节上限，需要豁免浏览器常规存储配额，否则已保存的转写与摘要会被系统清理。 |
| `scripting` | 在受支持的 B 站视频页注入阅读界面与播放器控件。 |
| `offscreen` | 用后台文档解码音频、处理 AI 与语音识别流，让用户继续浏览视频页而不被阻塞。 |
| `declarativeNetRequest` | 语音识别任务运行期间，为发往 B 站音频 CDN 的请求临时设置 Referer / Origin 以通过防盗链；任务结束即移除规则。规则只在内存中，不落盘、不远程导入。 |
| `https://www.bilibili.com/*` | 读取受支持的视频页与稍后再看页，以便添加文摘按钮与阅读界面。 |
| `https://api.bilibili.com/*` | 用户阅读或总结 B 站视频时获取视频元数据与字幕数据。 |
| `https://*.hdslb.com/*` | 获取托管在 B 站 CDN 上的字幕文件（字幕正文 JSON）。 |
| `https://*.bilivideo.com/*` | 仅在用户开启语音识别回退、且当前视频确实没有字幕轨时，下载该视频的音轨。 |
| `https://api.tavily.com/*`、`https://api.exa.ai/*`、`https://api.search.brave.com/*` | 仅在用户开启联网搜索并选定对应搜索平台时，代为发送模型生成的查询词并取回结果。 |
| `http://*/*`、`https://*/*`（可选权限） | 连接用户自己添加的 AI 或语音识别端点，包括本机 Whisper 服务与自建 / 内网 HTTP 端点。**不是默认授予**：只在用户保存匹配的平台、或点开模型列表时弹窗申请，删除平台即自动回收。 |

### 4.3 Remote code

选择 **「No, I am not using remote code」**。

全部第三方库（Mermaid、marked、d3）在构建期打包进扩展，运行时不请求也不执行任何远程脚本。

### 4.4 Data usage

按 `PRIVACY.md` 的实际数据流向勾选：

- **收集并传出设备外**：身份验证信息（用户自备的 API Key，仅发往用户自己选择的服务商）；个人通信内容（AI 对话文本、用户主动粘贴的图片，仅发往用户选择的 AI 平台）；用户活动（仅在用户请求 AI 分析或语音识别时）；网站内容（当前视频的元数据、字幕、选中文本、用于分析的评论，以及仅在开启语音识别回退时的音频）。
- **仅本地处理、不传出**：笔记、字幕与摘要缓存、对话历史、设置。
- **明确不收集**：个人身份信息、健康信息、财务信息、位置、浏览历史。
- 认证：不出售数据；不用于信用评估或借贷；不用于广告、分析、行为追踪或任何与核心功能无关的用途。

### 4.5 Privacy policy URL

`https://github.com/Edmund724/BiliScript/blob/main/PRIVACY.md`

该文件本轮已改为不绑定特定浏览器，满足开发者政策 1.5.2（隐私政策应主要提及 Microsoft Edge 而非其他浏览器）。

## 5. Store listings（简体中文，单语言）

包内没有 `_locales`，Partner Center 只会检测出一个语言行，填这一行即可。

| 字段 | 内容 |
|---|---|
| Extension name | 「BiliScript｜B站视频文摘」—**只读**，取自 manifest |
| Short description | 「在 B 站视频页阅读带时间戳字幕，生成摘要与 AI 对话。」—**只读**，取自 manifest |
| Category | Productivity |
| Store logo | 300×300（1:1） |
| Screenshots | 3–6 张，均 1280×800 |
| Small promotional tile | 440×280 |
| Large promotional tile | 1400×560（可选） |
| YouTube video URL | 无 |
| Search terms | 见下（≤7 个，每个 ≤30 字符，总 ≤21 词） |

**Search terms 建议**：`B站字幕`、`视频摘要`、`AI 总结`、`B站笔记`、`字幕阅读`、`视频翻译`、`语音转文字`

### Detailed description

> BiliScript 在 B 站视频页右侧打开文摘阅读面板，让你一边看视频，一边读取逐句字幕、章节和 AI 摘要。点击视频播放器下方的文摘按钮，或点击浏览器工具栏上的扩展图标——两个入口完全等价，打开的是同一个页面内阅读面板。设置、字幕、概览和 AI 对话都在这个面板内。
>
> 你可以按时间跳转字幕，搜索当前句，复制或下载 Markdown、SRT 和 TXT。概览会整理章节和重点引用。AI 对话能围绕当前视频追问，并使用你配置的模型；选中字幕后，可以继续请求讲解、翻译或润色。可选开启联网搜索后，模型在需要视频之外的信息时可自行查询，回答中给出搜索时间线、来源链接与内联引用；该功能默认关闭，需要用户自行配置搜索平台（Tavily / Exa / Brave Search）。
>
> 视频没有字幕轨时，语音识别回退可以把音频转成带时间戳的字幕。只有开启无字幕回退且当前视频确实没有字幕时，扩展才会抓取音频。
>
> API Key 由你自己配置。扩展直接连接你选择的 AI、语音识别和搜索服务，不经过本项目开发者。
>
> 需要帮助或报告问题，请访问 https://github.com/Edmund724/BiliScript/issues。

## 6. Notes for certification

这一节是过审的关键：审核员没有 API Key，必须让他们知道不看 AI 也能测完主要功能。

> 本扩展的 AI、语音识别与联网搜索功能需要使用者自行配置第三方 API Key，认证人员没有 Key，因此这些功能无法在审核环境验证。请按以下范围测试，全部无需任何账号或 Key。
>
> **无需 Key 即可完整测试的功能**
> 1. 在 Edge 中任选一个有字幕的 B 站视频（例如 BV1GJ411x7h7）。
> 2. 页面右侧面板应打开「文摘」阅读视图，逐句字幕带时间戳；点击任一句可跳转播放位置。
> 3. 面板内可保存带时间戳的笔记，并导出 Markdown / SRT / TXT。
> 4. 工具栏图标点击与页面内文摘按钮点击进入的是同一个面板。
> 5. 未配置任何平台时，模型选择器显示「未配置平台」；发起 AI 请求会被前置校验拦下，提示「baseUrl 未配置」或「模型未配置」，不产生任何网络请求。
>
> **需要自备 Key、认证环境无法验证的功能**
> 「概览」分页、AI 摘要与对话、联网搜索、无字幕视频的语音识别回退。这四项都必须真实调用使用者自己配置的平台才会产生内容。它们不影响字幕阅读、笔记与导出这几项主要功能的判定。
>
> **关于 declarativeNetRequest**
> 扩展不静态声明任何 DNR 规则，也不远程导入规则。仅在用户主动开启语音识别回退、且当前视频没有字幕轨时，代码在内存中创建会话规则，为发往 `*.bilivideo.com` 的音频请求设置 Referer / Origin 以通过防盗链；单个视频的音频下载量上限 200MB，任务结束后规则立即移除，规则状态不落盘。

**这一步的残留风险**：扩展**没有任何离线示例数据**（已核实，包内无 fixture、无预置缓存），所以「概览 / AI 对话 / 语音识别」三块在认证环境里完全不可测。政策 §1.3 要求扩展对认证人员可测，存在被判"无法测试"而拒的可能。两条缓解路线，**提交前需要拍板**：

1. 接受风险，只靠 Notes 说明 bring-your-own-key 架构的必然性；
2. 随包放一份纯本地的示例摘要，让「概览」页在无 Key 时也能显示内容（需新增代码与数据，属于产品改动）。

## 7. 提交后

- 状态流转：`In draft` → `In review` → （可选 `Waiting to publish`）→ `In the store`。新提交最多 7 个工作日。
- 审核中可点 **Cancel submission** 撤回，但会**中止当前审核并重新排队**，不是暂停。
- **每次版本更新都要重走审核**。发版节奏密的话，建议 unpacked 渠道当快速通道，Edge 只推稳定版。
- Partner Center 可开启 **Update REST API**（`https://api.addons.microsoftedge.microsoft.com`）自动上传新版本，但只能更新已有产品，首次创建必须在网页端做。
- 加速审核**不能申请**，由微软按用户价值、零提交失败、更新频率、安全性自动分配。
