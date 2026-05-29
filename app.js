// Git Manager — single-file vanilla JS module. Runs inside Porta's extension
// iframe, talks to the host via `window.portaBridge`.
(function () {
  "use strict";

  const bridge = window.portaBridge;
  if (!bridge) {
    document.body.innerText = "Missing portaBridge. Reload the extension.";
    return;
  }

  // ── State ──────────────────────────────────────────────────────────────
  const state = {
    currentTab: "status",
    branch: null,            // resolved current branch name
    upstream: null,          // upstream tracking branch ("origin/main", etc.)
    aheadBehind: null,       // { ahead, behind }
    log: [],                 // last `git log` result for history/rebase
    rebasePlan: [],          // { sha, msg, op } in topological order (oldest→newest)
    rebaseInProgress: false,
    repoOk: false,
  };

  // ── Helpers ────────────────────────────────────────────────────────────

  /** POSIX-safe single-quote escape so we can splice values into a shell command. */
  function quote(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
  }

  /**
   * Run `git <args>` in the app's root. Pass `args` as a single shell string
   * (you escape values, we don't second-guess). Returns the full ShellResult.
   */
  function git(args, opts) {
    return bridge.shell.run("git " + args, opts || {});
  }

  /** Run any shell command verbatim. Same return shape. */
  function sh(cmd, opts) {
    return bridge.shell.run(cmd, opts || {});
  }

  /** Stream a command's output to the drawer; resolves with ShellResult. */
  function streamCmd(cmd, opts) {
    drawer.append("$ " + cmd + "\n", "log-cmd");
    drawer.open();
    return bridge.shell.spawn(cmd, opts || {}, {
      onStdout: (line) => drawer.append(line + "\n"),
      onStderr: (line) => drawer.append(line + "\n", "log-err"),
    });
  }

  function toast(msg, kind) { bridge.ui.toast(msg, kind || "info"); }

  /** Render `text` into `node`, escaping HTML. */
  function setText(node, text) { node.textContent = text; }

  /** Build a DOM element from `(tag, props, ...children)`. */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const key in props) {
        if (key === "class") el.className = props[key];
        else if (key === "html") el.innerHTML = props[key];
        else if (key.startsWith("on") && typeof props[key] === "function") {
          el.addEventListener(key.slice(2).toLowerCase(), props[key]);
        } else if (key === "dataset") {
          for (const k in props[key]) el.dataset[k] = props[key][k];
        } else if (key in el) {
          el[key] = props[key];
        } else {
          el.setAttribute(key, props[key]);
        }
      }
    }
    for (const child of children) {
      if (child == null || child === false) continue;
      el.append(child.nodeType ? child : document.createTextNode(child));
    }
    return el;
  }

  // ── Drawer (bottom output panel) ───────────────────────────────────────
  const drawer = {
    el: null,
    out: null,
    open() { this.el && this.el.classList.add("is-open"); this._setToggle("hide"); },
    close() { this.el && this.el.classList.remove("is-open"); this._setToggle("show"); },
    append(text, kind) {
      if (!this.out) return;
      const span = document.createElement("span");
      if (kind) span.className = kind;
      span.textContent = text;
      this.out.appendChild(span);
      this.out.scrollTop = this.out.scrollHeight;
    },
    clear() { if (this.out) this.out.textContent = ""; },
    _setToggle(label) {
      const btn = document.getElementById("drawer-toggle");
      if (btn) btn.textContent = label;
    },
  };

  // ── Repo detection + current branch lookup ─────────────────────────────
  async function detectRepo() {
    const r = await git("rev-parse --is-inside-work-tree");
    state.repoOk = r.code === 0 && r.stdout.trim() === "true";
    return state.repoOk;
  }

  async function readHead() {
    // Detached HEAD → returns "HEAD"; we display the short SHA instead.
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

    const chip = document.getElementById("branch-chip");
    if (chip) {
      let label = state.branch;
      if (state.aheadBehind && (state.aheadBehind.ahead || state.aheadBehind.behind)) {
        const parts = [];
        if (state.aheadBehind.ahead) parts.push("↑" + state.aheadBehind.ahead);
        if (state.aheadBehind.behind) parts.push("↓" + state.aheadBehind.behind);
        label += " " + parts.join(" ");
      }
      chip.textContent = label;
    }
  }

  async function detectRebaseInProgress() {
    const r = await git("rev-parse --git-path rebase-merge");
    if (r.code !== 0) {
      state.rebaseInProgress = false;
      return;
    }
    const path = r.stdout.trim();
    const check = await sh("test -d " + quote(path) + " && echo yes || echo no");
    state.rebaseInProgress = check.stdout.trim() === "yes";
    if (!state.rebaseInProgress) {
      const r2 = await git("rev-parse --git-path rebase-apply");
      if (r2.code === 0) {
        const p2 = r2.stdout.trim();
        const c2 = await sh("test -d " + quote(p2) + " && echo yes || echo no");
        state.rebaseInProgress = c2.stdout.trim() === "yes";
      }
    }
  }

  // ── Tab routing ────────────────────────────────────────────────────────
  function activateTab(name) {
    state.currentTab = name;
    document.querySelectorAll(".tab").forEach((t) =>
      t.classList.toggle("is-active", t.dataset.tab === name)
    );
    document.querySelectorAll(".pane").forEach((p) =>
      p.classList.toggle("is-active", p.dataset.pane === name)
    );
    renderActiveTab();
  }

  async function renderActiveTab() {
    switch (state.currentTab) {
      case "status":   return statusTab.render();
      case "branches": return branchesTab.render();
      case "sync":     return syncTab.render();
      case "history":  return historyTab.render();
      case "rebase":   return rebaseTab.render();
      case "stash":    return stashTab.render();
    }
  }

  // ── Status tab ─────────────────────────────────────────────────────────
  const statusTab = (() => {
    const pane = () => document.getElementById("status-pane");
    let commitMsg = "";
    let amend = false;

    function parseStatus(porc) {
      // git status --porcelain=v1: XY <path>
      // X = index, Y = worktree. " " means unchanged. "?" = untracked.
      const staged = [];
      const unstaged = [];
      const lines = porc.split("\n").filter(Boolean);
      for (const line of lines) {
        if (line.length < 3) continue;
        const x = line[0], y = line[1];
        const path = line.slice(3).replace(/^"|"$/g, "");
        if (x !== " " && x !== "?") staged.push({ code: x, path });
        if (y !== " " || x === "?") unstaged.push({ code: y === " " ? x : y, path, untracked: x === "?" });
      }
      return { staged, unstaged };
    }

    function statusClass(code) {
      switch (code) {
        case "M": return "modified";
        case "A": return "added";
        case "D": return "deleted";
        case "R": return "renamed";
        case "?": return "untracked";
        default:  return "modified";
      }
    }

    async function stage(path)   { await git("add -- " + quote(path)); await render(); }
    async function unstage(path) {
      // `restore --staged` is git ≥ 2.23; fall back to `reset HEAD` otherwise.
      const r = await git("restore --staged -- " + quote(path));
      if (r.code !== 0) await git("reset HEAD -- " + quote(path));
      await render();
    }
    async function discard(path, untracked) {
      if (!confirm("Discard changes to " + path + "?")) return;
      if (untracked) await git("clean -f -- " + quote(path));
      else {
        const r = await git("restore -- " + quote(path));
        if (r.code !== 0) await git("checkout -- " + quote(path));
      }
      await render();
    }
    async function stageAll()   { await git("add -A"); await render(); }
    async function unstageAll() {
      const r = await git("restore --staged .");
      if (r.code !== 0) await git("reset HEAD .");
      await render();
    }

    async function commit() {
      const msg = commitMsg.trim();
      if (!amend && !msg) { toast("Commit message required", "error"); return; }
      const args = amend
        ? "commit --amend" + (msg ? " -m " + quote(msg) : " --no-edit")
        : "commit -m " + quote(msg);
      const r = await git(args);
      drawer.append("$ git " + args + "\n", "log-cmd");
      if (r.stdout) drawer.append(r.stdout + "\n");
      if (r.stderr) drawer.append(r.stderr + "\n", r.code === 0 ? null : "log-err");
      if (r.code === 0) {
        toast(amend ? "Amended" : "Committed", "success");
        commitMsg = "";
        amend = false;
        await readHead();
      } else {
        toast("Commit failed", "error");
        drawer.open();
      }
      await render();
    }

    async function render() {
      const node = pane();
      node.innerHTML = "";
      const r = await git("status --porcelain=v1");
      if (r.code !== 0) {
        node.append(h("div", { class: "banner-err" }, r.stderr || "git status failed"));
        return;
      }
      const { staged, unstaged } = parseStatus(r.stdout);

      // Staged section
      const stagedSec = h("div", { class: "section" });
      stagedSec.append(
        h("h3", { class: "section-title" },
          "Staged",
          h("span", { class: "count-chip" }, String(staged.length)),
          staged.length > 0 && h("button", { class: "btn-ghost", style: "margin-left:auto;font-size:10px;", onClick: unstageAll }, "Unstage all"),
        ),
      );
      if (staged.length === 0) {
        stagedSec.append(h("p", { class: "empty-sub", style: "padding:4px 8px;" }, "No staged changes"));
      } else {
        for (const f of staged) {
          stagedSec.append(h("div", { class: "file-row " + statusClass(f.code) },
            h("span", { class: "file-status" }, f.code),
            h("span", { class: "file-path", title: f.path }, f.path),
            h("span", { class: "file-actions" },
              h("button", { class: "file-action", onClick: () => unstage(f.path) }, "unstage"),
            ),
          ));
        }
      }
      node.append(stagedSec);

      // Unstaged section
      const unstagedSec = h("div", { class: "section" });
      unstagedSec.append(
        h("h3", { class: "section-title" },
          "Changes",
          h("span", { class: "count-chip" }, String(unstaged.length)),
          unstaged.length > 0 && h("button", { class: "btn-ghost", style: "margin-left:auto;font-size:10px;", onClick: stageAll }, "Stage all"),
        ),
      );
      if (unstaged.length === 0) {
        unstagedSec.append(h("p", { class: "empty-sub", style: "padding:4px 8px;" }, "Working tree clean"));
      } else {
        for (const f of unstaged) {
          unstagedSec.append(h("div", { class: "file-row " + statusClass(f.code) },
            h("span", { class: "file-status" }, f.code),
            h("span", { class: "file-path", title: f.path }, f.path),
            h("span", { class: "file-actions" },
              h("button", { class: "file-action", onClick: () => stage(f.path) }, "stage"),
              h("button", { class: "file-action act-discard", onClick: () => discard(f.path, f.untracked) }, "discard"),
            ),
          ));
        }
      }
      node.append(unstagedSec);

      // Commit box
      const commitSec = h("div", { class: "section" });
      commitSec.append(h("h3", { class: "section-title" }, "Commit"));
      const ta = h("textarea", {
        class: "input",
        placeholder: amend ? "Amend message (leave blank to keep)" : "Commit message…",
        value: commitMsg,
        onInput: (e) => { commitMsg = e.target.value; },
      });
      const optsRow = h("div", { class: "commit-options" });
      const amendChk = h("input", { type: "checkbox", checked: amend, onChange: (e) => { amend = e.target.checked; render(); } });
      optsRow.append(h("label", null, amendChk, "Amend HEAD"));
      const submitBtn = h("button", { class: "btn-primary", style: "margin-left:auto;", onClick: commit }, amend ? "Amend commit" : "Commit");
      if (staged.length === 0 && !amend) submitBtn.disabled = true;
      optsRow.append(submitBtn);
      commitSec.append(h("div", { class: "commit-box" }, ta, optsRow));
      node.append(commitSec);
    }

    return { render };
  })();

  // ── Branches tab ───────────────────────────────────────────────────────
  const branchesTab = (() => {
    const pane = () => document.getElementById("branches-pane");
    let newBranchName = "";

    async function loadBranches() {
      // %1f = unit separator, safe even in weird branch names.
      const sep = "\x1f";
      const r = await git(
        "branch -a --format=" + quote("%(HEAD)" + sep + "%(refname:short)" + sep + "%(upstream:short)" + sep + "%(upstream:track)" + sep + "%(objectname:short)")
      );
      if (r.code !== 0) return [];
      return r.stdout.split("\n").filter(Boolean).map((line) => {
        const [head, name, upstream, track, sha] = line.split(sep);
        return {
          isCurrent: head === "*",
          name,
          upstream: upstream || null,
          track: track || "",
          sha,
          isRemote: name.startsWith("remotes/"),
        };
      });
    }

    async function checkout(name) {
      // For remote branches like "remotes/origin/feature", create a local
      // tracking branch with the same short name.
      let target = name;
      let args = "checkout " + quote(target);
      if (name.startsWith("remotes/")) {
        const local = name.split("/").slice(2).join("/");
        target = local;
        args = "checkout -b " + quote(local) + " " + quote(name);
      }
      const r = await git(args);
      if (r.code === 0) {
        toast("Switched to " + target, "success");
        await readHead();
      } else {
        drawer.append("$ git " + args + "\n", "log-cmd");
        drawer.append(r.stderr + "\n", "log-err");
        drawer.open();
        toast("Checkout failed", "error");
      }
      await render();
    }

    async function createBranch() {
      const name = newBranchName.trim();
      if (!name) return;
      const r = await git("checkout -b " + quote(name));
      if (r.code === 0) {
        toast("Created " + name, "success");
        newBranchName = "";
        await readHead();
      } else {
        drawer.append(r.stderr + "\n", "log-err");
        drawer.open();
        toast("Create failed", "error");
      }
      await render();
    }

    async function deleteBranch(name) {
      if (!confirm("Delete branch " + name + "?")) return;
      let r = await git("branch -d " + quote(name));
      if (r.code !== 0) {
        if (!confirm("Branch not fully merged. Force-delete?")) return;
        r = await git("branch -D " + quote(name));
      }
      if (r.code === 0) toast("Deleted " + name, "success");
      else { drawer.append(r.stderr + "\n", "log-err"); drawer.open(); toast("Delete failed", "error"); }
      await render();
    }

    async function render() {
      const node = pane();
      node.innerHTML = "";

      // Create-branch form
      const form = h("div", { class: "branch-form" });
      const input = h("input", {
        class: "input",
        placeholder: "New branch name…",
        value: newBranchName,
        onInput: (e) => { newBranchName = e.target.value; },
        onKeydown: (e) => { if (e.key === "Enter") createBranch(); },
      });
      form.append(input, h("button", { class: "btn-primary", onClick: createBranch }, "Create"));
      node.append(form);

      const branches = await loadBranches();
      const local = branches.filter((b) => !b.isRemote);
      const remote = branches.filter((b) => b.isRemote);

      const localSec = h("div", { class: "section" });
      localSec.append(h("h3", { class: "section-title" }, "Local", h("span", { class: "count-chip" }, String(local.length))));
      for (const b of local) {
        const row = h("div", { class: "branch-row" + (b.isCurrent ? " is-current" : "") },
          h("span", { class: "branch-marker" }, b.isCurrent ? "*" : ""),
          h("span", { class: "branch-name", title: b.name }, b.name),
          h("span", { class: "branch-meta" }, b.upstream ? b.upstream + " " + b.track : ""),
          h("span", { class: "branch-actions" },
            !b.isCurrent && h("button", { class: "file-action", onClick: () => checkout(b.name) }, "switch"),
            !b.isCurrent && h("button", { class: "file-action act-discard", onClick: () => deleteBranch(b.name) }, "delete"),
          ),
        );
        localSec.append(row);
      }
      node.append(localSec);

      if (remote.length > 0) {
        const remoteSec = h("div", { class: "section" });
        remoteSec.append(h("h3", { class: "section-title" }, "Remote", h("span", { class: "count-chip" }, String(remote.length))));
        for (const b of remote) {
          // Skip the symbolic origin/HEAD pointer.
          if (b.name.endsWith("/HEAD")) continue;
          const row = h("div", { class: "branch-row" },
            h("span", { class: "branch-marker" }, ""),
            h("span", { class: "branch-name", title: b.name }, b.name),
            h("span", { class: "branch-meta" }, b.sha),
            h("span", { class: "branch-actions" },
              h("button", { class: "file-action", onClick: () => checkout(b.name) }, "check out"),
            ),
          );
          remoteSec.append(row);
        }
        node.append(remoteSec);
      }
    }

    return { render };
  })();

  // ── Sync tab ───────────────────────────────────────────────────────────
  const syncTab = (() => {
    const pane = () => document.getElementById("sync-pane");

    async function pull(rebase) {
      const args = "pull" + (rebase ? " --rebase" : "") + " --no-edit";
      const r = await streamCmd("git " + args);
      if (r.code === 0) toast("Pull complete", "success");
      else toast("Pull failed", "error");
      await readHead();
      render();
    }
    async function push(force) {
      // --force-with-lease is the safe force: refuses if remote moved since
      // last fetch. We never expose plain --force.
      const args = "push" + (force ? " --force-with-lease" : "") + (state.upstream ? "" : " -u origin " + quote(state.branch));
      const r = await streamCmd("git " + args);
      if (r.code === 0) toast("Push complete", "success");
      else toast("Push failed", "error");
      await readHead();
      render();
    }
    async function fetch(prune) {
      const args = "fetch --all" + (prune ? " --prune" : "");
      const r = await streamCmd("git " + args);
      if (r.code === 0) toast("Fetch complete", "success");
      else toast("Fetch failed", "error");
      await readHead();
      render();
    }

    async function render() {
      const node = pane();
      node.innerHTML = "";

      const actions = h("div", { class: "sync-actions" });
      actions.append(
        h("button", { class: "btn-primary", onClick: () => fetch(false) }, "Fetch"),
        h("button", { class: "btn", onClick: () => fetch(true) }, "Fetch + prune"),
        h("button", { class: "btn-primary", onClick: () => pull(false) }, "Pull"),
        h("button", { class: "btn", onClick: () => pull(true) }, "Pull --rebase"),
        h("button", { class: "btn-primary", onClick: () => push(false) }, state.upstream ? "Push" : "Push (set upstream)"),
        h("button", { class: "btn-danger", onClick: () => push(true) }, "Push --force-with-lease"),
      );
      node.append(actions);

      const status = h("div", { class: "sync-status" });
      if (state.upstream) {
        let line = "Tracking " + state.upstream;
        if (state.aheadBehind) {
          if (state.aheadBehind.ahead || state.aheadBehind.behind) {
            line += " · ahead " + state.aheadBehind.ahead + ", behind " + state.aheadBehind.behind;
          } else {
            line += " · up to date";
          }
        }
        status.textContent = line;
      } else {
        status.textContent = "No upstream set — first push will use `-u origin " + state.branch + "`.";
      }
      node.append(status);
    }

    return { render };
  })();

  // ── History tab ────────────────────────────────────────────────────────
  const historyTab = (() => {
    const pane = () => document.getElementById("history-pane");
    let expandedSha = null;
    let cachedLog = [];

    async function loadLog() {
      const sep = "\x1f";
      const r = await git(
        "log --no-color --pretty=format:" + quote("%h" + sep + "%s" + sep + "%an" + sep + "%ar") + " -n 100"
      );
      if (r.code !== 0) return [];
      return r.stdout.split("\n").filter(Boolean).map((line) => {
        const [sha, msg, author, when] = line.split(sep);
        return { sha, msg, author, when };
      });
    }

    function renderDiff(sha) {
      const sec = h("div", { class: "diff-view" });
      sec.textContent = "Loading diff…";
      git("show --no-color --stat -p " + quote(sha)).then((r) => {
        sec.innerHTML = "";
        for (const line of r.stdout.split("\n")) {
          const span = document.createElement("span");
          if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ")) span.className = "diff-file";
          else if (line.startsWith("+")) span.className = "diff-add";
          else if (line.startsWith("-")) span.className = "diff-del";
          else if (line.startsWith("@@")) span.className = "diff-hunk";
          span.textContent = line + "\n";
          sec.appendChild(span);
        }
      });
      return sec;
    }

    async function render() {
      const node = pane();
      node.innerHTML = "";
      cachedLog = await loadLog();
      state.log = cachedLog;
      const list = h("div", { class: "log-list" });
      for (const c of cachedLog) {
        const row = h("div", { class: "log-row" },
          h("span", { class: "log-sha" }, c.sha),
          h("span", { class: "log-msg", title: c.msg }, c.msg),
          h("span", { class: "log-author" }, c.author + " · " + c.when),
        );
        row.addEventListener("click", () => {
          expandedSha = expandedSha === c.sha ? null : c.sha;
          render();
        });
        list.append(row);
        if (expandedSha === c.sha) list.append(renderDiff(c.sha));
      }
      if (cachedLog.length === 0) {
        node.append(h("p", { class: "empty-sub" }, "No commits yet"));
      } else {
        node.append(list);
      }
    }

    return { render };
  })();

  // ── Rebase tab ─────────────────────────────────────────────────────────
  const rebaseTab = (() => {
    const pane = () => document.getElementById("rebase-pane");
    let target = "HEAD~5";

    async function loadCommitsSince(target) {
      const sep = "\x1f";
      // --reverse so we list oldest→newest, which is the order the rebase
      // todo file expects.
      const r = await git(
        "log --reverse --no-color --pretty=format:" + quote("%h" + sep + "%s") + " " + quote(target) + "..HEAD"
      );
      if (r.code !== 0) {
        return { err: r.stderr || "Bad rev " + target, commits: [] };
      }
      const commits = r.stdout.split("\n").filter(Boolean).map((line) => {
        const [sha, msg] = line.split(sep);
        return { sha, msg, op: "pick" };
      });
      return { commits };
    }

    async function buildPlan() {
      const { err, commits } = await loadCommitsSince(target);
      if (err) {
        pane().innerHTML = "";
        pane().append(h("div", { class: "banner-err" }, err));
        return;
      }
      state.rebasePlan = commits;
      render();
    }

    async function startRebase() {
      if (state.rebasePlan.length === 0) { toast("Nothing to rebase", "error"); return; }
      // git rebase rejects `pick` as the first todo line being squash/fixup,
      // so refuse if the user squashed everything onto nothing.
      if (state.rebasePlan[0].op === "squash" || state.rebasePlan[0].op === "fixup") {
        toast("First commit cannot be 'squash' — change it to 'pick'.", "error");
        return;
      }
      const todoLines = state.rebasePlan
        .filter((c) => c.op !== "drop")
        .map((c) => c.op + " " + c.sha + " " + c.msg)
        .join("\n");
      // Stash our todo to a tmp file, then have GIT_SEQUENCE_EDITOR overwrite
      // git's auto-generated todo with ours. GIT_EDITOR=true ensures squash's
      // combined-message editor is auto-accepted (we keep git's default
      // merged message — user can amend after).
      const tmp = "/tmp/porta-rebase-todo-" + Date.now();
      const writeR = await sh("cat > " + quote(tmp) + " <<'PORTA_EOF'\n" + todoLines + "\nPORTA_EOF");
      if (writeR.code !== 0) { toast("Could not write todo file", "error"); return; }

      const cmd = "GIT_SEQUENCE_EDITOR=" + quote("cp " + tmp) + " GIT_EDITOR=true git rebase -i " + quote(target);
      const r = await streamCmd(cmd);
      await sh("rm -f " + quote(tmp));
      if (r.code === 0) {
        toast("Rebase complete", "success");
        state.rebasePlan = [];
        await readHead();
      } else {
        toast("Rebase paused — resolve conflicts in your editor", "error");
      }
      await detectRebaseInProgress();
      render();
    }

    async function abortRebase() {
      const r = await streamCmd("git rebase --abort");
      if (r.code === 0) toast("Rebase aborted", "success");
      await detectRebaseInProgress();
      render();
    }

    async function continueRebase() {
      const r = await streamCmd("GIT_EDITOR=true git rebase --continue");
      if (r.code === 0) {
        toast("Rebase continued", "success");
        await readHead();
      }
      await detectRebaseInProgress();
      render();
    }

    function render() {
      const node = pane();
      node.innerHTML = "";

      if (state.rebaseInProgress) {
        node.append(h("div", { class: "in-progress-banner" }, "A rebase is in progress. Resolve conflicts in your editor, stage the fixes, then continue."));
        node.append(h("div", { class: "rebase-actions" },
          h("button", { class: "btn-primary", onClick: continueRebase }, "Continue"),
          h("button", { class: "btn-danger", onClick: abortRebase }, "Abort"),
        ));
        return;
      }

      const form = h("div", { class: "rebase-form" });
      const input = h("input", {
        class: "input",
        placeholder: "Target (e.g. HEAD~5, main, abc123)",
        value: target,
        onInput: (e) => { target = e.target.value; },
        onKeydown: (e) => { if (e.key === "Enter") buildPlan(); },
      });
      form.append(input, h("button", { class: "btn-primary", onClick: buildPlan }, "Plan rebase"));
      node.append(form);

      if (state.rebasePlan.length === 0) {
        node.append(h("p", { class: "empty-sub" },
          "Pick a target ref. The commits between it and HEAD will appear here so you can pick / squash / drop each one."
        ));
        return;
      }

      const list = h("div", { class: "section" });
      for (let i = 0; i < state.rebasePlan.length; i++) {
        const c = state.rebasePlan[i];
        const select = h("select", { class: "input",
          onChange: (e) => { c.op = e.target.value; render(); },
        });
        for (const op of ["pick", "squash", "fixup", "drop"]) {
          const opt = h("option", { value: op, selected: c.op === op }, op);
          select.append(opt);
        }
        const row = h("div", { class: "rebase-todo-row" + (c.op === "drop" ? " is-drop" : "") },
          select,
          h("span", { class: "log-sha" }, c.sha),
          h("span", { class: "log-msg", title: c.msg }, c.msg),
        );
        list.append(row);
      }
      node.append(list);

      node.append(h("div", { class: "rebase-actions" },
        h("button", { class: "btn-primary", onClick: startRebase }, "Start rebase"),
        h("button", { class: "btn-ghost", onClick: () => { state.rebasePlan = []; render(); } }, "Clear plan"),
      ));
    }

    return { render };
  })();

  // ── Stash tab ──────────────────────────────────────────────────────────
  const stashTab = (() => {
    const pane = () => document.getElementById("stash-pane");
    let stashMsg = "";
    let includeUntracked = false;

    async function loadStash() {
      const sep = "\x1f";
      const r = await git("stash list --pretty=format:" + quote("%gd" + sep + "%s"));
      if (r.code !== 0) return [];
      return r.stdout.split("\n").filter(Boolean).map((line) => {
        const [ref, msg] = line.split(sep);
        return { ref, msg };
      });
    }

    async function saveStash() {
      const args = "stash push" + (includeUntracked ? " -u" : "") + (stashMsg.trim() ? " -m " + quote(stashMsg.trim()) : "");
      const r = await git(args);
      if (r.code === 0) { toast("Stashed", "success"); stashMsg = ""; }
      else { drawer.append(r.stderr + "\n", "log-err"); drawer.open(); toast("Stash failed", "error"); }
      await render();
    }

    async function applyStash(ref) {
      const r = await git("stash apply " + quote(ref));
      if (r.code === 0) toast("Applied " + ref, "success");
      else { drawer.append(r.stderr + "\n", "log-err"); drawer.open(); toast("Apply failed", "error"); }
      await render();
    }
    async function popStash(ref) {
      const r = await git("stash pop " + quote(ref));
      if (r.code === 0) toast("Popped " + ref, "success");
      else { drawer.append(r.stderr + "\n", "log-err"); drawer.open(); toast("Pop failed", "error"); }
      await render();
    }
    async function dropStash(ref) {
      if (!confirm("Drop " + ref + "?")) return;
      const r = await git("stash drop " + quote(ref));
      if (r.code === 0) toast("Dropped " + ref, "success");
      await render();
    }

    async function render() {
      const node = pane();
      node.innerHTML = "";

      const form = h("div", { class: "stash-form" });
      const input = h("input", {
        class: "input",
        placeholder: "Stash message (optional)",
        value: stashMsg,
        onInput: (e) => { stashMsg = e.target.value; },
      });
      const chk = h("input", { type: "checkbox", checked: includeUntracked, onChange: (e) => { includeUntracked = e.target.checked; } });
      form.append(input,
        h("label", { class: "commit-options", style: "white-space:nowrap;" }, chk, "include untracked"),
        h("button", { class: "btn-primary", onClick: saveStash }, "Stash"),
      );
      node.append(form);

      const stashes = await loadStash();
      if (stashes.length === 0) {
        node.append(h("p", { class: "empty-sub" }, "No stashes"));
        return;
      }
      const sec = h("div", { class: "section" });
      for (const s of stashes) {
        const row = h("div", { class: "stash-row" },
          h("span", { class: "stash-idx" }, s.ref),
          h("span", { class: "stash-msg", title: s.msg }, s.msg),
          h("span", { class: "stash-actions" },
            h("button", { class: "file-action", onClick: () => applyStash(s.ref) }, "apply"),
            h("button", { class: "file-action", onClick: () => popStash(s.ref) }, "pop"),
            h("button", { class: "file-action act-discard", onClick: () => dropStash(s.ref) }, "drop"),
          ),
        );
        sec.append(row);
      }
      node.append(sec);
    }

    return { render };
  })();

  // ── No-repo bootstrap ──────────────────────────────────────────────────
  async function renderNoRepo() {
    const root = document.querySelector(".panes");
    if (!root) return;
    root.innerHTML = "";
    const tpl = document.getElementById("tpl-no-repo");
    const node = tpl.content.cloneNode(true);
    const initBtn = node.querySelector('[data-act="init"]');
    // Without a root_dir, `git init` would init Porta's own launch dir —
    // safer to disable the button and explain.
    if (!bridge.app.rootDir) {
      initBtn.disabled = true;
      initBtn.textContent = "App has no root_dir";
      const sub = node.querySelector(".empty-sub");
      if (sub) sub.textContent = "Set this app's root directory in App Settings to enable git.";
    } else {
      initBtn.addEventListener("click", async () => {
        const r = await git("init");
        drawer.append(r.stdout || r.stderr || "", r.code === 0 ? null : "log-err");
        if (r.code === 0) {
          toast("Initialized git repo", "success");
          await init();
        } else toast("git init failed", "error");
      });
    }
    const wrap = h("section", { class: "pane is-active" });
    const inner = h("div", { class: "pane-inner" });
    inner.append(node);
    wrap.append(inner);
    root.append(wrap);
  }

  // ── Init ───────────────────────────────────────────────────────────────
  async function init() {
    bridge.ui.setTitle("Git — " + bridge.app.name);

    // Wire drawer DOM (templates were rendered server-side).
    drawer.el = document.getElementById("drawer");
    drawer.out = document.getElementById("drawer-output");
    document.getElementById("drawer-clear").addEventListener("click", () => drawer.clear());
    document.getElementById("drawer-toggle").addEventListener("click", () => {
      if (drawer.el.classList.contains("is-open")) drawer.close();
      else drawer.open();
    });
    document.getElementById("refresh-btn").addEventListener("click", refresh);
    document.querySelectorAll(".tab").forEach((t) => {
      t.addEventListener("click", () => activateTab(t.dataset.tab));
    });

    if (!await detectRepo()) {
      await renderNoRepo();
      return;
    }
    await readHead();
    await detectRebaseInProgress();
    activateTab("status");
  }

  async function refresh() {
    const btn = document.getElementById("refresh-btn");
    if (btn) btn.classList.add("spinning");
    try {
      await readHead();
      await detectRebaseInProgress();
      await renderActiveTab();
    } finally {
      if (btn) btn.classList.remove("spinning");
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
