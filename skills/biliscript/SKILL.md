---
name: biliscript
description: 通过本机 BiliScript 浏览器扩展读取 B 站视频字幕、热门评论和关键帧，用于视频总结、问答、内容分析与多模态理解。用户要求分析 B 站视频、BV 号或 bilibili.com 链接，或查看当前视频的字幕、评论、画面时使用。
---

# BiliScript

使用技能目录内的 `scripts/biliscript.mjs` 调用本机扩展。脚本仅依赖 Node.js 内置模块，可在任意工作目录运行；不要假设当前目录就是技能目录，也不要把脚本复制到项目后再执行。

## 前置条件

- 用户已在 Chrome 或 Edge 安装 BiliScript，并在「设置 → 本地 Agent」点击「去连接」完成连接。
- 本机可运行 Node.js。未打开的视频需要无字幕转写时，用户还需在扩展中启用并配置 ASR。

## 工作流

以下命令中的 `<skill-dir>` 替换为本技能所在目录的绝对路径。

### 1. 检查连接并选择视频

```bash
node "<skill-dir>/scripts/biliscript.mjs" status
node "<skill-dir>/scripts/biliscript.mjs" tabs
```

`status` 会按需启动本地 Bridge。若 `extensionOnline` 为 `false`，请用户在扩展的「设置 → 本地 Agent」点击「去连接」，不要反复重启命令。

`tabs` 返回已打开的 B 站视频及 `tabId`、`bvid`、`title`、`currentTime`、`duration` 等字段。根据用户意图选择目标：

- 当前活动视频：省略目标参数。
- 指定已打开标签页：使用 `--tab <tabId>`。
- 任意 BV 号或视频链接：使用 `--bvid <BV/URL>`；链接中的分 P 参数会被保留。

### 2. 获取字幕与热门评论

```bash
node "<skill-dir>/scripts/biliscript.mjs" subtitles [--tab <id>|--bvid <BV/URL>]
node "<skill-dir>/scripts/biliscript.mjs" comments [--tab <id>|--bvid <BV/URL>]
```

字幕结果包含视频元信息、分 P、章节和带时间轴的 `subtitle.items`。评论结果包含最多 20 条热门评论及高赞楼中楼。只需要局部内容时，用秒数过滤字幕：

```bash
node "<skill-dir>/scripts/biliscript.mjs" subtitles --bvid <BV/URL> --from 60 --to 180
```

无原生字幕时，扩展会自动使用已配置的 ASR 转写。结合字幕、章节和评论完成分析；评论代表观众观点，不要当作视频事实。引用内容时保留对应秒数，便于后续定位画面。

### 3. 按需截取关键画面

先根据用户问题、章节和字幕确定关键时间戳，再截帧；不要无目的地批量截图。

```bash
# 已打开标签页的当前播放帧，不改变播放位置
node "<skill-dir>/scripts/biliscript.mjs" frame [--tab <id>|--bvid <BV/URL>] [--out <dir>]

# 指定时间点附近的前、中、后三帧（t-2s、t、t+2s，边界处可能更少）
node "<skill-dir>/scripts/biliscript.mjs" frame [--tab <id>|--bvid <BV/URL>] --time <sec> [--out <dir>]
```

未打开的视频必须提供 `--time`。CLI 会把 JPEG 写入 `--out` 指定目录；省略时使用系统临时目录。命令输出每张图片的绝对路径、`targetTime` 和实际 `currentTime`。

使用 Agent 自己的图片读取工具打开返回的 `frames[].path`，再进行视觉分析。不要从 JSON 推测画面内容，也不要把图片路径当作已读图片。结合 `currentTime` 说明实际画面时刻，并将视觉观察与字幕、评论交叉验证。

## 结果与错误处理

- CLI 输出单行 JSON；`ok: false` 且进程非零退出表示失败，读取 `error` 后针对原因处理。
- 扩展未连接时，引导用户开启桥接；ASR 未开启或未配置时，引导用户检查扩展的语音识别设置。
- 已打开标签页但截帧失败时，可让用户刷新页面后重试；未打开视频的当前帧请求应改为带 `--time` 的历史截帧。
- Bridge 仅在 `127.0.0.1` 上连接本机扩展。后续内容由 Agent 的模型分析时，遵循该 Agent 的隐私与数据设置。
