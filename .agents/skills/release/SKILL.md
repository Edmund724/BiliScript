---
name: release
description: Execute the BiliScript version bump, README sync, validation build, release-note review gate, GitHub Release, and Firefox AMO / Edge Add-ons store submission workflow. Use when the user asks to bump the version, prepare a release, update README from commit history, or publish a new version.
---

# BiliScript Release Workflow

Execute steps in order. Pause at the **Review Gate** before tagging or publishing to GitHub or browser extension stores.

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

Run typecheck, unit tests, release packaging, and Firefox AMO static lint:

```powershell
pnpm run typecheck && pnpm test && pnpm run build:release && pnpm dlx web-ext lint -s dist-firefox
```

- If `scripts/build_release.py` fails on a ZIP size guard (`MAX_CHROMIUM_ZIP_BYTES` / `MAX_FIREFOX_ZIP_BYTES`) due to legitimate new features, raise the budget with ~3%–4% headroom and re-run `pnpm run build:release`.

**Done when**: `typecheck`, `vitest`, `build:release`, and `web-ext lint` all exit `0`, producing `release/BiliScript-v<version>-Chromium.zip`, `release/BiliScript-v<version>-Firefox.zip`, and `release/BiliScript-v<version>-Source.zip`.

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
- **Body**: Opening summary paragraph, thematic bullet sections (`## ...`) covering user-facing features and fixes grounded in `$lastTag..HEAD` commits, and `## 升级方式` referencing `BiliScript-v<version>-Chromium.zip`, `BiliScript-v<version>-Firefox.zip`, `BiliScript-v<version>-Source.zip`, Edge Add-ons store, and Firefox Add-ons (AMO).

Present the full draft to the user and **stop before tagging or publishing**.
If the user requests edits (including README wording adjustments), apply the edits, commit and push to `main`, and present the updated draft for confirmation.

**Done when**: the user explicitly approves the release notes.

## 6. Tag and Publish GitHub Release

Only after explicit user approval, write the approved notes to a temporary file (outside the repo, e.g. system temp) and publish all three release archives:

```powershell
git tag -a "v<version>" -m "<Release Title>"
git push origin "v<version>"
gh release create "v<version>" `
  "release/BiliScript-v<version>-Chromium.zip" `
  "release/BiliScript-v<version>-Firefox.zip" `
  "release/BiliScript-v<version>-Source.zip" `
  --title "<Release Title>" --notes-file "<notes-file>"
```

Verify the published release URL and all three attached ZIP assets via `gh release view "v<version>"`.

**Done when**: tag `v<version>` is pushed, GitHub Release is published with `Chromium.zip`, `Firefox.zip`, and `Source.zip` attached, and the release URL is verified.

## 7. Submit to Firefox AMO and Edge Add-ons Store

After GitHub Release succeeds, submit the new version to both browser stores using the same `<notes-file>`:

```powershell
pnpm run publish:amo -- --notes-file "<notes-file>"
pnpm run publish:edge -- --notes-file "<notes-file>"
```

- **Firefox AMO** (`scripts/publish-amo.mjs`): reads `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET` from the environment, runs `web-ext sign --channel=listed` against `dist-firefox/` (excluding `**/*.map`) with `--upload-source-code release/BiliScript-v<version>-Source.zip`, release/approval metadata, and `--approval-timeout 0`. If either env var is missing, skips and prints manual AMO upload instructions.
- **Edge Add-ons** (`scripts/publish-edge.mjs`): reads `EDGE_PRODUCT_ID`, `EDGE_CLIENT_ID`, and `EDGE_API_KEY` (Edge Publish API v1.1) from the environment, uploads `release/BiliScript-v<version>-Chromium.zip`, polls package validation, and submits the draft for certification. If any env var is missing, skips and prints manual Partner Center upload instructions.

Remove `<notes-file>` after both commands finish, and report each store's outcome (submitted vs skipped with manual upload reminder) in the final reply.

**Done when**: both store scripts have run cleanly and their outcomes (submitted or skipped) are reported to the user.
