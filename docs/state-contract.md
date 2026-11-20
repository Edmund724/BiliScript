# State Encapsulation Contract

This document defines how the extension's shared state is read and written. The main bag lives in
`extension/core/state.ts` and is exported as `state` plus the named `clipState` / `uiState`
handles. The player-AI namespace lives in its own module, `extension/ai/player-ai-state.ts`
(see below).

> Since the TypeScript migration, the setter rule below is enforced at compile time:
> business fields are `readonly` on the public namespace types, so a direct write fails
> `tsc --noEmit`. This document remains the human-readable rationale; the types in
> `state.ts` are the machine-checked source of truth.

## Namespaces

There are three namespaces in the core state bag, exposed as structured aliases on the
`state` object:

| Structured alias | Business object     |
| ---------------- | ------------------- |
| `state.reader`   | reader state        |
| `state.clip`     | clip/subtitle state |
| `state.ui`       | UI/chrome state     |

The module also exports the standalone `clipState` / `uiState` handles (the
same objects as `state.clip` / `state.ui`) as the write-discipline entry points for modules
that write clip/UI fields.

The `playerAi` namespace has moved out of the core bag: it is fully owned by the `ai` domain
(`ai/player-ai.ts` is the only business writer) and lives in `ai/player-ai-state.ts` as
`playerAiState`, with the same Readonly-fields + setter whitelist shape as the core namespaces.
Its one external writer — `reader/shell.ts` (`enterReaderShell`) — goes
through the intent-level `suppressUntil(timestamp)` helper exported by that module, so callers
outside `ai/` never touch player-AI slots directly.

### The `chatSessionState` bag (`extension/chat/chat-state.ts`)

The sidepanel conversation bag is a **second state namespace**, owned by the `chat` domain and
exported as the module-level singleton `chatSessionState` (14 business fields, see
[ADR-0005](adr/0005-state-bag-write-discipline.md) 适用范围二). It follows the same Readonly + setter
split, and both slices are covered — every field is `Readonly` on the public type:

| Field                                                    | Write discipline                                                       |
| -------------------------------------------------------- | ---------------------------------------------------------------------- |
| `currentConversationId`, `currentConversationMeta`, `chatHistory` | `Readonly` on the public type — written through `applyConversationIdentity` / `detachConversationIdentity` / `clearConversationIdentity` / `ensureConversationId` / `appendChatHistory` |
| `savedConversations`                                      | `Readonly` — written through `setSavedConversations`                    |
| `contextData`, `currentContextKey`, `providers`, `liveContextData`, `liveContextKey`, `liveTabUrl`, `aiPrefs`, `asrTranscribingActive`, `aiThinkingLevel`, `webSearchEnabled` | `Readonly` on the public type, with `aiPrefs` / `contextData` / `liveContextData` readonly one level deeper (nested scalar fields and index-signature keys are compile errors) — written through the intent-level primitives in `chat/chat-state.ts` (`applyProviderPrefs`, `applyContextToMain`, `applyLiveContextSnapshot`, `resetLiveContext`, `setAiThinkingLevel`, …; ADR-0005 修订 2026-09-29). Array in-place edits one level below those keys are still unconstrained |

Tests that reuse the singleton inside one module epoch reset it through the test-only injection
point `resetChatSessionStateForTests()`, and arrange preconditions through the writable handle
`chatSessionStateForTests` (the `force-set`-for-scaffolding precedent of `readingViewOpen` above),
instead of hand-resetting field by field. Production code must not touch either.

Plus a single flat settings object:

- `state.settings` — current settings (a copy of `DEFAULT_SETTINGS`).
- `state.setSettings(next)` — replace `settings` with `next`.
- `state.patchSettings(patch)` — shallow-merge `patch` into `settings` (same write discipline;
  the intent-level entry for single-field updates, e.g. the live-toggle write in `entry/content.ts`).

## The rule

Business fields are written **only** through their `set<Field>(value)` method. Do **not** write
`state.<namespace>.<businessField> = value` directly.

```js
// correct
state.reader.setTheme("dark");
clipState.setTitle("...");
uiState.setStatusText("...");
playerAiState.setSubmitting(true); // from ai/player-ai-state.ts
suppressUntil(Date.now() + 2500);  // intent-level write from outside ai/

// incorrect — bypasses the setter contract
state.reader.readingTheme = "dark";
```

Because `state.reader` is the reader namespace object, reading `state.reader.<field>` on the
**right-hand side** of a setter call is fine and equivalent:

```js
state.reader.setSettingsExpanded(!state.reader.readingSettingsExpanded);
```

## Internal-field whitelist

The following `state.reader` fields have **no setter** and are intentionally written directly. They are
internal DOM/timer/observer/bound-state bookkeeping, not business fields. Do **not** convert these to
setters, and do **not** add copies of them to the setter table:

