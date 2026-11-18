# 开发与架构指南

## 环境与构建

仓库通过 `package.json` 的 `devEngines` 锁定 **pnpm 12.x**（使用 `npm install` 会触发 `EBADDEVENGINES` 拒绝执行；一次性 CLI 工具请使用 `pnpm dlx <pkg>`）。

```bash
git clone https://github.com/Edmund724/BiliScript.git
cd BiliScript
pnpm install

pnpm run dev            # 监听模式，修改源码持续重建到 dist/
pnpm run build          # 单次构建到 dist/（含 sourcemap）
pnpm run build:release  # 生成发布压缩包到 release/（不含 sourcemap）
```

日常开发运行 `pnpm run dev`，随后打开 `chrome://extensions/` 或 `edge://extensions/`，开启「开发者模式」，点击「加载已解压的扩展程序」并选择仓库下的 `dist/` 目录即可。

## 二次开发与验证

你可以配合编程 Agent 按个人需求定制功能（如调整概览提示词、扩展导出格式或接入私有模型）。提交改动前请执行完整静态检查与测试，并在真实 B 站视频页核验行为：

```bash
pnpm test
pnpm run typecheck
pnpm run build
```

涉及真实 DOM 几何、MV3 Service Worker 生命周期、Offscreen 文档或 CSP 边界的改动，可运行真机自检套件 `pnpm harness:browser`（场景编写说明见 `scripts/browser-harness/README.md`）。

> 请始终保留在扩展设置界面填写 API Key 的机制，切勿将任何私钥硬编码进源码。

## 目录结构

```text
extension/
├── manifest.json          # MV3 扩展清单
├── _locales/              # 多语言文案资源
├── entry/                 # 运行时入口（background、content、offscreen 及样式）
├── agent-bridge/          # 本地 Agent WebSocket 桥接、多实例路由与视频采集
├── ai/                    # AI 客户端、多协议适配、长视频 L0/L1 索引与两阶段混合召回、SSE 流式解析与播放器快捷按钮
├── asr/                   # 语音识别（音频分片、并发转写、WAV 编码）
├── bilibili/              # B 站 API 网关与视频 ID 解析
├── chat/                  # 对话运行时与本地会话存储
├── live/                  # 实时伴看（MOSS Live / Gemini Live 会话、音画同步与浮窗）
├── search/                # 联网搜索（多平台适配器、智能回退链与缓存执行器）
├── core/                  # 核心状态管理、运行时与消息分发
├── notes/                 # 导出渲染（Markdown、SRT、TXT）
├── subtitle/              # 字幕抓取、双语轨道事务、翻译与缓存
├── reader/                # 文摘面板视图生命周期、跟随同步与布局
├── ui/                    # 通用 UI 组件、Markdown / 公式 / 图表渲染与时间戳导航
├── shared/                # 跨模块基础工具（DOM、日志、字符串处理等）
└── icons/                 # 扩展图标资源
```

- **构建产物边界**：`extension/entry/content-bootstrap.iife.js`、`extension/entry/content-main.mjs` 与 `extension/entry/chunks/` 由构建脚本自动生成，请勿手动编辑。
- **运行时依赖**：生产依赖仅包含 `katex`（LaTeX 公式排版）与按需懒加载的 `mermaid`（流程图与时序图渲染），不影响常驻包体积。

## 评测基准与架构文档

- **Agent 协作规范**：编程 Agent 在本仓库工作时请遵循根目录 [`AGENTS.md`](../AGENTS.md) 中的工具链、测试与架构约束。
- **ASR 转写模型与并发评测**：可运行 `pnpm run eval:run` 复现 60 分钟音频（5 分钟/片、10 并发）下各模型的实测耗时与 RTF，或运行 `pnpm run eval:sweep` 压测并发度。转写并发固定上限为 10 片，源于对硅基流动的实测结果：超过 12 并发会触发服务端排队，20 并发整体耗时反而慢于 9 并发。
- **领域模型与架构决策**：核心领域术语以根目录 [`GLOSSARY.md`](../GLOSSARY.md) 为准；历次架构裁决与审查红线索引见 [docs/adr/README.md](adr/README.md)。
