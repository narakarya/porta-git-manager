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

    /**
     * Show a skeleton "loading" card in the modal slot.  Returns `true` if it
     * actually took ownership of the slot, `false` if another modal/loading
     * was already up — callers should bail out on `false` to avoid running
     * a second fetch behind the first (the double-click guard).
     *
     * `ui.diffModal` knows to swap in over an active loading card so the
     * skeleton transitions smoothly to the real content (no flicker through
     * a closed state).
     */
    showLoading(label) {
      const root = $("#modal-root");
      // Already showing a real modal OR another loading card — refuse.
      if (!root.hidden && !root.dataset.loadingActive) return false;
      if (root.dataset.loadingActive) return false;
      root.hidden = false;
      root.dataset.loadingActive = "1";
      root.innerHTML = "";
      const card = h("div", { class: "modal-card modal-wide modal-loading" },
        h("div", { class: "diff-modal-head" },
          h("div", { class: "diff-modal-title" },
            h("div", { class: "skel skel-line skel-modal-title" }),
            label && h("p", { class: "diff-modal-sub diff-modal-loading-label" }, label),
          ),
        ),
        h("div", { class: "diff-modal-main is-loading" },
          h("div", { class: "diff-tree diff-modal-loading-tree" },
            h("div", { class: "diff-tree-toolbar" },
              h("div", { class: "skel skel-tree-filter" }),
            ),
            h("div", { class: "diff-tree-body" },
              ...Array.from({ length: 12 }, (_, i) => h("div", {
                class: "skel skel-tree-row skel-tree-row-" + (i % 4),
              })),
            ),
          ),
          h("div", { class: "diff-modal-content" },
            h("div", { class: "skel skel-loading-file-head" }),
            ...Array.from({ length: 10 }, (_, i) => h("div", { class: "skel skel-diff-line skel-diff-line-" + (i % 5) })),
            h("div", { class: "skel skel-loading-file-head" }),
            ...Array.from({ length: 8 }, (_, i) => h("div", { class: "skel skel-diff-line skel-diff-line-" + (i % 5) })),
          ),
        ),
      );
      root.appendChild(card);
      return true;
    },

    /** Dismiss the loading card if it's still up. No-op otherwise. */
    hideLoading() {
      const root = $("#modal-root");
      if (!root.dataset.loadingActive) return;
      delete root.dataset.loadingActive;
      root.hidden = true;
      root.innerHTML = "";
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
    /**
     * Read-only diff viewer. `files` is the output of gmParseDiffDoc(raw).
     * Used by the stash and branch "View"/"Diff" previews — rendering only,
     * no stage/discard actions. Resolves when dismissed.
     */
    diffModal({ title, subtitle, files, refetch }) {
      return new Promise((resolve) => {
        const root = $("#modal-root");
        // Double-open guard: if a *real* modal is already up, refuse. A
        // loading skeleton is acceptable — we'll overwrite it (the smooth
        // transition between "loading" and "real" modal).
        if (!root.hidden && !root.dataset.loadingActive) { resolve(); return; }
        if (root.dataset.loadingActive) delete root.dataset.loadingActive;
        root.hidden = false;
        root.innerHTML = "";
        const close = () => {
          root.hidden = true;
          root.classList.remove("modal-root-fullscreen");
          root.innerHTML = "";
          window.removeEventListener("keydown", onKey, true);
          resolve();
        };
        const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
        window.addEventListener("keydown", onKey, true);

        const content = h("div", { class: "diff-modal-content" });
        let viewMode = "unified";
        let currentList = files;
        const hasRefetch = typeof refetch === "function";
        let ignoreWs = false;
        let contextLines = 3;
        let currentFiles = files;
        const renderInto = (list) => {
          currentList = list;
          if (viewMode === "split") gmRenderDiffDocSplit(content, list);
          else gmRenderDiffDoc(content, list);
          content.scrollTop = 0;
        };
        const showList = (list) => renderInto(list);

        const activeRowRef = { row: null };
        const paintTreeRef = { fn: null };

        async function reload() {
          if (!hasRefetch) return;
          try {
            const fresh = await refetch({ ignoreWhitespace: ignoreWs, context: contextLines });
            if (!Array.isArray(fresh)) return;
            currentFiles = fresh;
            if (paintTreeRef.fn) {
              paintTreeRef.fn();
            }
            if (activeRowRef.row && activeRowRef.row.classList.contains("diff-tree-all")) {
              renderInto(currentFiles);
            } else if (activeRowRef.row) {
              const path = activeRowRef.row.dataset.path;
              const match = currentFiles.find((f) => f.path === path);
              renderInto(match ? [match] : currentFiles);
            } else {
              renderInto(currentFiles);
            }
          } catch (e) {
            ui.toast("Could not refresh diff: " + (e.message || e), "error", 5000);
          }
        }

        let main;
        if (files.length > 1) {
          // VSCode-style: a file tree on the left, the selected file's diff on
          // the right. "All files" shows the full multi-file diff.
          const nav = h("div", { class: "diff-tree" });
          activeRowRef.row = null;
          const setActive = (row) => {
            if (activeRowRef.row) activeRowRef.row.classList.remove("is-active");
            activeRowRef.row = row;
            if (row) row.classList.add("is-active");
          };
          const totals = files.reduce((acc, f) => { const s = gmFileStats(f); acc.add += s.add; acc.del += s.del; return acc; }, { add: 0, del: 0 });

          let treeFilter = "";
          const filterInput = h("input", {
            class: "diff-tree-filter",
            placeholder: "Filter files…",
            onInput: (e) => { treeFilter = e.target.value; paintTree(); },
          });
          const toolbar = h("div", { class: "diff-tree-toolbar" },
            filterInput,
            h("span", { class: "diff-tree-totals" },
              h("span", { class: "stat-add" }, "+" + totals.add),
              h("span", { class: "stat-del" }, "−" + totals.del),
            ),
          );
          const treeBody = h("div", { class: "diff-tree-body" });

          function paintTree() {
            treeBody.innerHTML = "";
            const visible = gmFilterFiles(currentFiles, treeFilter);
            const allRow = h("button", {
              class: "diff-tree-row diff-tree-all" + (!treeFilter && (!activeRowRef.row || activeRowRef.row === null) ? " is-active" : ""),
              onClick: () => { setActive(allRow); showList(visible); },
            },
              h("span", { class: "diff-tree-name" },
                visible.length + (treeFilter ? " of " + currentFiles.length : "") + " files changed"),
              h("span", { class: "diff-tree-stat" },
                h("span", { class: "stat-add" }, "+" + totals.add),
                h("span", { class: "stat-del" }, "−" + totals.del)),
            );
            if (!activeRowRef.row) {
              activeRowRef.row = allRow;
              allRow.classList.add("is-active");
            }
            treeBody.append(allRow);
            if (visible.length === 0) {
              treeBody.append(h("div", { class: "diff-tree-empty" }, "No files match"));
              return;
            }
            gmRenderFileTree(treeBody, visible, {
              onPick: (f, row) => { setActive(row); showList([f]); },
            });
          }
          paintTreeRef.fn = paintTree;
          paintTree();

          nav.append(toolbar);
          nav.append(treeBody);
          main = h("div", { class: "diff-modal-main" }, nav, content);
        } else {
          main = h("div", { class: "diff-modal-main is-single" }, content);
        }

        const wsChk = h("input", {
          type: "checkbox",
          checked: ignoreWs,
          onChange: (e) => { ignoreWs = e.target.checked; reload(); },
        });
        const wsLabel = h("label", { class: "diff-modal-opt" }, wsChk, "Ignore whitespace");

        const ctxSelect = h("select", {
          class: "diff-modal-opt-select",
          onChange: (e) => { contextLines = e.target.value === "all" ? 99999 : Number(e.target.value); reload(); },
        },
          h("option", { value: "3" }, "±3 ctx"),
          h("option", { value: "6" }, "±6 ctx"),
          h("option", { value: "all" }, "All ctx"),
        );

        const optsBar = hasRefetch ? h("div", { class: "diff-modal-opts" }, wsLabel, ctxSelect) : null;

        // Wrap + Fullscreen — always available (no refetch dependency).
        // Both persist via localStorage so the user's preference survives
        // closing & re-opening the modal.
        const lsGet = (k, fallback) => {
          try { const v = window.localStorage.getItem(k); return v == null ? fallback : v === "true"; }
          catch (_) { return fallback; }
        };
        const lsSet = (k, v) => { try { window.localStorage.setItem(k, String(v)); } catch (_) {} };

        let wrap = lsGet("pgm.diff.wrap", true);   // default ON — long lines wrap by default
        const wrapChk = h("input", {
          type: "checkbox",
          checked: wrap,
          onChange: (e) => {
            wrap = e.target.checked;
            lsSet("pgm.diff.wrap", wrap);
            main.classList.toggle("is-wrap", wrap);
          },
        });
        const wrapLabel = h("label", { class: "diff-modal-opt" }, wrapChk, "Wrap");
        if (wrap) main.classList.add("is-wrap");

        let fullscreen = lsGet("pgm.diff.fullscreen", false);
        const fsBtn = h("button", {
          class: "btn-ghost diff-modal-fs",
          title: "Toggle fullscreen",
          onClick: () => {
            fullscreen = !fullscreen;
            lsSet("pgm.diff.fullscreen", fullscreen);
            applyFullscreen();
          },
        }, fullscreen ? "Restore" : "Full");
        function applyFullscreen() {
          // The Escape handler we added below relies on the modal-root flex
          // container — fullscreen also toggles a class on root so its
          // padding can be turned off (otherwise the card can't actually
          // reach the viewport edges; see .modal-root.is-fullscreen rule).
          root.classList.toggle("modal-root-fullscreen", fullscreen);
          card.classList.toggle("is-fullscreen", fullscreen);
          fsBtn.textContent = fullscreen ? "Restore" : "Full";
        }
        const viewOpts = h("div", { class: "diff-modal-opts" }, wrapLabel);

        const toggle = h("div", { class: "view-toggle" },
          h("button", {
            class: "view-toggle-btn is-active",
            onClick: (e) => {
              if (viewMode === "unified") return;
              viewMode = "unified";
              e.currentTarget.parentElement.querySelectorAll(".view-toggle-btn").forEach((b) => b.classList.remove("is-active"));
              e.currentTarget.classList.add("is-active");
              renderInto(currentList);
            },
          }, "Unified"),
          h("button", {
            class: "view-toggle-btn",
            onClick: (e) => {
              if (viewMode === "split") return;
              viewMode = "split";
              e.currentTarget.parentElement.querySelectorAll(".view-toggle-btn").forEach((b) => b.classList.remove("is-active"));
              e.currentTarget.classList.add("is-active");
              renderInto(currentList);
            },
          }, "Split"),
        );

        const card = h("div", { class: "modal-card modal-wide" },
          h("div", { class: "diff-modal-head" },
            h("div", { class: "diff-modal-title" },
              h("h3", null, title),
              subtitle && h("p", { class: "diff-modal-sub", title: subtitle }, subtitle),
            ),
            optsBar,
            viewOpts,
            toggle,
            fsBtn,
            h("button", { class: "btn-ghost", onClick: close }, "Close"),
          ),
          main,
        );
        root.appendChild(card);
        if (fullscreen) applyFullscreen();   // apply persisted state on open
        showList(files);
      });
    },
  };

  // ── Shared read-only diff rendering (stash / branch previews) ─────────────
  // The Status tab has its own interactive renderer (with stage/discard
  // buttons) trapped in its closure; these module-level helpers are a
  // standalone, action-free variant that also handles multi-file diffs.
  function gmDiffCodeHtml(body, lang, wordTokens) {
    const esc = window.GMText.escapeHtml;
    if (wordTokens) {
      return wordTokens.map((w) =>
        w.changed ? '<span class="' + wordTokens.cls + '">' + esc(w.t) + "</span>" : esc(w.t)
      ).join("");
    }
    const toks = window.GMHi.tokenize(body, lang);
    return toks.map((t) => t.type ? '<span class="syn-' + t.type + '">' + esc(t.t) + "</span>" : esc(t.t)).join("");
  }

  /** Split a (possibly multi-file) unified diff into files, each with hunks. */
  function gmParseDiffDoc(text) {
    const files = [];
    let file = null, hunk = null;
    const pushHunk = () => { if (file && hunk) { file.hunks.push(hunk); hunk = null; } };
    const pushFile = () => { pushHunk(); if (file) files.push(file); file = null; };
    for (const line of (text || "").split("\n")) {
      if (line.startsWith("diff --git")) {
        pushFile();
        const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
        file = { path: m ? m[2] : "", header: [line], hunks: [] };
      } else if (line.startsWith("@@")) {
        if (!file) file = { path: "", header: [], hunks: [] };
        pushHunk();
        hunk = { header: line, lines: [] };
      } else if (hunk) {
        hunk.lines.push(line);
      } else if (file) {
        file.header.push(line);
      }
    }
    pushFile();
    // Trim the trailing blank line git emits on each file's last hunk.
    for (const f of files) {
      const last = f.hunks[f.hunks.length - 1];
      if (last) while (last.lines.length && last.lines[last.lines.length - 1] === "") last.lines.pop();
    }
    return files;
  }

  /** Render parsed files read-only (unified view) into `node`. */
  function gmRenderDiffDoc(node, files) {
    node.innerHTML = "";
    if (!files || !files.length) {
      node.append(h("div", { class: "status-diff-empty" }, "No changes to show."));
      return;
    }
    for (const f of files) {
      const lang = window.GMHi.langFromPath(f.path || "");
      const block = h("div", { class: "diff-file-block" });
      const body  = h("div", { class: "diff-file-body" });

      // Sticky header: chevron + icon + path + +/- stats pills.
      const st = gmFileStats(f);
      const chev = h("span", { class: "chev" }, "▾");
      const head = h("div", { class: "diff-file-head" },
        chev,
        gmFileIcon(f.path),
        h("span", { class: "path" }, f.path || "(unnamed)"),
        h("span", { class: "stats" },
          st.add ? h("span", { class: "stat-add" }, "+" + st.add) : null,
          st.del ? h("span", { class: "stat-del" }, "−" + st.del) : null,
        ),
      );
      head.addEventListener("click", () => {
        const collapsed = block.classList.toggle("is-collapsed");
        chev.textContent = collapsed ? "▸" : "▾";
      });
      block.append(head);

      // git's "diff --git …" / "+++" / "---" header lines go inside the
      // body (still visible when expanded, hidden when collapsed) — they're
      // noise once the sticky header above shows the same path nicely.
      for (const m of f.header) {
        if (m.startsWith("diff ") || m.startsWith("+++") || m.startsWith("---")) continue;
        body.append(h("span", { class: "diff-line diff-meta" }, m || " "));
      }
      for (const hunk of f.hunks) {
        const wrapper = h("div", { class: "hunk" });
        wrapper.append(h("div", { class: "hunk-header" }, hunk.header));
        const range = window.GMDiff.parseHunkHeader(hunk.header);
        const rows = window.GMDiff.numberHunkLines(hunk.lines, range);
        for (let k = 0; k < rows.length; k++) {
          const r = rows[k], next = rows[k + 1];
          if (r.kind === "del" && next && next.kind === "add") {
            const d = window.GMDiff.wordDiff(r.text, next.text);
            if (d) {
              r._wd = d.del; r._wd.cls = "wd-del";
              next._wd = d.add; next._wd.cls = "wd-add";
            }
          }
        }
        for (const r of rows) {
          if (r.kind === "meta") { wrapper.append(h("span", { class: "diff-line diff-meta" }, r.text || " ")); continue; }
          const lineBody = r.text.slice(1) || " ";
          wrapper.append(h("span", { class: "diff-line diff-" + r.kind },
            h("span", { class: "diff-gutter" }, r.oldNo == null ? "" : String(r.oldNo)),
            h("span", { class: "diff-gutter" }, r.newNo == null ? "" : String(r.newNo)),
            h("span", { class: "diff-code", html: gmDiffCodeHtml(lineBody, lang, r._wd || null) }),
          ));
        }
        body.append(wrapper);
      }

      block.append(body);
      node.append(block);
    }
  }

  /**
   * Render parsed files into `node` in side-by-side (split) view. Re-uses the
   * shared toSplitRows helper from window.GMDiff. Identical sticky-header +
   * collapse behaviour as gmRenderDiffDoc.
   */
  function gmRenderDiffDocSplit(node, files) {
    node.innerHTML = "";
    if (!files || !files.length) {
      node.append(h("div", { class: "status-diff-empty" }, "No changes to show."));
      return;
    }
    for (const f of files) {
      const lang = window.GMHi.langFromPath(f.path || "");
      const block = h("div", { class: "diff-file-block" });
      const body  = h("div", { class: "diff-file-body" });
      const st = gmFileStats(f);
      const chev = h("span", { class: "chev" }, "▾");
      const head = h("div", { class: "diff-file-head" },
        chev,
        gmFileIcon(f.path),
        h("span", { class: "path" }, f.path || "(unnamed)"),
        h("span", { class: "stats" },
          st.add ? h("span", { class: "stat-add" }, "+" + st.add) : null,
          st.del ? h("span", { class: "stat-del" }, "−" + st.del) : null,
        ),
      );
      head.addEventListener("click", () => {
        const collapsed = block.classList.toggle("is-collapsed");
        chev.textContent = collapsed ? "▸" : "▾";
      });
      block.append(head);

      for (const hunk of f.hunks) {
        const wrapper = h("div", { class: "hunk hunk-split" });
        wrapper.append(h("div", { class: "hunk-header" }, hunk.header));
        const range = window.GMDiff.parseHunkHeader(hunk.header);
        const numbered = window.GMDiff.numberHunkLines(hunk.lines, range);
        const splitRows = window.GMDiff.toSplitRows(numbered);
        const grid = h("div", { class: "diff-split" });
        function cell(side, c) {
          if (!c) {
            return h("span", { class: "diff-cell diff-cell-" + side + " diff-blank" },
              h("span", { class: "diff-gutter" }, ""),
              h("span", { class: "diff-code", html: " " }));
          }
          const lineBody = c.text.slice(1) || " ";
          return h("span", { class: "diff-cell diff-cell-" + side + " diff-" + c.kind },
            h("span", { class: "diff-gutter" }, c.no == null ? "" : String(c.no)),
            h("span", { class: "diff-code", html: gmDiffCodeHtml(lineBody, lang, c._wd || null) }));
        }
        for (const sr of splitRows) {
          grid.append(cell("left", sr.left), cell("right", sr.right));
        }
        wrapper.append(grid);
        body.append(wrapper);
      }
      block.append(body);
      node.append(block);
    }
  }

  /** Added/removed line counts for one parsed file. */
  function gmFileStats(f) {
    let add = 0, del = 0;
    for (const hk of f.hunks) for (const ln of hk.lines) {
      if (ln[0] === "+") add++; else if (ln[0] === "-") del++;
    }
    return { add, del };
  }

  // Data layer lives in file-tree.js (window.GMTree); these are local
  // aliases so callers don't have to know.
  const gmFileTree = window.GMTree.fileTree;
  const gmFilterFiles = window.GMTree.filterFiles;
  const gmParseStatus = window.GMStatus.parsePorcelain;
  const gmStatusClass = window.GMStatus.statusClass;

  /**
   * Render a file tree into `nav`. The data layer (`gmFileTree`) builds
   * the nested structure; this function walks it. Per-row rendering is
   * delegated so callers can produce different row contents (diff modal
   * shows +/- stats; Status tab shows status letters + per-file actions).
   *
   * opts = {
   *   depth?: number,                  // initial padding depth (default 0)
   *   onPick(file, rowEl, event): void,// file click handler
   *   onDirPick(files, rowEl, event): void, // optional folder click handler
   *   renderRow(file, depth): Node,    // builds and returns the file row inner content;
   *                                    // MUST NOT attach its own click handler
   *                                    // (we attach onPick to the wrapper button)
   *   keyFor(file): string,            // optional stable row key for selection
   *   rowClassFor(file): string,       // optional additional row class
   * }
   */
  function gmRenderFileTree(nav, files, opts) {
    const node = gmFileTree(files);
    const onPick = opts.onPick || (() => {});
    const onDirPick = opts.onDirPick || null;
    const renderRow = opts.renderRow || defaultDiffRow;
    const rowClassFor = opts.rowClassFor || (() => "");
    walk(nav, node, opts.depth || 0);

    function collectFiles(n) {
      let out = n.files.slice();
      for (const child of n.dirs.values()) out = out.concat(collectFiles(child));
      return out;
    }

    function walk(parent, n, depth) {
      for (const dir of n.dirs.values()) {
        // Folder row: chevron + name. Clicking toggles the child wrapper's
        // .is-collapsed class (CSS hides children when set). State stays
        // in the DOM — caller doesn't need to track anything; if the
        // caller fully re-renders the tree, folders reset to expanded.
        const chev = h("span", { class: "tree-chev" }, "▾");
        const dirFiles = collectFiles(dir);
        const dirRow = h("div", {
          class: "diff-tree-row diff-tree-dir",
          style: { paddingLeft: (depth * 12 + 6) + "px" },
          title: onDirPick ? "Click to expand/collapse. Cmd/Ctrl-click to select folder." : "Expand/collapse " + dir.name + "/",
        },
          chev,
          h("span", { class: "tree-folder-icon", ariaHidden: "true" }),
          h("span", { class: "diff-tree-name" }, dir.name + "/"),
        );
        const childWrap = h("div", { class: "diff-tree-children" });
        dirRow.addEventListener("click", (e) => {
          if (onDirPick && (e.metaKey || e.ctrlKey || e.shiftKey)) {
            onDirPick(dirFiles, dirRow, e);
            return;
          }
          const collapsed = childWrap.classList.toggle("is-collapsed");
          dirRow.classList.toggle("is-collapsed", collapsed);
          chev.textContent = collapsed ? "▸" : "▾";
        });
        parent.append(dirRow);
        parent.append(childWrap);
        walk(childWrap, dir, depth + 1);
      }
      for (const f of n.files) {
        const inner = renderRow(f, depth);
        const statusCls = f.code ? " status-" + gmStatusClass(f.code) : "";
        const row = h("button", {
          class: "diff-tree-row diff-tree-file" + statusCls + (rowClassFor(f) ? " " + rowClassFor(f) : ""),
          style: { paddingLeft: (depth * 12 + 10) + "px" },
          onClick: (e) => onPick(f, row, e),
        }, ...(Array.isArray(inner) ? inner : [inner]));
        row.dataset.path = f.path;
        row.dataset.key = opts.keyFor ? opts.keyFor(f) : f.path;
        parent.append(row);
      }
    }
  }

  /** Return an <svg.ficon> referencing the appropriate sprite symbol by file extension. */
  function gmFileIcon(path) {
    const ext = (path || "").split(".").pop().toLowerCase();
    const known = ["ts", "tsx", "js", "jsx", "json", "css", "html", "md", "rs", "py", "sh"];
    const id = known.includes(ext) ? "ficon-" + ext : "ficon-generic";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "ficon");
    svg.setAttribute("viewBox", "0 0 14 14");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#" + id);
    svg.appendChild(use);
    return svg;
  }

  /**
   * Deterministic pastel HSL background per author name.
   * djb2 hash → pick one of 12 hues; fixed saturation/lightness for readability
   * against the dark theme. Two different spellings of the same author's name
   * map to different colors — accepted trade-off.
   */
  function gmAuthorChipColor(name) {
    let hash = 5381;
    for (let i = 0; i < (name || "").length; i++) {
      hash = ((hash << 5) + hash + name.charCodeAt(i)) >>> 0;
    }
    const hue = (hash % 12) * 30;   // 0, 30, 60, … 330
    return "hsl(" + hue + ", 45%, 35%)";
  }

  /** Default row renderer — matches the previous diff modal look (+/- pills). */
  function defaultDiffRow(f) {
    const st = gmFileStats(f);
    return [
      gmFileIcon(f.path),
      h("span", { class: "diff-tree-name", title: f.path }, f._name),
      h("span", { class: "diff-tree-stat" },
        st.add ? h("span", { class: "stat-add" }, "+" + st.add) : null,
        st.del ? h("span", { class: "stat-del" }, "−" + st.del) : null),
    ];
  }

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
    paintQuickbar();
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
    // Re-entering Status should reflect the real working tree, so force a fresh
    // read on activation; in-tab clicks then ride the cache. Other tabs keep
    // their own loaded-flag caching and aren't forced here.
    renderActiveTab(name === "status" ? { force: true } : undefined);
  }

  async function renderActiveTab(opts) {
    const map = { status: statusTab, branches: branchesTab, sync: syncTab, history: historyTab, rebase: rebaseTab, stash: stashTab, tags: tagsTab, pr: prTab };
    const tab = map[state.currentTab];
    if (tab) await tab.render(opts || {});
  }

  // ── Status tab ───────────────────────────────────────────────────────────
  const statusTab = (() => {
    const pane = () => document.querySelector('.pane[data-pane="status"]');
    let lastDiffPath = null;
    let lastDiffSource = null;  // "staged" | "unstaged" | "untracked"
    let caretPos = null;        // caret offset to restore after a filter re-render
    const selectedStatus = new Set();
    let lastSelectedStatusKey = null;

    // Selection clicks repaint the pane via render(), but the working tree only
    // actually changes on refresh()/an action (both force a render). So cache the
    // parsed `git status` and per-file diffs and only re-shell when forced. This
    // turns a file click from "two git subprocesses + rebuild" into a pure repaint.
    let statusCache = null;
    const diffCache = new Map(); // "source:path" -> parsed diff
    function invalidateStatus() { statusCache = null; diffCache.clear(); }

    async function loadStatus() {
      if (statusCache) return statusCache;
      const r = await git("status --porcelain=v2");
      if (r.code !== 0) return { err: r.stderr || "git status failed" };
      statusCache = gmParseStatus(r.stdout);
      return statusCache;
    }

    /**
     * Run git diff for the selected file and return a structured form:
     *   { header: [str], hunks: [{ header, lines }], untracked: bool }
     * Hunks let us render a per-hunk action bar and build a minimal patch
     * for `git apply` when the user clicks Stage hunk / Unstage / Discard.
     */
    async function loadDiff(file, source) {
      if (file.submodule) {
        const where = "-C " + quote(file.path) + " ";
        const status = await git(where + "status --short");
        const stagedDiff = await git(where + "diff --cached --no-color");
        const unstagedDiff = await git(where + "diff --no-color");
        const summary = file.submoduleSummary ? " · " + file.submoduleSummary : "";
        const header = [file.path + " (submodule" + summary + ")"];
        const hunks = [];
        let body = "";
        if ((status.stdout || "").trim()) {
          body += "Submodule status:\n" + status.stdout.trimEnd() + "\n";
        }
        if ((stagedDiff.stdout || "").trim()) body += "\nStaged diff:\n" + stagedDiff.stdout.trimEnd() + "\n";
        if ((unstagedDiff.stdout || "").trim()) body += "\nUnstaged diff:\n" + unstagedDiff.stdout.trimEnd() + "\n";
        if (!body.trim()) body = "No inner submodule changes.";
        hunks.push({
          header: "@@ submodule " + file.path + " @@",
          lines: body.split("\n").map((l) => " " + l),
        });
        return { submodule: true, header, hunks };
      }
      if (source === "untracked" || file.untracked) {
        // Untracked directory: list the files it contains rather than
        // trying to `head` a directory (which errors).
        if (file.path.endsWith("/")) {
          const dir = file.path.replace(/\/+$/, "");
          const r = await sh("find " + quote(dir) + " -type f 2>/dev/null | head -n 500");
          const files = (r.stdout || "").split("\n").filter(Boolean);
          return {
            untracked: true,
            header: [file.path + " (untracked directory · " + files.length + " file" + (files.length === 1 ? "" : "s") + ")"],
            hunks: files.length ? [{
              header: "@@ -0,0 +1," + files.length + " @@",
              lines: files.map((l) => "+" + l),
            }] : [],
          };
        }
        // Untracked file has no real diff. Synthesize a hunk so the
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

    // Build the inner code HTML for one diff line: syntax tokens, with
    // optional word-change spans layered on top. `body` excludes the +/-/space
    // prefix. `wordTokens` is an array from wordDiff (with a `.cls` property), or null.
    function diffCodeHtml(body, lang, wordTokens) {
      const esc = window.GMText.escapeHtml;
      if (wordTokens) {
        return wordTokens.map((w) =>
          w.changed ? '<span class="' + wordTokens.cls + '">' + esc(w.t) + "</span>" : esc(w.t)
        ).join("");
      }
      const toks = window.GMHi.tokenize(body, lang);
      return toks.map((t) => t.type ? '<span class="syn-' + t.type + '">' + esc(t.t) + "</span>" : esc(t.t)).join("");
    }

    /**
     * Render the parsed diff into `node`. Each hunk is its own .hunk
     * container with a header bar holding the @@ line plus per-hunk
     * action buttons (Stage/Unstage/Discard, depending on `source`).
     * Dispatches to the unified or split renderer based on state.diffView.
     */
    function renderDiffInto(node, parsed, source, filePath) {
      node.innerHTML = "";
      const lang = window.GMHi.langFromPath(filePath || "");
      for (const m of parsed.header) {
        const cls = (m.startsWith("diff ") || m.startsWith("+++") || m.startsWith("---")) ? "diff-file" : "diff-meta";
        node.appendChild(h("span", { class: "diff-line " + cls }, m || " "));
      }
      if (parsed.submodule) {
        node.appendChild(h("div", { class: "status-submodule-note" },
          "Actions run inside this submodule. Commit submodule changes from that repo before committing the parent pointer.",
        ));
      }
      const renderHunkBody = state.diffView === "split" ? renderSplitHunkBody : renderUnifiedHunkBody;
      for (const hunk of parsed.hunks) {
        const wrapper = h("div", { class: "hunk" });
        const actions = h("span", { class: "hunk-actions" });
        if (parsed.submodule) {
          if (source === "staged") {
            actions.append(h("button", { class: "hunk-action", onClick: () => unstage(filePath, true) }, "Unstage"));
          } else {
            actions.append(
              h("button", { class: "hunk-action", onClick: () => stage(filePath, true) }, "Stage all"),
              h("button", { class: "hunk-action danger", onClick: () => discard({ path: filePath, submodule: true }) }, "Discard all"),
            );
          }
        } else if (source === "untracked") {
          actions.append(
            h("button", { class: "hunk-action",        onClick: () => stageOneHunk(filePath, hunk, source) }, "Stage all"),
            h("button", { class: "hunk-action danger", onClick: () => discardOneHunk(filePath, hunk, source) }, "Delete"),
          );
        } else if (source === "unstaged") {
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
        renderHunkBody(wrapper, hunk, lang);
        node.appendChild(wrapper);
      }
    }

    function renderUnifiedHunkBody(wrapper, hunk, lang) {
      const range = window.GMDiff.parseHunkHeader(hunk.header);
      const rows = window.GMDiff.numberHunkLines(hunk.lines, range);
      // Pre-compute word diffs for an adjacent del/add singleton pair.
      for (let k = 0; k < rows.length; k++) {
        const r = rows[k], next = rows[k + 1];
        if (r.kind === "del" && next && next.kind === "add") {
          const d = window.GMDiff.wordDiff(r.text, next.text);
          if (d) {
            r._wd = d.del; r._wd.cls = "wd-del";
            next._wd = d.add; next._wd.cls = "wd-add";
          }
        }
      }
      for (const r of rows) {
        if (r.kind === "meta") {
          wrapper.appendChild(h("span", { class: "diff-line diff-meta" }, r.text || " "));
          continue;
        }
        const body = r.text.slice(1) || " ";
        const code = h("span", { class: "diff-code", html: diffCodeHtml(body, lang, r._wd || null) });
        wrapper.appendChild(h("span", { class: "diff-line diff-" + r.kind },
          h("span", { class: "diff-gutter" }, r.oldNo == null ? "" : String(r.oldNo)),
          h("span", { class: "diff-gutter" }, r.newNo == null ? "" : String(r.newNo)),
          code,
        ));
      }
    }

    /**
     * Split-view: pair consecutive removed/added runs into side-by-side
     * rows. Context lines appear on both sides. When a run of removals is
     * not the same length as the following run of additions, the longer
     * side spills to extra rows with the shorter side blank.
     */
    function renderSplitHunkBody(wrapper, hunk, lang) {
      // Tag the hunk for split-mode horizontal scroll (single scrollbar
      // shared by both columns). See .hunk-split rule in style.css.
      wrapper.classList.add("hunk-split");
      const range = window.GMDiff.parseHunkHeader(hunk.header);
      const numbered = window.GMDiff.numberHunkLines(hunk.lines, range);
      const splitRows = window.GMDiff.toSplitRows(numbered);
      const grid = h("div", { class: "diff-split" });

      function cell(side, c) {
        if (!c) {
          return h("span", { class: "diff-cell diff-cell-" + side + " diff-blank" },
            h("span", { class: "diff-gutter" }, ""),
            h("span", { class: "diff-code", html: " " }));
        }
        const body = c.text.slice(1) || " ";
        return h("span", { class: "diff-cell diff-cell-" + side + " diff-" + c.kind },
          h("span", { class: "diff-gutter" }, c.no == null ? "" : String(c.no)),
          h("span", { class: "diff-code", html: diffCodeHtml(body, lang, c._wd || null) }));
      }

      for (const sr of splitRows) {
        grid.append(cell("left", sr.left), cell("right", sr.right));
      }
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
        return deleteUntracked({ path: filePath });
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

    async function deleteUntracked(file) {
      const isDir = /\/$/.test(file.path || "");
      const label = isDir ? "folder" : "file";
      const ok = await ui.confirm({
        title: "Delete untracked " + label + "?",
        body: `Remove ${file.path} from disk. This also removes ignored files inside it. There's no undo.`,
        danger: true,
        okLabel: "Delete",
      });
      if (!ok) return;
      const target = String(file.path || "").replace(/\/+$/, "") || file.path;
      const r = await sh("rm -rf -- " + quote(target));
      if (r.code === 0) {
        ui.toast("Deleted " + file.path, "success");
        await refresh();
      } else {
        ui.toast(r.stderr || "Delete failed", "error", 5000);
        await refresh();
      }
    }

    function statusKey(source, file) {
      return source + ":" + file.path;
    }

    function pruneStatusSelection(status) {
      const live = new Set();
      for (const f of status.staged || []) live.add(statusKey("staged", f));
      for (const f of status.unstaged || []) live.add(statusKey(f.submodule ? "submodule" : f.untracked ? "untracked" : "unstaged", f));
      for (const key of [...selectedStatus]) if (!live.has(key)) selectedStatus.delete(key);
      if (lastSelectedStatusKey && !live.has(lastSelectedStatusKey)) lastSelectedStatusKey = null;
    }

    async function selectFile(file, source, diffNode) {
      state.selectedFile = file ? `${source}:${file.path}` : null;
      lastDiffPath = file?.path;
      lastDiffSource = source;
      document.querySelectorAll('.pane[data-pane="status"] .diff-tree-file').forEach((row) => {
        row.classList.toggle("is-active", row.dataset.key === state.selectedFile);
      });
      if (!file) {
        diffNode.innerHTML = '<div class="status-diff-empty">Select a file to preview the diff.</div>';
        return;
      }
      const cacheKey = source + ":" + file.path;
      const cached = diffCache.get(cacheKey);
      if (cached) { renderDiffInto(diffNode, cached, source, file.path); return; }
      diffNode.innerHTML = '<div class="status-diff-empty"><span class="spinner"></span></div>';
      const parsed = await loadDiff(file, source);
      // If user clicked something else while we were loading, drop this result.
      if (lastDiffPath !== file.path || lastDiffSource !== source) return;
      diffCache.set(cacheKey, parsed);
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

    const stage = (p, submodule) => withRefresh(async () => {
      if (submodule) {
        const inner = await git("-C " + quote(p) + " add -A");
        if (inner.code !== 0) return inner;
      }
      return git("add -- " + quote(p));
    }, submodule ? "Staged submodule changes" : null);
    const stageAll  = () => withRefresh(async () => {
      const r = await git("add -A");
      if (r.code !== 0) return r;
      for (const f of state.statusFiles.unstaged) {
        if (!f.submodule) continue;
        const inner = await git("-C " + quote(f.path) + " add -A");
        if (inner.code !== 0) return inner;
      }
      return { code: 0 };
    }, "Staged all changes");
    async function unstage(p, submodule) {
      if (submodule) await git("-C " + quote(p) + " restore --staged .");
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
      if (file.untracked) {
        await deleteUntracked(file);
        return;
      }
      const ok = await ui.confirm({
        title: "Discard changes?",
        body: `This will permanently revert ${file.path}. There's no undo for unstaged work.`,
        danger: true, okLabel: "Discard",
      });
      if (!ok) return;
      if (file.submodule) {
        let r = await git("-C " + quote(file.path) + " restore --staged --worktree .");
        if (r.code !== 0) { ui.toast(r.stderr || "Discard failed", "error", 5000); await refresh(); return; }
        r = await git("-C " + quote(file.path) + " clean -fd");
        if (r.code !== 0) { ui.toast(r.stderr || "Clean failed", "error", 5000); await refresh(); return; }
        r = await git("submodule update --checkout -- " + quote(file.path));
        if (r.code !== 0) { ui.toast(r.stderr || "Submodule reset failed", "error", 5000); await refresh(); return; }
        ui.toast("Discarded submodule changes", "success");
        await refresh();
        return;
      }
      let r = await git("restore -- " + quote(file.path));
      if (r.code !== 0) r = await git("checkout -- " + quote(file.path));
      if (r.code !== 0) { ui.toast(r.stderr || "Discard failed", "error", 5000); await refresh(); return; }
      ui.toast("Discarded changes", "success");
      await refresh();
    }

    async function discardStatusEntries(entries, label) {
      if (!entries.length) return;
      const ok = await ui.confirm({
        title: "Discard " + label + "?",
        body: `Permanently discard ${entries.length} selected item${entries.length === 1 ? "" : "s"}. Untracked files/folders will be deleted from disk. There's no undo.`,
        danger: true,
        okLabel: "Discard",
      });
      if (!ok) return;

      let fail = 0;
      const seen = new Set();
      for (const entry of entries) {
        const file = entry.file;
        const path = String(file.path || "");
        const dedupeKey = entry.source + ":" + path;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        let r = { code: 0 };
        if (file.untracked || entry.source === "untracked") {
          const target = path.replace(/\/+$/, "") || path;
          r = await sh("rm -rf -- " + quote(target));
        } else if (file.submodule || entry.source === "submodule") {
          r = await git("-C " + quote(path) + " restore --staged --worktree .");
          if (r.code === 0) r = await git("-C " + quote(path) + " clean -fd");
          if (r.code === 0) r = await git("submodule update --checkout -- " + quote(path));
        } else if (entry.source === "staged") {
          r = await git("restore --staged --worktree -- " + quote(path));
          if (r.code !== 0) r = await git("checkout HEAD -- " + quote(path));
        } else {
          r = await git("restore -- " + quote(path));
          if (r.code !== 0) r = await git("checkout -- " + quote(path));
        }
        if (r.code !== 0) fail++;
      }
      selectedStatus.clear();
      ui.toast(fail ? `Done — ${fail} discard(s) failed` : "Discarded " + label, fail ? "error" : "success", fail ? 5000 : 2400);
      await refresh();
    }

    function statusEntriesFrom(status, keys) {
      const out = [];
      const wanted = keys ? new Set(keys) : null;
      const add = (source, file) => {
        const key = statusKey(source, file);
        if (!wanted || wanted.has(key)) out.push({ source, file });
      };
      for (const f of status.staged || []) add("staged", f);
      for (const f of status.unstaged || []) add(f.submodule ? "submodule" : f.untracked ? "untracked" : "unstaged", f);
      return out;
    }

    function applyStatusSelection(key, event, visibleKeys) {
      const multi = event && (event.metaKey || event.ctrlKey);
      const range = event && event.shiftKey && lastSelectedStatusKey && visibleKeys.includes(lastSelectedStatusKey);
      if (range) {
        const a = visibleKeys.indexOf(lastSelectedStatusKey);
        const b = visibleKeys.indexOf(key);
        if (b !== -1) {
          const lo = Math.min(a, b), hi = Math.max(a, b);
          for (let i = lo; i <= hi; i++) selectedStatus.add(visibleKeys[i]);
        }
      } else if (multi) {
        if (selectedStatus.has(key)) selectedStatus.delete(key);
        else selectedStatus.add(key);
        lastSelectedStatusKey = key;
      } else {
        selectedStatus.clear();
        selectedStatus.add(key);
        lastSelectedStatusKey = key;
      }
    }

    function toggleFolderSelection(files, sourceFor, event, visibleKeys) {
      const keys = files.map((f) => statusKey(sourceFor(f), f));
      if (!keys.length) return;
      if (event && event.shiftKey && lastSelectedStatusKey && visibleKeys.includes(lastSelectedStatusKey)) {
        const target = keys[keys.length - 1];
        applyStatusSelection(target, event, visibleKeys);
        return;
      }
      const allSelected = keys.every((k) => selectedStatus.has(k));
      for (const key of keys) {
        if (allSelected) selectedStatus.delete(key);
        else selectedStatus.add(key);
      }
      lastSelectedStatusKey = keys[keys.length - 1];
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
    /** Build a Status-flavoured tree row's inner content (icon, status letter, name, actions). */
    function statusTreeRow(file, source, diffNode, filter) {
      const isStaged = source === "staged";
      const isSubmodule = source === "submodule";
      const statusText = file.untracked ? "new" : file.code;
      const statusTitle = file.submodule
        ? "Submodule: " + (file.submoduleSummary || "dirty")
        : file.untracked ? "Untracked" : "";
      return [
        gmFileIcon(file.path),
        h("span", { class: "file-status status-" + gmStatusClass(file.code), title: statusTitle }, statusText),
        h("span", { class: "file-name", title: file.path,
          html: window.GMText.highlightMatches(file._name || file.path.split("/").pop(), filter || "") }),
        h("span", { class: "row-actions" },
          isStaged
            ? h("button", { class: "row-action", onClick: (e) => { e.stopPropagation(); unstage(file.path, file.submodule); } }, "unstage")
            : h("button", { class: "row-action", onClick: (e) => { e.stopPropagation(); stage(file.path, file.submodule); } }, isSubmodule ? "stage all" : "stage"),
          !isStaged && h("button", { class: "row-action danger", onClick: (e) => { e.stopPropagation(); discard(file); } }, "discard"),
        ),
      ];
    }

    async function render(opts) {
      // refresh() and every mutating action pass { force:true } — that's our
      // signal the working tree may have changed, so drop the cached status/diffs.
      if (opts && opts.force) invalidateStatus();
      const node = pane();
      node.innerHTML = "";
      node.className = "pane is-active status-pane";

      const status = await loadStatus();
      if (status.err) {
        node.append(h("div", { class: "empty" }, h("p", { class: "empty-title" }, "Could not read status"), h("p", { class: "empty-sub" }, status.err)));
        return;
      }
      state.statusFiles = { staged: status.staged, unstaged: status.unstaged };
      pruneStatusSelection(status);
      paintTopBar();

      const filter = state.fileFilter.toLowerCase();
      const match = (f) => !filter || f.path.toLowerCase().includes(filter);
      const staged = status.staged.filter(match);
      const unstaged = status.unstaged.filter(match);
      const visibleStatusKeys = [
        ...staged.map((f) => statusKey("staged", f)),
        ...unstaged.map((f) => statusKey(f.submodule ? "submodule" : f.untracked ? "untracked" : "unstaged", f)),
      ];

      // ─── Toolbar ──────────────────────────────────────────────────────
      const filterInput = h("input", {
        class: "status-filter",
        placeholder: "Filter files…",
        value: state.fileFilter,
        onInput: (e) => { caretPos = e.target.selectionStart; state.fileFilter = e.target.value; render(); },
      });
      const toolbar = h("div", { class: "status-toolbar" },
        filterInput,
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
      if (selectedStatus.size > 0) {
        node.append(h("div", { class: "bulk-bar status-bulk-bar" },
          h("span", { class: "bulk-count" }, selectedStatus.size + " selected"),
          h("div", { class: "toolbar-spacer" }),
          h("button", { class: "btn-mini", onClick: () => { selectedStatus.clear(); render(); } }, "Clear"),
          h("button", { class: "btn-mini danger", onClick: () => discardStatusEntries(statusEntriesFrom(status, selectedStatus), "selected changes") }, "Discard selected"),
        ));
      }
      // Restore the caret in the file filter after this render recreated it.
      if (caretPos != null) { filterInput.focus(); try { filterInput.setSelectionRange(caretPos, caretPos); } catch (_) {} caretPos = null; }

      // ─── Split (file list ↔ diff) ────────────────────────────────────
      const diffNode = h("div", { class: "status-diff" });
      diffNode.innerHTML = '<div class="status-diff-empty">Select a file to preview the diff.</div>';

      const list = h("div", { class: "status-list" });

      function appendSection(label, items, sourceFor, actions) {
        list.append(h("div", { class: "file-section-title" },
          h("span", null, label),
          h("span", { class: "count" }, String(items.length)),
          h("span", { class: "section-actions" }, ...(actions || [])),
        ));
        if (items.length === 0) {
          list.append(h("div", { class: "empty-files" },
            label === "Staged" ? "Nothing staged"
              : status.unstaged.length === 0 ? "Working tree clean" : "Nothing matches filter"));
          return;
        }
        gmRenderFileTree(list, items, {
          keyFor: (f) => `${sourceFor(f)}:${f.path}`,
          rowClassFor: (f) => {
            const key = statusKey(sourceFor(f), f);
            return (selectedStatus.has(key) ? "is-selected " : "") + (state.selectedFile === key ? "is-active" : "");
          },
          onDirPick: (files, _row, e) => {
            toggleFolderSelection(files, sourceFor, e, visibleStatusKeys);
            render();
          },
          renderRow: (f, _depth) => statusTreeRow(f, sourceFor(f), diffNode, filter),
          onPick: (f, row, e) => {
            const source = sourceFor(f);
            const key = `${source}:${f.path}`;
            applyStatusSelection(key, e, visibleStatusKeys);
            state.selectedFile = key;
            render();
          },
        });
      }

      appendSection("Staged", staged, () => "staged", [
        h("button", { class: "act-all", onClick: unstageAll, disabled: staged.length === 0 }, "Unstage all"),
      ]);
      appendSection("Changes", unstaged, (f) => f.submodule ? "submodule" : f.untracked ? "untracked" : "unstaged", [
        h("button", { class: "act-all", onClick: stageAll, disabled: unstaged.length === 0 }, "Stage all"),
        h("button", { class: "act-all danger", onClick: () => discardStatusEntries(statusEntriesFrom({ staged: [], unstaged: status.unstaged }), "all changes"), disabled: status.unstaged.length === 0 }, "Discard all"),
      ]);

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
    const selected = new Set(); // branch names ticked for bulk delete
    let facet = "all";          // local-branch facet: all|merged|unmerged|local-only|on-remote
    let loaded = false;

    async function loadBranches() {
      const sep = "\x1f";
      const r = await git("branch -a --format=" + quote("%(HEAD)" + sep + "%(refname:short)" + sep + "%(upstream:short)" + sep + "%(upstream:track)" + sep + "%(objectname:short)" + sep + "%(committerdate:relative)" + sep + "%(contents:subject)"));
      if (r.code !== 0) return { local: [], remote: [] };
      // Which local branches are already merged into the current HEAD —
      // safe to delete. `git branch --merged` lists them (current branch
      // is prefixed with "*").
      const mergedR = await git("branch --merged");
      const merged = new Set(
        mergedR.code === 0
          ? mergedR.stdout.split("\n").map((s) => s.replace(/^[*+]?\s*/, "").trim()).filter(Boolean)
          : []
      );
      const all = r.stdout.split("\n").filter(Boolean).map((line) => {
        const [head, name, upstream, track, sha, when, subject] = line.split(sep);
        return {
          isCurrent: head === "*",
          name, upstream: upstream || null, track: track || "", sha,
          when: when || "", subject: subject || "",
          isRemote: name.startsWith("remotes/"),
          merged: merged.has(name),
        };
      });
      // Content-identical-to-HEAD detection. Two refs hold identical working
      // content iff their tree objects match — independent of commit history.
      // One `rev-parse` resolves HEAD's tree plus every branch's tree in a
      // single call (O(1) git invocations, not one diff per branch), so a
      // branch whose tree equals HEAD's carries nothing HEAD lacks: deleting
      // it loses no work even when `git branch --merged` calls it unmerged
      // (divergent history that happens to land on the same tree). This is a
      // strictly stronger signal than `merged` (which is ancestry-based and
      // still true for branches sitting *behind* a moved-on HEAD).
      const treeRefs = all.filter((b) => !b.name.endsWith("/HEAD"));
      if (treeRefs.length) {
        const args = ["HEAD^{tree}"].concat(treeRefs.map((b) => b.name + "^{tree}"));
        const tr = await git("rev-parse " + args.map(quote).join(" "));
        if (tr.code === 0) {
          const trees = tr.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
          const headTree = trees[0];
          // rev-parse emits one line per arg in order; trees[i+1] ↔ treeRefs[i].
          if (headTree && trees.length === treeRefs.length + 1) {
            treeRefs.forEach((b, i) => { b.identical = trees[i + 1] === headTree; });
          }
        }
      }
      const localList = all.filter((b) => !b.isRemote);
      const remoteList = all.filter((b) => b.isRemote && !b.name.endsWith("/HEAD"));
      // Short names that exist on a remote (strip "remotes/<remote>/"), so we
      // can flag which local branches are also published vs. local-only.
      const remoteShort = new Set(remoteList.map((b) => b.name.split("/").slice(2).join("/")));
      for (const b of localList) b.hasRemote = remoteShort.has(b.name);
      return { local: localList, remote: remoteList };
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

    // Parse a remotes/<remote>/<branch...> ref into its remote + branch parts.
    function remoteParts(name) {
      const parts = name.split("/"); // ["remotes", "<remote>", ...branch]
      return { remote: parts[1], branch: parts.slice(2).join("/") };
    }

    async function deleteRemoteBranch(b) {
      const { remote, branch } = remoteParts(b.name);
      const ok = await ui.confirm({
        title: "Delete remote branch?",
        body: `Run \`git push --delete ${remote} ${branch}\`. This removes the branch on ${remote} — collaborators may still have it locally.`,
        danger: true, okLabel: "Delete remote",
      });
      if (!ok) return;
      const r = await sh("git push --delete " + quote(remote) + " " + quote(branch), { timeout: 60000 });
      if (r.code === 0) { ui.toast("Removed " + branch + " from " + remote, "success"); await refresh(); }
      else ui.toast(r.stderr || "Remote delete failed", "error", 5000);
    }

    // Bulk delete every ticked branch. Locals go through `branch -d` with a
    // single follow-up force prompt for any that weren't fully merged; remotes
    // go through `push --delete`. One confirm up front covers the whole set.
    async function deleteSelected() {
      const names = [...selected];
      if (!names.length) return;
      const locals = names.filter((n) => !n.startsWith("remotes/"));
      const remotes = names.filter((n) => n.startsWith("remotes/"));
      const lines = [];
      if (locals.length) lines.push("Local: " + locals.join(", "));
      if (remotes.length) lines.push("Remote: " + remotes.map((n) => { const p = remoteParts(n); return p.remote + "/" + p.branch; }).join(", "));
      const ok = await ui.confirm({
        title: `Delete ${names.length} branch${names.length > 1 ? "es" : ""}?`,
        body: lines.join(" · ") + ". Unmerged local branches will ask before force-deleting.",
        danger: true, okLabel: "Delete",
      });
      if (!ok) return;
      const unmerged = [];
      for (const n of locals) {
        const r = await git("branch -d " + quote(n));
        if (r.code !== 0) unmerged.push(n);
      }
      if (unmerged.length) {
        const force = await ui.confirm({
          title: "Force delete unmerged?",
          body: `Not fully merged: ${unmerged.join(", ")}. Force-deleting drops their unmerged commits.`,
          danger: true, okLabel: "Force delete",
        });
        if (force) for (const n of unmerged) await git("branch -D " + quote(n));
      }
      let remoteFail = 0;
      for (const n of remotes) {
        const { remote, branch } = remoteParts(n);
        const r = await sh("git push --delete " + quote(remote) + " " + quote(branch), { timeout: 60000 });
        if (r.code !== 0) remoteFail++;
      }
      selected.clear();
      ui.toast(remoteFail ? `Done — ${remoteFail} remote delete(s) failed` : "Deleted selected branches", remoteFail ? "error" : "success");
      await refresh();
    }

    // Read-only preview of how a branch differs from HEAD. Default direction
    // is three-dot `HEAD...<branch>` — what the branch carries relative to
    // the merge base. If that's empty (e.g. the branch was created from main,
    // never updated, and main moved forward — branch is "unmerged" per
    // `git branch --merged` but has no own work), fall back to a two-arg
    // `<branch> HEAD` diff so the user still sees what HEAD has that the
    // branch doesn't. Only when BOTH directions are empty is the branch truly
    // identical to HEAD.
    async function diffBranch(b) {
      // Double-click guard via showLoading — bail if a modal is already up.
      if (!ui.showLoading("Diffing " + b.name + "…")) return;
      const ref = b.name;
      let direction = "branch-side";

      const fetchFiles = async ({ ignoreWhitespace, context } = { ignoreWhitespace: false, context: 3 }) => {
        const flags = (ignoreWhitespace ? " -w" : "") + " -U" + context;
        const cmd = direction === "head-side"
          ? "diff " + quote(ref) + " HEAD --no-color" + flags
          : "diff HEAD..." + quote(ref) + " --no-color" + flags;
        const r = await git(cmd);
        if (r.code !== 0) throw new Error(r.stderr || "Diff failed");
        return gmParseDiffDoc(r.stdout);
      };

      try {
        let files = await fetchFiles();
        let title = "Branch diff: " + b.name;
        let subtitle = files.length + " files changed";

        if (!files.length) {
          // Three-dot empty — try the other direction.
          direction = "head-side";
          files = await fetchFiles();
          if (!files.length) {
            ui.hideLoading();
            // For branches the user already knows are merged (badge says so),
            // a long "identical to HEAD" toast is just noise. Short ack
            // instead. Truly-identical unmerged branches keep the longer
            // explanation because that case is less obvious.
            if (b.merged) ui.toast("Already merged.", "info", 2000);
            else ui.toast("Branch is identical to HEAD — nothing to diff.", "info", 4000);
            return;
          }
          title = "Branch diff: " + b.name + " (behind HEAD)";
          subtitle = files.length + " files HEAD carries that this branch doesn't";
        }

        await ui.diffModal({ title, subtitle, files, refetch: fetchFiles });
      } catch (err) {
        ui.hideLoading();
        ui.toast(err.message || "Diff failed", "error", 5000);
      }
    }

    // Load + initial paint. The search box lives here so it survives
    // re-paints; only the list region under it is rebuilt on keystrokes.
    async function render(opts) {
      const force = !!(opts && opts.force);
      const node = pane();
      node.innerHTML = "";
      node.className = "pane is-active branches-pane";

      const filterInput = h("input", {
        class: "history-search",
        placeholder: "Filter branches…",
        value: state.branchFilter,
        // Re-paint only the list — rebuilding this input on each keystroke
        // is what made the caret jump to the end.
        onInput: (e) => { state.branchFilter = e.target.value; paint(); },
      });
      const newInput = h("input", {
        class: "input branch-create-input",
        placeholder: "New branch name…",
        value: newBranchName,
        onInput: (e) => { newBranchName = e.target.value; },
        onKeydown: (e) => { if (e.key === "Enter") createBranch(); },
      });
      const top = h("div", { class: "branches-top" },
        filterInput,
        h("div", { class: "toolbar-spacer" }),
        newInput,
        h("button", { class: "btn-primary", onClick: createBranch, disabled: !newBranchName.trim() }, "Create"),
      );
      node.append(top);
      node.append(h("div", { class: "branches-list-wrap" }));

      if (!loaded || force) {
        const { local, remote } = await loadBranches();
        state.branches = { local, remote };
        loaded = true;
        // Drop ticks for branches that no longer exist (e.g. after a delete).
        const live = new Set([...local, ...remote].map((b) => b.name));
        for (const n of [...selected]) if (!live.has(n)) selected.delete(n);
      }
      paint();
    }

    function paint() {
      const wrap = pane() && pane().querySelector(".branches-list-wrap");
      if (!wrap) return;
      wrap.innerHTML = "";
      const { local, remote } = state.branches || { local: [], remote: [] };

      const f = state.branchFilter.toLowerCase();
      const match = (b) => !f || b.name.toLowerCase().includes(f);
      const hl = (s) => window.GMText.highlightMatches(s, f);
      const toggle = (name, on) => { if (on) selected.add(name); else selected.delete(name); paint(); };
      const branchSortKey = (b) => {
        if (b.isCurrent) return "0:";
        if (b.name === "main") return "1:";
        if (b.name === "master") return "2:";
        return "3:" + b.name.toLowerCase();
      };
      const sortBranches = (items) => items.slice().sort((a, b) => branchSortKey(a).localeCompare(branchSortKey(b)));

      // Local-branch facet predicate (chips below the search box).
      const facetMatch = (b) => {
        switch (facet) {
          case "identical": return b.identical;
          case "merged": return b.merged;
          case "unmerged": return !b.merged;
          case "local-only": return !b.hasRemote;
          case "on-remote": return b.hasRemote;
          default: return true;
        }
      };

      // Sync state badge (ahead/behind/gone), only meaningful with an upstream.
      function trackBadge(b) {
        if (!b.upstream) return null;
        const t = b.track || "";
        if (/gone/.test(t)) return h("span", { class: "branch-tag is-gone" }, "upstream gone");
        const ahead = (t.match(/ahead (\d+)/) || [])[1];
        const behind = (t.match(/behind (\d+)/) || [])[1];
        if (!ahead && !behind) return h("span", { class: "branch-tag is-synced" }, "up to date");
        return h("span", { class: "branch-tag is-diverged" },
          ahead ? "↑" + ahead : "", behind ? " ↓" + behind : "");
      }

      // Does this local branch also exist on a remote?
      function remoteBadge(b) {
        return b.hasRemote
          ? h("span", { class: "branch-tag is-onremote" }, "on remote")
          : h("span", { class: "branch-tag is-local" }, "local-only");
      }

      function mergeBadge(b) {
        if (b.isCurrent) return null;
        // "identical" is the strongest safe-to-delete signal: same tree as
        // HEAD, so deleting loses nothing. Show it instead of merged/unmerged
        // (it can be true even when `git branch --merged` reports unmerged).
        if (b.identical) {
          return h("span", {
            class: "branch-tag is-identical",
            title: "Same content as HEAD — safe to delete (no unique work).",
          }, "identical to HEAD");
        }
        return b.merged
          ? h("span", { class: "branch-tag is-merged", title: "Merged into HEAD — safe to delete." }, "merged")
          : h("span", { class: "branch-tag is-unmerged", title: "Has commits not in HEAD — delete needs force." }, "unmerged");
      }

      function branchRow(b, opts) {
        // Column 1 is now a single shared slot: green dot if this is the current
        // branch, otherwise a checkbox (or a transparent spacer for unselectable
        // non-current rows). Earlier versions kept two side-by-side 16px columns,
        // which left the dot visually unaligned with the checkbox column.
        let lead;
        if (b.isCurrent) {
          lead = h("span", { class: "branch-marker" }, "●");
        } else if (opts.selectable) {
          lead = h("input", { type: "checkbox", class: "branch-check",
            checked: selected.has(b.name),
            onChange: (e) => { e.stopPropagation(); toggle(b.name, e.target.checked); },
            onClick: (e) => e.stopPropagation() });
        } else {
          lead = h("span", { class: "branch-check-spacer" });
        }
        // Whole row is clickable to open the diff (mirrors stash row UX).
        // Checkbox and action buttons stop propagation so they don't also
        // fire the row click. Current branch has no diff target — no row
        // onClick there.
        return h("div", {
          class: "branch-row" + (b.isCurrent ? " is-current" : "") + (selected.has(b.name) ? " is-checked" : "") + (opts.onActivate ? " is-clickable" : ""),
          onClick: opts.onActivate ? () => opts.onActivate(b) : undefined,
        },
          lead,
          h("div", { class: "branch-main" },
            h("div", { class: "branch-line" },
              h("span", { class: "branch-name", title: b.name, html: hl(b.name) }),
              opts.tags,
            ),
            h("div", { class: "branch-sub" },
              h("span", { class: "branch-sha" }, b.sha),
              b.when && h("span", { class: "branch-when" }, b.when),
              b.subject && h("span", { class: "branch-subject", title: b.subject }, b.subject),
            ),
          ),
          h("span", { class: "branch-actions", onClick: (e) => e.stopPropagation() }, ...opts.actions),
        );
      }

      // Facet chips: quick filter over local branches by merge/publish state.
      const facetDefs = [
        { key: "all", label: "All", n: local.length },
        { key: "identical", label: "Identical", n: local.filter((b) => b.identical).length },
        { key: "merged", label: "Merged", n: local.filter((b) => b.merged).length },
        { key: "unmerged", label: "Unmerged", n: local.filter((b) => !b.merged).length },
        { key: "local-only", label: "Local-only", n: local.filter((b) => !b.hasRemote).length },
        { key: "on-remote", label: "On remote", n: local.filter((b) => b.hasRemote).length },
      ];
      wrap.append(h("div", { class: "branch-facets" },
        ...facetDefs.map((d) => h("button", {
          class: "facet-chip" + (facet === d.key ? " is-active" : ""),
          onClick: () => { facet = d.key; paint(); },
        }, d.label, h("span", { class: "facet-n" }, String(d.n)))),
      ));

      // Bulk-action bar appears only while something is ticked.
      if (selected.size > 0) {
        wrap.append(h("div", { class: "bulk-bar" },
          h("span", { class: "bulk-count" }, selected.size + " selected"),
          h("div", { style: { flex: "1" } }),
          h("button", { class: "btn-mini", onClick: () => { selected.clear(); paint(); } }, "Clear"),
          h("button", { class: "btn-mini danger", onClick: deleteSelected }, "Delete selected"),
        ));
      }

      const list = h("div", { class: "branches-list" });

      const filteredLocal = sortBranches(local.filter((b) => match(b) && facetMatch(b)));
      list.append(h("div", { class: "branch-section-title" }, "Local", h("span", { class: "count" }, String(filteredLocal.length))));
      if (filteredLocal.length === 0) list.append(h("div", { class: "empty-files" }, "No matching local branches"));
      for (const b of filteredLocal) {
        list.append(branchRow(b, {
          selectable: !b.isCurrent,
          onActivate: !b.isCurrent ? diffBranch : null,
          tags: h("span", { class: "branch-tags" }, mergeBadge(b), remoteBadge(b), trackBadge(b)),
          actions: [
            !b.isCurrent && h("button", { class: "btn-mini", onClick: () => checkout(b) }, "Switch"),
            !b.isCurrent && h("button", { class: "btn-mini danger", onClick: () => deleteBranch(b.name) }, "Delete"),
          ].filter(Boolean),
        }));
      }

      // Facets describe local branches only — hide remotes when one is active.
      const filteredRemote = facet === "all" ? sortBranches(remote.filter(match)) : [];
      if (filteredRemote.length > 0) {
        list.append(h("div", { class: "branch-section-title" }, "Remote", h("span", { class: "count" }, String(filteredRemote.length))));
        for (const b of filteredRemote) {
          list.append(branchRow(b, {
            selectable: true,
            onActivate: diffBranch,
            tags: null,
            actions: [
              h("button", { class: "btn-mini", onClick: () => checkout(b) }, "Check out"),
              h("button", { class: "btn-mini danger", onClick: () => deleteRemoteBranch(b) }, "Delete remote"),
            ],
          }));
        }
      }

      if (filteredLocal.length === 0 && filteredRemote.length === 0 && state.branchFilter) {
        list.append(h("div", { class: "empty-files" }, "No branches match “" + state.branchFilter + "”."));
      }

      wrap.append(list);
    }

    return { render, invalidate: () => { loaded = false; } };
  })();

  // ── Sync tab ─────────────────────────────────────────────────────────────
  const syncTab = (() => {
    const pane = () => document.querySelector('.pane[data-pane="sync"]');
    let running = null; // action name currently running, for visual feedback
    let newRemoteName = "";
    let newRemoteUrl = "";
    let remotesLoaded = false;

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
        remotesLoaded = false;
        await render({ force: true });
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
      remotesLoaded = false;
      await render({ force: true });
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
      if (r.code === 0) { ui.toast("Renamed", "success"); remotesLoaded = false; await render({ force: true }); }
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
      if (r.code === 0) { ui.toast("URL updated", "success"); remotesLoaded = false; await render({ force: true }); }
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

    async function render(opts) {
      const force = !!(opts && opts.force);
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
      if (!remotesLoaded || force) {
        state.remotes = await loadRemotes();
        remotesLoaded = true;
      }
      const remotes = state.remotes || [];
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
              h("button", { class: "btn-mini",        onClick: () => setRemoteUrl(r.name, r.fetchUrl) }, "Edit URL"),
              h("button", { class: "btn-mini",        onClick: () => renameRemote(r.name)             }, "Rename"),
              h("button", { class: "btn-mini danger", onClick: () => removeRemote(r.name)             }, "Remove"),
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

    return { render, invalidate: () => { remotesLoaded = false; } };
  })();

  // ── History tab ──────────────────────────────────────────────────────────
  const historyTab = (() => {
    const pane = () => document.querySelector('.pane[data-pane="history"]');
    let caretPos = null; // caret offset to restore after a search re-render
    let lastFiles = []; // parsed files of the most-recently-rendered commit (used by Tasks 17/18)
    let logCache = new Map(); // filter string -> commits
    let detailCache = new Map(); // short sha -> rendered detail data

    function openInViewer(commit, files) {
      if (!files || !files.length) { ui.toast("No diff to show", "info"); return; }
      // Double-click guard. We already have `files` in hand from the inline
      // detail render, but the modal-level guard is what prevents two opens
      // — call showLoading purely to occupy the slot, then immediately swap
      // in via diffModal (no visible skeleton time since files are ready).
      if (!ui.showLoading("Opening viewer…")) return;
      const fetchFiles = async ({ ignoreWhitespace, context } = { ignoreWhitespace: false, context: 3 }) => {
        const flags = (ignoreWhitespace ? " -w" : "") + " -U" + context;
        const r = await git("show --no-color --format= -p" + flags + " " + quote(commit.sha));
        if (r.code !== 0) throw new Error(r.stderr || "git show failed");
        return gmParseDiffDoc(r.stdout);
      };
      ui.diffModal({
        title: commit.msg,
        subtitle: commit.sha + " · " + commit.author + " · " + commit.when,
        files,
        refetch: fetchFiles,
      });
    }

    async function loadLog(filter) {
      const sep = "\x1f";
      const grep = filter ? " --grep=" + quote(filter) + " -i" : "";
      const r = await git("log --no-color" + grep + " --pretty=format:" + quote("%h" + sep + "%s" + sep + "%an" + sep + "%ar" + sep + "%H" + sep + "%p") + " -n 100");
      if (r.code !== 0) return [];
      return r.stdout.split("\n").filter(Boolean).map((line) => {
        const [sha, msg, author, when, fullSha, parents] = line.split(sep);
        return { sha, msg, author, when, fullSha, parents: (parents || "").trim() };
      });
    }

    async function loadCommitDetail(commit) {
      if (detailCache.has(commit.sha)) return detailCache.get(commit.sha);
      // Parallel fetches — body, absolute timestamp, and the patch itself.
      const [bodyRes, absRes, showRes] = await Promise.all([
        git("show -s --format=%b " + quote(commit.sha)),
        git("show -s --format=%ai " + quote(commit.sha)),
        git("show --no-color --format= -p " + quote(commit.sha)),
      ]);
      const detail = {
        bodyText: (bodyRes.code === 0 ? bodyRes.stdout : "").trimEnd(),
        absDate: (absRes.code === 0 ? absRes.stdout : "").trim(),
        files: gmParseDiffDoc(showRes.stdout),
      };
      detailCache.set(commit.sha, detail);
      return detail;
    }

    function paintCommitDetail(detailNode, commit, detail) {
      detailNode.innerHTML = "";

      // ── Card ─────────────────────────────────────────────────────────
      const subject = h("div", { class: "subject" }, commit.msg);
      const card = h("div", { class: "commit-card" }, subject);

      if (detail.bodyText) card.append(h("div", { class: "body" }, detail.bodyText));

      card.append(h("div", { class: "sep" }));

      card.append(h("div", { class: "meta" },
        h("span", null, commit.author),
        h("span", null, "·"),
        h("span", { title: detail.absDate }, commit.when),
      ));

      const parents = (commit.parents || "").split(/\s+/).filter(Boolean);
      const shaPill = h("span", { class: "commit-sha-pill" }, commit.sha);
      const copyBtn = h("button", { class: "row-action", title: "Copy full SHA",
        onClick: async (e) => {
          e.stopPropagation();
          try { await navigator.clipboard.writeText(commit.fullSha); ui.toast("Copied SHA", "success", 1200); }
          catch (_) { ui.toast("Copy failed", "error"); }
        } }, "copy");
      const pillRow = h("div", { class: "pill-row" }, shaPill, copyBtn);
      for (const p of parents) {
        pillRow.append(h("span", { class: "parent-label" }, "parent:"));
        pillRow.append(h("span", { class: "commit-sha-pill" }, p));
      }
      lastFiles = detail.files;
      const viewerBtn = h("button", { class: "btn-mini",
        onClick: (e) => { e.stopPropagation(); openInViewer(commit, detail.files); } },
        "Open in viewer ↗");
      pillRow.append(viewerBtn);
      card.append(pillRow);

      detailNode.append(card);

      // ── Diff + stat strip ────────────────────────────────────────────
      const files = detail.files;
      const totals = files.reduce((acc, f) => {
        const s = gmFileStats(f); acc.add += s.add; acc.del += s.del; return acc;
      }, { add: 0, del: 0 });
      const total = totals.add + totals.del || 1;
      const addPct = (totals.add / total) * 100;
      detailNode.append(h("div", { class: "commit-stat-strip" },
        h("span", { class: "stat-files" }, files.length + " file" + (files.length === 1 ? "" : "s") + " changed"),
        h("span", { class: "stat-sep" }, "·"),
        h("span", { class: "stat-add" }, "+" + totals.add),
        h("span", { class: "stat-sep" }, "/"),
        h("span", { class: "stat-del" }, "−" + totals.del),
        h("span", { class: "stat-bar" },
          h("span", { class: "stat-bar-add", style: { width: addPct + "%" } }),
          h("span", { class: "stat-bar-del", style: { width: (100 - addPct) + "%" } }),
        ),
      ));

      const diffWrap = h("div", { class: "commit-diff" });
      detailNode.append(diffWrap);
      gmRenderDiffDoc(diffWrap, files);
    }

    async function renderDetail(detailNode, commit) {
      if (detailCache.has(commit.sha)) {
        paintCommitDetail(detailNode, commit, detailCache.get(commit.sha));
        return;
      }
      detailNode.innerHTML = "";

      // Skeleton — structure matches the real layout so the swap doesn't jump.
      detailNode.append(h("div", { class: "commit-card skel-card" },
        h("div", { class: "skel skel-line skel-subject" }),
        h("div", { class: "skel skel-line skel-body" }),
        h("div", { class: "sep" }),
        h("div", { class: "skel skel-line skel-meta" }),
        h("div", { class: "pill-row" },
          h("div", { class: "skel skel-pill" }),
          h("div", { class: "skel skel-pill" }),
        ),
      ));
      detailNode.append(h("div", { class: "commit-stat-strip skel-strip" },
        h("div", { class: "skel skel-line skel-strip-text" }),
        h("div", { class: "skel skel-bar" }),
      ));
      for (let i = 0; i < 5; i++) {
        detailNode.append(h("div", { class: "skel skel-diff-line" }));
      }

      paintCommitDetail(detailNode, commit, await loadCommitDetail(commit));
    }

    async function render(opts) {
      const force = !!(opts && opts.force);
      const node = pane();
      node.innerHTML = "";
      node.className = "pane is-active history-pane";

      const search = h("input", {
        class: "history-search",
        placeholder: "Filter commits by message…",
        value: state.historyFilter,
        onInput: (e) => { caretPos = e.target.selectionStart; state.historyFilter = e.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(render, 250); },
      });
      node.append(h("div", { class: "history-top" }, search));
      // The re-render above recreates this input; put the caret back where the
      // user was typing instead of letting it snap to the end.
      if (caretPos != null) { search.focus(); try { search.setSelectionRange(caretPos, caretPos); } catch (_) {} caretPos = null; }

      const list = h("div", { class: "history-list" });
      const detail = h("div", { class: "history-detail" });
      detail.innerHTML = '<div class="history-detail-empty">Pick a commit to inspect.</div>';
      node.append(h("div", { class: "history-split" }, list, detail));

      const cacheKey = state.historyFilter || "";
      if (force) {
        logCache.clear();
        detailCache.clear();
      }
      let commits = logCache.get(cacheKey);
      if (!commits) {
        commits = await loadLog(state.historyFilter);
        logCache.set(cacheKey, commits);
      }
      state.log = commits;
      if (commits.length === 0) {
        list.append(h("div", { class: "empty-files" }, "No commits match"));
        return;
      }
      for (const c of commits) {
        const initial = (c.author || "?").trim().charAt(0).toUpperCase();
        const chip = h("span", { class: "author-chip",
          title: c.author,
          style: { background: gmAuthorChipColor(c.author || "") } }, initial);
        const row = h("div", {
          class: "log-row" + (state.selectedCommit === c.sha ? " is-selected" : ""),
          onClick: () => {
            state.selectedCommit = c.sha;
            document.querySelectorAll(".log-row").forEach((r) => r.classList.toggle("is-selected", r.dataset.sha === c.sha));
            renderDetail(detail, c);
          },
          dataset: { sha: c.sha },
        },
          chip,
          h("span", { class: "log-sha" }, c.sha),
          h("span", null,
            h("span", { class: "log-msg-line", title: c.msg, html: window.GMText.highlightMatches(c.msg, (state.historyFilter || "").toLowerCase()) }),
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
    return { render, invalidate: () => { logCache.clear(); detailCache.clear(); } };
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
      // Build todo: drop -> skipped; reword -> pick + exec amend with the
      // user-provided message. Other ops -> emitted as-is.
      const lines = [];
      for (const c of state.rebasePlan) {
        if (c.op === "drop") continue;
        if (c.op === "reword") {
          if (!c.newMsg || !c.newMsg.trim()) {
            ui.toast(`Commit ${c.sha} is marked reword but has no new message. Re-select to enter one.`, "error", 5000);
            return;
          }
          lines.push(`pick ${c.sha} ${c.msg}`);
          lines.push(`exec git commit --amend -m ${quote(c.newMsg.trim())}`);
        } else {
          lines.push(`${c.op} ${c.sha} ${c.msg}`);
        }
      }
      const todo = lines.join("\n");
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
        class: "input",
        placeholder: "HEAD~5, main, abc123…",
        value: state.rebaseTarget,
        onInput: (e) => { state.rebaseTarget = e.target.value; },
        onKeydown: (e) => { if (e.key === "Enter") buildPlan(); },
      });
      node.append(h("div", { class: "rebase-form" },
        h("label", { class: "rebase-form-label" }, "Rebase onto"),
        targetInput,
        h("button", { class: "btn-primary", onClick: buildPlan }, "Plan rebase"),
      ));

      if (state.rebasePlan.length === 0) {
        node.append(h("div", { class: "rebase-empty" },
          h("div", { class: "rebase-empty-title" }, "Interactive rebase"),
          h("p", { class: "empty-sub", style: { margin: "0 auto" } },
            "Enter a target ref above and press Plan rebase. Commits between it and HEAD appear here, where you can pick · squash · fixup · drop and reorder them before applying."),
        ));
        return;
      }

      const plan = h("div", { class: "rebase-plan" });
      for (let i = 0; i < state.rebasePlan.length; i++) {
        const c = state.rebasePlan[i];
        const prevOp = c.op;
        const sel = h("select", {
          class: "input rebase-op",
          onChange: async (e) => {
            const newOp = e.target.value;
            if (newOp === "reword") {
              const msg = await ui.input({
                title: "Reword commit " + c.sha,
                body: "Replaces the commit message during rebase. Original stays in the planning view above for reference.",
                placeholder: "New commit message",
                initial: c.newMsg || c.msg,
                okLabel: "Set message",
              });
              if (msg == null) {
                // Cancelled — revert select to previous op without re-render.
                e.target.value = prevOp;
                return;
              }
              c.newMsg = msg;
            }
            c.op = newOp;
            render();
          },
        });
        for (const op of ["pick", "reword", "squash", "fixup", "drop"]) {
          sel.append(h("option", { value: op, selected: c.op === op }, op));
        }
        const grip = h("span", { class: "grip", title: "Move up/down" },
          h("button", { class: "row-action", onClick: () => move(i, -1), disabled: i === 0 }, "↑"),
          h("button", { class: "row-action", onClick: () => move(i, +1), disabled: i === state.rebasePlan.length - 1 }, "↓"),
        );
        const msgCell = h("span", { class: "log-msg-line", title: c.msg }, c.msg);
        const row = h("div", { class: "rebase-todo-row" + (c.op === "drop" ? " is-drop" : ""), dataset: { op: c.op } },
          grip,
          sel,
          h("span", { class: "log-sha" }, c.sha),
          msgCell,
        );
        if (c.op === "reword" && c.newMsg) {
          msgCell.append(h("span", { class: "reword-preview" }, "→ " + c.newMsg));
        }
        plan.append(row);
      }
      node.append(plan);

      node.append(h("div", { class: "rebase-actions" },
        h("button", { class: "btn-primary", onClick: startRebase }, "Start rebase"),
        h("span", { class: "rebase-count" }, state.rebasePlan.filter((c) => c.op !== "drop").length + " of " + state.rebasePlan.length + " commits kept"),
        h("div", { style: { flex: "1" } }),
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
    const selectedRefs = new Set(); // stash refs ticked for bulk drop
    let loaded = false;

    async function loadStash() {
      const sep = "\x1f";
      const r = await git("stash list --pretty=format:" + quote("%gd" + sep + "%s" + sep + "%cr"));
      if (r.code !== 0) return [];
      return r.stdout.split("\n").filter(Boolean).map((line) => {
        const [ref, m, when] = line.split(sep);
        // "WIP on main: 9f39576 Subject" / "On main: custom message" →
        // pull out the branch and a clean description.
        const parsed = /^(?:WIP on|On) ([^:]+):\s*(.*)$/.exec(m || "");
        const branch = parsed ? parsed[1] : null;
        let desc = parsed ? parsed[2] : (m || "");
        // Auto WIP entries prefix the HEAD sha — drop it for readability.
        desc = desc.replace(/^[0-9a-f]{7,40}\s+/, "");
        return { ref, msg: m, branch, desc: desc || m, when: when || "" };
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
    async function show(s) {
      // showLoading returns false if a modal/loading is already up — that's
      // the double-click guard. Bail early so we don't queue a second fetch
      // behind the first.
      if (!ui.showLoading("Loading stash diff…")) return;
      const fetchFiles = async ({ ignoreWhitespace, context } = { ignoreWhitespace: false, context: 3 }) => {
        const flags = (ignoreWhitespace ? " -w" : "") + " -U" + context;
        const r = await git("stash show -p --no-color" + flags + " " + quote(s.ref));
        if (r.code !== 0) throw new Error(r.stderr || "Could not load stash diff");
        return gmParseDiffDoc(r.stdout);
      };
      try {
        const files = await fetchFiles();
        if (!files.length) {
          ui.hideLoading();
          ui.toast("Stash has no tracked changes to preview", "info");
          return;
        }
        // ui.diffModal sees loadingActive and swaps in over the skeleton.
        await ui.diffModal({
          title: s.ref + (s.branch ? " · on " + s.branch : ""),
          subtitle: s.desc || null,
          files,
          refetch: fetchFiles,
        });
      } catch (err) {
        ui.hideLoading();
        ui.toast(err.message || "Failed to load stash diff", "error", 5000);
      }
    }

    // Drop every ticked stash. Refs are positional (stash@{0}, stash@{1}…) and
    // reindex after each drop, so we drop highest-index-first to keep the
    // remaining refs valid mid-loop.
    async function dropSelected() {
      const refs = [...selectedRefs];
      if (!refs.length) return;
      const ok = await ui.confirm({
        title: `Drop ${refs.length} stash${refs.length > 1 ? "es" : ""}?`,
        body: `Permanently drop ${refs.join(", ")}. This can't be undone.`,
        danger: true, okLabel: "Drop",
      });
      if (!ok) return;
      const idx = (ref) => { const m = /stash@\{(\d+)\}/.exec(ref); return m ? Number(m[1]) : 0; };
      refs.sort((a, b) => idx(b) - idx(a));
      let fail = 0;
      for (const ref of refs) {
        const r = await git("stash drop " + quote(ref));
        if (r.code !== 0) fail++;
      }
      selectedRefs.clear();
      ui.toast(fail ? `Done — ${fail} drop(s) failed` : "Dropped selected stashes", fail ? "error" : "success");
      await refresh();
    }

    async function render(opts) {
      const force = !!(opts && opts.force);
      const node = pane();
      node.innerHTML = "";
      node.className = "pane is-active stash-pane";

      const msgInput = h("input", {
        class: "input stash-message-input",
        placeholder: "Stash message (optional)",
        value: msg,
        onInput: (e) => { msg = e.target.value; },
        onKeydown: (e) => { if (e.key === "Enter") save(); },
      });
      const untrackedChk = h("input", { type: "checkbox", checked: includeUntracked, onChange: (e) => { includeUntracked = e.target.checked; } });
      node.append(h("div", { class: "stash-top" },
        msgInput,
        h("label", { class: "toolbar-check" }, untrackedChk, "include untracked"),
        h("button", { class: "btn-primary", onClick: save }, "Stash"),
      ));

      node.append(h("div", { class: "stash-list-wrap" }));

      if (!loaded || force) {
        const stashes = await loadStash();
        state.stashes = stashes;
        state.stashCount = stashes.length;
        loaded = true;
        // Drop ticks for stashes that no longer exist.
        const live = new Set(stashes.map((s) => s.ref));
        for (const ref of [...selectedRefs]) if (!live.has(ref)) selectedRefs.delete(ref);
        paintTopBar();
      }
      paint();
    }

    function paint() {
      const wrap = pane() && pane().querySelector(".stash-list-wrap");
      if (!wrap) return;
      wrap.innerHTML = "";
      const stashes = state.stashes || [];
      const toggle = (ref, on) => { if (on) selectedRefs.add(ref); else selectedRefs.delete(ref); paint(); };

      if (selectedRefs.size > 0) {
        wrap.append(h("div", { class: "bulk-bar" },
          h("span", { class: "bulk-count" }, selectedRefs.size + " selected"),
          h("div", { style: { flex: "1" } }),
          h("button", { class: "btn-mini", onClick: () => { selectedRefs.clear(); paint(); } }, "Clear"),
          h("button", { class: "btn-mini danger", onClick: dropSelected }, "Drop selected"),
        ));
      }

      const list = h("div", { class: "stash-list" });
      if (stashes.length === 0) {
        list.append(h("div", { class: "empty-files" }, "No stashes"));
      } else {
        for (const s of stashes) {
          // Whole row is clickable to open the diff viewer. Children that have
          // their own click semantics (checkbox + action buttons) stop the event
          // from bubbling to the row. The "View" button is gone — the row IS the
          // viewer affordance.
          const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
          list.append(h("div", {
            class: "stash-row" + (selectedRefs.has(s.ref) ? " is-checked" : ""),
            onClick: () => show(s),
          },
            h("input", {
              type: "checkbox", class: "stash-check",
              checked: selectedRefs.has(s.ref),
              onChange: (e) => { e.stopPropagation(); toggle(s.ref, e.target.checked); },
              onClick: (e) => e.stopPropagation(),
            }),
            h("span", { class: "stash-idx" }, s.ref),
            h("div", { class: "stash-main" },
              h("div", { class: "stash-line" },
                h("span", { class: "stash-msg", title: s.msg }, s.desc),
              ),
              h("div", { class: "stash-sub" },
                s.branch && h("span", { class: "stash-branch" }, s.branch),
                s.when && h("span", { class: "stash-when" }, s.when),
              ),
            ),
            h("span", { class: "stash-actions" },
              h("button", { class: "btn-mini", onClick: stop(() => apply(s.ref)) }, "Apply"),
              h("button", { class: "btn-mini", onClick: stop(() => pop(s.ref)) }, "Pop"),
              h("button", { class: "btn-mini danger", onClick: stop(() => drop(s.ref)) }, "Drop"),
            ),
          ));
        }
      }
      wrap.append(list);
    }

    return { render, invalidate: () => { loaded = false; } };
  })();

  // ── Tags tab ─────────────────────────────────────────────────────────────
  const tagsTab = (() => {
    const pane = () => document.querySelector('.pane[data-pane="tags"]');
    let newName = "";
    let newMsg = "";
    let annotated = true;
    let filter = "";
    let caretPos = null; // caret offset to restore after a filter re-render
    let tags = [];
    let loaded = false;

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
        loaded = false;
        await render({ force: true });
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
      loaded = false;
      await render({ force: true });
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

    async function render(opts) {
      const force = !!(opts && opts.force);
      const node = pane();
      node.innerHTML = "";
      node.className = "pane is-active tags-pane";

      const nameInput = h("input", {
        class: "input tag-name-input",
        placeholder: "Tag name (e.g. v1.0.0)",
        value: newName,
        onInput: (e) => { newName = e.target.value; },
        onKeydown: (e) => { if (e.key === "Enter") create(); },
      });
      const msgInput = h("input", {
        class: "input tag-message-input",
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
        class: "history-search tag-filter-input",
        placeholder: "Filter…",
        value: filter,
        onInput: (e) => { caretPos = e.target.selectionStart; filter = e.target.value; render(); },
      });

      node.append(h("div", { class: "tags-top" },
        nameInput,
        msgInput,
        h("label", { class: "toolbar-check" }, annChk, "annotated"),
        h("button", { class: "btn-primary", onClick: create, disabled: !newName.trim() }, "Create"),
        h("div", { class: "toolbar-spacer" }),
        filterInput,
      ));
      // Keep the caret where the user was typing across the filter re-render.
      if (caretPos != null) { filterInput.focus(); try { filterInput.setSelectionRange(caretPos, caretPos); } catch (_) {} caretPos = null; }

      if (!loaded || force) {
        tags = await loadTags();
        loaded = true;
      }
      const f = filter.toLowerCase();
      const visible = f ? tags.filter((t) => t.name.toLowerCase().includes(f)) : tags;

      const list = h("div", { class: "tags-list" });
      if (visible.length === 0) {
        list.append(h("div", { class: "empty-files" }, tags.length === 0 ? "No tags" : "No tags match"));
      } else {
        for (const t of visible) {
          list.append(h("div", { class: "tag-row" },
            h("span", { class: "tag-name", title: t.name, html: window.GMText.highlightMatches(t.name, f) }),
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

    return { render, invalidate: () => { loaded = false; } };
  })();

  // ── PR tab (GitHub via gh CLI) ───────────────────────────────────────────
  const prTab = (() => {
    const pane = () => document.querySelector('.pane[data-pane="pr"]');
    let prs = [];
    let selected = null;     // selected PR number
    let creating = false;
    let newTitle = "", newBody = "";
    let baseBranch = null;   // repo default branch, cached
    let filter = "";
    let ghOk = null;         // cached once gh auth verified
    let listEl = null, detailEl = null; // live nodes for client-side re-paint
    let prsLoaded = false;
    let detailCache = new Map();

    function gh(args, opts) { return sh("gh " + args, opts || {}); }

    // Normalize one statusCheckRollup entry into {name, kind, url}.
    function checkInfo(c) {
      const name = c.name || c.context || "check";
      const concl = (c.conclusion || c.state || "").toUpperCase();
      const status = (c.status || "").toUpperCase();
      let kind;
      if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(concl)) kind = "fail";
      else if (concl === "SUCCESS") kind = "pass";
      else if (["NEUTRAL", "SKIPPED"].includes(concl)) kind = "skip";
      else if (status && status !== "COMPLETED") kind = "pending";
      else if (concl === "PENDING" || !concl) kind = "pending";
      else kind = "pass";
      return { name, kind, url: c.detailsUrl || c.targetUrl || "" };
    }

    // Roll a check list up to one overall {kind, label}.
    function rollup(checks) {
      if (!checks || !checks.length) return null;
      let fail = 0, pend = 0, pass = 0;
      for (const c of checks) {
        const k = checkInfo(c).kind;
        if (k === "fail") fail++; else if (k === "pending") pend++; else pass++;
      }
      if (fail) return { kind: "fail", label: fail + " failing" };
      if (pend) return { kind: "pending", label: pend + " pending" };
      return { kind: "pass", label: "checks passed" };
    }

    function reviewBadge(decision) {
      switch (decision) {
        case "APPROVED": return h("span", { class: "pr-tag is-approved" }, "approved");
        case "CHANGES_REQUESTED": return h("span", { class: "pr-tag is-changes" }, "changes requested");
        case "REVIEW_REQUIRED": return h("span", { class: "pr-tag is-review" }, "review required");
        default: return null;
      }
    }

    function checksBadge(checks) {
      const r = rollup(checks);
      if (!r) return null;
      return h("span", { class: "pr-tag is-check-" + r.kind }, r.label);
    }

    function relTime(iso) {
      if (!iso) return "";
      const then = new Date(iso).getTime();
      if (!then) return "";
      const s = Math.max(1, Math.round((Date.now() - then) / 1000));
      const u = [[31536000, "y"], [2592000, "mo"], [604800, "w"], [86400, "d"], [3600, "h"], [60, "m"]];
      for (const [secs, label] of u) if (s >= secs) return Math.floor(s / secs) + label + " ago";
      return s + "s ago";
    }

    async function probeGh() {
      const r = await gh("auth status");
      return r.code === 0;
    }

    async function loadBase() {
      if (baseBranch) return baseBranch;
      const r = await gh("repo view --json defaultBranchRef -q .defaultBranchRef.name");
      baseBranch = r.code === 0 ? (r.stdout.trim() || "main") : "main";
      return baseBranch;
    }

    async function loadPRs() {
      const fields = "number,title,headRefName,baseRefName,author,isDraft,reviewDecision,statusCheckRollup,url,updatedAt,additions,deletions";
      const r = await gh("pr list --state open --limit 50 --json " + fields);
      if (r.code !== 0) return { error: r.stderr || "gh pr list failed" };
      try { return { prs: JSON.parse(r.stdout || "[]") }; }
      catch (_) { return { error: "Could not parse gh output" }; }
    }

    function setBadge() {
      const b = document.getElementById("badge-pr");
      if (!b) return;
      if (prs.length) { b.textContent = String(prs.length); b.classList.add("show"); }
      else b.classList.remove("show");
    }

    // ── Actions ─────────────────────────────────────────────────────────────
    async function create() {
      const head = state.branch;
      if (!head || head.startsWith("(")) { ui.toast("Not on a named branch", "error"); return; }
      const base = await loadBase();
      if (head === base) { ui.toast("You're on the base branch (" + base + ")", "error"); return; }
      const title = newTitle.trim();
      let args = "pr create --base " + quote(base) + " --head " + quote(head);
      if (title) args += " --title " + quote(title) + " --body " + quote(newBody.trim());
      else args += " --fill";
      const r = await gh(args, { timeout: 90000 });
      if (r.code === 0) {
        ui.toast("PR created", "success");
        creating = false; newTitle = ""; newBody = "";
        prsLoaded = false;
        detailCache.clear();
        await render({ force: true });
      } else ui.toast(r.stderr || "Create PR failed (is the branch pushed?)", "error", 7000);
    }

    async function viewDiff(num) {
      // Double-click guard via showLoading — the gh pr diff fetch can take a
      // few seconds for large PRs; without this, two quick clicks queued two
      // fetches and the second eventually re-opened the modal.
      if (!ui.showLoading("Loading PR #" + num + " diff…")) return;
      try {
        const r = await gh("pr diff " + num + " --color never");
        if (r.code !== 0) {
          ui.hideLoading();
          ui.toast(r.stderr || "Could not load PR diff", "error", 5000);
          return;
        }
        const files = gmParseDiffDoc(r.stdout);
        if (!files.length) {
          ui.hideLoading();
          ui.toast("PR has no diff", "info");
          return;
        }
        await ui.diffModal({ title: "PR #" + num + " diff", subtitle: files.length + " file(s) changed", files });
      } catch (err) {
        ui.hideLoading();
        ui.toast(err.message || "Could not load PR diff", "error", 5000);
      }
    }

    async function checkout(num) {
      const r = await gh("pr checkout " + num, { timeout: 60000 });
      if (r.code === 0) { ui.toast("Checked out PR #" + num, "success"); await refresh(); }
      else ui.toast(r.stderr || "Checkout failed", "error", 5000);
    }

    async function openWeb(num) {
      const r = await gh("pr view " + num + " --web");
      if (r.code !== 0) ui.toast(r.stderr || "Could not open browser", "error", 5000);
    }

    async function merge(pr) {
      const ok = await ui.confirm({
        title: "Merge PR #" + pr.number + "?",
        body: `Squash-merge "${pr.title}" into ${pr.baseRefName} and delete the head branch. This can't be undone from here.`,
        danger: true, okLabel: "Squash & merge",
      });
      if (!ok) return;
      const r = await gh("pr merge " + pr.number + " --squash --delete-branch", { timeout: 90000 });
      if (r.code === 0) {
        ui.toast("Merged PR #" + pr.number, "success");
        selected = null;
        prsLoaded = false;
        detailCache.clear();
        await refresh();
      }
      else ui.toast(r.stderr || "Merge failed", "error", 7000);
    }

    // ── Detail pane ─────────────────────────────────────────────────────────
    async function renderDetail(node, num, opts) {
      const force = !!(opts && opts.force);
      if (!force && detailCache.has(num)) {
        paintDetail(node, detailCache.get(num));
        return;
      }
      node.innerHTML = '<div class="status-diff-empty"><span class="spinner"></span></div>';
      const fields = "number,title,body,state,isDraft,headRefName,baseRefName,author,reviewDecision,statusCheckRollup,url,additions,deletions,mergeable,labels";
      const r = await gh("pr view " + num + " --json " + fields);
      if (selected !== num) return; // user moved on
      if (r.code !== 0) { node.innerHTML = ""; node.append(h("div", { class: "history-detail-empty" }, r.stderr || "Could not load PR")); return; }
      let pr;
      try { pr = JSON.parse(r.stdout); } catch (_) { node.innerHTML = ""; node.append(h("div", { class: "history-detail-empty" }, "Parse error")); return; }
      detailCache.set(num, pr);
      paintDetail(node, pr);
    }

    function paintDetail(node, pr) {
      node.innerHTML = "";

      node.append(h("div", { class: "pr-detail-head" },
        h("div", { class: "pr-detail-title" },
          h("span", { class: "pr-num" }, "#" + pr.number),
          h("span", null, pr.title),
        ),
        h("div", { class: "pr-detail-meta" },
          pr.isDraft && h("span", { class: "pr-tag is-draft" }, "draft"),
          reviewBadge(pr.reviewDecision),
          checksBadge(pr.statusCheckRollup),
          h("span", { class: "pr-branches" }, pr.baseRefName + " ← " + pr.headRefName),
          h("span", { class: "pr-diffstat" }, h("span", { class: "stat-add" }, "+" + (pr.additions || 0)), " ", h("span", { class: "stat-del" }, "−" + (pr.deletions || 0))),
          pr.author && h("span", { class: "pr-author" }, "@" + (pr.author.login || pr.author.name || "")),
        ),
      ));

      node.append(h("div", { class: "pr-actions" },
        h("button", { class: "btn-mini", onClick: () => viewDiff(pr.number) }, "View diff"),
        h("button", { class: "btn-mini", onClick: () => checkout(pr.number) }, "Checkout"),
        h("button", { class: "btn-mini", onClick: () => openWeb(pr.number) }, "Open in browser"),
        h("button", { class: "btn-mini danger", onClick: () => merge(pr) }, "Squash & merge"),
      ));

      // Checks — summary + attention rows always visible; passing/skipped
      // collapsed behind a toggle so a PR with dozens of green checks stays calm.
      const checks = (pr.statusCheckRollup || []).map(checkInfo);
      if (checks.length) node.append(renderChecks(checks));

      // Body — rendered as GitHub-flavored Markdown.
      node.append(h("div", { class: "pr-section-title" }, "Description"));
      if (pr.body && pr.body.trim()) {
        node.append(h("div", { class: "pr-body md-body", html: window.GMMd.render(pr.body) }));
      } else {
        node.append(h("div", { class: "pr-body is-empty" }, "(no description)"));
      }
    }

    // Build the collapsible checks section. Failing + pending checks are shown
    // up front; passing/skipped ones hide behind a "Show N passing" toggle
    // (auto-collapsed only when there are enough to be noisy).
    function renderChecks(checks) {
      const order = { fail: 0, pending: 1, skip: 2, pass: 3 };
      const sorted = checks.slice().sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
      const count = (k) => sorted.filter((c) => c.kind === k).length;
      const fail = count("fail"), pend = count("pending"), pass = count("pass"), skip = count("skip");

      const summary = h("div", { class: "pr-checks-summary" });
      const pill = (n, kind, label) => n ? h("span", { class: "pr-check-pill is-" + kind },
        h("span", { class: "pr-check-dot is-" + kind }), n + " " + label) : null;
      summary.append(
        pill(fail, "fail", "failing"),
        pill(pend, "pending", "pending"),
        pill(pass, "pass", "passed"),
        pill(skip, "skip", "skipped"),
      );

      const row = (c) => h("a", {
        class: "pr-check-row" + (c.url ? " is-link" : ""),
        ...(c.url ? { href: c.url, target: "_blank", rel: "noopener noreferrer" } : {}),
      },
        h("span", { class: "pr-check-dot is-" + c.kind }),
        h("span", { class: "pr-check-name" }, c.name),
        h("span", { class: "pr-check-kind is-" + c.kind }, c.kind),
      );

      const attention = sorted.filter((c) => c.kind === "fail" || c.kind === "pending");
      const rest = sorted.filter((c) => c.kind === "pass" || c.kind === "skip");

      const wrap = h("div", { class: "pr-checks-wrap" });
      wrap.append(h("div", { class: "pr-section-title" }, "Checks"), summary);

      if (attention.length) {
        const cl = h("div", { class: "pr-checks" });
        attention.forEach((c) => cl.append(row(c)));
        wrap.append(cl);
      }

      if (rest.length) {
        // Show inline when short and nothing else is demanding attention;
        // otherwise tuck them behind a toggle.
        const collapse = rest.length > 4 || attention.length > 0;
        const restList = h("div", { class: "pr-checks" + (collapse ? " is-collapsed" : "") });
        rest.forEach((c) => restList.append(row(c)));
        if (collapse) {
          let open = false;
          const toggle = h("button", { class: "pr-checks-toggle" },
            "Show " + rest.length + " passing check" + (rest.length === 1 ? "" : "s"));
          toggle.addEventListener("click", () => {
            open = !open;
            restList.classList.toggle("is-collapsed", !open);
            toggle.textContent = (open ? "Hide " : "Show ") + rest.length + " passing check" + (rest.length === 1 ? "" : "s");
          });
          wrap.append(toggle, restList);
        } else {
          wrap.append(restList);
        }
      }

      return wrap;
    }

    // Client-side re-paint of the PR list from cached `prs` + filter — used by
    // the filter box and row selection so a keystroke never re-hits gh.
    function paintList() {
      if (!listEl) return;
      const f = filter.toLowerCase();
      const visible = prs.filter((p) => !f || p.title.toLowerCase().includes(f) || String(p.number).includes(f) || (p.headRefName || "").toLowerCase().includes(f));
      listEl.innerHTML = "";
      if (visible.length === 0) {
        listEl.append(h("div", { class: "empty-files" }, prs.length === 0 ? "No open PRs" : "No PRs match"));
        return;
      }
      for (const p of visible) {
        const row = h("button", { class: "pr-row" + (selected === p.number ? " is-selected" : ""),
          onClick: () => { selected = p.number; paintList(); renderDetail(detailEl, p.number); } },
          h("div", { class: "pr-row-top" },
            h("span", { class: "pr-num" }, "#" + p.number),
            h("span", { class: "pr-row-title", title: p.title }, p.title),
          ),
          h("div", { class: "pr-row-sub" },
            p.isDraft && h("span", { class: "pr-tag is-draft" }, "draft"),
            checksBadge(p.statusCheckRollup),
            reviewBadge(p.reviewDecision),
            h("span", { class: "pr-row-branch", title: p.headRefName }, p.headRefName),
            h("span", { class: "pr-row-when" }, relTime(p.updatedAt)),
          ),
        );
        listEl.append(row);
      }
    }

    // ── Render ──────────────────────────────────────────────────────────────
    async function render(opts) {
      const force = !!(opts && opts.force);
      const node = pane();
      node.innerHTML = "";
      node.className = "pane is-active pr-pane";
      listEl = detailEl = null;

      // Cache a successful auth check; keep retrying while it fails.
      if (ghOk !== true) ghOk = await probeGh();
      if (!ghOk) {
        node.append(h("div", { class: "empty-files", style: { padding: "24px", lineHeight: "1.6" } },
          "GitHub CLI not available or not authenticated.",
          h("div", { style: { marginTop: "8px", color: "var(--text-dim)" } }, "Install gh and run `gh auth login`, then refresh."),
        ));
        return;
      }

      // Create form (inline) ──────────────────────────────────────────────
      if (creating) {
        const base = await loadBase();
        const titleInput = h("input", { class: "input", placeholder: "PR title (blank = fill from commits)",
          value: newTitle, onInput: (e) => { newTitle = e.target.value; } });
        const bodyInput = h("textarea", { class: "input", rows: 5, placeholder: "Description (optional)",
          style: { resize: "vertical", fontFamily: "inherit" }, value: newBody, onInput: (e) => { newBody = e.target.value; } });
        node.append(h("div", { class: "pr-create" },
          h("div", { class: "pr-create-head" },
            h("span", null, "New PR: ", h("strong", null, state.branch || "?"), " → ", h("strong", null, base)),
          ),
          titleInput, bodyInput,
          h("div", { class: "pr-create-actions" },
            h("button", { class: "btn-ghost", onClick: () => { creating = false; render(); } }, "Cancel"),
            h("button", { class: "btn-primary", onClick: create }, "Create PR"),
          ),
        ));
        return;
      }

      // Top bar — filter re-paints the list client-side (input never rebuilt).
      const filterInput = h("input", {
        class: "history-search", placeholder: "Filter PRs…", value: filter,
        onInput: (e) => { filter = e.target.value; paintList(); },
      });
      node.append(h("div", { class: "pr-top" },
        filterInput,
        h("div", { class: "toolbar-spacer" }),
        h("button", { class: "btn-primary", onClick: () => { creating = true; newTitle = ""; newBody = ""; render(); } }, "New PR"),
      ));

      listEl = h("div", { class: "pr-list" });
      detailEl = h("div", { class: "pr-detail" });
      detailEl.innerHTML = '<div class="history-detail-empty">Pick a PR to inspect.</div>';
      node.append(h("div", { class: "pr-split" }, listEl, detailEl));

      if (!prsLoaded || force) {
        listEl.innerHTML = '<div class="status-diff-empty"><span class="spinner"></span></div>';
        const res = await loadPRs();
        if (res.error) { listEl.innerHTML = ""; listEl.append(h("div", { class: "empty-files" }, res.error)); return; }
        prs = res.prs;
        prsLoaded = true;
        if (force) detailCache.clear();
        // Drop a stale selection if that PR is no longer open.
        if (selected != null && !prs.some((p) => p.number === selected)) selected = null;
      }
      setBadge();

      paintList();
      if (selected != null) await renderDetail(detailEl, selected, { force });
    }

    return { render, invalidate: () => { prsLoaded = false; detailCache.clear(); } };
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

  // ── Top-bar quick Pull / Push ────────────────────────────────────────────
  // Shared runner so the Sync tab and the top bar behave identically:
  // toast → run → toast → refresh. Buttons are disabled while running and
  // when there's nothing actionable (e.g. push with no upstream + no branch).
  let quickRunning = false;
  function paintQuickbar() {
    const pull = $("#quick-pull");
    const push = $("#quick-push");
    if (!pull || !push) return;
    const ab = state.aheadBehind;
    pull.disabled = quickRunning || !state.repoOk;
    push.disabled = quickRunning || !state.repoOk || !state.branch;
    pull.classList.toggle("has-work", !!(ab && ab.behind));
    push.classList.toggle("has-work", !!(ab && ab.ahead) || !state.upstream);
    const pl = pull.querySelector(".quick-label");
    const ph = push.querySelector(".quick-label");
    if (pl) pl.textContent = ab && ab.behind ? "Pull ↓" + ab.behind : "Pull";
    if (ph) ph.textContent = ab && ab.ahead ? "Push ↑" + ab.ahead : "Push";
  }

  async function runQuick(label, cmd, okMsg) {
    if (quickRunning) return;
    quickRunning = true;
    paintQuickbar();
    ui.toast("Running " + label + "…", "info", 1000);
    const r = await sh(cmd, { timeout: 120000 });
    quickRunning = false;
    if (r.code === 0) ui.toast(okMsg || label + " complete", "success");
    else ui.toast(r.stderr || label + " failed", "error", 5000);
    await refresh();
  }

  function quickPull() {
    runQuick("pull", "git pull --no-edit");
  }
  function quickPush() {
    const upstreamArgs = state.upstream ? "" : " -u origin " + quote(state.branch);
    runQuick("push", "git push" + upstreamArgs);
  }

  // ── Refresh: probes + re-render active tab ───────────────────────────────
  async function refresh() {
    const btn = $("#refresh-btn");
    if (btn) btn.classList.add("spinning");
    try {
      for (const tab of [branchesTab, syncTab, historyTab, stashTab, tagsTab, prTab]) {
        if (tab && tab.invalidate) tab.invalidate();
      }
      await readHead();
      await detectRebase();
      await probeStashCount();
      paintTopBar();
      await renderActiveTab({ force: true });
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
      if (["1", "2", "3", "4", "5", "6", "7", "8"].includes(k)) {
        const tab = ["status", "branches", "sync", "history", "rebase", "stash", "tags", "pr"][parseInt(k, 10) - 1];
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
    $("#quick-pull").addEventListener("click", quickPull);
    $("#quick-push").addEventListener("click", quickPush);
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
