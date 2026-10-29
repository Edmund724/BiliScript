# browser-harness —— 真机验证薄层

零依赖 CDP：起一个隔离的 headless Edge，装上 `dist/` 里的未打包扩展，连页面 target 与扩展的 MV3 服务工作线程，各自求值。

```sh
pnpm harness:browser          # 自检（也是 API 用法示例）
pnpm harness:browser --headed # 带窗口
BILISCRIPT_EDGE=<路径> pnpm harness:browser
```

## 什么时候用它

判据是**jsdom（`pnpm test`）够不着**：真实 DOM 几何（宽度 / 溢出 / 贴栏落点）、B 站真实接口与真实响应形状、MV3 SW 的真实生命周期与回收、offscreen 文档、CSP 与真实下载、控制台与网络失败。

够得着的别来这儿。能用 vitest 表达成断言的（含 jsdom 里的整链——喂真接口响应的那种），留在 `tests/`：那是每次改代码都跑的；这个每次都要起浏览器、连真网，慢且带外部依赖。

## 它导出什么

`harness.mjs` 只有管道，没有场景：

| 导出 | 作用 |
|---|---|
| `launchBrowser(opts)` | 唯一端口 + 唯一临时 profile + `--load-extension`；**默认静音**（`muted`）、**默认不允许自动播放**（`autoplay`）、**默认关同步**（`sync`）；等 `/json/version` 就绪，返回 `{ child, pid, exe, port, profileDir, version, args, muted, autoplay, sync }` |
| `attachPage(browser)` | 连页面 target，开 Page/Runtime/Network/Log + 视口倍率 |
| `watchPage(pageCdp)` | 收集页面 console 与网络失败（带上限截断） |
| `createWorkerSession({ pageCdp, browser })` | 连扩展 SW 并等到执行上下文绑定；`evaluate()` 带重连重试（SW 被回收是常态） |
| `screenshot(pageCdp, file)` | 落 PNG |
| `artifactDir(name)` / `writeEvidence(dir, obj)` | 工件落 `.scratch/browser-harness/<name>/`（`.scratch/` 已 ignore） |
| `waitFor(label, fn, opts)` | 轮询到真值，超时报出最后一次的值 |
| `teardown({ browser, cdps })` / `withBrowser(opts, fn)` | 只杀自己 spawn 的进程（`taskkill /PID <自己> /T /F`；profile 删不掉时按 **exe 名 + profile 路径**两道字面量条件补杀），删临时 profile |
| `CDP` | 协议客户端：`send(method, params, sessionId)` / `on(method, fn)` / `evaluate(expr)` |

场景脚本直接 import 这些：

```js
import { withBrowser, attachPage, screenshot, waitFor } from "<repo>/scripts/browser-harness/harness.mjs";

await withBrowser({}, async ({ browser }) => {
  const page = await attachPage(browser);
  await page.cdp.send("Page.navigate", { url: "https://www.bilibili.com/video/BV..." });
  await waitFor("阅读按钮", async () => page.cdp.evaluate("!!document.getElementById('biliscript-script-button')"));
  await screenshot(page.cdp, "out/01.png");
});
```

## 场景层（`scenarios/`）

管道之上是**场景**：一段真机判据，自己起浏览器、自己断言、自己收摊，非零退出即红。

```sh
pnpm harness:scenario --list                                  # 列出现有场景
pnpm harness:scenario bilingual-subtitles                     # 全流程（约 90–120s，需要 bilibili.com）
pnpm harness:scenario bilingual-subtitles -- --fixture-only    # 不起浏览器，秒级
pnpm harness:scenario bilingual-subtitles -- --headed          # 带窗口
```

`run-scenario.mjs` 只做「名字 → `scenarios/<name>.mjs`」的分发与退出码透传；`--` 之后的参数原样交给场景。