```
readingVideoEl
readingDocumentClickBound
readingShellState
```

`readingShellState` is the shell-lifecycle state machine field (`closed | entering | open | exiting`,
single source in `core/state.ts`). Its only writer is the exported `transitionReaderShell(to)`, which
validates the from→to edge (rejections are logged unconditionally via `logWarnAlways`) and keeps
`readingViewOpen` as its derived boolean projection (`state === "open"`). Production write points
(`reader/shell.ts` enter/exit transactions, `lifecycle.enterReaderMode` / `closeReadingView`) must go
through `transitionReaderShell`, never through `setViewOpen` — that setter (and the
`readingViewOpen` accessor itself) exists as an unvalidated force-set for test scaffolding only.

## Context attribution (runtime volatility)

The three core namespaces above form a **content-script (page-context) singleton**: every importer of
`core/state.ts` runs in the content bundle (`entry/content.ts`, `reader/*`, `subtitle/*`,
`bilibili/*`, `asr/fallback.ts`, …). The `playerAi` namespace in `ai/player-ai-state.ts` shares the
same lifetime: its static importers are content-page modules only (`reader/shell.ts`
plus `ai/player-ai.ts`, the latter riding the player-ai dynamic chunk), so MV3 SW
termination does not touch it either. The service-worker bundle reaches `state.ts` only through
static imports (`shared/logging.ts`, `shared/error-helpers.ts`, `bilibili/gateway.ts`), and its
paths only read defaults (`state.settings?.enableDebugLogs`); no SW path writes business fields.
Loss of this state on page reload is accepted product semantics (state is re-derived from the URL,
Bilibili APIs, or a re-fetch), so nothing here is persisted to `chrome.storage.session`.

Consequences of that attribution:

- MV3 SW termination does not touch any namespace above (core namespaces and `playerAiState` alike).
- The only module-level mutable state in the SW graph is the DNR session-rule id ledger held by
  `extension/core/offscreen-host.ts` (backed by `extension/asr/session-rule-manager.ts`). DNR session rules outlive SW instances while the ledger
  resets on cold start, so the ledger reconciles against
  `chrome.declarativeNetRequest.getSessionRules()` before the first allocation in each SW
  instance — the platform is the source of truth.
- Per-page in-memory registries that hold live promises (for example `activeAsrTranscribes` in
  `asr/fallback.ts`, the "don't cancel on video switch" carrier) belong to the page context and
  are intentionally not persisted; when the context dies the registry dies with it and the
  completed results are recovered from the extension-origin IndexedDB subtitle cache.

## Persistent cache tiering & eviction (`biliscript-subtitle-store` v2)

Subtitle tracks and AI derived artifacts are persisted in the **extension-origin IndexedDB**
database `biliscript-subtitle-store` (schema v2, `extension/subtitle/idb-store.ts`), never in
`chrome.storage.sync` and never in the `bilibili.com` page-origin IndexedDB:

| ObjectStore | Primary key | Indexes | Contents & eviction policy |
| --- | --- | --- | --- |
| `subtitle_pages` | `${bvid}:${cid}` | `by_lastUsed`, `by_bvid` | Three-tier subtitle tracks (`rawTracks`, `segmentedTracks`, `translatedTracks`); dual-threshold LRU capped at **100 pages / 150 MB** (`lastUsed` refreshed on hit). When a page is evicted due to cap, `by_bvid` is checked and only when no pages remain for that `bvid` are same-`bvid` entries in `ai_artifacts` cascade-deleted. |
| `ai_artifacts` | `key` | `by_family_bvid`, `by_family_lastUsedAt`, `by_bvid`, `by_lastUsedAt` | Four AI artifact families with per-family video-count (`bvid`) LRU caps (`lastUsedAt` refreshed on hit): `biliscript_lvs_l1_index_` (**100** videos, plus 16-entry bounded in-memory LRU in `ai/l1-chapter-index.ts`), `biliscript_lvs_analysis_final_` (**100** videos), `biliscript_lvs_analysis_` (**20** videos), `biliscript_lvs_summary_` (**20** videos). |
| `chat_images` | `id` | `by_conversationId`, `by_bvid`, `by_lastUsedAt` | Externalized conversation message images (`{ id, conversationId, bvid, mime, data, estimatedBytes, createdAt, updatedAt, lastUsedAt }`). `biliscript_ai_conversations_v1` in `chrome.storage.local` stores lightweight `{ mime, idbRef }` references while in-memory conversation state stays hydrated as `{ mime, data }`. Protected by an **80 MB** total-byte LRU cap (`lastUsedAt` refreshed on read) plus synchronous orphan reclamation via `by_conversationId` and active-reference pruning. |

### Origin isolation, migration & video-level cleanup

