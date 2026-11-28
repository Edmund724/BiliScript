# 本地 Agent 桥接指南

BiliScript 通过本机 WebSocket 桥接对外提供视频字幕、热门评论与多时间点关键帧读取能力，支持 **Skill + CLI**（面向编程 Agent）与 **MCP Server**（面向桌面对话客户端）两种接入方式。扩展与本地 Bridge 之间的数据仅经本机 `127.0.0.1` 传输，不经过任何第三方服务器；后续分析产生的数据传输遵循所用客户端或 Agent 自身的模型与隐私设置。

## 前置要求

- 已在 Chrome / Edge 120+ 或桌面端 Firefox 153+ 安装 BiliScript 扩展。
- 宿主机已安装 **Node.js 22.20+**。
- Bridge 必须与浏览器运行在同一宿主机环境中（非容器、非沙箱、非 WSL）；若编程 Agent 运行在隔离沙箱内，需由用户在本机终端执行安装命令。

## 接入方式选型

| 维度 | 方式 A：编程 Agent（Skill + CLI） | 方式 B：桌面对话客户端（MCP Server） |
| :--- | :--- | :--- |
| 适用客户端 | Kimi Code、DeepSeek Harness、Antigravity、Claude Code、Codex 等支持 Skill 与终端工具的编程 Agent | Claude Desktop、Cherry Studio、ChatWise 等支持标准 MCP `stdio` 的桌面对话客户端 |
| 调用方式 | 按 Skill 工作流执行 `node <skill-dir>/scripts/biliscript.mjs <cmd>` | 在客户端注册 `node <skill-dir>/scripts/biliscript.mjs mcp`（零第三方依赖） |
| 长字幕处理 | `subtitle.items` 超过 12 KiB 自动落盘 `.txt`，由 Agent 用本地文件工具分段精读 | 纯内存智能分段：≤ 24 KiB 直出全文；超长自动返回章节或 300 秒时间桶目录与开头 180 秒预览，按区间调用 `biliscript_subtitles` 单次最多内联 48 KiB 并返回 `nextFrom` 游标 |
| 多时间点截帧 | `--times` / `--time` 单次上限 **12 帧**，落盘 JPEG 后调用读图工具查看 | `biliscript_frame` 的 `times` / `time` 单次上限 **6 帧**，直接返回原生 JPEG 图片（零临时文件） |

> [!IMPORTANT]
> **同一客户端请勿同时启用 Skill 与 MCP**：已加载 BiliScript Skill 的编程 Agent 直接使用内置 CLI 即可，无需在同一客户端重复配置 BiliScript MCP Server，以免重复加载工具定义导致上下文冗余或调度冲突。

## 启用与安装

### 1. 开启扩展桥接开关

打开任意 B 站或 YouTube 视频页的文摘面板，进入「设置 → 本地 Agent 连接」，开启开关并点击「去连接」。

- 桥接默认关闭，仅监听与连接 `ws://127.0.0.1:18492`（可在「连接地址」子页测试连通性、修改端口或恢复默认）。
- 若本机尚未安装 Bridge，连接失败弹出的引导窗提供 **「编程 Agent（Skill）」** 与 **「桌面客户端（MCP）」** 双标签页，可按当前系统与端口一键复制安装指令或 `mcpServers` JSON 配置。

### 2. 运行宿主机一键安装脚本

在宿主机终端执行对应系统的命令（两种接入方式均需执行此步骤以准备 `~/.agents/skills/biliscript/scripts/biliscript.mjs` 与本地 Bridge，无需 `npx` 或 `git clone`）：

- **Windows（PowerShell）**

  ```powershell
  irm https://raw.githubusercontent.com/Edmund724/BiliScript/main/scripts/install-agent.ps1 | iex
  ```

- **macOS / Linux（POSIX Shell）**

  ```bash
  curl -fsSL https://raw.githubusercontent.com/Edmund724/BiliScript/main/scripts/install-agent.sh | sh
  ```

若在扩展中修改过桥接端口（例如改为 `19000`），安装时附带 `BILISCRIPT_BRIDGE_PORT` 环境变量即可：

