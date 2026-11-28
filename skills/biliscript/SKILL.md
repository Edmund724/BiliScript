---
name: biliscript
disable-model-invocation: true
description: 通过本机 BiliScript 浏览器扩展读取 B 站与 YouTube 视频字幕、热门评论和关键帧，用于视频总结、问答、内容分析与多模态理解。用户要求分析 B 站或 YouTube 视频、BV 号、视频链接，或查看当前视频的字幕、评论、画面时使用。
---

# BiliScript

使用技能目录内的 `scripts/biliscript.mjs` 调用本机扩展。脚本仅依赖 Node.js 内置模块，直接通过技能目录绝对路径 `<skill-dir>/scripts/biliscript.mjs` 从当前工作目录执行。

## 前置条件与连接机制

- 用户已在 Chrome 或 Edge 安装 BiliScript，并在「设置 → 本地 Agent」开启连接或点击「去连接」。
- 本机可运行 Node.js。无原生字幕的视频需要自动转写时，用户需在扩展设置中开启「无字幕时自动生成字幕」并配置语音识别平台。
- **冷启动自动等待重连**：本地 Bridge Daemon 默认监听 `127.0.0.1:18492`（可用 `BILISCRIPT_BRIDGE_PORT` 覆盖），空闲 5 分钟（300 秒）后自动退出。任意 CLI 命令均会按需拉起 Daemon；`tabs`、`fetch`、`subtitles`、`comments`、`frame` 与 `status --wait` 在冷启动时会自动进入最长 **35 秒**的宽限等待队列，扩展断开后会先按 **1s → 2s → 4s → 8s** 指数退避重连并每 **30 秒**周期唤醒，接通后立即执行已排队请求。`status`（无 `--wait`）立即返回当前状态；显式等待重连可使用 `status --wait`。
- **无需重复配置 MCP**：已加载本 Skill 的编程 Agent 直接使用内置 CLI 即可，无需在同一客户端重复配置 BiliScript MCP Server（MCP 仅面向不支持 Skill 的纯对话桌面客户端）。

## 工作流

以下命令中的 `<skill-dir>` 替换为本技能所在目录的绝对路径。

### 1. 目标选择

按已知条件选择最短入口：

- **已知视频 ID 或链接**：直接跳至第 2 步并传入 `--bvid <ID/URL>`（或等价别名 `--video <ID/URL>`）。B 站支持 BV 号、带 `?p=` 分 P 参数的链接（含未打开标签页后台直拉）；YouTube 支持 `youtube.com/watch?v=...`、`youtu.be/...` 或 11 位视频 ID，且要求目标视频已在浏览器标签页中打开。
- **分析当前活动视频标签页**（B 站或 YouTube）：直接跳至第 2 步并省略目标参数。
- **需要从多个已打开标签页中选择**：先列出当前视频标签页（Daemon 快照超时 6 秒）：

```bash
node "<skill-dir>/scripts/biliscript.mjs" tabs
```

`tabs` 返回已打开视频的 `site`（`bilibili` | `youtube`）、`tabId`、`bvid`（B 站 BV 号或 YouTube 11 位原始 ID）、`title`、`currentTime`、`duration` 与 `subtitlesReady`（当前活动标签带 `active: true`）。同时连接多个浏览器实例时，`tabs` 会聚合所有在线实例并分配不冲突的 `tabId`；`--tab` 路由到所属实例，`--bvid` / `--video` 优先命中已打开该视频的实例，省略参数时优先选活动视频标签页。

**完成判据**：已确定目标参数（`--bvid <ID/URL>`、`--video <ID/URL>`、`--tab <tabId>` 或省略以指向当前活动标签页）；若任务涉及当前播放进度，已记录对应的 `currentTime`。

### 2. 单趟拉取字幕与热评（长字幕按文件精读）

执行单趟采集命令一次获取视频元信息（`video`）、分 P（`pages`）、章节（`chapters`）、字幕（`subtitle`）与最多 20 条热门评论及高赞楼中楼（`comments`）：

```bash
node "<skill-dir>/scripts/biliscript.mjs" fetch [--tab <id>|--bvid <ID/URL>|--video <ID/URL>] [--from <sec> --to <sec>] [--out <dir>]
```