- **Origin isolation (SW RPC)**: Content-script callers (`subtitle/cache.ts`, `ai/l1-chapter-index.ts`,
  `ai/analysis-orchestrate.ts`, `chat/conversation-storage.ts`) never touch `globalThis.indexedDB` on
  `http:`/`https:` origins; `extension/subtitle/store-client.ts` routes all reads, writes, and clears
  through the existing `subtitle-cache` message family (`extension/subtitle/subtitle-cache-handler.ts`)
  in the Service Worker. Offscreen chat workers (`ai/ladder.ts`) continue to reach SW segment/L1 caches
  exclusively through `segment-cache` messages (`ai/segment-cache-proxy.ts`) without bundling cache
  modules.
- **Conversation image externalization & hydration (`extension/chat/conversation-storage.ts`)**:
  - *Write ordering (no dangling references)*: On save, every new image is written to `chat_images`
    first; only after the IDB write confirms `ok: true` is `{ mime, idbRef }` written into
    `biliscript_ai_conversations_v1`. If a single image fails to write to IDB (or SW RPC errors), that
    image falls back to inline `{ mime, data }` with a warning so no dangling `idbRef` is ever persisted.
    If `storage.local.set` fails after writing new images, those newly written IDB records are rolled back.
  - *Read hydration & single-image fault tolerance*: Loading history batch-fetches all referenced `idbRef`
    records via `get-chat-images` and hydrates them back to `{ mime, data }`. If an individual record is
    missing, corrupted, or the RPC fails, only the affected image is degraded (safely skipped with a
    warning) while conversation text and all other valid images still load normally.
  - *Legacy inline base64 lazy migration*: When reading legacy conversations containing inline
    `{ mime, data }` images, `readConversationHistory` returns the hydrated conversations normally and
    lazily writes those inline images to `chat_images` first, replacing only successfully persisted
    entries in `biliscript_ai_conversations_v1` with `{ mime, idbRef }` (idempotent write-then-replace).
  - *Orphan reclamation & capacity cap*: Deleting a conversation, clearing all conversations, overwriting
    a conversation with an image removed/replaced, or evicting the oldest conversation beyond the 60-entry
    cap synchronously removes obsolete `chat_images` records via the `by_conversationId` index and prunes
    unreferenced orphan records (also available via `pruneOrphanChatImages`). `chat_images` further
    enforces an **80 MB** total-byte LRU cap (`evictChatImagesIfNeeded`) to prevent unbounded growth.
- **Write-then-delete migration**:
  - *Read-path lazy migration*: On an `ai_artifacts` miss, `extension/subtitle/ai-artifact-cache.ts`
    checks legacy `chrome.storage.local` by exact key or `getKeys()` prefix, writes the record to
    IndexedDB first, and deletes the legacy data key and its per-key LRU index only after the IDB
    write succeeds; if IDB write fails, the legacy key is retained and the legacy payload is returned.
  - *Startup / update batched migration*: `migrateLegacyLocalStorageToIdb`
    (`extension/subtitle/storage-migration.ts`, wired in `entry/on-installed.ts` and
    `entry/background.ts`) migrates remaining legacy `biliscript_lvs_*` and
    `biliscript_subtitle_cache_*` entries in batches, removes retired `biliscript_lvs_raw_*` and
    LRU index/manifest metadata, and writes `biliscript_idb_v2_migration_done` only after zero
    failures so interruptions safely resume on next startup.
- **Video-level cleanup (`clearVideoCache(bvid, cid?)`)**: Exported from `extension/subtitle/cache.ts`;
  cancels pending translated-track debounce buffers, clears matching entries from the `l1-chapter-index`
  in-memory LRU via registered hooks, deletes matching `subtitle_pages` and `ai_artifacts` entries in
  IndexedDB (via SW RPC from content scripts), and removes any remaining legacy `chrome.storage.local`
  keys and per-key LRU indexes for the target video (or single part when `cid` is given).

## Future note

Business-field writes are now guarded at compile time (see the note at the top). A dev-mode
`Proxy`/assertion helper that hard-fails on a direct write at runtime was considered but
**not** implemented; it would only add coverage for the whitelisted internal fields, and
adding one risks altering their existing direct-write behavior and the bundle.

## Guide for contributors

- When adding a **new business field** to a namespace, add a matching `set<Field>(value)` setter on the
  namespace object, and write that field through the setter everywhere.
- When adding a **new internal timer/host/observer/bound flag** that has no setter and must be written
  directly, add it to the internal-field whitelist list above.
- Keep business writes on setters; keep internal (whitelisted) writes direct.
- The `playerAi` namespace lives in `ai/player-ai-state.ts`, not `core/state.ts`; extend it there
  and keep cross-module writes routed through intent-level helpers (like `suppressUntil`).
