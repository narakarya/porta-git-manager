# Changelog

All notable changes to porta-git-manager are documented here. This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) loosely.

## [Unreleased]

## [0.7.18] — 2026-05-30

### Fixed
- **Elixir, Ruby, and Python file icons rendered blank.** Their Devicon `-original` glyphs define gradients inside the sprite `<symbol>`, which Chromium fails to paint when referenced through `<use>`. Swapped to the solid `-plain` variants (Elixir in brand purple, Ruby red, Python yellow) so they render crisply at icon size.

### Changed
- **Status bulk-selection actions moved into the toolbar.** The "N selected · Clear · Discard selected" controls now sit inline in the Status toolbar instead of a separate bar below it.
- **Top bar and panes are more responsive.** Hardened flex/grid overflow handling so the branch chip truncates gracefully, tag/remote rows don't push actions off-screen, and panes scroll instead of clipping in narrow windows.

## [0.7.17] — 2026-05-30

### Added
- **Elixir and Ruby file-type icons.** The file tree now shows the brand logos for `.ex`/`.exs`/`.heex`/`.eex` (Elixir) and `.rb`/`.erb`/`.rake` (Ruby), sourced from Devicon.

## [0.7.16] — 2026-05-30

### Fixed
- **"Discard all" now discards everything again.** A v0.7.14 refactor narrowed it to unstaged changes only, so staged edits and `git add`-ed new files were left behind (and the button greyed out once everything was staged). It once more reverts staged + unstaged changes and removes untracked files, matching its label.

### Changed
- **Folder icons in the file tree are real SVG glyphs.** The hand-drawn CSS folder box is replaced with clean Lucide folder marks that open/close as you expand a directory, consistent with the new brand file-type icons.

## [0.7.15] — 2026-05-30

### Added
- **Brand file-type icons.** The file tree now shows real, colored language logos (TypeScript, JavaScript, React for `.tsx`/`.jsx`, CSS, HTML, Python, Rust, Bash) sourced from Devicon, plus a JSON badge and a clean generic file mark. Embedded inline — still zero runtime dependencies.
- **PR descriptions render as Markdown.** A new dependency-free, XSS-safe Markdown renderer (`md-util.js`) turns PR bodies into formatted HTML: headings, emphasis, inline/fenced code (syntax-highlighted), links, images, blockquotes, lists, task lists, tables, and autolinks. URLs are scheme-checked so `javascript:`/`data:` never reach the DOM.

### Changed
- **PR checks are summarized instead of dumped.** A pill summary (failing / pending / passed) sits up top, failing and pending checks are listed first, and passing checks collapse behind a "Show N passing checks" toggle. Each check links to its details run.

### Fixed
- **Clicking files in Status is no longer sluggish.** Selecting a file used to re-run `git status`, rebuild the whole pane, and re-run `git diff` on every click. Parsed status and per-file diffs are now cached, so switching between files is a pure repaint — caches refresh on actions, manual refresh, and Status-tab re-entry.

## [0.7.14] — 2026-05-30

### Changed
- **Status selection now behaves more like an editor file list.** File rows use click selection, Cmd/Ctrl-click toggles rows, Shift-click selects ranges, and Cmd/Ctrl-click on folders selects nested files without permanent checkboxes.
- **Status section actions moved closer to their context.** `Unstage all` now lives on the Staged header, while `Stage all` and `Discard all` live on the Changes header.

### Fixed
- **Diff modal loading shimmer fills wide screens.** The loading skeleton now mirrors the final modal layout with a file-tree placeholder on the left and full-width diff placeholders on the right.

## [0.7.13] — 2026-05-30

### Added
- **Status tab can discard selected files or folders.** File rows now have checkboxes, folder and subfolder rows can select all nested files, and the bulk bar can discard only the selected changes.
- **Status tab can discard all changes from the toolbar.** The action handles staged tracked files, unstaged files, untracked files/folders, and dirty submodules with one confirmation.

## [0.7.12] — 2026-05-30

