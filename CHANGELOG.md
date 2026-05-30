# Changelog

All notable changes to porta-git-manager are documented here. This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) loosely.

## [Unreleased]
- (Pending v0.7.0 features.)

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