| 场景 | 判据 | 成本 |
|---|---|---|
| `bilingual-subtitles`（S1–S10 + S7b） | 双语字幕在**真 B 站页面**上的东西：副列浮层对页面样式级联的胜出、弹层两列各自的滚动位置、真实 listbox 的点击路径、MV3 SW 里的 fixture 补丁、SPA 换视频的偏好保留、解释卡引用只含主行 | 全流程 90–120s（真网一趟 + fixture 补丁一趟）；`--fixture-only` < 1s |
| `subtitle-prefetch`（S1–S5） | 字幕预抓取的真机判据：进视频页**不经任何点击**即发出字幕列表请求、抓取在飞时对话 tab 的等待反馈（spinner 通知条 / 发送键禁用 / placeholder）、字幕在手后点 AI 键零等待上屏、SPA 换片也预抓取、无字幕视频不触发 ASR | 全流程约 80–120s（真网 + SW 目标上的 Fetch 扣住/回放 fixture） |
| `sw-message-router`（S1–S6） | 消息入口路由的真实 MV3 SW 判据（离线、不联网）：未登记类型不答、offscreen 专属类型被页面发送者调用时拿到拒绝信封（`仅接受 offscreen 文档发送`）、已知类型照常路由到真 handler、设置经路由器读写往返稳定、SW 顶层同步注册了入口 | 约 2s（起一次隔离 Edge，不抓网） |
| `reader-follow-button`（F1–F7） | 「字幕」tab 跟随播放悬浮按钮的真机样式判据：manual 态显形（滚轮触发）与 auto 态隐藏、flyme 下液态玻璃胶囊契约（无框透明描边 / card 透镜渐变底 / blur(20px) 磨砂 / 顶沿折射高光 + 漫射浮层阴影，与 token 探针对齐而非硬编码色值）、hover 转 accent-soft 底 + accent 字且描边保持透明、按压 scale 与点击恢复跟随（不 seek）、flyme 深色档 token 换值后仍同族、editorial 浅色/深色两档保持基表 1px 细边实底零滤镜（色板经设置抽屉真实保存链路切换） | 全流程约 30–60s（真 B 站页 + fixture 字幕数据）；`--fixture-only` < 1s |
| `reader-quote-share`（Q1–Q11） | 分享金句卡片弹窗与阅读面板同 token 的真机判据：容器 28px 圆角/superellipse(1.25)/面板阴影/mask 纱（token 现值对齐，四象限通用）、关闭键 34×34/svg 18/hover 与 focus-visible 底=fill-hover 字色不变、操作钮 32px 高 999px（复制透明次要、保存 accent 实底 on-fill 字、hover brightness(1.05)）、busy 禁用 .45、preset/pattern 12px 圆角、选中态 accent-soft 底/accent 字/600 字重/无边框与阴影、卡片 20px 圆角与 6cqi 字号；真指针 hover/active scale(.91)、真 Tab/Escape 键、复制成功 accent 字无铺底 + 剪贴板 image/png 回读、保存 PNG 真实下载落盘验魔数、关闭键/遮罩/Escape 三路径各自可重开、窄视口不横向溢出且操作可达、prefers-reduced-motion 下 transition/animation/active transform 全 none | 全流程约 60–120s（真 B 站页 + fixture 字幕/金句数据 + CDP 授权剪贴板/下载）；`--fixture-only` < 1s |

工件落 `.scratch/browser-harness/scenarios/<name>/`（`evidence.json` + 逐场景 PNG）。断言清单在 `evidence.checks`：任一 FAIL 即退出码 1（`evidence.failed` 是失败项名单）。

### 写场景的规矩

- **只 import `../harness.mjs`**：别再写第二份 CDP 客户端、启动参数、target 挑选或收摊。管道层的教训回流到本目录，场景步骤与页内测量脚本留在场景里。
- **SW 一律经 `createWorkerSession`**（按 `dist/manifest.json` 的 `background.service_worker` 后缀挑 target，并等到 `typeof chrome === "object"`）。SW 被回收是常态：补丁这类副作用要挂在 `onReconnect` 上重打，别假设装一次就活到最后。
- **真输入用 `Input.dispatchMouseEvent`**（见「坑」里 `element.click()` 那条）。点击前确认目标当场有几何，且 `document.elementFromPoint(中心)` 就是它本身；0×0 / 被盖住 / 出视口一律**记 FAIL**，不要静默点空——真机上「副列被页面样式压成 0×0」这类缺陷正是靠这条变成红色的，而不是「点了没反应」。
- **媒体当场收干净**：进阅读模式后立刻 `pause()` 页面里的 `video/audio`，`finally` 里再来一次（见「坑」里「别在页里留还在播的媒体元素」那条）。
- **断言进 `checks`，退出码说话**：只把读数写进 `evidence.json` 不算回归资产，读数对了没人判就是绿的。
- **fixture 是数据不是代码**：写进 `tests/fixtures/`，场景只读，并在断言里自检形状（含按被测实现同一条规则**独立复算**期望值）；场景代码里不得出现 `.scratch/` 路径。