### Changed
- **Toolbar headers are cleaner across the app.** Branches, Stash, Tags, and PR headers now use consistent spacing, wrapping, input sizing, and checkbox alignment.
- **Branch list prioritizes the branches users reach for most.** The current branch stays first, followed by `main`, `master`, then the rest alphabetically. Remote branches remain grouped in the Remote section.

### Fixed
- **Stash and branch bulk-selection bars no longer float with awkward gaps.** The selected-count bar now sits flush above the list with stable spacing.

## [0.7.11] — 2026-05-30

### Changed
- **Tab rendering is less chatty.** Branches, Sync remotes, History logs/details, Stash, Tags, and PR list/details now cache their loaded data across tab switches. The refresh button and data-changing actions still force reloads.
- **Diff file tree rows are cleaner.** Folder/file rows now use steadier spacing, clearer folder icons, fixed-width diffstat pills, and more readable file-name styling.

## [0.7.10] — 2026-05-30

### Fixed
- **Status tab untracked folders are clearer and removable.** Untracked entries now show a `new` badge instead of a raw `?`, preview actions say `Stage all` / `Delete`, and deleting an untracked folder removes the selected folder from disk including ignored contents after confirmation.

### Changed
- **File tree affordances are more explicit.** Expand/collapse folder rows now consistently use a pointer cursor, visible folder icon, chevron, hover/focus states, and stable status sizing.

## [0.7.9] — 2026-05-30

### Fixed
- **Status tab can manage dirty submodules.** `git status --porcelain=v2` is now parsed so entries like `priv` show as modified submodules instead of a confusing `?`, and stage/discard actions run inside the submodule when needed.

## [0.7.8] — 2026-05-30

### Fixed
- **Diff modal header controls are vertically centered.** Title/subtitle text, whitespace/context controls, wrap checkbox, view toggle, fullscreen, and close actions now align cleanly, with the fullscreen button no longer carrying extra visual width.

## [0.7.6] — 2026-05-30

### Fixed
- **JetBrains Mono now actually applies.** The 0.7.5 attempt loaded the font via `@import` from Google Fonts, but the WebView's iframe context blocked the external request — the font never arrived and the system mono stack kept rendering. WOFF2 files now ship locally in `fonts/` (~375 KB for Regular/Medium/SemiBold/Bold) via `@font-face` declarations. Loads instantly, works offline, no repeated downloads.

## [0.7.5] — 2026-05-30

### Added
- **JetBrains Mono everywhere code is rendered.** All `font-family: ui-monospace, Menlo, monospace` declarations consolidated behind a single `--mono` CSS variable that prefers JetBrains Mono (loaded via Google Fonts `@import`) and falls back to the system mono stack offline. Applies to diff code, hunk headers, sha pills, branch chips, history log, rebase rows, tag pills, kbd badges, textarea input — everything.
- **Consistent loading skeleton across every diff-modal open.** New `ui.showLoading(label)` / `ui.hideLoading()` helpers render a modal-shell skeleton with shimmer placeholders for the file header and ~14 diff lines. Wired into stash row click, branch row click, PR diff, and History "Open in viewer" — previously these had no loading state at all and the modal just appeared 100–2000ms later out of nowhere.

### Fixed
- **Double-click on stash/branch/PR rows no longer opens the modal twice.** `ui.showLoading` returns `false` if a modal or skeleton is already up — callers bail out. `ui.diffModal` also refuses if a real modal exists (and seamlessly overwrites a loading skeleton in the smooth-transition path).
- **Merged-branch diff toast is now a quiet "Already merged."** instead of the longer "Branch is identical to HEAD — nothing to diff." Truly-identical unmerged branches keep the original wording because that case isn't obvious from the row.

## [0.7.4] — 2026-05-30

### Fixed
- **Rebase tab actually scrolls.** Long plans had `flex-shrink: 1` on children, so when row count exceeded pane height the plan compressed and `.rebase-plan`'s `overflow: hidden` clipped the middle rows — the visible bug was rows 1–5 + row 10 with a gap and the footer floating. `.rebase-pane > * { flex-shrink: 0 }` now lets the plan keep its natural height and the pane scrolls.
- **Fullscreen modal actually goes fullscreen now.** The 0.7.3 selector `.modal-card.is-fullscreen` (2 classes) lost the specificity battle against `.modal-card.modal-wide` (also 2 classes) which sets `max-width: 92vw` / `max-height: 86vh`. Bumped fullscreen selector to `.modal-card.modal-wide.is-fullscreen` (3 classes) so it wins.
- **Wrap default is now ON.** First-time users see wrapped lines instead of horizontal scroll. The existing `localStorage` persistence preserves whatever the user changes to.

