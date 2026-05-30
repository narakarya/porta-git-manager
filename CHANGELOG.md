# Changelog

All notable changes to porta-git-manager are documented here. This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) loosely.

## [Unreleased]

## [0.7.0] — 2026-05-30

First release as the standalone `narakarya/porta-git-manager` repo (extracted from `narakarya/porta`'s `extensions-bundled/git-manager/` with full commit history preserved via `git filter-repo`).

### Fixed
- Branches tab can scroll again. The facet-chip wrap (added in v0.5.86) had broken the inner list's flex height — `.branches-list-wrap` is now a proper flex container with `min-height: 0`.
- Current-branch green dot now aligns with the checkbox column instead of floating in a second 16px slot. Grid template changed from `16px 16px 1fr auto` to `16px 1fr auto`; the lead cell is the dot OR a checkbox, never both.

### Changed
- Stash row: click anywhere on a row (outside checkbox or action buttons) to open the viewer. The explicit `View` button is gone — the row IS the viewer affordance. Apply / Pop / Drop buttons use `stopPropagation` so they don't fire the row click.
- Status tab: file list is now a folder-nested tree built on the same `gmRenderFileTree` primitive used by the stash / branch diff viewer. Hover-revealed stage / unstage / discard buttons preserved. Tiny file-type icon prepended per row.
- Diff modal: sticky per-file header with chevron-collapse (`▾` / `▸`). Each file's header stays pinned while you scroll inside its body — no more losing track of which file you're inside on multi-file diffs.
- Diff modal tree pane: search input (`Filter files…`) above the tree, sticky toolbar, file-type icons in rows, pill-styled `+N / −M` aligned right with subtle background.
- History tab commit detail: structured card replacing the bare 3-row label/value layout. Subject (bold, larger), optional multi-line body (mono), separator, meta line (author · relative time with absolute time tooltip), SHA pill amber + click-to-copy, parent SHA pills.
- History tab diff body: rendered via the shared `gmRenderDiffDoc` — gutter, syntax highlight, word-level highlight on paired changes, sticky per-file headers. Previously this was raw line-classing only.
- History tab log row: per-author chip (14px circle with first initial + deterministic color from `djb2(name)` over 12 pastel hues), sticky search bar so it stays accessible while scrolling 100 commits.

### Added
- Diff modal: Unified ↔ Split toggle in the head. The split-pairing logic (`toSplitRows`) was lifted out of the Status tab into `diff-util.js` so Status and modal share it.
- Diff modal: `[ ] Ignore whitespace` + `[ ±3 / ±6 / All ctx ]` controls that appear when the caller passes a `refetch` callback. Stash `show`, branch `diffBranch`, and the new History "Open in viewer" all supply one — flag changes re-run `git stash show -p` / `git diff` / `git show` with `-w` / `-U<n>`.
- History tab: "Open in viewer ↗" button on the commit card that opens the full diff modal (tree pane, toggle, whitespace/context controls) for the current commit. Useful when a commit touches 20+ files and the inline detail pane feels cramped.
- History tab: sticky stat strip ("3 files changed · +47 / −12") above the diff with a proportional visual `+/−` bar.
- History tab: skeleton loading state for commit detail. Card + strip + diff-line placeholders shimmer during fetch; all three `git show` calls (body, abs date, patch) run in parallel via `Promise.all`. Layout doesn't jump on swap-in.
- Shared `gmRenderFileTree(node, files, opts)` rendering primitive driven by a `renderRow(file, depth)` callback. Used by Status, the diff modal's tree pane, and any future tree caller.
- File-type SVG icon sprite (`ficon-ts`, `ficon-tsx`, `ficon-js`, `ficon-jsx`, `ficon-json`, `ficon-css`, `ficon-html`, `ficon-md`, `ficon-rs`, `ficon-py`, `ficon-sh`, `ficon-generic`) — monochrome 14×14 inheriting `currentColor`. No asset files; the sprite ships in `index.html`.

### Internal
- `gmFileTree` extracted from `app.js` into its own UMD module `file-tree.js` with unit tests (`test/file-tree.test.mjs`, 5 tests). Also exposes `filterFiles` for the diff modal's tree filter input.
- `toSplitRows` lifted from Status tab's `renderSplitHunkBody` into `diff-util.js` with unit tests (3 new tests). Status and the new modal split renderer (`gmRenderDiffDocSplit`) both consume it.
- GitHub Actions test workflow (`.github/workflows/test.yml`) running `node --test test/*.test.mjs` on push + PR.

## [0.6.3] — 2026-05-29
- Facet chips above the branch list (All / Merged / Unmerged / Local-only / On remote) with live counts.
- Tab badges no longer reserve empty space when count is zero.

## [0.6.2] — 2026-05-28
- Stash "View" opens a read-only diff in a VSCode-style viewer (file tree + diff).
- Branch "Diff" previews what a branch carries relative to current HEAD.
- On-remote vs local-only badge per local branch.
- Remote branch delete via `git push --delete`.
- Checkbox multi-select on branch and stash rows with bulk-action bar.
- Filter caret fix on Status / Branches / History / Tags inputs.

## [0.6.1]
- Discarding a folder that's its own git repo now works (`git clean -ffd` behind a confirm).
- Discard no longer fakes success — surfaces real errors.

## [0.6.0]
- Untracked diff fix (preview as all-added hunk; directories list contents).
- Branches: larger rows with last-commit info, merged/unmerged badges, tracking badges.
- Stash: parsed branch chip + relative time, pill action buttons.
- Rebase: target as labelled card, todo rows with op color accents, kept-counter.
- Top bar: Pull / Push quick buttons with ahead/behind counts.
- Sync remote actions match pill style.

## [0.5.0]
- Diffs: line-number gutter, word-level change highlighting, syntax highlighting for common languages.
- Search-match highlighting in filters.
- Visible-at-rest row actions.

## [0.4.0]
- Split / unified diff toggle in Status.
- Remote management in Sync (add / rename / edit URL / remove).
- Per-hunk Stage / Unstage / Discard in Status diff preview.

(Earlier versions documented in git history.)
