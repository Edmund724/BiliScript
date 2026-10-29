# BiliScript 宣传片制作

当前宣传片是 1920×1080、30fps、35 秒的中文横版 Remotion 工程。新会话按本文件开始；创作意图看 `DIRECTION.md`，精确帧号看时间轴代码，不要从旧渲染记录反推制作流程。

## 冷启动

```sh
pnpm install
pnpm promo:studio
```

`promo:studio` 会合成音频、准备素材并打开 Remotion Studio。已跟踪的录屏、海报和裁剪框足够完成修改与渲染，不需要本机已有 `.scratch/`、`release/` 或浏览器登录状态。

阅读顺序：

1. `DIRECTION.md`：为什么这样拍、宣传口径与镜头意图。
2. `timeline.mjs`：镜头帧区间、分镜与证据采样点。
3. `video/Root.tsx` → `video/Promo.tsx` → 对应镜头实现。
4. `audio.mjs`、`captions.mjs`：声音事件与字幕。

## 浏览器缓存

Remotion 的 Chrome Headless Shell 只保留主 checkout 的 `node_modules/.remotion/chrome-headless-shell`，worktree 直接复用，不再各下载约 280MB。`render.mjs` 与 `remotion.config.ts` 都通过 `browser-executable.mjs` 解析：

1. `BILISCRIPT_REMOTION_BROWSER_EXECUTABLE` 指定的路径优先；
2. 否则用 `git rev-parse --git-common-dir` 找到主 checkout，缓存里的可执行文件存在就复用；
3. 都不成立时返回 `null`，由 Remotion 按默认逻辑下载。

浏览器二进制不进版本库，也不在 worktree 之间复制。

## 按任务开始

| 任务 | 命令 | 产物 |
| --- | --- | --- |
| 修改镜头并预览 | `pnpm promo:studio` | Remotion Studio |
| 输出单镜头关键帧 | `pnpm promo:audio && node scripts/promo/render.mjs --scene=hero --stills-only` | `.scratch/promo/evidence/hero/` |
| 渲染全片草稿 | `pnpm promo:audio && node scripts/promo/render.mjs --draft` | `.scratch/promo/evidence/BiliScript-promo-draft.mp4` |
| 正式渲染 | `pnpm promo:render` | `release/` 中的 MP4、封面、SRT 与 credits |
| 只改字幕或致谢 | `node scripts/promo/render.mjs --post-only` | 按新事实源重生成 `release/` 的 SRT、credits、封面与母版，并刷新 `.scratch/promo/evidence/final-*`；不重渲视频帧 |
| 草稿验收 | `pnpm promo:verify -- --kind=draft .scratch/promo/evidence/BiliScript-promo-draft.mp4` | `.scratch/promo/evidence/draft-*` |
| 最终验收 | `pnpm promo:verify -- --kind=final release/BiliScript-promo-1080p.mp4` | `.scratch/promo/evidence/final-*` |
| 重录单镜头 | 见下节 | 替换 `public/media/` 中对应素材后重新渲染 |

单镜头 id：`hero`、`subtitle`、`overview`、`chat`、`subtools`、`websearch`、`appearance`、`providers`、`outro`。把 `--scene=hero` 换成目标 id；去掉 `--stills-only` 还会输出该镜头的草稿视频。

`promo:verify` 必须显式指定产物类型和路径，并在检查前打印绝对路径。draft 按 960×540 验收，final 按 1920×1080 验收；完整回放、音频和视觉证据检查保持一致。

## 重录

重录使用真实 B 站页面、真实扩展和真实平台配置，不是冷启动前置条件。先构建扩展并启动专用浏览器：

```sh
pnpm build
node scripts/promo/session.mjs start
```

在打开的窗口登录 B 站，在文摘面板设置中配置并测试 AI 平台。可用 `node scripts/promo/session.mjs status` 检查页面状态，结束后运行 `node scripts/promo/session.mjs stop`。

统一入口是 `node scripts/promo/record.mjs <镜头 id>`。录制直接更新 `public/media/` 中实际参与渲染的素材，不再手工从 scratch 拷贝；原始帧保留在 `.scratch/promo/frames/`，输出与操作证据写入 `.scratch/promo/evidence/<镜头 id>.json`。

| 镜头 | 录制命令 | 直接更新的入库素材 |
| --- | --- | --- |
| hero | `node scripts/promo/record.mjs hero` | `hero-hook.mp4`、`hero-panel.png` |
| subtitle | `node scripts/promo/record.mjs subtitle` | `subtitle-seek-03.mp4` |
| overview | `node scripts/promo/record.mjs overview` | 两条 overview MP4 与 `overview-poster.jpg` |
| chat | `node scripts/promo/record.mjs chat` | `chat.mp4` |
| appearance | `node scripts/promo/record.mjs appearance` | `appearance.mp4` |
| providers | `node scripts/promo/record.mjs providers` | `ai-providers.mp4` |

重录后运行 `pnpm promo:render`。`media.mjs` 是录制素材文件名的唯一清单，录制 module 与 `prepare` 都从这里读取输出契约。

overview、chat、appearance 重录会分别更新 `generated/panel-crops.json` 中的对应项，与入库素材一起提交。`prepare` 只读取并校验该文件，不读取 `.scratch/promo/frames/`；原始帧仅作为本地录制证据保留。

## 工件地图

| 类别 | 位置 | 内容 |
| --- | --- | --- |
| 镜头实现 | `scripts/promo/video/`、`index.ts` | Remotion 合成与视觉实现 |
| 时间事实 | `timeline.mjs`、`outro-timeline.mjs`、`subtitle-timeline.mjs` | 帧区间、镜头内部节拍、跳播接缝与证据采样点 |
| 声音与字幕事实 | `audio.mjs`、`captions.mjs`、`synthesize-audio.mjs` | cue、字幕与音频合成 |
| 已跟踪媒体 | `public/media/`、`assets/providers/`、`assets/voice/` | 录屏、海报、平台 Logo 与原片人声 |
| 裁剪框事实 | `generated/panel-crops.json` | 由录制入口按镜头更新，`prepare` 与渲染只读 |
| 本地生成物 | `.scratch/promo/` | 合成音频、运行时 public、录制帧、草稿与验收证据 |
| 交付物 | `release/` | 正式 MP4、母版、封面、SRT 与 credits |

## 修改纪律

- `DIRECTION.md` 保留创作方向与镜头意图；精确时间只改时间轴、音频或字幕事实源，不再复制第二份逐秒表。
- 领域用语遵循根 `GLOSSARY.md`；“宣传片”与 B 站“视频”不是同一概念。
- 当前工程使用 Remotion，不依赖 `plan.json`、HTML+GSAP 或 `om`。项目里的通用视频 skill 只提供创作与验收方法，不是另一条必须执行的构建链。
- 自动检查通过后仍要实际查看关键帧、转场与全片，并检查声音；没有完成的视觉或听感验收必须明确说明。
