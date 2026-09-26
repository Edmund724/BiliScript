# 传递依赖公告的处置判据

扫描器（`pnpm audit`、GitHub Dependabot 等）按 **lockfile** 判，不按产物判。
本仓库是打包型浏览器扩展，真正承担风险的是进产物的代码。两者错位时按本文
的判据处置，不要每次从零吵一遍。

## 判据

**只处理进产物或随产物分发的传递依赖；够不着的记理由，不静默。**

- 「进产物」指经 `pnpm build` / `pnpm build:content` 打进 `dist/`（或
  `extension/entry/` 产物）的代码。判法：在构建产物及其 sourcemap 里搜包名
  与涉事函数，确认出现次数与可达性——符号在 dist 里出现不等于被调用，沿
  调用面确认（先例：mermaid-12-upgrade/07 里 chevrotain 及其 lodash-es 在
  12.0.0 产物中出现 0 次，唯一 importer 是被裁掉的 usecaseDiagram）。
- 够不着产物的公告：把「查过了、够不着、为什么」写下来（原地注释或本文），
  不要用 `ignoreGhsas` 之类的永久静音——静音会把「查过了」变成「以后不再
  看」，新公告出现时也被一起吞掉。
- 进产物且公告覆盖当前版本：优先 override 到**已修且已在产物里跑**的版本
  （override 不往产物加新代码，只是让 lockfile 说实话）。override 不是免费
  的：加完后必须实测产物与不加时逐字节相同（先例：mermaid-12-upgrade/07 的
  `lodash-es: 4.18.1`，执行轮做了两遍构建逐字节比对）。override 注释里写明
  它的死亡条件（何时该删），一条看不出年代的 override 会被后来人默认假设
  「现在还有用」。
- 上游公告与 issue 不可直接当事实用：公告编号可能是旧 ID 的别名、issue 可能
  零评论无人认领、release notes 的处方可能实测无效。定案只靠两种手段：探
  产物、探上游的实际文件（mermaid-12-upgrade 地图 Notes 的教训条）。

## 与浏览器地板的同源漏洞

manifest 的 `minimum_chrome_version` 是签入的静态文件，构建零改写；
esbuild target 已收成单一常量（`scripts/build-guards.js` 的
`BUILD_TARGET`），两者的一致性由 build-content.js 的 manifest 守卫块逐构建
断言。但这只挡 **target ↔ manifest** 漂移：**「代码实际需要的最低版本 ↔
manifest 声明的地板」方向当前没有任何机制能发现**——真实 Chrome 冒烟跑在
冒烟机的 Chrome（远新于地板）上，`node --check` 只认本地 Node 的语法。依赖
升级引入 post-floor 内建时不会有人在构建期被拦住，只能靠在升级评审时主动
扫产物（先例：mermaid-12-upgrade/08 对全部 chunk 做 chrome120 vs esnext 的
esbuild.transform 逐字节对照）。

另记一条会加速变老的事实：Chrome 自 153（2026-09-08）起改为**两周一个
版本**，旧 4 周节奏下 N-2 约等于 2 个月，现在 N-2 只有 2 周——「地板」这个
产物的保质期减半了。当前地板（Chrome 120）由 ADR 0002 的能力需求（offscreen
音频等）背书，不是版本计数，这条事实不构成现在改地板的理由，但重估地板时
要用新的时间尺度。
