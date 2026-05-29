# Git Manager — Porta extension

Runs `git` against an app's `root_dir` from the extension panel. No build step;
pure HTML + JS + CSS that talks to Porta via `window.portaBridge`.

## Features

| Tab | What |
|-----|------|
| **Status** | Split view with diff preview, **per-hunk Stage / Unstage / Discard** (hover the hunk header), file-level stage / unstage / discard, commit + amend (⌘↵), **Unified ↔ Split diff toggle** *(new in 0.4.0)*. Untracked files **and directories** now preview their contents instead of showing "(no diff)" *(fixed in 0.6.0)*. |
| **Branches** | Local + remote, filter input, current marker, ahead/behind tracking, create + switch + (force-)delete. **Merged / unmerged badges**, tracking badges, and last-commit info per row *(new in 0.6.0)*. |
| **Sync** | Card grid: Fetch, Fetch + prune, Pull, Pull --rebase, Push, Push --force-with-lease. Per-card running state. **Remote management** *(new in 0.4.0)*: list / add / rename / edit-URL / remove. **Top-bar quick Pull / Push** *(new in 0.6.0)*. |
| **History** | Split view: last 100 commits with message search; click to see header + colored diff. |
| **Rebase** | Pick a target ref, choose pick/squash/fixup/drop per commit, reorder with ↑↓, abort/continue when paused. |
| **Stash** | List, save (with message + include-untracked toggle), apply, pop, drop. Rows show the **branch chip + relative time**, parsed from the stash message *(new in 0.6.0)*. |
| **Tags** *(new in 0.3.0)* | Create lightweight or annotated tags, push to origin, delete locally, delete on origin. Filter input for finding among many. |

## UI/UX overhaul + fixes (0.6.0)

- **Untracked diff fix** — untracked files used to show "(no diff)" because the
  list passed them through as `unstaged`, so `git diff` (which ignores untracked
  paths) returned nothing. They now route through the `untracked` path and
  preview their first 4 KB as an all-added hunk. **Untracked directories** list
  their contained files instead of erroring on `head`. Discard handles
  directories too (`rm -rf` / `git clean -fd`).
- **Branches** — larger rows with per-row last-commit info (sha · relative time ·
  subject). New **status badges**: `merged` / `unmerged` (via `git branch
  --merged`) so you can see at a glance which branches are safe to delete, plus
  tracking badges (`up to date` / `↑n ↓n` / `upstream gone` / `local-only`).
  Switch / Delete / Check out became visible pill buttons.
- **Stash** — the `WIP on <branch>: <sha> <subject>` message is parsed into a
  branch chip + relative time, the leading sha is dropped from the description,
  and the cramped `stash@{n}` column got proper spacing. Apply / Pop / Drop are
  pill buttons.
- **Rebase** — the target input is now a labelled card, the empty state is an
  informative panel, todo rows carry per-op colour accents (pick=green,
  squash/fixup=amber, drop=red) plus a "X of Y commits kept" counter.
- **Top bar** — quick **Pull** / **Push** buttons next to the branch chip, with
  live ahead/behind counts (`Pull ↓2`, `Push ↑3`) and a highlight when there's
  work to do. They share the Sync tab's runner (toast → run → toast → refresh)
  and disable while running.
- **Sync** — remote actions (Edit URL / Rename / Remove) use the same pill style
  for consistency.

## UI/UX overhaul (0.5.0)

A systemic visual refresh built on a single design-token system:

- **Diffs** (Status + History, unified *and* split) now render a **line-number
  gutter**, **word-level change highlighting** (only the changed tokens within a
  `-`/`+` pair are emphasized), and **syntax highlighting** for common languages
  (JS/TS/JSX, JSON, CSS, HTML, Markdown, shell, Rust, Python). Unknown file types
  fall back to plain rendering — highlighting can never break a diff.
- **Search-match highlighting**: typing in the Status / Branches / History / Tags
  filters wraps the matched substring in a `mark`, so you see *why* a row matched.
  Branches gets a friendly empty-filter message.
- **Visible-at-rest actions**: row actions (stage/unstage/discard, branch/stash/tag
  buttons, per-hunk actions) are now faintly visible instead of hidden until hover,
  and brighten on hover/selection.
