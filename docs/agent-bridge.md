# 本地 Agent 桥接指南

BiliScript 支持通过本机 WebSocket 桥接，供 Kimi Code、DeepSeek Harness、Antigravity、Claude Code 等编程 Agent 读取当前 B 站或 YouTube 视频的字幕、热门评论与关键帧。CLI 与扩展之间的数据仅经本机 `127.0.0.1` 传输，不经过任何第三方服务器；后续分析产生的数据传输遵循所用 Agent 自身的模型与隐私设置。

## 前置要求

- 已在 Chrome / Edge 120+ 或桌面端 Firefox 153+ 安装 BiliScript 扩展。
- 宿主机已安装 **Node.js 22.20+**。
- Bridge 必须与浏览器运行在同一宿主机环境中（非容器、非沙箱、非 WSL）；若编程 Agent 运行在隔离沙箱内，需由用户在本机终端执行安装命令。

## 启用与安装

### 1. 开启扩展桥接开关

打开任意 B 站或 YouTube 视频页的文摘面板，进入「设置 → 本地 Agent 连接」，开启开关并点击「去连接」。

- 桥接默认关闭，仅监听与连接 `ws://127.0.0.1:18492`（可在「连接地址」子页测试连通性、修改端口或恢复默认）。
- 若本机尚未安装 Bridge，连接失败弹出的引导窗会按当前操作系统生成对应安装指令，可一键复制使用。

### 2. 运行宿主机一键安装脚本

在宿主机终端执行对应系统的命令，无需 `npx` 或 `git clone`：

- **Windows（PowerShell）**

  ```powershell
  irm https://raw.githubusercontent.com/Edmund724/BiliScript/main/scripts/install-agent.ps1 | iex
  ```

- **macOS / Linux（POSIX Shell）**

  ```bash
  curl -fsSL https://raw.githubusercontent.com/Edmund724/BiliScript/main/scripts/install-agent.sh | sh
  ```

脚本会将 Skill 与内置 CLI 免交互安装至 `~/.agents/skills/biliscript`，自动启动本地 Bridge 并校验扩展连接状态。下载优先走 GitHub 归档，失败后自动切换至 jsDelivr；失效的会话代理仅在当前安装进程内绕开，不会修改系统代理配置。

**版本升级**：直接重新运行上方对应系统的一键安装命令即可，脚本会自动覆盖旧版 Skill / CLI、终止旧 Bridge 进程并拉起新版。

**安装到其他 Agent 目录**：如需安装至 Claude Code 等其他 Agent 的全局技能目录，可执行：

```bash
npx -y skills add Edmund724/BiliScript -g -y
```

安装后按 [skills/biliscript/SKILL.md](../skills/biliscript/SKILL.md) 中的说明调用即可。

## 使用方式与连接特性

安装接通后，直接让编程 Agent 分析当前打开的 B 站或 YouTube 视频，或向其提供 BV 号 / 视频链接即可（YouTube 需在浏览器标签页中打开目标视频）：

- **单趟全量采集**：`fetch` 命令可一次拉取视频元信息、分 P、章节、字幕与最多 20 条热门评论；字幕 UTF-8 JSON 超过 12 KiB 时自动落盘为本地文本文件，供 Agent 按章节时间轴分段精读。
- **按需关键帧采样**：B 站与 YouTube 均支持截取当前播放帧；B 站额外支持对指定秒数截取前后多帧并调用本地读图工具核验画面。
- **无字幕自动转写**：B 站目标视频无原生字幕时，自动复用你在扩展设置中配置的语音识别（ASR）平台进行转写。
- **冷启动与多实例路由**：CLI 与扩展支持 35 秒冷启动宽限等待与断线后指数退避重连，支持多个浏览器实例同时在线并按标签页、BV 号或 YouTube 视频 ID 自动路由。

## 卸载与清理

1. 在扩展「设置 → 本地 Agent 连接」中断开并关闭开关。
2. 停止后台进程并清理本机文件（以下以 Windows PowerShell 默认安装目录与默认端口 `18492` 为例）：

```powershell
$cli = "$HOME\.agents\skills\biliscript\scripts\biliscript.mjs"
$status = node $cli status | ConvertFrom-Json
Stop-Process -Id $status.daemonPid -Force
Remove-Item "$HOME\.agents\skills\biliscript" -Recurse -Force
Remove-Item "$env:TEMP\biliscript-bridge-18492.token" -Force -ErrorAction SilentlyContinue
```

若自定义过安装目录或桥接端口，请将上述路径与 `.token` 文件名中的端口号替换为实际值。