### Added
- **Rebase: `reword` op.** Selecting reword on a commit opens a modal asking for a new message; the new value previews inline below the original as `→ <new>`. On Start rebase, reword commits expand to `pick <sha>` + `exec git commit --amend -m <new>` in the todo file, so the message rewrites cleanly during the non-interactive rebase. Cancelling the new-message modal reverts the select to its previous op.

## [0.7.3] — 2026-05-30

### Fixed
- **Fullscreen modal actually fills the viewport now.** The 0.7.2 attempt left `.modal-root`'s 20px padding intact so the card stayed inset. Now toggles `position: fixed; inset: 0` on the card AND drops the parent's padding via `.modal-root-fullscreen`.
- **Untracked directories no longer render as ghost rows in the Status tree.** `git status` reports untracked directories like `.claude/` (trailing slash); `gmFileTree` previously created a `.claude` dir node plus an empty-name file child — two visual rows for one logical entry. Trailing-slash paths now become single leaves at parent level with the slash preserved for display.
- **Bigger, more visible chevron on per-file diff headers** (History detail + diff modal). Was 9px in a 9px slot — now 13px in an 18px slot with hover highlight. Padding on the header row bumped from 6px to 8px for a more clickable target.
- **Branch facet chips sit flush below the filter row.** Previously had dangling padding (`2px 0 8px`) that left awkward dead space — now padded `8px 12px` with a `border-bottom` so the row feels like a deliberate toolbar.

### Added
- **Folder collapse / expand in the file tree.** Click any folder row to collapse its contents; chevron flips `▾`/`▸`. Works in the Status tab tree and the diff modal's tree pane. State lives in the DOM so a re-render resets to all-expanded.
- **Wrap + Fullscreen toggles persist via localStorage** (`pgm.diff.wrap` / `pgm.diff.fullscreen`). User preference survives closing and re-opening the modal.

### Changed
- **Branch row: click anywhere on the row to open the diff** (matches the stash row UX from 0.7.0). The explicit "Diff" button is gone from both local and remote rows; "Switch" / "Delete" still pill-button. Current branch has no row click (nothing to diff against itself).

## [0.7.2] — 2026-05-30

### Changed
- Split-view diff now scrolls horizontally as a unit per hunk (single scrollbar shared by both columns), replacing the per-line scrollbars introduced in 0.7.1. Inner grid uses `width: max-content; min-width: 100%` to grow with content while keeping a 50/50 split. Same improvement applies to the Status tab's split view.

### Added
- **Wrap toggle** in the diff modal head. Toggles `pre-wrap` + `word-break: break-word` on diff code so long lines fold to fit the cell instead of triggering horizontal scroll. Works for both unified and split view.
- **Fullscreen button** in the diff modal head. Expands the modal card to viewport (`100vw × 100vh`, no border-radius). Toggles back to a regular wide modal via `Restore`.

### Fixed
- Branch "Diff" now falls back to a two-arg `<branch> HEAD` diff when the three-dot `HEAD...<branch>` is empty. Previously, a branch that was created from main and never updated (while main moved forward) was labeled "unmerged" but showed "already merged or identical" when you clicked Diff — contradicting the badge. Now the modal opens with the changes HEAD carries that the branch doesn't, titled "Branch diff: ... (behind HEAD)". Only when both directions are empty does the toast still say "identical to HEAD".

## [0.7.1] — 2026-05-30

### Fixed
- Split-view diff right column no longer overflows past the modal edge. Grid templates now use `minmax(0, 1fr)` so both sides stay 50/50, and long lines scroll horizontally inside each code cell instead of pushing the layout wider than its container. Same fix benefits the Status tab's split view (shared `.diff-cell` rules).

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