```powershell
# Windows (PowerShell)
$env:BILISCRIPT_BRIDGE_PORT='19000'; irm https://raw.githubusercontent.com/Edmund724/BiliScript/main/scripts/install-agent.ps1 | iex
```

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Edmund724/BiliScript/main/scripts/install-agent.sh | BILISCRIPT_BRIDGE_PORT=19000 sh
```

脚本会将 Skill 与内置 CLI 免交互安装至 `~/.agents/skills/biliscript`，自动启动本地 Bridge、校验扩展连接状态，并在终端打印当前宿主机真实绝对路径对应的 `mcpServers` JSON 配置片段。下载优先走 GitHub 归档，失败后自动切换至 jsDelivr；失效的会话代理仅在当前安装进程内绕开，不会修改系统代理配置。

**版本升级**：直接重新运行上方对应系统的一键安装命令即可，脚本会自动覆盖旧版 Skill / CLI、终止旧 Bridge 进程并拉起新版。

### 3. 完成客户端接入

#### 方式 A：编程 Agent（Skill + CLI）

运行一键安装脚本后，支持 `~/.agents/skills` 目录的编程 Agent 可直接加载技能。如需安装至 Claude Code 等其他 Agent 的全局技能目录，可执行：

```bash
pnpm dlx skills add Edmund724/BiliScript -g -y
```

安装后按 [skills/biliscript/SKILL.md](../skills/biliscript/SKILL.md) 中的说明调用即可。

#### 方式 B：桌面对话客户端（MCP Server）

完成第 2 步安装后，将终端输出（或扩展引导弹窗「桌面客户端（MCP）」标签页生成）的 `mcpServers` JSON 粘贴到 Claude Desktop、Cherry Studio、ChatWise 等客户端的 MCP 配置文件中，并将路径中的 `<你的用户名>` 替换为本机实际主目录（或直接复用安装脚本输出的绝对路径）：

- **默认端口（`18492`）示例（macOS，Windows / Linux 替换为对应绝对路径）**

  ```json
  {
    "mcpServers": {
      "biliscript": {
        "command": "node",
        "args": [
          "/Users/<你的用户名>/.agents/skills/biliscript/scripts/biliscript.mjs",
          "mcp"
        ]
      }
    }
  }
  ```

- **自定义端口（如 `19000`）示例**

  ```json
  {
    "mcpServers": {
      "biliscript": {
        "command": "node",
        "args": [
          "C:\\Users\\<你的用户名>\\.agents\\skills\\biliscript\\scripts\\biliscript.mjs",
          "mcp"
        ],
        "env": {
          "BILISCRIPT_BRIDGE_PORT": "19000"
        }
      }
    }
  }
  ```

MCP Server 注册 5 个只读工具：`biliscript_status`、`biliscript_tabs`、`biliscript_fetch`、`biliscript_subtitles` 与 `biliscript_frame`。保存配置并重启客户端即可开始对话。

## 使用方式与连接特性

安装接通后，直接让编程 Agent 或桌面客户端分析当前打开的 B 站或 YouTube 视频，或向其提供 BV 号 / 视频链接即可（YouTube 需在浏览器标签页中打开目标视频）：

- **单趟全量采集与智能分段字幕**：单趟即可拉取视频元信息、分 P、章节、字幕与最多 20 条热门评论。CLI 路径下字幕 JSON 超过 12 KiB 自动落盘供本地文件工具精读；MCP 路径下全程纯内存返回——未传区间且 ≤ 24 KiB 直出全文，超长视频自动切换导览模式（返回章节或 300 秒时间桶目录及开头 180 秒预览），再按目标区间调用 `biliscript_subtitles(from, to)` 分段读取（单区间上限 48 KiB，超限时在完整字幕行边界截断并返回 `nextFrom` 续读游标）。
- **双站多时间点精确截帧**：B 站（含未打开标签页后台直拉）与**已打开标签页的 YouTube** 均支持指定历史时间点截帧，省略时间参数时截取当前播放帧。CLI（`--times` / `--time`，单次上限 12 帧落盘 JPEG）与 MCP（`biliscript_frame` 的 `times` / `time`，单次上限 6 帧原生图片返回）统一默认每点精确采样 **1 帧**（`spanSeconds = 0`），仅在需要核对切屏前后画面时显式附加可选 `--span` / `spanSeconds`（1–8 秒）邻域展开。
- **无字幕自动转写**：B 站目标视频无原生字幕时，自动复用你在扩展设置中配置的语音识别（ASR）平台进行转写。
- **按需连接、5 分钟空闲自退与多实例路由**：本地 Bridge Daemon 空闲 5 分钟后自动退出；MCP 进程空闲期间不持有 Daemon 长连接，每次工具调用按需短连复用（多客户端窗口并发零端口冲突）。CLI、MCP 与扩展均支持 35 秒冷启动宽限等待与断线指数退避重连，支持多个浏览器实例同时在线并按标签页、BV 号或 YouTube 视频 ID 自动路由。

## 卸载与清理

1. 在扩展「设置 → 本地 Agent 连接」中断开并关闭开关；如曾配置 MCP 客户端，从客户端 MCP 配置中移除 `biliscript` 条目。
2. 停止后台进程并清理本机文件（以下以默认安装目录与默认端口 `18492` 为例）：

- **Windows（PowerShell）**

  ```powershell
  $cli = "$HOME\.agents\skills\biliscript\scripts\biliscript.mjs"
  $status = node $cli status | ConvertFrom-Json
  Stop-Process -Id $status.daemonPid -Force
  Remove-Item "$HOME\.agents\skills\biliscript" -Recurse -Force
  Remove-Item "$env:TEMP\biliscript-bridge-18492.token" -Force -ErrorAction SilentlyContinue
  ```

- **macOS / Linux（POSIX Shell）**

  ```bash
  CLI="$HOME/.agents/skills/biliscript/scripts/biliscript.mjs"
  PID=$(node -e 'const s = JSON.parse(require("node:child_process").execFileSync("node", [process.argv[1], "status"], { encoding: "utf8" })); process.stdout.write(String(s.daemonPid || ""));' "$CLI")
  [ -n "$PID" ] && kill "$PID"
  rm -rf "$HOME/.agents/skills/biliscript" "${TMPDIR:-/tmp}/biliscript-bridge-18492.token"
  ```

若自定义过安装目录或桥接端口，请将上述路径与 `.token` 文件名中的端口号替换为实际值。
