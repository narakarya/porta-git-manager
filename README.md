# porta-git-manager

A vanilla-JS git GUI that ships as a [Porta](https://github.com/narakarya/porta) extension. Status, stage, commit, branches, sync, rebase, stash, tags — all driven by `git` against the active app's `root_dir`.

No build step. No runtime dependencies. Talks to Porta via `window.portaBridge`.

## Install

In Porta → Settings → Extensions → "Install from GitHub":

```
narakarya/porta-git-manager
```

Pin a version:
```
narakarya/porta-git-manager@v0.7.0
```

## Features

| Tab | What |
|-----|------|
| **Status** | File tree (folder-nested) for staged + unstaged + untracked. Per-file and per-hunk Stage / Unstage / Discard. Commit / amend (⌘↵). Unified ↔ Split diff toggle. |
| **Branches** | Local + remote, facet chips (All / Merged / Unmerged / Local-only / On remote), filter, current marker, ahead/behind, tracking + merge badges, diff preview, multi-select bulk delete, remote-branch delete. |
| **Sync** | Card grid: Fetch, Fetch+prune, Pull, Pull --rebase, Rebase from main/master, Push, Push --force-with-lease. Remote management. |
| **History** | Commit log with message search, source-branch picker for cross-branch cherry-pick, commit detail card (subject + body + author chip + SHA pills), inline diff with sticky file headers, "Open in viewer" for tree-pane navigation, cherry-pick, and reset. |
| **Rebase** | Pick / squash / fixup / drop per commit, reorder with ↑↓, abort / continue on pause. |
| **Stash** | Save with message + include-untracked. Click any row to view changes (tree-style diff viewer). Apply / Pop / Drop. Multi-select bulk drop. |
| **Tags** | Lightweight or annotated, push / delete locally and on origin. |

## Security

- Sees only the active app's `root_dir`. Porta's `extension_shell_run` refuses any `cwd` outside it.
- Permissions: `shell` only. No network, no filesystem outside `root_dir`.

## Development

Clone:
```bash
git clone git@github.com:narakarya/porta-git-manager.git
cd porta-git-manager
```

Symlink for hot-reload in Porta:
```bash
ln -s "$PWD" ~/.porta/extensions/git-manager
```
Then Settings → Extensions → ↻ refresh.

Tests:
```bash
npm test
```

## License

MIT. See [LICENSE](./LICENSE).

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).
