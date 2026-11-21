# ADR 索引与体例

`docs/adr/` 收录本仓现行有效的跨模块架构裁决（逆转成本高、无上下文易被误改、存在真实权衡的硬边界）。索引表提供全部决策入口，「审查红线」集中列出架构评审与 AI 代理严禁重提的已否决方向。

## 索引表

| 编号 | 标题 | 核心边界 |
| --- | --- | --- |
| [0001](0001-background-no-runtime-lazy.md) | background 禁运行时惰性加载与 256KB 静态图守卫 | 后台 `splitting: false`，体积靠 minify 与静态拆链；动态 `import()` 仅限页面环境 |
| [0002](0002-state-bag-write-discipline.md) | 状态袋维持页面单例与 `Readonly` 写门禁 | `core/state` 与 `chat-state` 不按目录拆碎散字段、不改构造注入（DI），写门禁由 `tsc` 兜底 |
| [0003](0003-light-dom-script-panel.md) | Light DOM 右栏文摘面板、几何降级链与宿主碰撞边界 | 不迁 Shadow DOM、不搬宿主节点；右栏锚点三级降级；防宿主 `[hidden] !important` 与控制栏 `createOverflowCheck` 塌陷 |
| [0004](0004-content-two-round-build-and-reader-gate.md) | Content 两轮构建、双实例共享槽与懒域宽类型门面 | 首帧常驻 2 请求；共享可变态挂 `globalThis` 槽并承接同帧消息分发；`ReaderDomain` 维持宽类型双通道 |
| [0005](0005-provider-http-dual-relay.md) | 跨上下文 AI 请求双代发通道与宿主权限代查 | 禁页面源直发；SW 15s 短代发 vs Offscreen 流式分块长代发（配 2s 活性确认）；权限统一经后台真门预检 |
| [0006](0006-output-budget-wide-default-retreat-learned-cap.md) | 输出上限宽默认、平台拒收退回与会话内学习上限 | 三层单源预算；仅 `anthropic` 声明默认 `32768`；超限 400 无感退回 `8192` 并按会话内存记忆 |
| [0007](0007-upstream-model-facts-snapshot.md) | 上游模型事实以 `models.dev` 构建期快照为源 | UI 目录与思考值集共用构建期零依赖快照；不嵌入第三方 LLM SDK 运行时；`protocol` 不参与目录查表 |
| [0008](0008-thinking-tiers-and-wire-maps.md) | 思考档位双词表、协议无关事实层与三协议线格式出口表 | `default`（不干预）与 7 档强度阶梯分表隔离；档位事实协议无关；Messages 侧三张显式出口表且禁自造 `budget_tokens` |
| [0009](0009-gemini-native-protocol.md) | 引入第三种线格式协议（Gemini 原生 `generateContent`） | 手写零依赖原生 SSE 适配器保 `thoughtSignature` 与函数配对；仅落离散 `thinkingLevel`，不做数值预算轨 |
| [0010](0010-bilingual-secondary-subtitle-and-translation.md) | 双语副轨独立槽、并列接受事务与 AI 译文游标调度 | `clip.secondarySubtitle` 与 `secondary-subtitle-ready` 隔离副作用；原生去同族配对，AI 译文走 `boundary-v3` 与 90s 游标优先调度 |
| [0011](0011-subtitle-prefetch-and-asr-isolation.md) | 视频页字幕预抓取、发送闸重试与 ASR 跨导航/分段流式隔离 | 进视频页即预抓原生字幕（禁自动 ASR）；发送闸重试拦截 `error`；在途 ASR 与 `fetchRunId` 解耦；Offscreen 10-moof 分段解码防 OOM |
| [0012](0012-long-video-state-relay-and-hybrid-retrieval.md) | 长视频阶梯预算、滑动状态接力总结、单跳混合召回与 Map-Reduce 兜底 | 200k 阶梯与三级溢出回落；零向量/分词依赖；概览超预算走状态接力，对话优先 L1+BM25 单跳召回，Map-Reduce 仅作冷兜底 |
| [0013](0013-chat-turn-dag-and-dual-context.md) | 对话回合单向等待 DAG、延迟停止看门狗与双轨上下文隔离 | `settled <- switch`、`replay <- sendGate`、`replay` 零等待防死锁；建连延迟 `stop` + 4s 看门狗；`contextData` 与 `liveContextData` 分离 |
| [0014](0014-web-search-privacy-gate-and-cooldown.md) | 联网搜索隐私授权闸、哈希缓存跨上下文共享与 SW 持久化冷却 | 显式授权与 `true -> false` 退订清缓存；哈希缓存开放给页面划词卡与 Offscreen 共享；冷却账本持久化防 SW 休眠清零 |
| [0015](0015-live-websocket-offscreen-dnr.md) | 实时伴看 Offscreen WebSocket 承载与 DNR 握手头注入 | WS 固定在 `["BLOBS"]` Offscreen 发起；SW 以 DNR 规则 `9002` 覆写鉴权头与 `Origin`；权限成对覆盖 `http(s)` 与 `ws(s)` |
| [0016](0016-live-companion-overlay-hosts.md) | 实时伴看浮窗主承载架构：视频页与直播间双宿主边界 | 双端共用跨全屏吸附浮窗；视频页会话独立于面板并保留状态条与只读记录；直播间走独立 `live-room` 懒包且禁页面工具 |
| [0017](0017-firefox-desktop-compatibility.md) | 桌面端 Firefox（153+）兼容架构与双目标发布边界 | 清单派生 Event Page、28 常驻域与显式 CSP（防本机连接强升 HTTPS）；隐藏 `iframe` 承载 Offscreen；禁裸写标准滚动条 |
| [0018](0018-layered-storage-and-extension-idb.md) | 扩展三层存储架构：`sync` 配置、`local` 密钥与 SW 快照、扩展源 IndexedDB v2 | 配置 `sync` / 明文密钥 `local` + 官方凭据单源引用；SW 快照无写透双通道失效；大体积数据落 SW 扩展源 IDB v2 |
| [0019](0019-rich-text-mathml-and-mermaid-slim.md) | 宿主富文本渲染与包体控制：KaTeX 纯 MathML 零字体与 Mermaid 构建期裁剪替身 | KaTeX 纯 MathML 零字体避宿主 CSP；Mermaid 构建区锚点裁剪 + `d3-slim` 同步落样式控死 3.9MB 预算 |