### 场景层的已知限制（这些是判据的边界，不是待办）

- `element.click()` 是 `isTrusted: false`：**播放器控件、剪贴板、下载、全屏、真键击**在这一层都够不着（扩展自己挂的 DOM 能吃，这是场景里其余点击的理由）。要真输入就得算坐标发 CDP 指针事件——`bilingual-subtitles` 已经这么做了；仍够不着的是**文本拖选**（用 `Range` + `selectionchange` 构造，见「坑」里 `element.click()` 那条）。
- headless 里留一个**还在播的 `<video>`** 会让整个浏览器几秒后不再响应 CDP（「坑」里「别在页里留还在播的媒体元素」那条）。场景必须自己 `pause()`；注意这同时会改变「阅读列表跟着播放位置走」这类读数的取值——那种读数只记录、不判定。
- **真网是外部依赖**：页面结构、样式表、接口形状都可能变。`--fixture-only` 是能离线跑的底线（fixture 形状 + 期望值复算），全流程红了要先分辨是产品回归还是站点变更。
- **临时 profile 里的 `chrome.storage.sync` 会被云端整包回放**：默认 `--disable-sync` 已关掉这条（见「坑」里「临时 profile 不等于干净环境」那条），场景另有一条「污染即失败」的判定，免得把回放造成的翻转当成绿色。

## 坑

- **挑 SW target 必须按 `dist/manifest.json` 的 `background.service_worker` 后缀**，别按 `chrome-extension://` 泛匹配：同一个 profile 里还有 Edge 自带组件扩展的 `background.rollup.js`，连错 worker 会让 SW 里的补丁**静默失效**。`attachExtensionWorker` 已按这份声明挑。
- **SW 里的 `fetch` 补丁只在 MV3 SW 存活期间有效**。SW 被回收后重启，补丁就没了。要跨回收保活，得在 `onReconnect` 里重打。
- **`element.click()` 是 `isTrusted: false`**。扩展自己挂的 DOM（文摘面板、选轨弹层）能吃；B 站播放器控件、剪贴板、autoplay、全屏、真键击不一定。要真输入得自己发 `Input.dispatchMouseEvent` + 算坐标。
- **`/json/list` 里组件扩展的 target 一直会有**。断言只看自己的。
- **静音默认开，而且必须开**。无头实例没有窗口、没有标签静音入口：一出声就只能杀进程。出声来源是产品自己的两条路——扩展 `seekReadingTarget` 会 `video.play()`（阅读视图点时间戳＝暂停即播放），B 站页面本身也会自动播放。要听声音（极少）传 `muted: false`。CDP 读不回静音状态，所以只有这个开关是可靠手段。
- **autoplay 默认关**。新 headless 就是真 Chrome，默认要用户手势：`video.play()` 抛 `NotAllowedError`，`AudioContext` 停在 `suspended`，此时 `ctx.resume()` **不 reject 也不 resolve**（吊死到超时）。需要「像用户已经点过一下」的场景传 `autoplay: true`；默认不动它是因为那是产品行为。
- **临时 profile 不等于干净环境，所以默认关同步**。本机 Edge 会用 Windows 账户自动登录：起跑之后云端会给**同一个扩展 ID** 回放一份 `chrome.storage.sync`（drive.mjs 实测一次 13 个键，含 `bilingualSubtitles: true→false` 与 `secondarySubtitleLang: ai-ja→ai-en`），落在场景中途就把读数翻掉——随机，而且看起来完全像产品 bug（同一份脚本 run18 干净、run19 两次撞上）。所以 `launchBrowser` 默认加 `--disable-sync`：关的是**同步机制**，不是 storage 能力，`chrome.storage.sync` 照常读写、只是不出本机（自检的 `sw-storage-sync-works` 在真机上钉这一点）。要真同步行为传 `sync: true`。**但也别为了看这条回放去跑 `sync: true` 的对照**：那个 profile 会把空的扩展存储推上云端，可能盖掉本机真实的已同步设置——这台机器上的那份真实数据正是 run18/run19 的判据来源。
- **别在页里留还在播的媒体元素**。实测：headless 里留一个在播的 `<video>`，几秒后**整个浏览器不再响应 CDP**——`/json/list` 的 ws 连不上、`Target.getTargets` 超时、连页面连接的求值都吊死，排查看起来像扩展坏了。测完当场 `pause()` + `removeAttribute("src")` + `load()` + `remove()`。
- **连上 SW 之后要等执行上下文**。刚连上时 `Runtime.enable` 会立刻返回，但 `typeof chrome` 还是 `"undefined"`（上下文没建起来）；SW 在跑自己的模块图时，发给它的 CDP 命令是**排队**而不是报错，这一窗口里 `Runtime.enable` / `Runtime.evaluate` 会超时不返回，几秒后自己就好。`createWorkerSession` 因此按「短超时轮询、不判死」处理，别把这段时间当死连接去反复重连。
- **只碰自己的进程与自己的临时 profile**。这是真机上有用户会话的机器。要按命令行里的 profile 路径捞漏网的浏览器时，两条约束缺一不可：**exe 名**要一起比（否则这段挑选脚本本身也出现在命令行里，会连坐把宿主进程一起杀掉——真踩过，宿主当场退出），**命令行的路径匹配要用 `.Contains()` 而不是 `-like`**（路径里的反斜杠在 `-like` 里是字面量，多转义一层就永远匹配不到，兜底静默失效）。`teardown` 的补杀就是按这两条写的。

