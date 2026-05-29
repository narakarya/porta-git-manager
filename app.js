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
    diffView: "unified", // "unified" | "split" — toggled by Status tab toolbar
    remotes: [],         // populated by Sync tab
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
    /**
     * Text-input modal replacing `window.prompt`, which the sandboxed
     * extension iframe blocks (silent fail when clicked). Resolves with
     * the trimmed value on confirm, or null on cancel.
     */
    input({ title, body, placeholder = "", initial = "", okLabel = "OK", cancelLabel = "Cancel" }) {
      return new Promise((resolve) => {
        const root = $("#modal-root");
        root.hidden = false;
        root.innerHTML = "";
        let value = initial;
        const close = (commit) => {
          root.hidden = true;
          root.innerHTML = "";
          window.removeEventListener("keydown", onKey, true);
          resolve(commit ? (value.trim() || null) : null);
        };
        const onKey = (e) => {
          if (e.key === "Escape") { e.stopPropagation(); close(false); }
        };
        window.addEventListener("keydown", onKey, true);
        const inp = h("input", {
          class: "input", style: { marginBottom: "12px" },
          placeholder, value: initial,
          onInput: (e) => { value = e.target.value; },
          onKeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); close(true); } },
        });
        const card = h("div", { class: "modal-card" },
          h("h3", null, title),
          body && h("p", null, body),
          inp,
          h("div", { class: "actions" },
            h("button", { class: "btn-ghost", onClick: () => close(false) }, cancelLabel),
            h("button", { class: "btn-primary", onClick: () => close(true) }, okLabel),
          ),
        );
        root.appendChild(card);
        setTimeout(() => inp.focus(), 0);
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

  async function renderActiveTab() {
    const map = { status: statusTab, branches: branchesTab, sync: syncTab, history: historyTab, rebase: rebaseTab, stash: stashTab, tags: tagsTab };
    const tab = map[state.currentTab];
    if (tab) await tab.render();
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

    /**
     * Run git diff for the selected file and return a structured form:
     *   { header: [str], hunks: [{ header, lines }], untracked: bool }
     * Hunks let us render a per-hunk action bar and build a minimal patch
     * for `git apply` when the user clicks Stage hunk / Unstage / Discard.
     */
    async function loadDiff(file, source) {
      if (source === "untracked") {
        // Untracked files have no real diff. Synthesize a hunk so the
        // preview shows the file's first 4 KB as "all added".
        const r = await sh("head -c 4096 " + quote(file.path));
        const content = r.code === 0 ? (r.stdout || "") : "(binary or unreadable)";
        const lines = content.split("\n");
        return {
          untracked: true,
          header: [file.path + " (untracked)"],
          hunks: [{
            header: "@@ -0,0 +1," + lines.length + " @@",
            lines: lines.map((l) => "+" + l),
          }],
        };
      }
      const flag = source === "staged" ? "--cached" : "";
      const r = await git("diff --no-color " + flag + " -- " + quote(file.path));
      if (r.code !== 0) return { header: [r.stderr || "(no diff)"], hunks: [] };
      if (!r.stdout.trim()) return { header: ["(no diff)"], hunks: [] };
      return parseDiff(r.stdout);
    }

    function parseDiff(text) {
      const header = [];
      const hunks = [];
      let current = null;
      for (const line of text.split("\n")) {
        if (line.startsWith("@@")) {
          if (current) hunks.push(current);
          current = { header: line, lines: [] };
        } else if (current) {
          current.lines.push(line);
        } else {
          header.push(line);
        }
      }
      if (current) hunks.push(current);
      // Trim the trailing empty line that `git diff` always emits.
      if (hunks.length > 0) {
        const last = hunks[hunks.length - 1];
        while (last.lines.length > 0 && last.lines[last.lines.length - 1] === "") last.lines.pop();
      }
      return { header, hunks };
    }

    function buildHunkPatch(filePath, hunk) {
      return ["--- a/" + filePath, "+++ b/" + filePath, hunk.header, ...hunk.lines].join("\n") + "\n";
    }

    /**
     * Write `patch` to a temp file and `git apply` it with the requested
     * flags. `--whitespace=nowarn` matches the UI's diff rendering — we
     * don't bubble whitespace warnings up as errors.
     */
    async function applyHunk(patch, opts) {
      const tmp = "/tmp/porta-hunk-" + Date.now() + "-" + Math.floor(Math.random() * 1e6) + ".patch";
      const write = await sh("cat > " + quote(tmp) + " <<'PORTA_PATCH_EOF'\n" + patch + "PORTA_PATCH_EOF");
      if (write.code !== 0) return { code: write.code, stderr: "Could not write patch file" };
      const args = ["apply"];
      if (opts.cached)  args.push("--cached");
      if (opts.reverse) args.push("--reverse");
      args.push("--whitespace=nowarn");
      args.push(quote(tmp));
      const r = await git(args.join(" "));
      await sh("rm -f " + quote(tmp));
      return r;
    }

    function classifyDiffLine(line) {
      if (line.startsWith("+")) return "add";
      if (line.startsWith("-")) return "del";
      if (line.startsWith("\\")) return "meta"; // "\ No newline at end of file"
      return null; // context
    }

    /**
     * Render the parsed diff into `node`. Each hunk is its own .hunk
     * container with a header bar holding the @@ line plus per-hunk
     * action buttons (Stage/Unstage/Discard, depending on `source`).
     * Dispatches to the unified or split renderer based on state.diffView.
     */
    function renderDiffInto(node, parsed, source, filePath) {
      node.innerHTML = "";
      for (const m of parsed.header) {
        const cls = (m.startsWith("diff ") || m.startsWith("+++") || m.startsWith("---")) ? "diff-file" : "diff-meta";
        node.appendChild(h("span", { class: "diff-line " + cls }, m || " "));
      }
      const renderHunkBody = state.diffView === "split" ? renderSplitHunkBody : renderUnifiedHunkBody;
      for (const hunk of parsed.hunks) {
        const wrapper = h("div", { class: "hunk" });
        const actions = h("span", { class: "hunk-actions" });
        if (source === "unstaged" || source === "untracked") {
          actions.append(
            h("button", { class: "hunk-action",        onClick: () => stageOneHunk(filePath, hunk, source) }, "Stage hunk"),
            h("button", { class: "hunk-action danger", onClick: () => discardOneHunk(filePath, hunk, source) }, "Discard"),
          );
        } else if (source === "staged") {
          actions.append(
            h("button", { class: "hunk-action", onClick: () => unstageOneHunk(filePath, hunk) }, "Unstage hunk"),
          );
        }
        wrapper.appendChild(h("div", { class: "hunk-header" }, hunk.header, actions));
        renderHunkBody(wrapper, hunk);
        node.appendChild(wrapper);
      }
    }

    function renderUnifiedHunkBody(wrapper, hunk) {
      for (const line of hunk.lines) {
        const kind = classifyDiffLine(line);
        const cls = "diff-line" + (kind ? " diff-" + kind : "");
        wrapper.appendChild(h("span", { class: cls }, line || " "));
      }
    }

    /**
     * Split-view: pair consecutive removed/added runs into side-by-side
     * rows. Context lines appear on both sides. When a run of removals is
     * not the same length as the following run of additions, the longer
     * side spills to extra rows with the shorter side blank.
     */
    function renderSplitHunkBody(wrapper, hunk) {
      const grid = h("div", { class: "diff-split" });
      // Buffers for the current run of removals/additions. They get
      // flushed (as paired rows) whenever we hit a context line or EOH.
      let dels = [];
      let adds = [];

      function flush() {
        const n = Math.max(dels.length, adds.length);
        for (let i = 0; i < n; i++) {
          const left  = i < dels.length ? dels[i] : null;
          const right = i < adds.length ? adds[i] : null;
          grid.append(
            h("span", {
              class: "diff-cell diff-cell-left" + (left ? " diff-del" : " diff-blank"),
            }, left == null ? " " : left.slice(1) || " "),
            h("span", {
              class: "diff-cell diff-cell-right" + (right ? " diff-add" : " diff-blank"),
            }, right == null ? " " : right.slice(1) || " "),
          );
        }
        dels = [];
        adds = [];
      }

      for (const line of hunk.lines) {
        if (line.startsWith("-")) { dels.push(line); continue; }
        if (line.startsWith("+")) { adds.push(line); continue; }
        // Anything else (context, "\ No newline…") closes the pending run.
        flush();
        const body = line.startsWith(" ") || line.startsWith("\\") ? line.slice(1) : line;
        const cls = line.startsWith("\\") ? " diff-meta" : "";
        grid.append(
          h("span", { class: "diff-cell diff-cell-left"  + cls }, body || " "),
          h("span", { class: "diff-cell diff-cell-right" + cls }, body || " "),
        );
      }
      flush();
      wrapper.appendChild(grid);
    }

    // ── Per-hunk actions ───────────────────────────────────────────────────

    async function stageOneHunk(filePath, hunk, source) {
      if (source === "untracked") {
        // Untracked files have no real hunk in the index — synthesized
        // one is for preview only. Stage the whole file instead.
        return stage(filePath);
      }
      const r = await applyHunk(buildHunkPatch(filePath, hunk), { cached: true });
      if (r.code === 0) { ui.toast("Staged hunk", "success"); await refresh(); }
      else ui.toast(r.stderr || "Stage hunk failed", "error", 5000);
    }

    async function unstageOneHunk(filePath, hunk) {
      const r = await applyHunk(buildHunkPatch(filePath, hunk), { cached: true, reverse: true });
      if (r.code === 0) { ui.toast("Unstaged hunk", "success"); await refresh(); }
      else ui.toast(r.stderr || "Unstage hunk failed", "error", 5000);
    }

    async function discardOneHunk(filePath, hunk, source) {
      if (source === "untracked") {
        const ok = await ui.confirm({
          title: "Delete untracked file?",
          body: `Remove ${filePath} from disk. There's no undo.`,
          danger: true, okLabel: "Delete",
        });
        if (!ok) return;
        const r = await sh("rm -f " + quote(filePath));
        if (r.code === 0) { ui.toast("Deleted " + filePath, "success"); await refresh(); }
        else ui.toast(r.stderr || "Delete failed", "error", 5000);
        return;
      }
      const ok = await ui.confirm({
        title: "Discard hunk?",
        body: "Revert this hunk in the working tree. There's no undo.",
        danger: true, okLabel: "Discard",
      });
      if (!ok) return;
      const r = await applyHunk(buildHunkPatch(filePath, hunk), { reverse: true });
      if (r.code === 0) { ui.toast("Discarded hunk", "success"); await refresh(); }
      else ui.toast(r.stderr || "Discard hunk failed", "error", 5000);
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
      const parsed = await loadDiff(file, source);
      // If user clicked something else while we were loading, drop this result.
      if (lastDiffPath !== file.path || lastDiffSource !== source) return;
      renderDiffInto(diffNode, parsed, source, file.path);
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
        h("div", { style: { flex: "1" } }),
        // View toggle: unified diff is one column with +/- prefixes; split
        // shows the old/new sides in two columns so paired changes line up.
        h("div", { class: "view-toggle" },
          h("button", {
            class: "view-toggle-btn" + (state.diffView === "unified" ? " is-active" : ""),
            onClick: () => { state.diffView = "unified"; render(); },
          }, "Unified"),
          h("button", {
            class: "view-toggle-btn" + (state.diffView === "split" ? " is-active" : ""),
            onClick: () => { state.diffView = "split"; render(); },
          }, "Split"),
        ),
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
    let newRemoteName = "";
    let newRemoteUrl = "";

    async function loadRemotes() {
      const r = await git("remote -v");
      if (r.code !== 0) return [];
      const map = new Map();
      for (const line of r.stdout.split("\n").filter(Boolean)) {
        const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
        if (!m) continue;
        const [, name, url, kind] = m;
        if (!map.has(name)) map.set(name, { name, fetchUrl: "", pushUrl: "" });
        const r = map.get(name);
        if (kind === "fetch") r.fetchUrl = url;
        else r.pushUrl = url;
      }
      return [...map.values()];
    }

    async function addRemote() {
      const name = newRemoteName.trim();
      const url = newRemoteUrl.trim();
      if (!name || !url) return;
      const r = await git("remote add " + quote(name) + " " + quote(url));
      if (r.code === 0) {
        newRemoteName = "";
        newRemoteUrl = "";
        ui.toast("Added remote " + name, "success");
        await render();
      } else ui.toast(r.stderr || "Add remote failed", "error", 5000);
    }

    async function removeRemote(name) {
      const ok = await ui.confirm({
        title: "Remove remote?",
        body: `Stops tracking ${name}. Branches that tracked it become orphaned, but their commits stay.`,
        danger: true, okLabel: "Remove",
      });
      if (!ok) return;
      const r = await git("remote remove " + quote(name));
      if (r.code === 0) ui.toast("Removed " + name, "success");
      else ui.toast(r.stderr || "Remove failed", "error", 5000);
      await render();
    }

    async function renameRemote(oldName) {
      const newName = await ui.input({
        title: "Rename remote",
        body: `Rename "${oldName}" to:`,
        initial: oldName,
        okLabel: "Rename",
      });
      if (!newName || newName === oldName) return;
      const r = await git("remote rename " + quote(oldName) + " " + quote(newName));
      if (r.code === 0) { ui.toast("Renamed", "success"); await render(); }
      else ui.toast(r.stderr || "Rename failed", "error", 5000);
    }

    async function setRemoteUrl(name, currentUrl) {
      const newUrl = await ui.input({
        title: "Edit remote URL",
        body: `New URL for "${name}":`,
        initial: currentUrl,
        placeholder: "git@github.com:owner/repo.git",
        okLabel: "Save",
      });
      if (!newUrl || newUrl === currentUrl) return;
      const r = await git("remote set-url " + quote(name) + " " + quote(newUrl));
      if (r.code === 0) { ui.toast("URL updated", "success"); await render(); }
      else ui.toast(r.stderr || "Update failed", "error", 5000);
    }

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

    async function render() {
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

      // ─── Remotes section ──────────────────────────────────────────────
      const remotes = await loadRemotes();
      state.remotes = remotes;
      const remotesBox = h("div", { class: "sync-summary" },
        h("div", { class: "label" }, "Remotes"),
      );
      if (remotes.length === 0) {
        remotesBox.append(h("div", { class: "value", style: { color: "var(--text-mute)", fontSize: "11px" } }, "No remotes configured"));
      } else {
        const list = h("div", { class: "remote-list" });
        for (const r of remotes) {
          list.append(h("div", { class: "remote-row" },
            h("span", { class: "remote-name" }, r.name),
            h("span", { class: "remote-url", title: r.fetchUrl }, r.fetchUrl),
            h("span", { class: "remote-actions" },
              h("button", { class: "row-action",        onClick: () => setRemoteUrl(r.name, r.fetchUrl) }, "edit URL"),
              h("button", { class: "row-action",        onClick: () => renameRemote(r.name)             }, "rename"),
              h("button", { class: "row-action danger", onClick: () => removeRemote(r.name)             }, "remove"),
            ),
          ));
        }
        remotesBox.append(list);
      }
      // Add-remote form (always visible — most repos have <5 remotes).
      const nameInput = h("input", {
        class: "input", style: { maxWidth: "140px" },
        placeholder: "Name (e.g. origin)",
        value: newRemoteName,
        onInput: (e) => { newRemoteName = e.target.value; },
        onKeydown: (e) => { if (e.key === "Enter") addRemote(); },
      });
      const urlInput = h("input", {
        class: "input",
        placeholder: "URL (git@…:owner/repo.git)",
        value: newRemoteUrl,
        onInput: (e) => { newRemoteUrl = e.target.value; },
        onKeydown: (e) => { if (e.key === "Enter") addRemote(); },
      });
      remotesBox.append(h("div", { class: "remote-add-form" },
        nameInput,
        urlInput,
        h("button", {
          class: "btn-primary",
          onClick: addRemote,
          disabled: !newRemoteName.trim() || !newRemoteUrl.trim(),
        }, "Add"),
      ));
      node.append(remotesBox);

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

  // ── Tags tab ─────────────────────────────────────────────────────────────
  const tagsTab = (() => {
    const pane = () => document.querySelector('.pane[data-pane="tags"]');
    let newName = "";
    let newMsg = "";
    let annotated = true;
    let filter = "";

    async function loadTags() {
      const sep = "\x1f";
      // refname:short is the bare tag name; objectname:short is the SHA the
      // tag points at (commit SHA for lightweight, tag object SHA for
      // annotated — close enough for display); contents:subject is the
      // first message line for annotated tags (empty for lightweight).
      const r = await git("tag -l --format=" + quote("%(refname:short)" + sep + "%(objectname:short)" + sep + "%(contents:subject)"));
      if (r.code !== 0) return [];
      return r.stdout.split("\n").filter(Boolean).map((line) => {
        const [name, sha, msg] = line.split(sep);
        return { name, sha, msg: msg || "" };
      });
    }

    async function create() {
      const name = newName.trim();
      if (!name) return;
      const args = annotated
        ? "tag -a " + quote(name) + " -m " + quote(newMsg.trim() || name)
        : "tag " + quote(name);
      const r = await git(args);
      if (r.code === 0) {
        ui.toast("Created tag " + name, "success");
        newName = "";
        newMsg = "";
        await render();
      } else ui.toast(r.stderr || "Create tag failed", "error", 5000);
    }

    async function push(name) {
      const r = await sh("git push origin " + quote(name), { timeout: 60000 });
      if (r.code === 0) ui.toast("Pushed " + name, "success");
      else ui.toast(r.stderr || "Push tag failed", "error", 5000);
    }

    async function del(name) {
      const ok = await ui.confirm({
        title: "Delete tag locally?",
        body: `Delete the local tag "${name}". The remote tag (if any) won't be touched — use Delete remote for that.`,
        danger: true, okLabel: "Delete",
      });
      if (!ok) return;
      const r = await git("tag -d " + quote(name));
      if (r.code === 0) ui.toast("Deleted " + name, "success");
      else ui.toast(r.stderr || "Delete failed", "error", 5000);
      await render();
    }

    async function delRemote(name) {
      const ok = await ui.confirm({
        title: "Delete remote tag?",
        body: `Run \`git push --delete origin ${name}\`. This unpublishes the tag on origin — collaborators may still have it locally.`,
        danger: true, okLabel: "Delete remote",
      });
      if (!ok) return;
      const r = await sh("git push --delete origin " + quote(name), { timeout: 60000 });
      if (r.code === 0) ui.toast("Removed " + name + " from origin", "success");
      else ui.toast(r.stderr || "Remote delete failed", "error", 5000);
    }

    async function render() {
      const node = pane();
      node.innerHTML = "";
      node.className = "pane is-active tags-pane";

      const nameInput = h("input", {
        class: "input", style: { maxWidth: "180px" },
        placeholder: "Tag name (e.g. v1.0.0)",
        value: newName,
        onInput: (e) => { newName = e.target.value; },
        onKeydown: (e) => { if (e.key === "Enter") create(); },
      });
      const msgInput = h("input", {
        class: "input", style: { maxWidth: "240px" },
        placeholder: "Message (annotated tags)",
        value: newMsg,
        onInput: (e) => { newMsg = e.target.value; },
        onKeydown: (e) => { if (e.key === "Enter") create(); },
      });
      const annChk = h("input", {
        type: "checkbox", checked: annotated,
        onChange: (e) => { annotated = e.target.checked; render(); },
      });
      const filterInput = h("input", {
        class: "history-search", style: { maxWidth: "180px" },
        placeholder: "Filter…",
        value: filter,
        onInput: (e) => { filter = e.target.value; render(); },
      });

      node.append(h("div", { class: "tags-top" },
        nameInput,
        msgInput,
        h("label", { class: "commit-options", style: { whiteSpace: "nowrap" } }, annChk, "annotated"),
        h("button", { class: "btn-primary", onClick: create, disabled: !newName.trim() }, "Create"),
        h("div", { style: { flex: "1" } }),
        filterInput,
      ));

      const tags = await loadTags();
      const f = filter.toLowerCase();
      const visible = f ? tags.filter((t) => t.name.toLowerCase().includes(f)) : tags;

      const list = h("div", { class: "tags-list" });
      if (visible.length === 0) {
        list.append(h("div", { class: "empty-files" }, tags.length === 0 ? "No tags" : "No tags match"));
      } else {
        for (const t of visible) {
          list.append(h("div", { class: "tag-row" },
            h("span", { class: "tag-name", title: t.name }, t.name),
            h("span", { class: "tag-sha" }, t.sha),
            h("span", { class: "tag-msg", title: t.msg }, t.msg),
            h("span", { class: "tag-actions" },
              h("button", { class: "row-action",        onClick: () => push(t.name)      }, "push"),
              h("button", { class: "row-action danger", onClick: () => delRemote(t.name) }, "remote ×"),
              h("button", { class: "row-action danger", onClick: () => del(t.name)       }, "delete"),
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
      if (["1", "2", "3", "4", "5", "6", "7"].includes(k)) {
        const tab = ["status", "branches", "sync", "history", "rebase", "stash", "tags"][parseInt(k, 10) - 1];
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
