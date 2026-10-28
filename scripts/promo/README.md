# BiliScript 宣传片制作

当前宣传片是 1920×1080、30fps、33 秒的中文横版 Remotion 工程。新会话按本文件开始；创作意图看 `DIRECTION.md`，精确帧号看时间轴代码，不要从旧渲染记录反推制作流程。

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

## 按任务开始

| 任务 | 命令 | 产物 |
| --- | --- | --- |
| 修改镜头并预览 | `pnpm promo:studio` | Remotion Studio |
| 输出单镜头关键帧 | `pnpm promo:audio && node scripts/promo/render.mjs --scene=hero --stills-only` | `.scratch/promo/evidence/hero/` |
| 渲染全片草稿 | `pnpm promo:audio && node scripts/promo/render.mjs --draft` | `.scratch/promo/evidence/BiliScript-promo-draft.mp4` |
| 正式渲染 | `pnpm promo:render` | `release/` 中的 MP4、封面、SRT 与 credits |
| 最终验收 | `pnpm promo:verify` | `.scratch/promo/evidence/` 中的回放、音频与联系表证据 |
| 重录单镜头 | 见下节 | 替换 `public/media/` 中对应素材后重新渲染 |

单镜头 id：`hero`、`subtitle`、`overview`、`chat`、`appearance`、`providers`、`outro`。把 `--scene=hero` 换成目标 id；去掉 `--stills-only` 还会输出该镜头的草稿视频。

`promo:verify` 默认验收 `release/BiliScript-promo-1080p.mp4`，只应在正式渲染后运行。不要在草稿渲染后用它判断新草稿：当前命令不会自动选择 draft 产物。

## 重录

重录使用真实 B 站页面、真实扩展和真实平台配置，不是冷启动前置条件。先构建扩展并启动专用浏览器：

```sh
pnpm build
node scripts/promo/session.mjs start
```

在打开的窗口登录 B 站，在文摘面板设置中配置并测试 AI 平台。可用 `node scripts/promo/session.mjs status` 检查页面状态，结束后运行 `node scripts/promo/session.mjs stop`。

| 镜头 | 录制命令 | 当前生成物与入库素材的关系 |
| --- | --- | --- |
| hero | `node scripts/promo/record-hero.mjs` | 写入 `.scratch/promo/public/media/`；用生成物替换 `hero-hook.mp4`、`hero-panel.png` |
| subtitle | `node scripts/promo/record-subtitle-seek-03.mjs` | 更新 `subtitle-seek-03.mp4`，同时保留录制证据 |
| overview | `node scripts/promo/record-overview-04.mjs` | 更新两条 overview MP4；首帧在 `.scratch/promo/frames/04-overview-chapters/000000.jpg`，用于替换 `overview-poster.jpg` |
| chat | `node scripts/promo/record.mjs chat` | 只生成 `04-chat` 录制帧；当前没有重新生成 `chat.mp4` 的完整入口 |
| appearance | `node scripts/promo/record-appearance-05.mjs` | 生成 `.scratch/promo/clips/05-appearance.mp4`；用于替换 `appearance.mp4` |
| providers | `node scripts/promo/record-providers-06.mjs` | 生成 `.scratch/promo/clips/06-ai-providers.mp4`；用于替换 `ai-providers.mp4` |

重录后确认 `public/media/` 中实际参与渲染的素材已更新，再运行 `pnpm promo:render`。chat 的完整视频重录是已知缺口，不要把只更新录制帧当成已替换视频。

裁剪框由 overview、chat、appearance 三份 `frames.json` 决定：三份齐全时重新计算；三份都不存在时沿用已提交的 `generated/panel-crops.json`；只存在一部分时 prepare 会报错，避免混合新旧几何。需要回退时移出整个 `.scratch/promo/frames/`，不要只保留其中一部分。

## 工件地图

| 类别 | 位置 | 内容 |
| --- | --- | --- |
| 镜头实现 | `scripts/promo/video/`、`index.ts` | Remotion 合成与视觉实现 |
| 时间事实 | `timeline.mjs`、`outro-timeline.mjs`、`subtitle-timeline.mjs` | 帧区间、镜头内部节拍与跳播数学 |
| 声音与字幕事实 | `audio.mjs`、`captions.mjs`、`synthesize-audio.mjs` | cue、字幕与音频合成 |
| 已跟踪媒体 | `public/media/`、`assets/providers/`、`assets/voice/` | 录屏、海报、平台 Logo 与原片人声 |
| 已提交回退 | `generated/panel-crops.json` | 无录制帧时使用的面板裁剪框 |
| 本地生成物 | `.scratch/promo/` | 合成音频、运行时 public、录制帧、草稿与验收证据 |
| 交付物 | `release/` | 正式 MP4、母版、封面、SRT 与 credits |

## 修改纪律

- `DIRECTION.md` 保留创作方向与镜头意图；精确时间只改时间轴、音频或字幕事实源，不再复制第二份逐秒表。
- 领域用语遵循根 `GLOSSARY.md`；“宣传片”与 B 站“视频”不是同一概念。
- 当前工程使用 Remotion，不依赖 `plan.json`、HTML+GSAP 或 `om`。项目里的通用视频 skill 只提供创作与验收方法，不是另一条必须执行的构建链。
- 自动检查通过后仍要实际查看关键帧、转场与全片，并检查声音；没有完成的视觉或听感验收必须明确说明。