## 与既有走查的关系

本目录是**工具**（入库、复用）。`.scratch/tickets/<票>/walkthrough/` 是**某一次走查的产物**（README + PNG + evidence.json，不入库）。看到 `walkthrough/` 是记录，看到 `scripts/browser-harness/` 是能力。

历史：target 挑选（`/entry/background.js` 后缀）这类逻辑最初手写在 `.scratch/tickets/bilingual-subtitles/walkthrough/drive.mjs`（那份脚本把管道、fixture、十一个场景焊在一起）。管道层抽进本目录之后，**场景层也毕业了**：subtitle-track-picker 票需要同一批真机判据（这条正是「第二张票」的判据），于是双语字幕的十一个场景迁进 `scenarios/bilingual-subtitles.mjs`，其中的 fixture 常量落成 `tests/fixtures/` 下的可提交数据。那份 walkthrough 脚本保持原样不动，它仍是那一次走查的记录。

## 边界：什么进 git，什么不进

- **管道进这里**（本目录）。它被证明会重复：同一仓两次走查用了两套机制。
- **事实进 `tests/fixtures/`**。接口响应与字段形状是数据，丢了就没了——样例：`tests/fixtures/bilibili/bv1mAam6tEL8-subtitle-shape.md`（从 `.scratch` 转写的字幕轨形状与对齐数字；它引用的 `research/01-track-shape.md` 已经丢失，这就是要转写的原因）。`.scratch/` 里的 `research/` 会随票据整理消失，别把它当事实的家。
  - 场景读的 fixture 一律是**可提交数据**：`bilingual-subtitles` 读 `tests/fixtures/bilibili/bilingual-walkthrough/`（`bundles.json` 两个视频的轨列表应答、`bodies.json` 九条正文、`search-expectations.json` 独立复算出的搜索期望、`meta.json` 形状事实与来源说明）。场景只读，并在断言里自检形状；样本 bvid 因此不再是场景里的硬编码参数。
- **场景按需迁**：出现**第二个**需要同一批真机判据的票时才建 `scenarios/`，迁第一个场景、把样本 bvid 与 fixture 变成可提交数据。只被需要过一次的场景留在 `.scratch`，那是验收记录，不是回归资产。双语字幕这一批已经毕业（见上节），后续同类票直接往 `scenarios/` 里加场景。
- **场景层的改动不用回流本目录**。`.scratch/tickets/bilingual-subtitles/walkthrough/drive.mjs` 长到几千行也不影响这里：只有**管道层**的教训才回流——CDP 客户端、启动参数、target 挑选、就绪门、收摊。场景步骤、fixture 生成、页内测量脚本都是它自己的事（写场景的规矩见上）。真机走查的产出是**发现**：发现一旦落定，就补一条 jsdom 断言把它锁住（见 `tests/reader/bilingual-picker.test.ts` 的「真机反向发现的修复锁」一节），走查脚本本身不必变成回归资产。

