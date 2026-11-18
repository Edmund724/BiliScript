---
name: release
description: Execute the BiliScript version bump, README sync, validation build, release-note review gate, and GitHub Release workflow. Use when the user asks to bump the version, prepare a release, update README from commit history, or publish a new version.
---

# BiliScript Release Workflow

Execute steps in order. Pause at the **Review Gate** before tagging or publishing to GitHub.

## 1. Inspect Baseline and Commit History

Run from the repository root:

```powershell
git status
$lastTag = git describe --tags --abbrev=0
git log "$lastTag..HEAD" --oneline --no-merges
gh release view $lastTag
```

Review `git log "$lastTag..HEAD"` (and `--stat` / `git show <hash>` for key commits) to separate user-facing features and bug fixes from internal refactors, and confirm the current release-note style from `gh release view $lastTag`.

**Done when**: working tree status, previous tag, commit changes since `$lastTag`, and reference release-note structure are collected.

## 2. Bump Version and Sync Documentation

1. Determine the target version (default `+0.0.1` patch increment unless specified otherwise).
2. Update all three version sources in sync (guarded by `scripts/build-content.js` and `scripts/build_release.py`):
   - `package.json` (`"version"`)
   - `extension/manifest.json` (`"version"`)
   - `extension/core/version.ts` (`BILISCRIPT_VERSION`)
3. Update `README.md` (and `docs/development.md` / `docs/guide.md` if module exports or user setup changed) to reflect confirmed user-facing capabilities since `$lastTag`. Keep `README.md`'s concise routing layout and omit unconfirmed, experimental, or soon-to-be-removed features.

**Done when**: all three version files match the target version and documentation updates are complete.

## 3. Validate and Build Release Archive

Run typecheck, unit tests, and release packaging:

```powershell
pnpm run typecheck && pnpm test && pnpm run build:release
```

- If `scripts/build_release.py` fails on the ZIP size guard (`max_release_zip_bytes`) due to legitimate new features, record the actual built ZIP size in its baseline comment, raise `max_release_zip_bytes` with ~3%–4% headroom, and re-run `pnpm run build:release`.

**Done when**: `typecheck`, `vitest`, and `build:release` all exit `0`, producing `release/BiliScript-v<version>-Chromium.zip`.

## 4. Commit and Push `main`

Check `git status` and stage only the files edited for this release:

```powershell
git add package.json extension/manifest.json extension/core/version.ts scripts/build_release.py README.md
git commit -m "chore(release): 版本号升至 <version> 并更新 README 与打包体积预算"
git push origin main
```

**Done when**: the release prep commit is pushed to `origin/main` and verified via `git rev-parse --short HEAD`.

## 5. Review Gate: Draft Release Notes and Wait for Approval

Draft the Chinese release notes matching the structure of `gh release view $lastTag`:

- **Tag**: `v<version>`
- **Title**: `v<version> — <一句话核心变更摘要>`
- **Body**: Opening summary paragraph, thematic bullet sections (`## ...`) covering user-facing features and fixes grounded in `$lastTag..HEAD` commits, and `## 升级方式` referencing `BiliScript-v<version>-Chromium.zip` and Edge Add-ons store.

Present the full draft to the user and **stop before tagging or publishing**.
If the user requests edits (including README wording adjustments), apply the edits, commit and push to `main`, and present the updated draft for confirmation.

**Done when**: the user explicitly approves the release notes.

## 6. Tag and Publish GitHub Release

Only after explicit user approval, write the approved notes to a temporary file (outside the repo, e.g. system temp) and publish:

```powershell
git tag -a "v<version>" -m "<Release Title>"
git push origin "v<version>"
gh release create "v<version>" "release/BiliScript-v<version>-Chromium.zip" --title "<Release Title>" --notes-file "<notes-file>"
```

Verify the published release URL and attached ZIP asset via `gh release view "v<version>"`.

**Done when**: tag `v<version>` is pushed, GitHub Release is published with `BiliScript-v<version>-Chromium.zip` attached, and the release URL is verified.
