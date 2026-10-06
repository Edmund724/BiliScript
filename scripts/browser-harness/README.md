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

历史：`/entry/background.js` 这类挑选逻辑最初手写在 `.scratch/tickets/bilingual-subtitles/walkthrough/drive.mjs`（那份 1.7k 行脚本把管道、fixture、九个场景焊在一起）。本目录把那 15% 的管道抽出来；那份脚本保持原样不动，它是那一次走查的记录。

## 边界：什么进 git，什么不进

- **管道进这里**（本目录）。它被证明会重复：同一仓两次走查用了两套机制。
- **事实进 `tests/fixtures/`**。接口响应与字段形状是数据，丢了就没了——样例：`tests/fixtures/bilibili/bv1mAam6tEL8-subtitle-shape.md`（从 `.scratch` 转写的字幕轨形状与对齐数字；它引用的 `research/01-track-shape.md` 已经丢失，这就是要转写的原因）。`.scratch/` 里的 `research/` 会随票据整理消失，别把它当事实的家。
- **场景按需迁**：出现**第二个**需要同一批真机判据的票时，才建 `scenarios/` 并迁第一个场景，同时把样本 bvid 与 fixture 变成参数。判据是 `scenarios/*.mjs` 的第 2 个文件——只被需要过一次的场景留在 `.scratch`，那是验收记录，不是回归资产。
- **场景层的改动不用回流本目录**。`.scratch/tickets/bilingual-subtitles/walkthrough/drive.mjs` 长到几千行也不影响这里：只有**管道层**的教训才回流——CDP 客户端、启动参数、target 挑选、就绪门、收摊。场景步骤、fixture 生成、页内测量脚本都是它自己的事。真机走查的产出是**发现**：发现一旦落定，就补一条 jsdom 断言把它锁住（见 `tests/reader/bilingual-picker.test.ts` 的「真机反向发现的修复锁」一节），走查脚本本身不必变成回归资产。

