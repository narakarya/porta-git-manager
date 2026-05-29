// Git Manager — vanilla JS git GUI. Talks to Porta's host via portaBridge.
//
// Structural notes:
//   • Each tab is a closure that owns its own render state and exposes only
//     `render(opts?)`. The shell calls render() when the tab activates and
//     after any global refresh.
//   • All git work goes through `git(args)` / `sh(cmd)` which return the
//     ShellResult shape from the bridge. Callers decide how to surface
//     errors (toast vs. inline banner vs. modal).
//   • UI primitives (toast, confirm modal, file selector) live in `ui.*`
//     and are *not* the host's portaBridge.ui — those are too thin for
//     anything more than a status message.
(function () {
  "use strict";

  const bridge = window.portaBridge;
  if (!bridge) {
    document.body.innerText = "Missing portaBridge. Reload the extension.";
    return;
  }

  // ── Global state ─────────────────────────────────────────────────────────
  const state = {
    currentTab: "status",
    branch: null,
    upstream: null,
    aheadBehind: null,
    rebaseInProgress: false,
    stashCount: 0,
    repoOk: false,
    // Per-tab caches that survive tab switching — refetched only by refresh()
    // or after an action that invalidates the cache.
    statusFiles: { staged: [], unstaged: [] },
    selectedFile: null,
    fileFilter: "",
    branches: { local: [], remote: [] },
    branchFilter: "",
    log: [],
    historyFilter: "",
    selectedCommit: null,
    rebasePlan: [],
    rebaseTarget: "HEAD~5",
    stashes: [],
    commitMsg: "",
    commitAmend: false,
  };

  // ── Helpers ──────────────────────────────────────────────────────────────
  const $ = (sel, root) => (root || document).querySelector(sel);
  const quote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

  function git(args, opts) {
    return bridge.shell.run("git " + args, opts || {});
  }
  function sh(cmd, opts) {
    return bridge.shell.run(cmd, opts || {});
  }

  /** Create an element via (tag, props?, ...children). False/null children skipped. */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (k === "class") el.className = v;
        else if (k === "html") el.innerHTML = v;
        else if (k === "dataset") for (const d in v) el.dataset[d] = v[d];
        else if (k.startsWith("on") && typeof v === "function") {
          el.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (k === "style" && typeof v === "object") {
          for (const s in v) el.style[s] = v[s];
        } else if (k in el) {
          el[k] = v;
        } else {
          el.setAttribute(k, v);
        }
      }
    }
    for (const c of children) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function splitPath(p) {
    const i = p.lastIndexOf("/");
    return i === -1 ? { dir: "", name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
  }

  // ── UI primitives: toast + modal confirm ─────────────────────────────────
  const ui = {
    toast(msg, kind = "info", ms = 2400) {
      const region = $("#toast-region");
      if (!region) return;
      const t = h("div", { class: "toast toast-" + kind },
        h("span", { class: "toast-msg" }, msg),
        h("button", {
          class: "toast-close",
          onClick: () => t.remove(),
          innerHTML: '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
        }),
      );
      region.appendChild(t);
      if (ms > 0) setTimeout(() => t.remove(), ms);
    },
    confirm({ title, body, danger, okLabel = "OK", cancelLabel = "Cancel" }) {
      return new Promise((resolve) => {
        const root = $("#modal-root");
        root.hidden = false;
        root.innerHTML = "";
        const close = (ok) => {
          root.hidden = true;
          root.innerHTML = "";
          window.removeEventListener("keydown", onKey, true);
          resolve(ok);
        };
        const onKey = (e) => {
          if (e.key === "Escape") { e.stopPropagation(); close(false); }
          else if (e.key === "Enter") { e.preventDefault(); close(true); }
        };
        window.addEventListener("keydown", onKey, true);
        const card = h("div", { class: "modal-card" },
          h("h3", null, title),
          body && h("p", null, body),
          h("div", { class: "actions" },
            h("button", { class: "btn-ghost", onClick: () => close(false) }, cancelLabel),
            h("button", {
              class: danger ? "btn-danger" : "btn-primary",
              onClick: () => close(true),
              autofocus: true,
            }, okLabel),
          ),
        );
        root.appendChild(card);
        const okBtn = card.querySelector("button[autofocus]");
        if (okBtn) okBtn.focus();
      });
    },
  };

  // ── Top-bar branch chip / badges ─────────────────────────────────────────
  function paintTopBar() {
    const chip = $("#branch-chip");
    if (chip) {
      chip.innerHTML = "";
      if (state.branch) {
        chip.append(state.branch);
        if (state.aheadBehind) {
          if (state.aheadBehind.ahead) {
            chip.append(h("span", { class: "delta ahead" }, " ↑" + state.aheadBehind.ahead));
          }
          if (state.aheadBehind.behind) {
            chip.append(h("span", { class: "delta behind" }, " ↓" + state.aheadBehind.behind));
          }
        }
      }
    }
    const setBadge = (id, text, urgent) => {
      const b = document.getElementById(id);
      if (!b) return;
      if (text) { b.textContent = text; b.classList.add("show"); }
      else b.classList.remove("show");
      b.classList.toggle("urgent", !!urgent);
    };
    const changesCount = state.statusFiles.staged.length + state.statusFiles.unstaged.length;
    setBadge("badge-status", changesCount > 0 ? String(changesCount) : "");
    setBadge("badge-stash", state.stashCount > 0 ? String(state.stashCount) : "");
    setBadge("badge-rebase", state.rebaseInProgress ? "!" : "", true);
  }

  // ── Repo / HEAD probes ───────────────────────────────────────────────────
  async function detectRepo() {
    const r = await git("rev-parse --is-inside-work-tree");
    state.repoOk = r.code === 0 && r.stdout.trim() === "true";
    return state.repoOk;
  }

  async function readHead() {
    const head = await git("symbolic-ref --quiet --short HEAD");
    if (head.code === 0) {
      state.branch = head.stdout.trim();
    } else {
      const sha = await git("rev-parse --short HEAD");
      state.branch = sha.code === 0 ? "(" + sha.stdout.trim() + ")" : "(no HEAD)";
    }
    const up = await git("rev-parse --abbrev-ref --symbolic-full-name @{u}");
    state.upstream = up.code === 0 ? up.stdout.trim() : null;
    if (state.upstream) {
      const counts = await git("rev-list --left-right --count @{u}...HEAD");
      if (counts.code === 0) {
        const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number);
        state.aheadBehind = { ahead, behind };
      } else state.aheadBehind = null;
    } else state.aheadBehind = null;
  }

  async function detectRebase() {
    const r = await git("rev-parse --git-path rebase-merge");
    if (r.code !== 0) { state.rebaseInProgress = false; return; }
    const p = r.stdout.trim();
    const c = await sh("test -d " + quote(p) + " && echo y || echo n");
    if (c.stdout.trim() === "y") { state.rebaseInProgress = true; return; }
    const r2 = await git("rev-parse --git-path rebase-apply");
    if (r2.code === 0) {
      const p2 = r2.stdout.trim();
      const c2 = await sh("test -d " + quote(p2) + " && echo y || echo n");
      state.rebaseInProgress = c2.stdout.trim() === "y";
    } else state.rebaseInProgress = false;
  }

  async function probeStashCount() {
    const r = await git("stash list --format=%gd");
    state.stashCount = r.code === 0 ? r.stdout.split("\n").filter(Boolean).length : 0;
  }

  // ── Tab routing ──────────────────────────────────────────────────────────
  function activateTab(name) {
    state.currentTab = name;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-active", t.dataset.tab === name));
    document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("is-active", p.dataset.pane === name));
    renderActiveTab();
  }

  function renderActiveTab() {
    const map = { status: statusTab, branches: branchesTab, sync: syncTab, history: historyTab, rebase: rebaseTab, stash: stashTab };
    const tab = map[state.currentTab];
    if (tab) tab.render();
  }

  // ── Status tab ───────────────────────────────────────────────────────────
  const statusTab = (() => {
    const pane = () => document.querySelector('.pane[data-pane="status"]');
    let lastDiffPath = null;
    let lastDiffSource = null;  // "staged" | "unstaged" | "untracked"

    function parsePorcelain(text) {
      const staged = [], unstaged = [];
      for (const line of text.split("\n").filter(Boolean)) {
        if (line.length < 3) continue;
        const x = line[0], y = line[1];
        const path = line.slice(3).replace(/^"|"$/g, "");
        if (x !== " " && x !== "?") staged.push({ code: x, path });
        if (y !== " " || x === "?") unstaged.push({ code: y === " " ? x : y, path, untracked: x === "?" });
      }
      return { staged, unstaged };
    }

    function statusClass(code) {
      return ({ M: "modified", A: "added", D: "deleted", R: "renamed", "?": "untracked" })[code] || "modified";
    }

    async function loadStatus() {
      const r = await git("status --porcelain=v1");
      if (r.code !== 0) return { err: r.stderr || "git status failed" };
      return parsePorcelain(r.stdout);
    }

    async function loadDiff(file, source) {
      if (source === "untracked") {
        const r = await sh("head -c 4096 " + quote(file.path));
        if (r.code !== 0) return [{ kind: "meta", text: "(binary or unreadable)" }];
        const lines = (r.stdout || "").split("\n");
        return [
          { kind: "file", text: file.path + " (untracked)" },
          ...lines.map((l) => ({ kind: "add", text: "+" + l })),
        ];
      }
      const flag = source === "staged" ? "--cached" : "";
      const r = await git("diff --no-color " + flag + " -- " + quote(file.path));
      if (r.code !== 0) return [{ kind: "meta", text: r.stderr || "(no diff)" }];
      if (!r.stdout.trim()) return [{ kind: "meta", text: "(no diff)" }];
      return r.stdout.split("\n").map(classifyDiffLine);
    }

    function classifyDiffLine(line) {
      if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ")) return { kind: "file", text: line };
      if (line.startsWith("@@")) return { kind: "hunk", text: line };
      if (line.startsWith("+")) return { kind: "add", text: line };
      if (line.startsWith("-")) return { kind: "del", text: line };
      return { kind: "meta", text: line };
    }

    function renderDiffInto(node, lines) {
      node.innerHTML = "";
      for (const l of lines) {
        node.appendChild(h("span", { class: "diff-line diff-" + l.kind }, l.text || " "));
      }
    }

    async function selectFile(file, source, diffNode) {
      state.selectedFile = file ? `${source}:${file.path}` : null;
      lastDiffPath = file?.path;
      lastDiffSource = source;
      document.querySelectorAll('.pane[data-pane="status"] .file-row').forEach((row) => {
        row.classList.toggle("is-selected", row.dataset.key === state.selectedFile);
      });
      if (!file) {
        diffNode.innerHTML = '<div class="status-diff-empty">Select a file to preview the diff.</div>';
        return;
      }
      diffNode.innerHTML = '<div class="status-diff-empty"><span class="spinner"></span></div>';
      const lines = await loadDiff(file, source);
      // If user clicked something else while we were loading, drop this result.
      if (lastDiffPath !== file.path || lastDiffSource !== source) return;
      renderDiffInto(diffNode, lines);
    }

    // ── Actions ───────────────────────────────────────────────────────────
    async function withRefresh(fn, okMsg) {
      try {
        const r = await fn();
        if (r && r.code !== 0) {
          ui.toast(r.stderr || "Git error", "error");
          return false;
        }
        if (okMsg) ui.toast(okMsg, "success");
        await refresh();
        return true;
      } catch (e) {
        ui.toast(String(e), "error");
        return false;
      }
    }

    const stage     = (p) => withRefresh(() => git("add -- " + quote(p)));
    const stageAll  = () => withRefresh(() => git("add -A"), "Staged all changes");
    async function unstage(p) {
      const r = await git("restore --staged -- " + quote(p));
      if (r.code !== 0) await git("reset HEAD -- " + quote(p));
      await refresh();
    }
    async function unstageAll() {
      const r = await git("restore --staged .");
      if (r.code !== 0) await git("reset HEAD .");
      ui.toast("Unstaged all", "success");
      await refresh();
    }
    async function discard(file) {
      const ok = await ui.confirm({
        title: "Discard changes?",
        body: `This will permanently revert ${file.path}. There's no undo for unstaged work.`,
        danger: true, okLabel: "Discard",
      });
      if (!ok) return;
      if (file.untracked) await git("clean -f -- " + quote(file.path));
      else {
        const r = await git("restore -- " + quote(file.path));
        if (r.code !== 0) await git("checkout -- " + quote(file.path));
      }
      ui.toast("Discarded changes", "success");
      await refresh();
    }
    async function commit() {
      const msg = state.commitMsg.trim();
      if (!state.commitAmend && !msg) { ui.toast("Commit message required", "error"); return; }
      const args = state.commitAmend
        ? "commit --amend" + (msg ? " -m " + quote(msg) : " --no-edit")
        : "commit -m " + quote(msg);
      const r = await git(args);
      if (r.code === 0) {
        state.commitMsg = "";
        state.commitAmend = false;
        ui.toast(state.commitAmend ? "Amended commit" : "Committed", "success");
        await refresh();
      } else {
        ui.toast(r.stderr || "Commit failed", "error", 5000);
      }
    }

    // ── Render ────────────────────────────────────────────────────────────
    function fileLabel(file) {
      const { dir, name } = splitPath(file.path);
      return h("span", { class: "file-path", title: file.path },
        dir && h("span", { class: "file-dir" }, dir),
        h("span", { class: "file-name" }, name),
      );
    }

    function renderFileRow(file, source, diffNode) {
      const key = `${source}:${file.path}`;
      const isStaged = source === "staged";
      const row = h("div", {
        class: "file-row " + statusClass(file.code) + (state.selectedFile === key ? " is-selected" : ""),
        dataset: { key },
        onClick: () => selectFile(file, source, diffNode),
      },
        h("span", { class: "file-status" }, file.code),
        fileLabel(file),
        h("span", { class: "row-actions" },
          isStaged
            ? h("button", { class: "row-action", onClick: (e) => { e.stopPropagation(); unstage(file.path); } }, "unstage")
            : h("button", { class: "row-action", onClick: (e) => { e.stopPropagation(); stage(file.path); } }, "stage"),
          !isStaged && h("button", { class: "row-action danger", onClick: (e) => { e.stopPropagation(); discard(file); } }, "discard"),
        ),
      );
      return row;
    }

    async function render() {
      const node = pane();
      node.innerHTML = "";
      node.className = "pane is-active status-pane";

      const status = await loadStatus();
      if (status.err) {
        node.append(h("div", { class: "empty" }, h("p", { class: "empty-title" }, "Could not read status"), h("p", { class: "empty-sub" }, status.err)));
        return;
      }
      state.statusFiles = { staged: status.staged, unstaged: status.unstaged };
      paintTopBar();

      const filter = state.fileFilter.toLowerCase();
      const match = (f) => !filter || f.path.toLowerCase().includes(filter);
      const staged = status.staged.filter(match);
      const unstaged = status.unstaged.filter(match);

      // ─── Toolbar ──────────────────────────────────────────────────────
      const filterInput = h("input", {
        class: "status-filter",
        placeholder: "Filter files…",
        value: state.fileFilter,
        onInput: (e) => { state.fileFilter = e.target.value; render(); },
      });
      const toolbar = h("div", { class: "status-toolbar" },
        filterInput,
        h("button", { class: "btn-ghost", onClick: stageAll, disabled: unstaged.length === 0 }, "Stage all"),
        h("button", { class: "btn-ghost", onClick: unstageAll, disabled: staged.length === 0 }, "Unstage all"),
      );
      node.append(toolbar);

      // ─── Split (file list ↔ diff) ────────────────────────────────────
      const diffNode = h("div", { class: "status-diff" });
      diffNode.innerHTML = '<div class="status-diff-empty">Select a file to preview the diff.</div>';

      const list = h("div", { class: "status-list" });

      list.append(
        h("div", { class: "file-section-title" },
          "Staged",
          h("span", { class: "count" }, String(staged.length)),
        ),
      );
      if (staged.length === 0) {
        list.append(h("div", { class: "empty-files" }, "Nothing staged"));
      } else {
        staged.forEach((f) => list.append(renderFileRow(f, "staged", diffNode)));
      }

      list.append(
        h("div", { class: "file-section-title" },
          "Changes",
          h("span", { class: "count" }, String(unstaged.length)),
        ),
      );
      if (unstaged.length === 0) {
        list.append(h("div", { class: "empty-files" }, status.unstaged.length === 0 ? "Working tree clean" : "Nothing matches filter"));
      } else {
        unstaged.forEach((f) => list.append(renderFileRow(f, "unstaged", diffNode)));
      }

      const split = h("div", { class: "status-split" }, list, diffNode);
      node.append(split);

      // Re-apply selection diff after re-render so picking a stage/unstage
      // doesn't blank the diff pane each time.
      if (state.selectedFile) {
        const [src, ...rest] = state.selectedFile.split(":");
        const path = rest.join(":");
        const pool = src === "staged" ? status.staged : status.unstaged;
        const file = pool.find((f) => f.path === path);
        if (file) selectFile(file, src, diffNode);
        else state.selectedFile = null;
      }

      // ─── Commit area ──────────────────────────────────────────────────
      const ta = h("textarea", {
        placeholder: state.commitAmend ? "Amend message (blank = keep HEAD's)" : "Commit message…",
        value: state.commitMsg,
        onInput: (e) => { state.commitMsg = e.target.value; },
        onKeydown: (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        },
      });
      const amendChk = h("input", {
        type: "checkbox",
        checked: state.commitAmend,
        onChange: (e) => { state.commitAmend = e.target.checked; render(); },
      });
      const submitBtn = h("button", { class: "btn-primary", onClick: commit },
        state.commitAmend ? "Amend commit" : "Commit",
        h("span", { class: "kbd" }, "⌘↵"),
      );
      if (!state.commitAmend && staged.length === 0) submitBtn.disabled = true;

      node.append(
        h("div", { class: "commit-area" },
          ta,
          h("div", { class: "commit-options" },
            h("label", null, amendChk, "Amend HEAD"),
            h("span", { class: "spacer" }),
            submitBtn,
          ),
        ),
      );
    }

    return { render };
  })();

  // ── Branches tab ─────────────────────────────────────────────────────────
  const branchesTab = (() => {
    const pane = () => document.querySelector('.pane[data-pane="branches"]');
    let newBranchName = "";

    async function loadBranches() {
      const sep = "\x1f";
      const r = await git("branch -a --format=" + quote("%(HEAD)" + sep + "%(refname:short)" + sep + "%(upstream:short)" + sep + "%(upstream:track)" + sep + "%(objectname:short)"));
      if (r.code !== 0) return { local: [], remote: [] };
      const all = r.stdout.split("\n").filter(Boolean).map((line) => {
        const [head, name, upstream, track, sha] = line.split(sep);
        return {
          isCurrent: head === "*",
          name, upstream: upstream || null, track: track || "", sha,
          isRemote: name.startsWith("remotes/"),
        };
      });
      return {
        local: all.filter((b) => !b.isRemote),
        remote: all.filter((b) => b.isRemote && !b.name.endsWith("/HEAD")),
      };
    }

    async function checkout(b) {
      let args, label;
      if (b.isRemote) {
        const local = b.name.split("/").slice(2).join("/");
        args = "checkout -b " + quote(local) + " " + quote(b.name);
        label = local;
      } else {
        args = "checkout " + quote(b.name);
        label = b.name;
      }
      const r = await git(args);
      if (r.code === 0) {
        ui.toast("Switched to " + label, "success");
        await refresh();
      } else ui.toast(r.stderr || "Checkout failed", "error", 5000);
    }

    async function createBranch() {
      const name = newBranchName.trim();
      if (!name) return;
      const r = await git("checkout -b " + quote(name));
      if (r.code === 0) {
        newBranchName = "";
        ui.toast("Created " + name, "success");
        await refresh();
      } else ui.toast(r.stderr || "Create failed", "error", 5000);
    }

    async function deleteBranch(name) {
      const ok = await ui.confirm({
        title: "Delete branch?",
        body: `Delete local branch "${name}"? If it has unmerged commits, you'll be prompted to force-delete.`,
        danger: true, okLabel: "Delete",
      });
      if (!ok) return;
      let r = await git("branch -d " + quote(name));
      if (r.code !== 0) {
        const force = await ui.confirm({
          title: "Force delete?",
          body: `"${name}" isn't fully merged. Force-deleting drops the unmerged commits.`,
          danger: true, okLabel: "Force delete",
        });
        if (!force) return;
        r = await git("branch -D " + quote(name));
      }
      if (r.code === 0) {
        ui.toast("Deleted " + name, "success");
        await refresh();
      } else ui.toast(r.stderr || "Delete failed", "error", 5000);
    }

    async function render() {
      const node = pane();
      node.innerHTML = "";
      node.className = "pane is-active branches-pane";

      const filterInput = h("input", {
        class: "history-search",
        placeholder: "Filter branches…",
        value: state.branchFilter,
        onInput: (e) => { state.branchFilter = e.target.value; render(); },
      });
      const newInput = h("input", {
        class: "input", style: { maxWidth: "240px" },
        placeholder: "New branch name…",
        value: newBranchName,
        onInput: (e) => { newBranchName = e.target.value; },
        onKeydown: (e) => { if (e.key === "Enter") createBranch(); },
      });
      const top = h("div", { class: "branches-top" },
        filterInput,
        h("div", { style: { flex: "1" } }),
        newInput,
        h("button", { class: "btn-primary", onClick: createBranch, disabled: !newBranchName.trim() }, "Create"),
      );
      node.append(top);

      const { local, remote } = await loadBranches();
      state.branches = { local, remote };

      const f = state.branchFilter.toLowerCase();
      const match = (b) => !f || b.name.toLowerCase().includes(f);

      const list = h("div", { class: "branches-list" });

      const filteredLocal = local.filter(match);
      list.append(h("div", { class: "branch-section-title" }, "Local", h("span", { class: "count" }, String(filteredLocal.length))));
      if (filteredLocal.length === 0) list.append(h("div", { class: "empty-files" }, "No matching local branches"));
      for (const b of filteredLocal) {
        list.append(h("div", { class: "branch-row" + (b.isCurrent ? " is-current" : "") },
          h("span", { class: "branch-marker" }, b.isCurrent ? "●" : ""),
          h("span", { class: "branch-name", title: b.name }, b.name),
          h("span", { class: "branch-meta" }, b.upstream ? `${b.upstream} ${b.track}` : ""),
          h("span", { class: "branch-actions" },
            !b.isCurrent && h("button", { class: "row-action", onClick: () => checkout(b) }, "switch"),
            !b.isCurrent && h("button", { class: "row-action danger", onClick: () => deleteBranch(b.name) }, "delete"),
          ),
        ));
      }

      const filteredRemote = remote.filter(match);
      if (filteredRemote.length > 0) {
        list.append(h("div", { class: "branch-section-title" }, "Remote", h("span", { class: "count" }, String(filteredRemote.length))));
        for (const b of filteredRemote) {
          list.append(h("div", { class: "branch-row" },
            h("span", { class: "branch-marker" }, ""),
            h("span", { class: "branch-name", title: b.name }, b.name),
            h("span", { class: "branch-meta" }, b.sha),
            h("span", { class: "branch-actions" },
              h("button", { class: "row-action", onClick: () => checkout(b) }, "check out"),
            ),
          ));
        }
      }

      node.append(list);
    }

    return { render };
  })();

  // ── Sync tab ─────────────────────────────────────────────────────────────
  const syncTab = (() => {
    const pane = () => document.querySelector('.pane[data-pane="sync"]');
    let running = null; // action name currently running, for visual feedback

    async function runWithFeedback(name, cmd, okMsg) {
      running = name;
      render();
      ui.toast(`Running ${name}…`, "info", 1000);
      const r = await sh(cmd, { timeout: 120000 });
      running = null;
      if (r.code === 0) {
        ui.toast(okMsg || `${name} complete`, "success");
      } else {
        ui.toast(r.stderr || `${name} failed`, "error", 5000);
      }
      await refresh();
      render();
    }

    async function pull(rebase) {
      const args = "git pull" + (rebase ? " --rebase" : "") + " --no-edit";
      await runWithFeedback(rebase ? "pull --rebase" : "pull", args);
    }
    async function push(force) {
      const upstreamArgs = state.upstream ? "" : " -u origin " + quote(state.branch);
      const args = "git push" + (force ? " --force-with-lease" : "") + upstreamArgs;
      await runWithFeedback(force ? "push --force-with-lease" : "push", args);
    }
    async function fetch(prune) {
      const args = "git fetch --all" + (prune ? " --prune" : "");
      await runWithFeedback(prune ? "fetch + prune" : "fetch", args);
    }

    function actionCard({ name, desc, onClick, danger }) {
      const isRunning = running === name;
      return h("button", {
        class: "sync-action" + (danger ? " danger" : "") + (isRunning ? " running" : ""),
        disabled: !!running,
        onClick,
      },
        h("div", { class: "name" }, name, isRunning && h("span", { class: "spinner", style: { marginLeft: "auto" } })),
        h("div", { class: "desc" }, desc),
      );
    }

    function render() {
      const node = pane();
      node.innerHTML = "";
      node.className = "pane is-active sync-pane";

      const summary = h("div", { class: "sync-summary" },
        h("div", { class: "label" }, "Branch · Tracking"),
        h("div", { class: "value" },
          state.branch || "(none)",
          h("span", { class: "delta" }, state.upstream ? "→ " + state.upstream : "no upstream"),
          state.aheadBehind && h("span", { class: "delta" },
            state.aheadBehind.ahead > 0 && h("span", { class: "ahead" }, "↑" + state.aheadBehind.ahead),
            state.aheadBehind.behind > 0 && h("span", { class: "behind" }, "↓" + state.aheadBehind.behind),
            state.aheadBehind.ahead + state.aheadBehind.behind === 0 ? "up to date" : null,
          ),
        ),
      );
      node.append(summary);

      const grid = h("div", { class: "sync-grid" },
        actionCard({ name: "Fetch",            desc: "Update remote refs without merging.",            onClick: () => fetch(false) }),
        actionCard({ name: "Fetch + prune",    desc: "Also remove refs to branches gone from remote.", onClick: () => fetch(true) }),
        actionCard({ name: "Pull",             desc: "Fetch + merge upstream into HEAD.",              onClick: () => pull(false) }),
        actionCard({ name: "Pull --rebase",    desc: "Fetch then rebase HEAD onto upstream.",          onClick: () => pull(true) }),
        actionCard({ name: "Push",             desc: state.upstream ? "Push HEAD to upstream." : "Push and set upstream to origin/" + state.branch + ".", onClick: () => push(false) }),
        actionCard({ name: "Push --force-with-lease", danger: true, desc: "Overwrite remote only if it hasn't moved since fetch.", onClick: () => push(true) }),
      );
      node.append(grid);
    }

    return { render };
  })();

  // ── History tab ──────────────────────────────────────────────────────────
  const historyTab = (() => {
    const pane = () => document.querySelector('.pane[data-pane="history"]');

    async function loadLog(filter) {
      const sep = "\x1f";
      const grep = filter ? " --grep=" + quote(filter) + " -i" : "";
      const r = await git("log --no-color" + grep + " --pretty=format:" + quote("%h" + sep + "%s" + sep + "%an" + sep + "%ar" + sep + "%H") + " -n 100");
      if (r.code !== 0) return [];
      return r.stdout.split("\n").filter(Boolean).map((line) => {
        const [sha, msg, author, when, fullSha] = line.split(sep);
        return { sha, msg, author, when, fullSha };
      });
    }

    async function renderDetail(detailNode, commit) {
      detailNode.innerHTML = "";
      const header = h("div", { class: "commit-header" },
        h("div", { class: "row" }, h("span", { class: "label" }, "sha"), h("span", { class: "val sha" }, commit.fullSha)),
        h("div", { class: "row" }, h("span", { class: "label" }, "author"), h("span", { class: "val" }, `${commit.author} · ${commit.when}`)),
        h("div", { class: "row" }, h("span", { class: "label" }, "msg"), h("span", { class: "val msg" }, commit.msg)),
      );
      detailNode.append(header);

      const diffWrap = h("div");
      detailNode.append(diffWrap);
      diffWrap.innerHTML = '<div class="status-diff-empty"><span class="spinner"></span></div>';
      const r = await git("show --no-color --stat -p " + quote(commit.sha));
      diffWrap.innerHTML = "";
      for (const line of r.stdout.split("\n")) {
        let cls = "diff-meta";
        if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ")) cls = "diff-file";
        else if (line.startsWith("@@")) cls = "diff-hunk";
        else if (line.startsWith("+")) cls = "diff-add";
        else if (line.startsWith("-")) cls = "diff-del";
        diffWrap.append(h("span", { class: "diff-line " + cls }, line || " "));
      }
    }

    async function render() {
      const node = pane();
      node.innerHTML = "";
      node.className = "pane is-active history-pane";

      const search = h("input", {
        class: "history-search",
        placeholder: "Filter commits by message…",
        value: state.historyFilter,
        onInput: (e) => { state.historyFilter = e.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(render, 250); },
      });
      node.append(h("div", { class: "history-top" }, search));

      const list = h("div", { class: "history-list" });
      const detail = h("div", { class: "history-detail" });
      detail.innerHTML = '<div class="history-detail-empty">Pick a commit to inspect.</div>';
      node.append(h("div", { class: "history-split" }, list, detail));

      const commits = await loadLog(state.historyFilter);
      state.log = commits;
      if (commits.length === 0) {
        list.append(h("div", { class: "empty-files" }, "No commits match"));
        return;
      }
      for (const c of commits) {
        const row = h("div", {
          class: "log-row" + (state.selectedCommit === c.sha ? " is-selected" : ""),
          onClick: () => {
            state.selectedCommit = c.sha;
            document.querySelectorAll(".log-row").forEach((r) => r.classList.toggle("is-selected", r.dataset.sha === c.sha));
            renderDetail(detail, c);
          },
          dataset: { sha: c.sha },
        },
          h("span", { class: "log-sha" }, c.sha),
          h("span", null,
            h("span", { class: "log-msg-line", title: c.msg }, c.msg),
            h("span", { class: "log-meta" }, `${c.author} · ${c.when}`),
          ),
        );
        list.append(row);
      }
      // Re-show last detail if it matches
      if (state.selectedCommit) {
        const cur = commits.find((c) => c.sha === state.selectedCommit);
        if (cur) renderDetail(detail, cur);
      }
    }

    let searchTimer = 0;
    return { render };
  })();

  // ── Rebase tab ───────────────────────────────────────────────────────────
  const rebaseTab = (() => {
    const pane = () => document.querySelector('.pane[data-pane="rebase"]');

    async function buildPlan() {
      const sep = "\x1f";
      const r = await git("log --reverse --no-color --pretty=format:" + quote("%h" + sep + "%s") + " " + quote(state.rebaseTarget) + "..HEAD");
      if (r.code !== 0) {
        ui.toast(r.stderr || "Bad target", "error", 5000);
        state.rebasePlan = [];
        render();
        return;
      }
      state.rebasePlan = r.stdout.split("\n").filter(Boolean).map((line) => {
        const [sha, msg] = line.split(sep);
        return { sha, msg, op: "pick" };
      });
      render();
    }

    async function startRebase() {
      if (state.rebasePlan.length === 0) return;
      if (state.rebasePlan[0].op === "squash" || state.rebasePlan[0].op === "fixup") {
        ui.toast("First commit cannot be 'squash' — change to 'pick'", "error", 4000);
        return;
      }
      const todo = state.rebasePlan.filter((c) => c.op !== "drop").map((c) => `${c.op} ${c.sha} ${c.msg}`).join("\n");
      const tmp = "/tmp/porta-rebase-todo-" + Date.now();
      const write = await sh("cat > " + quote(tmp) + " <<'PORTA_EOF'\n" + todo + "\nPORTA_EOF");
      if (write.code !== 0) { ui.toast("Could not write todo", "error"); return; }
      const cmd = "GIT_SEQUENCE_EDITOR=" + quote("cp " + tmp) + " GIT_EDITOR=true git rebase -i " + quote(state.rebaseTarget);
      ui.toast("Rebasing…", "info", 1500);
      const r = await sh(cmd, { timeout: 120000 });
      await sh("rm -f " + quote(tmp));
      if (r.code === 0) {
        state.rebasePlan = [];
        ui.toast("Rebase complete", "success");
      } else {
        ui.toast("Rebase paused — resolve conflicts in your editor, stage, then click Continue", "error", 6000);
      }
      await refresh();
    }

    async function abortRebase() {
      const r = await git("rebase --abort");
      if (r.code === 0) ui.toast("Rebase aborted", "success");
      else ui.toast(r.stderr || "Abort failed", "error");
      await refresh();
    }

    async function continueRebase() {
      const r = await sh("GIT_EDITOR=true git rebase --continue", { timeout: 60000 });
      if (r.code === 0) ui.toast("Rebase continued", "success");
      else ui.toast(r.stderr || "Continue failed", "error", 5000);
      await refresh();
    }

    function move(i, dir) {
      const j = i + dir;
      if (j < 0 || j >= state.rebasePlan.length) return;
      const arr = state.rebasePlan;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      render();
    }

    function render() {
      const node = pane();
      node.innerHTML = "";
      node.className = "pane is-active rebase-pane";

      if (state.rebaseInProgress) {
        node.append(
          h("div", { class: "in-progress-banner" },
            h("svg", { viewBox: "0 0 12 12", width: "14", height: "14", fill: "none", html: '<path d="M6 1l5 9H1L6 1z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M6 5v2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="6" cy="9" r="0.5" fill="currentColor"/>' }),
            h("div", null,
              h("strong", null, "Rebase in progress."),
              h("p", { style: { margin: "4px 0 0", color: "var(--text-mute)", fontSize: "11px" } },
                "Resolve conflicts in your editor, stage them from the Status tab, then come back here and click Continue."),
            ),
          ),
          h("div", { class: "rebase-actions" },
            h("button", { class: "btn-primary", onClick: continueRebase }, "Continue"),
            h("button", { class: "btn-danger", onClick: abortRebase }, "Abort"),
          ),
        );
        return;
      }

      const targetInput = h("input", {
        class: "input", style: { maxWidth: "280px" },
        placeholder: "Target ref (e.g. HEAD~5, main, abc123)",
        value: state.rebaseTarget,
        onInput: (e) => { state.rebaseTarget = e.target.value; },
        onKeydown: (e) => { if (e.key === "Enter") buildPlan(); },
      });
      node.append(h("div", { class: "rebase-form" }, targetInput, h("button", { class: "btn-primary", onClick: buildPlan }, "Plan rebase")));

      if (state.rebasePlan.length === 0) {
        node.append(h("p", { class: "empty-sub", style: { padding: "12px" } },
          "Pick a target ref. Commits between it and HEAD will appear here for you to pick / squash / fixup / drop and (optionally) reorder.",
        ));
        return;
      }

      for (let i = 0; i < state.rebasePlan.length; i++) {
        const c = state.rebasePlan[i];
        const sel = h("select", {
          class: "input",
          onChange: (e) => { c.op = e.target.value; render(); },
        });
        for (const op of ["pick", "squash", "fixup", "drop"]) {
          sel.append(h("option", { value: op, selected: c.op === op }, op));
        }
        const grip = h("span", { class: "grip", title: "Move up/down" },
          h("button", { class: "row-action", onClick: () => move(i, -1), disabled: i === 0 }, "↑"),
          h("button", { class: "row-action", onClick: () => move(i, +1), disabled: i === state.rebasePlan.length - 1 }, "↓"),
        );
        node.append(h("div", { class: "rebase-todo-row" + (c.op === "drop" ? " is-drop" : "") },
          grip,
          sel,
          h("span", { class: "log-sha" }, c.sha),
          h("span", { class: "log-msg-line", title: c.msg }, c.msg),
        ));
      }

      node.append(h("div", { class: "rebase-actions" },
        h("button", { class: "btn-primary", onClick: startRebase }, "Start rebase"),
        h("button", { class: "btn-ghost", onClick: () => { state.rebasePlan = []; render(); } }, "Clear"),
      ));
    }

    return { render };
  })();

  // ── Stash tab ────────────────────────────────────────────────────────────
  const stashTab = (() => {
    const pane = () => document.querySelector('.pane[data-pane="stash"]');
    let msg = "";
    let includeUntracked = false;

    async function loadStash() {
      const sep = "\x1f";
      const r = await git("stash list --pretty=format:" + quote("%gd" + sep + "%s"));
      if (r.code !== 0) return [];
      return r.stdout.split("\n").filter(Boolean).map((line) => {
        const [ref, m] = line.split(sep);
        return { ref, msg: m };
      });
    }

    async function save() {
      const args = "stash push" + (includeUntracked ? " -u" : "") + (msg.trim() ? " -m " + quote(msg.trim()) : "");
      const r = await git(args);
      if (r.code === 0) {
        msg = "";
        ui.toast("Stashed", "success");
        await refresh();
      } else ui.toast(r.stderr || "Stash failed", "error", 5000);
    }

    async function apply(ref) {
      const r = await git("stash apply " + quote(ref));
      if (r.code === 0) ui.toast("Applied " + ref, "success");
      else ui.toast(r.stderr || "Apply failed", "error", 5000);
      await refresh();
    }
    async function pop(ref) {
      const r = await git("stash pop " + quote(ref));
      if (r.code === 0) ui.toast("Popped " + ref, "success");
      else ui.toast(r.stderr || "Pop failed", "error", 5000);
      await refresh();
    }
    async function drop(ref) {
      const ok = await ui.confirm({ title: "Drop stash?", body: `Permanently drop ${ref}?`, danger: true, okLabel: "Drop" });
      if (!ok) return;
      const r = await git("stash drop " + quote(ref));
      if (r.code === 0) ui.toast("Dropped " + ref, "success");
      else ui.toast(r.stderr || "Drop failed", "error", 5000);
      await refresh();
    }

    async function render() {
      const node = pane();
      node.innerHTML = "";
      node.className = "pane is-active stash-pane";

      const msgInput = h("input", {
        class: "input", style: { maxWidth: "320px" },
        placeholder: "Stash message (optional)",
        value: msg,
        onInput: (e) => { msg = e.target.value; },
        onKeydown: (e) => { if (e.key === "Enter") save(); },
      });
      const untrackedChk = h("input", { type: "checkbox", checked: includeUntracked, onChange: (e) => { includeUntracked = e.target.checked; } });
      node.append(h("div", { class: "stash-top" },
        msgInput,
        h("label", { class: "commit-options", style: { whiteSpace: "nowrap" } }, untrackedChk, "include untracked"),
        h("button", { class: "btn-primary", onClick: save }, "Stash"),
      ));

      const stashes = await loadStash();
      state.stashes = stashes;
      state.stashCount = stashes.length;
      paintTopBar();

      const list = h("div", { class: "stash-list" });
      if (stashes.length === 0) {
        list.append(h("div", { class: "empty-files" }, "No stashes"));
      } else {
        for (const s of stashes) {
          list.append(h("div", { class: "stash-row" },
            h("span", { class: "stash-idx" }, s.ref),
            h("span", { class: "stash-msg", title: s.msg }, s.msg),
            h("span", { class: "stash-actions" },
              h("button", { class: "row-action", onClick: () => apply(s.ref) }, "apply"),
              h("button", { class: "row-action", onClick: () => pop(s.ref) }, "pop"),
              h("button", { class: "row-action danger", onClick: () => drop(s.ref) }, "drop"),
            ),
          ));
        }
      }
      node.append(list);
    }

    return { render };
  })();

  // ── No-repo bootstrap ────────────────────────────────────────────────────
  async function renderNoRepo() {
    const panes = $(".panes");
    panes.innerHTML = "";
    const tpl = $("#tpl-no-repo");
    const wrap = h("section", { class: "pane is-active", dataset: { pane: "status" } });
    wrap.append(tpl.content.cloneNode(true));
    const initBtn = wrap.querySelector('[data-act="init"]');
    if (!bridge.app.rootDir) {
      initBtn.disabled = true;
      initBtn.textContent = "App has no root_dir";
      const sub = wrap.querySelector(".empty-sub");
      if (sub) sub.textContent = "Set this app's root directory in App Settings to enable git.";
    } else {
      initBtn.addEventListener("click", async () => {
        const r = await git("init");
        if (r.code === 0) {
          ui.toast("Initialized git repo", "success");
          await init();
        } else ui.toast(r.stderr || "git init failed", "error");
      });
    }
    panes.appendChild(wrap);
  }

  // ── Refresh: probes + re-render active tab ───────────────────────────────
  async function refresh() {
    const btn = $("#refresh-btn");
    if (btn) btn.classList.add("spinning");
    try {
      await readHead();
      await detectRebase();
      await probeStashCount();
      paintTopBar();
      await renderActiveTab();
    } finally {
      if (btn) btn.classList.remove("spinning");
    }
  }

  // ── Keyboard shortcuts ───────────────────────────────────────────────────
  function bindKeys() {
    window.addEventListener("keydown", (e) => {
      // Ignore typing in inputs/textareas.
      const target = e.target;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
      // Don't fight Cmd/Ctrl + key — those are reserved for browser/host.
      if (e.metaKey || e.ctrlKey) return;
      const k = e.key.toLowerCase();
      if (["1", "2", "3", "4", "5", "6"].includes(k)) {
        const tab = ["status", "branches", "sync", "history", "rebase", "stash"][parseInt(k, 10) - 1];
        e.preventDefault();
        activateTab(tab);
      } else if (k === "r") {
        e.preventDefault();
        refresh();
      }
    });
  }

  // ── Init ─────────────────────────────────────────────────────────────────
  async function init() {
    bridge.ui.setTitle("Git — " + bridge.app.name);
    $("#refresh-btn").addEventListener("click", refresh);
    document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => activateTab(t.dataset.tab)));
    bindKeys();

    if (!await detectRepo()) {
      await renderNoRepo();
      return;
    }
    await readHead();
    await detectRebase();
    await probeStashCount();
    paintTopBar();
    activateTab("status");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
