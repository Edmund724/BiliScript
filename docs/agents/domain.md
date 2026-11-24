# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root, or
- **`GLOSSARY-MAP.md`** at the repo root if it exists: it points at one `GLOSSARY.md` per context. Read each one relevant to the topic.
- **`docs/adr/README.md`**: the index, and the 「审查红线」 list of directions already ruled out.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill creates them lazily when terms or decisions actually get resolved.

## Red-line index (directions already ruled out)

Architecture review — human or AI — must not re-propose the directions below. They are 已裁死 across separate ADR bodies, so reading only the ADR that "looks relevant" misses the others. Check all of them before writing a proposal:

- **ADR-0001**: 后台运行时惰性化（重开条件：`crbug/40760920` 落地）。
- **ADR-0002**: `reader` / `clip` / `ui` 或 `chat` 散字段的归属搬迁、全域收敛与模块级单例改构造注入（DI）。
- **ADR-0004**: 常驻请求结构仍是体验瓶颈期间，Content 单轮化 / `seam external`；收窄 `ReaderDomain`、统一 reader 域双访问通道或改用字符串分发。
- **ADR-0007**: 把原始上游数据或第三方 LLM SDK 接进请求链或运行时；用 UI 目录产物回填 `thinking-profiles.ts`；让 `protocol` 参与目录查表。
- **ADR-0008**: 为消除映射而按协议拆分模型档位事实表；把 `default`（不干预档）并入强度阶梯 `AI_THINKING_LEVELS`；以「可选条目 ≤ 1」为由隐藏零档模型的思考强度行。
- **ADR-0012**: 引入本地向量库、Embedding 模型或第三方分词依赖；将长视频字幕召回构建为多轮自主检索 Agent 循环。
- **ADR-0015**: 将实时伴看 WebSocket 客户端迁回 Service Worker 或 Content Script（SW WebSocket 握手绕过 DNR `modifyHeaders`，见 `crbug/40815149`）。
- **ADR-0017**: 将 `<all_urls>` / `https://*/*` 移入常驻 `host_permissions`；在未包裹 `@supports (-moz-appearance: none)` 时裸写 `scrollbar-width` 或 `scrollbar-color`；二期立项前在 Firefox 暴露未验收的 `live` 或 `tts` 入口。
- **ADR-0020**: 为文摘面板独立窗口引入跨进程扩展页（`chrome.windows.create` 独立文档 + 状态镜像）或搬移 B 站 `<video>` 宿主节点；将独立窗口像素宽高记忆写入 `chrome.storage.sync`。
- **ADR-0021**: 将未编码的原始 YouTube 视频 ID（含 `_`）直接拼入以下划线/冒号切分的存储键或将内部转义键泄漏至 UI/导出；将 YouTube `kind: "asr"` 平台自动字幕归入本扩展 `asr` 伪轨；伪装 `ANDROID` / `IOS` 客户端绕过 `timedtext` PO Token；二期立项前在 YouTube 暴露未验收的 ASR、实时伴看、播放器叠层/快捷 AI/扩展倍速、历史三帧或 Agent 桥接入口。

本条只是发现入口：原文摘引、重开条件与完整措辞以 `docs/adr/README.md`「审查红线」为准。红线只覆盖「已被否决过的方向」，不是「没裁过就不许做」。

## File structure

Single-context repo (this repo):

```
/
├── GLOSSARY.md
├── docs/adr/
│   ├── README.md
│   ├── 0001-background-no-runtime-lazy.md
│   └── 0002-state-bag-write-discipline.md
└── extension/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0003 (Light DOM 右栏文摘面板), but worth reopening because…_
