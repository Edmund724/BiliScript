# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists: it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/README.md`**: the index, and the 「审查红线」 list of directions already ruled out.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill creates them lazily when terms or decisions actually get resolved.

## Red-line index (directions already ruled out)

Architecture review — human or AI — must not re-propose the directions below. They are 已裁死 in four separate ADR bodies, so reading only the ADR that "looks relevant" misses the other three. Check all four before writing a proposal:

- **ADR-0003**: SW 运行时惰性化（重开条件：crbug/40760920 落地）。
- **ADR-0005**: reader/clip/ui 或 chat 散字段的归属搬迁与全域收敛。
- **ADR-0008**: 常驻请求结构仍是体验瓶颈期间，content 单轮化 / seam external。
- **ADR-0009**: 把 pi-ai 接进请求链；用目录数据回填 `thinking-profiles.ts`。

本条只是发现入口：原文摘引、重开条件与完整措辞以 `docs/adr/README.md`「审查红线」为准。红线只覆盖「已被否决过的方向」，不是「没裁过就不许做」。

## File structure

Single-context repo (this repo):

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── README.md
│   ├── 0001-long-video-summarization-map-reduce.md
│   └── 0002-chrome-only.md
└── extension/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0006 (整页接管退役), but worth reopening because…_