## 审查红线

架构评审（含 AI 代理）不得再提议下列已裁死事项；重开仅在对应正文列明的前提成立时有效：

- **ADR-0001：不得提议后台运行时惰性化**（动态 `import()` 仅限页面环境；重开条件：`crbug/40760920` 落地）。
- **ADR-0002：不得提议 `reader` / `clip` / `ui` 或 `chat` 散字段的归属搬迁、全域收敛或模块级单例改构造注入（DI）**。
- **ADR-0004：常驻请求结构（2 请求）仍是体验瓶颈期间，不得提议 Content 单轮化或 `seam external`；不得提议收窄 `ReaderDomain`、统一 reader 域双访问通道或改用字符串分发**。
- **ADR-0007：不得把原始上游数据或第三方 LLM SDK 接进请求链或运行时，不得用 UI 目录产物回填 `thinking-profiles.ts`，也不得让 `protocol` 参与目录查表**。
- **ADR-0008：不得为消除映射而按协议拆分模型档位事实表；不得把 `default`（不干预档）并入强度阶梯 `AI_THINKING_LEVELS`；不得以「可选条目 ≤ 1」为由隐藏零档模型的思考强度行**。
- **ADR-0012：不得引入本地向量库、Embedding 模型或第三方分词词典依赖，也不得将长视频字幕召回构建为多轮自主检索 Agent 循环**。
- **ADR-0015：不得将实时伴看 WebSocket 客户端迁回 Service Worker 或 Content Script**（SW WebSocket 握手绕过 DNR `modifyHeaders`，见 `crbug/40815149`）。
- **ADR-0017：不得将 `<all_urls>` 或 `https://*/*` 移入任一端常驻 `host_permissions`；不得在未包裹 `@supports (-moz-appearance: none)` 时裸写 `scrollbar-width` / `scrollbar-color`；二期立项前不得在 Firefox 暴露未验收的 `live` 或 `tts` 入口**。

红线只覆盖已被否决过的方向，未裁决事项按常规架构评审走。

## 体例规则

1. **只记高逆转成本、反直觉权衡的架构边界**：局部 UI 样式参数、常规组件封装以及已由 TypeScript 类型或测试自解释的实现细节不立 ADR。一篇 ADR 聚焦单一架构域，不拼凑无关主题。
2. **仅描述当前状态，直接覆盖维护**：策略演进、模块改名或常量调整时直接就地更新正文，**禁止追加文末 `## 修订` / `## 补注` 历史块、工单流水账或过时方案对比**；被彻底推翻的 ADR 直接删除并同步更新索引与引用。
3. **证据引用必须仓库内可解析**：引用真实源码路径、构建守卫或实测结论，严禁指向被 `.gitignore` 忽略的 `.scratch/` 路径。
4. **统一篇首状态行**：每篇标题后首条非空行固定写 `> 状态：有效`。

机械可判定的体例约束（连续编号与索引双向对齐、无 `.scratch/` 引用、篇首状态行一致、零历史修订/补注块）由 `tests/docs/adr-index.test.ts` 自动守卫。
