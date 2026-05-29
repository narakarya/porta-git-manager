# Git Manager — Porta extension

Runs `git` against an app's `root_dir` from the extension panel. No build step;
pure HTML + JS + CSS that talks to Porta via `window.portaBridge`.

## Features

| Tab | What |
|-----|------|
| **Status** | Working-tree and staged diff, stage/unstage per file, discard, commit (with amend) |
| **Branches** | List local + remote, switch, create, delete (with force-delete fallback), see upstream tracking + ahead/behind |
| **Sync** | Fetch (+ prune), pull, pull --rebase, push, push --force-with-lease |
| **History** | Last 100 commits; click to expand `git show --stat -p` with colored diff |
| **Rebase** | Pick a target (`HEAD~5`, `main`, SHA…); choose pick/squash/fixup/drop per commit; abort/continue when paused |
| **Stash** | Save (optional message + include-untracked), apply, pop, drop |

All commands stream to the bottom drawer so you can scrub output, retry, or
copy the failing line into a terminal.

## Install (dev)

1. Open Porta → Settings → Extensions → "Install from folder…".
2. Pick this folder.
3. Open any app card → click Extensions → choose **Git Manager**.

## Install (from GitHub)

Once published, install via shorthand: `owner/repo` or the full GitHub URL.

## Security

- The extension only sees `app.root_dir`. Porta's `extension_shell_run` refuses
  any `cwd` outside of it.
- Requires only the `shell` permission. No network, no filesystem outside
  `root_dir`.

## Interactive rebase notes

The UI drives `git rebase -i` non-interactively:

- `GIT_SEQUENCE_EDITOR='cp <tmp>'` overwrites git's auto-generated todo with
  ours, so the pick/squash/fixup/drop choices you set in the UI take effect.
- `GIT_EDITOR=true` accepts squash's combined-message editor unchanged — you
  get git's default merged message. Use Status → Amend to rewrite it after.
- On conflict, the rebase pauses. Resolve in your editor, stage the fixes
  from the Status tab, then return here and click **Continue**.

If you want to abandon a paused rebase, hit **Abort** — it runs
`git rebase --abort` and you're back where you started.
