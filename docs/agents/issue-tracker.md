# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `.scratch/tickets/`.

## Conventions

- One feature per directory: `.scratch/tickets/<feature-slug>/`
- The spec is `.scratch/tickets/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `.scratch/tickets/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`, never a single combined tickets file
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/tickets/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is `.scratch/tickets/<effort>/issues/00-map.md`; each **ticket** is a sibling `NN-<slug>.md`.

- `**Labels:**` records the ticket type: `wayfinder:map` on the map, one of `wayfinder:research` / `wayfinder:prototype` / `wayfinder:grilling` / `wayfinder:task` on tickets. Triage roles from `triage-labels.md` share this line.
- `**Status:**` records the ticket's state: `open` or `closed`. Markdown files have no assignee field, so a session claims a ticket by setting `**Status:** claimed` and saving before any work.
- **Blocking**: a `**Blocked by:** NN, NN` line next to the other header lines. A ticket is unblocked when every file it lists is `closed`.
- **Frontier**: scan the effort's `issues/` files for open, unblocked, unclaimed tickets; lowest number first.
- **Resolve**: append the answer to the bottom of the ticket as a dated `### <YYYY-MM-DD> — <gist>` section, set `**Status:** closed`, then add a one-line gist with a link to the map's `## Decisions so far`. Assets go in a sibling directory (`research/`, `prototypes/`) and are linked, not pasted.
