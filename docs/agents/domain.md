# Domain Docs

How engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root (global core product terms & domain navigation index).
- **`docs/glossary/`**: progressive domain volumes (`subtitle.md`, `ai.md`, `live.md`, `reader.md`) — read only the volume(s) matching your target area.
- **`docs/adr/README.md`**: the ADR index and the canonical 「审查红线」 list of directions already ruled out.
- **`docs/adr/`**: read ADRs that touch the area you are about to work in.

If any of these files do not exist, **proceed silently**. Do not flag their absence or suggest creating them upfront.

## Red-line index

Check **all** items in `docs/adr/README.md`「审查红线」before writing any architecture or refactor proposal. That section is the single source of truth for ruled-out directions and their reopen conditions; do not duplicate it elsewhere.

## File structure

Single-context repo:

```
/
├── GLOSSARY.md
├── docs/
│   ├── glossary/
│   │   ├── subtitle.md
│   │   ├── ai.md
│   │   ├── live.md
│   │   └── reader.md
│   └── adr/
│       ├── README.md
│       └── 0001-*.md …
└── extension/
```

## Use the glossary's vocabulary

When naming a domain concept (in an issue title, refactor proposal, hypothesis, or test name), use the term defined in `GLOSSARY.md`. Do not drift to synonyms the glossary explicitly avoids.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0003 (Light DOM 右栏文摘面板), but worth reopening because…_