- Tab badges reserve their space (no layout shift), rebase todo rows are
  colour-coded per op, and focus rings support keyboard navigation.

The diff/word/syntax/search logic lives in three small, unit-tested modules
(`text-util.js`, `diff-util.js`, `highlight.js`). Run the tests with:

```bash
node --test extensions-bundled/git-manager/test/text-util.test.mjs \
            extensions-bundled/git-manager/test/diff-util.test.mjs \
            extensions-bundled/git-manager/test/highlight.test.mjs
```

## UX shortcuts

- `1`–`7` switch tabs (Status / Branches / Sync / History / Rebase / Stash / Tags).
- `R` refreshes the active tab (branch, status, rebase state, stash count).
- `⌘↵` (or `Ctrl↵`) inside the commit textarea commits.
- Toasts replace native dialogs for routine feedback; an in-app modal handles
  destructive confirmations so you stay inside the panel.
- Every git action auto-refreshes the relevant tab — no manual reload.

## Split / unified diff (0.4.0)

In the Status tab toolbar, toggle between **Unified** (single column with
`+`/`-` prefixes) and **Split** (two columns, old left, new right). Split
view pairs consecutive removed/added lines so corresponding edits sit on
the same row; uneven runs spill into extra rows with the shorter side
blank. Context lines mirror on both sides.

## Remote management (0.4.0)

In the Sync tab, the Remotes box lists each remote with its fetch URL.
Per-row actions:

- **edit URL** — `git remote set-url <name> <url>`
- **rename** — `git remote rename <old> <new>`
- **remove** — `git remote remove <name>` (with confirm)

The add-remote form at the bottom takes a name + URL and runs
`git remote add`. Push / fetch from the Tags tab and the sync grid use
the standard remote resolution, so adding/removing a remote here
immediately affects what gets fetched and pushed.

## Per-hunk staging (0.3.0)

In the Status tab's diff preview, hover any hunk's `@@` header to reveal
**Stage hunk** / **Discard** (or **Unstage hunk** if the diff is from the
index). Under the hood the extension writes a minimal patch and runs
`git apply --cached` / `--reverse` for each click — same semantics as
`git add -p`.

Untracked files render their first 4 KB as a single all-added hunk;
"Stage" stages the whole file, "Discard" deletes it from disk (with
confirm modal).

## Install (locally bundled)

This folder ships inside the Porta repo at `extensions-bundled/git-manager/`.

**One-off install (Settings UI):**
1. Porta → Settings → Extensions → "Install from folder…"
2. Pick `<porta-repo>/extensions-bundled/git-manager`

**Symlink (hot-reload during dev):**
```bash
ln -s "$PWD/extensions-bundled/git-manager" ~/.porta/extensions/git-manager
```
Then Settings → Extensions → refresh (↻).

## Install (from GitHub subpath, Porta ≥ 0.5.69)

The loader supports `owner/repo:subpath` shorthand. Settings → Extensions →
"Install from GitHub" with:

```
narakarya/porta:extensions-bundled/git-manager
```

or a branch-pinned form:

```
narakarya/porta@main:extensions-bundled/git-manager
```

Equivalent full URL:

```
https://github.com/narakarya/porta/tree/main/extensions-bundled/git-manager
```

Porta downloads the whole repo zip into a tempdir, then installs the
extension from the subpath. Updates use the same URL via the "Update" button
in Settings → Extensions.

## Security

- Only sees `app.root_dir`. Porta's `extension_shell_run` refuses any `cwd`
  outside of it.
- Requires only the `shell` permission. No network, no filesystem outside
  `root_dir`.

## Interactive rebase notes

The UI drives `git rebase -i` non-interactively:

- `GIT_SEQUENCE_EDITOR='cp <tmp>'` overwrites git's auto-generated todo with
  the pick/squash/fixup/drop choices you set in the UI.
- `GIT_EDITOR=true` accepts squash's combined-message editor unchanged — you
  get git's default merged message. Use Status → Amend HEAD to rewrite it.
- On conflict, the rebase pauses. Resolve in your editor, stage the fixes
  from the Status tab, then click **Continue** here.

If you want to abandon a paused rebase, hit **Abort** — runs
`git rebase --abort` and you're back where you started.
