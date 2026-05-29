# Git Manager — Porta extension

Runs `git` against an app's `root_dir` from the extension panel. No build step;
pure HTML + JS + CSS that talks to Porta via `window.portaBridge`.

## Features

| Tab | What |
|-----|------|
| **Status** | Split view with diff preview, **per-hunk Stage / Unstage / Discard** buttons (hover the hunk header), file-level stage / unstage / discard, commit + amend (⌘↵). |
| **Branches** | Local + remote, filter input, current marker, ahead/behind tracking, create + switch + (force-)delete. |
| **Sync** | Card grid: Fetch, Fetch + prune, Pull, Pull --rebase, Push, Push --force-with-lease. Per-card running state. |
| **History** | Split view: last 100 commits with message search; click to see header + colored diff. |
| **Rebase** | Pick a target ref, choose pick/squash/fixup/drop per commit, reorder with ↑↓, abort/continue when paused. |
| **Stash** | List, save (with message + include-untracked toggle), apply, pop, drop. |
| **Tags** *(new in 0.3.0)* | Create lightweight or annotated tags, push to origin, delete locally, delete on origin. Filter input for finding among many. |

## UX shortcuts

- `1`–`7` switch tabs (Status / Branches / Sync / History / Rebase / Stash / Tags).
- `R` refreshes the active tab (branch, status, rebase state, stash count).
- `⌘↵` (or `Ctrl↵`) inside the commit textarea commits.
- Toasts replace native dialogs for routine feedback; an in-app modal handles
  destructive confirmations so you stay inside the panel.
- Every git action auto-refreshes the relevant tab — no manual reload.

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