- **大字幕自动落盘精读**：当 `subtitle.items` 的 UTF-8 JSON 体积超过 **12 KiB（12288 字节）** 或显式指定 `--out <dir>` 时，CLI 会将字幕写入 `${bvid}(-p${page})-${batchId}.txt`（默认位于系统临时目录），每行格式为 `<时间> <文本>`（不补零，如 `2:30 内容`；末尾时间达 1 小时及以上时带小时位，如 `1:02:30 内容`），JSON 中的 `subtitle` 返回 `{ source, trackId, language, path, count, from, to }`。遇到 `subtitle.path` 时，使用文件读取或文本检索工具结合 `chapters` 时间段与 `count` 分段精读，或追加 `--from <sec> --to <sec>` 提取局部区间。
- **无字幕自动转写与容错**：B 站视频无原生字幕且扩展已启用 ASR 时自动转写并返回 `source: "asr"` 字幕；YouTube 暂不支持无字幕 ASR 转写，且其原生/自动字幕均标 `source: "youtube"`。`fetch`、`subtitles`、`comments` 在 Bridge 与 CLI 侧均不设固定短超时，支持长视频与转写等待。热评请求失败时返回 `comments: []` 与 `commentsError`，字幕与元信息正常返回。
- **单项补拉**：仅需补拉局部字幕或热评时，可单独调用 `subtitles [--tab <id>|--bvid <ID/URL>|--video <ID/URL>] [--from <sec> --to <sec>] [--out <dir>]` 或 `comments [--tab <id>|--bvid <ID/URL>|--video <ID/URL>]`。
- **证据区分与时间锚点**：以 `subtitle` 和 `chapters` 作为视频内容事实依据，以 `comments` 作为观众观点与热点补充；整理要点时保留秒级时间锚点，便于下一步定位画面。

**完成判据**：已获取完整的 `video`、`chapters`、`subtitle`（内联 `items` 或已用文件工具读取 `subtitle.path` 相关区间）及 `comments`（或已确认 `commentsError`），并列出需要核验画面的精确秒数。

### 3. 定位关键秒数截帧并用读图工具核验画面

依据用户问题、章节和字幕确定目标时间戳后再截取关键帧：

```bash
# 已打开标签页的当前播放帧（B 站 / YouTube 均支持，不改变播放位置）
node "<skill-dir>/scripts/biliscript.mjs" frame [--tab <id>|--bvid <ID/URL>|--video <ID/URL>] [--out <dir>]

# 指定时间点附近前、中、后三帧（t-2s、t、t+2s，边界处可能更少；仅 B 站支持，未打开视频必传 --time）
node "<skill-dir>/scripts/biliscript.mjs" frame [--tab <id>|--bvid <BV/URL>] --time <sec> [--out <dir>]
```

- CLI 将 JPEG 写入 `--out` 指定目录（默认写入系统临时目录），输出每张图片的绝对路径 `frames[].path`、`targetTime` 与实际 `currentTime`。
- 同一视频的多个时间点可并发提交 `frame` 命令：扩展在队列内复用同一隐藏视频串行 seek，并在队列空闲、切换视频或出错时立即释放媒体。扩展单次截帧超时为 **45 秒**，Bridge Daemon 兜底等待超时为 **50 秒**；若单次超时，确认目标秒数或刷新页面后单次重试即可。
- 调用 Agent 自身的图片读取工具逐张打开 `frames[].path` 核验真实画面，结合 `currentTime` 描述画面细节并与字幕、评论交叉印证。

**完成判据**：所有目标 `frames[].path` 均已通过图片读取工具实际查看，视觉观察与 `currentTime`、字幕及章节证据交叉核验完毕后输出最终回答。

## 结果与错误处理

- CLI 输出单行 JSON；`ok: false` 且进程非零退出表示失败，根据 `error` 与字段处理：
  - `extensionOnline: false`（超过 35 秒冷启动宽限后仍未连接）：引导用户在扩展「设置 → 本地 Agent」开启连接或点击「去连接」。
  - ASR 未启用或配置不可用：引导用户在扩展设置中开启「无字幕时自动生成字幕」并检查语音识别平台、模型与域名授权。
  - 已打开标签页截帧失败：请用户刷新视频标签页后重试；未打开的视频改传 `--bvid <BV/URL> --time <sec>`。
- Bridge 仅在 `127.0.0.1` 上连接本机扩展。后续内容由 Agent 的模型分析时，遵循该 Agent 的隐私与数据设置。
