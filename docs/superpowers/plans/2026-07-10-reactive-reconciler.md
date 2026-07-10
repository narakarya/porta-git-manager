# Reactive Reconciler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every tab update the DOM in place (preserving scroll, focus, caret, selection, no flicker) on stage/unstage/discard/commit/refresh, by replacing `innerHTML=""` + rebuild with a keyed morph reconciler.

**Architecture:** New zero-dependency module `dom-util.js` exposes `reconcile(liveNode, freshNode)` that morphs `liveNode`'s children to match a freshly-built detached `freshNode`, reusing nodes by `data-key`, syncing attributes/props, and swapping event handlers recorded on `el.__on`. `h()` is extended to record handlers and pass `key` through. Each tab's `render()` builds into a detached container and calls `reconcile` instead of wiping the pane.

**Tech Stack:** Vanilla JS (ES5/ES2018-ish, no build step), UMD modules loaded as global `<script>` in index.html, `node:test` for unit tests.

## Global Constraints

- Zero runtime **and** dev dependencies — no new npm packages, no jsdom. Tests use an in-file DOM shim.
- Module files use the existing UMD wrapper: `(function(root,factory){ if(typeof module==="object"&&module.exports) module.exports=factory(); else root.GMX=factory(); })(typeof self!=="undefined"?self:this, function(){ ... return {...}; });`
- `dom-util.js` global name: `GMDom`. Load its `<script>` in index.html **before** `app.js`.
- Do not change git logic, action semantics, per-tab caches, or the `h(tag, props, ...children)` call signature.
- Convention shared by `h()` and reconcile: `key` prop → `el.dataset.key`; handlers recorded at `el.__on[type]`; `data-static` prop marks a subtree reconcile must not descend into.
- Validation per task: `npm test` green, plus the driven check named in the task.

---

### Task 1: `dom-util.js` — reconcile core + tests

**Files:**
- Create: `dom-util.js`
- Create: `test/dom-util.test.mjs`
- Modify: `index.html:178` (add `<script src="dom-util.js"></script>` immediately before the `app.js` script tag)

**Interfaces:**
- Produces:
  - `GMDom.reconcile(live, fresh)` → mutates `live` in place so its children match `fresh`'s children; returns `live`.
  - `GMDom.swapHandlers(live, fresh)` → for each event type in `live.__on ∪ fresh.__on`, removes the live listener and adds the fresh one, then sets `live.__on = fresh.__on`.
  - Key convention: a node is "keyed" iff `node.getAttribute("data-key")` is non-null. `data-static` (attribute present) means: sync the element's own attributes/handlers but do not touch its children.

- [ ] **Step 1: Write the failing tests**

Create `test/dom-util.test.mjs`. It ships a tiny DOM shim (enough API for reconcile) and exercises reconcile:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import pkg from "../dom-util.js";
const { reconcile } = pkg;

// ── Minimal DOM shim ──────────────────────────────────────────────────────
let idSeq = 0;
class FakeNode {
  constructor(tag) {
    this.nodeType = tag === "#text" ? 3 : 1;
    this.tagName = tag === "#text" ? undefined : tag.toUpperCase();
    this.childNodes = [];
    this.attrs = new Map();
    this.listeners = {};     // type -> [fn]
    this.__on = undefined;
    this.parentNode = null;
    this.nodeValue = "";
    this._id = ++idSeq;      // stable identity marker for reuse assertions
  }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get className() { return this.attrs.get("class") || ""; }
  set className(v) { this.attrs.set("class", v); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  getAttributeNames() { return [...this.attrs.keys()]; }
  appendChild(n) { return this.insertBefore(n, null); }
  append(...ns) { for (const n of ns) this.insertBefore(n, null); }
  insertBefore(n, ref) {
    if (n.parentNode) n.parentNode.removeChild(n);
    const i = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    this.childNodes.splice(i === -1 ? this.childNodes.length : i, 0, n);
    n.parentNode = this;
    return n;
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i !== -1) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  replaceChild(nw, old) {
    const i = this.childNodes.indexOf(old);
    if (i !== -1) { this.childNodes.splice(i, 1, nw); old.parentNode = null; nw.parentNode = this; }
    return old;
  }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener(t, fn) {
    const a = this.listeners[t]; if (!a) return;
    const i = a.indexOf(fn); if (i !== -1) a.splice(i, 1);
  }
}
function el(tag, attrs = {}, ...kids) {
  const n = new FakeNode(tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  for (const c of kids) n.appendChild(typeof c === "string" ? txt(c) : c);
  return n;
}
function txt(s) { const n = new FakeNode("#text"); n.nodeValue = s; return n; }
const ids = (node) => node.children.map((c) => c._id);
const keys = (node) => node.children.map((c) => c.getAttribute("data-key"));

// ── Tests ─────────────────────────────────────────────────────────────────
test("keyed nodes are reused (identity preserved) across reconcile", () => {
  const live = el("div", {}, el("li", { "data-key": "a" }), el("li", { "data-key": "b" }));
  const [aId, bId] = ids(live);
  const fresh = el("div", {}, el("li", { "data-key": "a" }), el("li", { "data-key": "b" }));
  reconcile(live, fresh);
  assert.deepEqual(ids(live), [aId, bId]);
});

test("reorder by key keeps identities and fixes order", () => {
  const live = el("div", {}, el("li", { "data-key": "a" }), el("li", { "data-key": "b" }), el("li", { "data-key": "c" }));
  const map = Object.fromEntries(live.children.map((c) => [c.getAttribute("data-key"), c._id]));
  const fresh = el("div", {}, el("li", { "data-key": "c" }), el("li", { "data-key": "a" }), el("li", { "data-key": "b" }));
  reconcile(live, fresh);
  assert.deepEqual(keys(live), ["c", "a", "b"]);
  assert.deepEqual(ids(live), [map.c, map.a, map.b]);
});

test("removed keys are dropped, new keys inserted", () => {
  const live = el("div", {}, el("li", { "data-key": "a" }), el("li", { "data-key": "b" }));
  const fresh = el("div", {}, el("li", { "data-key": "a" }), el("li", { "data-key": "c" }));
  reconcile(live, fresh);
  assert.deepEqual(keys(live), ["a", "c"]);
});

test("attributes sync: added, changed, removed", () => {
  const live = el("div", {}, el("li", { "data-key": "a", class: "old", title: "gone" }));
  const fresh = el("div", {}, el("li", { "data-key": "a", class: "new", role: "row" }));
  reconcile(live, fresh);
  const row = live.children[0];
  assert.equal(row.getAttribute("class"), "new");
  assert.equal(row.getAttribute("role"), "row");
  assert.equal(row.getAttribute("title"), null);
});

test("text node content updates without replacing element", () => {
  const live = el("div", {}, el("span", { "data-key": "s" }, "before"));
  const spanId = live.children[0]._id;
  const fresh = el("div", {}, el("span", { "data-key": "s" }, "after"));
  reconcile(live, fresh);
  assert.equal(live.children[0]._id, spanId);
  assert.equal(live.children[0].firstChild.nodeValue, "after");
});

test("swapHandlers: reused node ends up with fresh handler", () => {
  const live = el("li", { "data-key": "a" });
  const oldFn = () => "old"; live.__on = { click: oldFn }; live.addEventListener("click", oldFn);
  const fresh = el("li", { "data-key": "a" });
  const newFn = () => "new"; fresh.__on = { click: newFn };
  const parentLive = el("div", {}, live);
  reconcile(parentLive, el("div", {}, fresh));
  const row = parentLive.children[0];
  assert.equal(row.__on.click, newFn);
  assert.deepEqual(row.listeners.click, [newFn]);
});

test("data-static: children are not touched", () => {
  const live = el("div", {}, el("figure", { "data-key": "m", "data-static": "1" }, el("svg", { id: "kept" })));
  const svgId = live.children[0].children[0]._id;
  const fresh = el("div", {}, el("figure", { "data-key": "m", "data-static": "1" })); // no children
  reconcile(live, fresh);
  assert.equal(live.children[0].children[0]._id, svgId); // subtree untouched
});

test("tag change replaces the node", () => {
  const live = el("div", {}, el("span", { "data-key": "x" }));
  const oldId = live.children[0]._id;
  const fresh = el("div", {}, el("div", { "data-key": "x" }));
  reconcile(live, fresh);
  assert.equal(live.children[0].tagName, "DIV");
  assert.notEqual(live.children[0]._id, oldId);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/dom-util.test.mjs`
Expected: FAIL — `Cannot find module '../dom-util.js'` (module not created yet).

- [ ] **Step 3: Write `dom-util.js`**

Create `dom-util.js`. The DOM-standard API it uses (`childNodes`, `getAttribute`, `setAttribute`, `removeAttribute`, `getAttributeNames`, `insertBefore`, `removeChild`, `replaceChild`, `nodeType`, `tagName`, `nodeValue`, `addEventListener`, `removeEventListener`) is exactly what the shim implements and what real browsers provide.

```js
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GMDom = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function keyOf(node) {
    return node.nodeType === 1 && node.hasAttribute("data-key")
      ? node.getAttribute("data-key") : null;
  }

  // Move fresh's recorded handlers onto live, detaching live's stale ones.
  function swapHandlers(live, fresh) {
    const oldOn = live.__on || {};
    const newOn = fresh.__on || {};
    for (const type in oldOn) live.removeEventListener(type, oldOn[type]);
    for (const type in newOn) live.addEventListener(type, newOn[type]);
    live.__on = fresh.__on;
  }

  // Copy attributes from fresh onto live; drop attributes live has but fresh lacks.
  // value/checked are form *properties*, set only when they differ so typing is safe.
  function syncAttrs(live, fresh) {
    const freshNames = fresh.getAttributeNames();
    const seen = new Set(freshNames);
    for (const name of freshNames) {
      const v = fresh.getAttribute(name);
      if (live.getAttribute(name) !== v) live.setAttribute(name, v);
    }
    for (const name of live.getAttributeNames()) {
      if (!seen.has(name)) live.removeAttribute(name);
    }
    for (const prop of ["value", "checked", "selected", "disabled"]) {
      if (prop in fresh && live[prop] !== fresh[prop]) live[prop] = fresh[prop];
    }
  }

  // Morph a single element pair (same-ish node). Assumes tags already matched.
  function morph(live, fresh) {
    syncAttrs(live, fresh);
    swapHandlers(live, fresh);
    if (fresh.hasAttribute && fresh.hasAttribute("data-static")) return live;
    reconcileChildren(live, fresh);
    return live;
  }

  function sameType(a, b) {
    if (a.nodeType !== b.nodeType) return false;
    if (a.nodeType === 3) return true;          // both text
    return a.tagName === b.tagName;
  }

  function reconcileChildren(live, fresh) {
    const liveKids = live.childNodes;
    const freshKids = fresh.childNodes;

    // Index live's keyed children so we can pull them forward on reorder.
    const keyed = new Map();
    for (const child of liveKids) {
      const k = keyOf(child);
      if (k != null) keyed.set(k, child);
    }

    let cursor = 0; // position in live.childNodes we're placing the next node at
    for (let i = 0; i < freshKids.length; i++) {
      const fchild = freshKids[i];
      const fkey = keyOf(fchild);
      let match = null;

      if (fkey != null && keyed.has(fkey)) {
        match = keyed.get(fkey);
        keyed.delete(fkey);
      } else if (fkey == null) {
        const atCursor = liveKids[cursor];
        // Reuse the node at the cursor only if it's unkeyed and same type.
        if (atCursor && keyOf(atCursor) == null && sameType(atCursor, fchild)) {
          match = atCursor;
        }
      }

      if (match) {
        // Ensure it sits at the cursor position.
        if (liveKids[cursor] !== match) live.insertBefore(match, liveKids[cursor] || null);
        if (match.nodeType === 3) {
          if (match.nodeValue !== fchild.nodeValue) match.nodeValue = fchild.nodeValue;
        } else if (sameType(match, fchild)) {
          morph(match, fchild);
        } else {
          live.replaceChild(fchild, match);
        }
      } else {
        // No reuse: mount the fresh node here.
        live.insertBefore(fchild, liveKids[cursor] || null);
      }
      cursor++;
    }

    // Anything left past the cursor is stale — remove it.
    while (liveKids.length > cursor) live.removeChild(liveKids[liveKids.length - 1]);
  }

  // Public entry: morph live's children to match fresh's children.
  function reconcile(live, fresh) {
    reconcileChildren(live, fresh);
    return live;
  }

  return { reconcile, swapHandlers };
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/dom-util.test.mjs`
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Wire the script tag**

In `index.html`, add before the `app.js` line (currently `app.js:179` script tag at index.html:179):

```html
  <script src="dom-util.js"></script>
  <script src="app.js"></script>
```

(i.e. insert the `dom-util.js` line; keep `app.js` last so `GMDom` exists when app.js runs.)

- [ ] **Step 6: Commit**

```bash
git add dom-util.js test/dom-util.test.mjs index.html
git commit -m "feat: add GMDom.reconcile keyed DOM morph + tests"
```

---

### Task 2: Extend `h()` to record handlers and pass `key`

**Files:**
- Modify: `app.js:122-146` (the `h` function)

**Interfaces:**
- Consumes: nothing new.
- Produces: `h()` now (a) records each `onX` handler at `el.__on[type]` in addition to `addEventListener`; (b) maps a `key` prop to `el.dataset.key`; (c) maps a `static: true` prop to the `data-static` attribute. Call signature unchanged.

- [ ] **Step 1: Edit `h()`**

Replace the property loop body in `app.js:125-139` so the `on*`, `key`, and `static` cases are handled. The full updated function:

```js
  /** Create an element via (tag, props?, ...children). False/null children skipped. */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (k === "class") el.className = v;
        else if (k === "html") el.innerHTML = v;
        else if (k === "key") { if (v != null) el.dataset.key = String(v); }
        else if (k === "static") { if (v) el.setAttribute("data-static", "1"); }
        else if (k === "dataset") for (const d in v) el.dataset[d] = v[d];
        else if (k.startsWith("on") && typeof v === "function") {
          const type = k.slice(2).toLowerCase();
          (el.__on || (el.__on = {}))[type] = v;
          el.addEventListener(type, v);
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
```

- [ ] **Step 2: Verify nothing regressed**

Run: `npm test`
Expected: PASS (existing suites unaffected; `h` is not unit-tested but must not break the util tests — it isn't imported by them, so this confirms no syntax error via the whole suite still running clean).

- [ ] **Step 3: Manual smoke — app still boots**

Reload the extension in Porta. Expected: Status tab renders as before, buttons still respond (handlers now also flow through `__on`, but `addEventListener` still fires them). No behavioral change yet.

- [ ] **Step 4: Commit**

```bash
git add app.js
git commit -m "feat: h() records __on handlers and supports key/static props"
```

---

## Conversion Recipe (used by Tasks 3–10)

Every tab's `render` starts identically:

```js
const node = pane();
node.innerHTML = "";
node.className = "pane is-active X-pane";
// ...node.append(...) one or more times, sometimes with early returns...
```

Convert it to build a detached frame and morph:

1. Replace `node.innerHTML = "";` with `const next = document.createElement("div");`.
2. Keep the `node.className = ...` line as-is (the pane element itself persists).
3. Redirect **every** `node.append(` in that render body to `next.append(`.
4. Before **every** `return` inside the render, and at the natural end, call `reconcile(node, next);`. (Use the global `GMDom.reconcile`; add `const { reconcile } = window.GMDom;` once near the top of the IIFE in Task 3, so all tabs share it.)
5. Add `key` props to repeated/movable children so morphs are clean (each task lists the exact keys).

Positional (unkeyed) matching already preserves top-level containers and their scroll; keys make list rows and reorderable items reuse cleanly.

---

### Task 3: Convert Status tab to reconcile (hot path)

**Files:**
- Modify: `app.js:2105-2270` (`statusTab.render`)
- Modify: `app.js` top of IIFE (add `const { reconcile } = window.GMDom;` after `const bridge = window.portaBridge;`, ~app.js:16)
- Modify: `app.js:2172-2213` (`appendSection`) and row builders to add keys

**Interfaces:**
- Consumes: `GMDom.reconcile` (Task 1), keyed `h()` (Task 2).
- Produces: Status pane updates in place.

- [ ] **Step 1: Expose reconcile in the IIFE**

After `app.js:16` (`const bridge = window.portaBridge;`) add:

```js
  const { reconcile } = window.GMDom;
```

- [ ] **Step 2: Apply the Conversion Recipe to `render` (app.js:2105)**

- Line 2110 `node.innerHTML = "";` → `const next = document.createElement("div");`
- The early-return error branch (app.js:2114-2117): change `node.append(...)` → `next.append(...)` and insert `reconcile(node, next);` immediately before its `return;`.
- Every other `node.append(` in this function (the toolbar at ~2162, the split at ~2224, the commit area at ~2260) → `next.append(`.
- At the end of the function (after the commit-area append, ~2269) add `reconcile(node, next);`.

- [ ] **Step 3: Add keys to sections and rows**

- In `appendSection` (app.js:2172), key the section wrapper. Change the section title container and give the whole section a stable key by wrapping items — simplest: pass a `sectionKey` and set it on the file-section-title and on the tree container. Concretely, add `key: "sec:" + label` to the `h("div", { class: "file-section-title", ... })` at app.js:2173.
- Rows already have a stable key string at app.js:2185 (`keyFor: (f) => \`${sourceFor(f)}:${f.path}\``). Ensure `gmRenderFileTree` stamps it as `data-key`. In `gmRenderFileTree`'s row creation (file-tree render path in app.js; the `renderRow`/row `h(...)`), add `key: keyFor(f)` to the row element props. Locate the row `h("div"/"button", {...})` inside `gmRenderFileTree` and add `key: opts.keyFor ? opts.keyFor(f) : undefined`.
- Key the diff container: `const diffNode = h("div", { class: "status-diff", key: "diff" });` (app.js:2167).
- Key the commit area: add `key: "commit"` to the `h("div", { class: "commit-area" }, ...)` at app.js:2260, and `key: "commit-ta"` to the textarea at app.js:2238.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS (no unit test covers Status, but suite stays green — confirms no syntax break).

- [ ] **Step 5: Driven verification (the real check)**

Reload the extension. In a repo with a long list of changes:
1. Scroll the Changes list halfway down.
2. Click a file to show its diff; scroll the diff.
3. Stage that file (or hit the row's stage action).
Expected: the list scroll position and the diff scroll position **do not jump**; only the staged row moves to the Staged section; no full-pane flash. Type in the commit textarea, then stage another file — caret stays put and text is retained.

- [ ] **Step 6: Commit**

```bash
git add app.js
git commit -m "feat: Status tab updates in place via reconcile"
```

---

### Task 4: Convert Branches tab

**Files:**
- Modify: `app.js:2608-2700+` (`branchesTab.render` and its `paint` at app.js:2700)

**Interfaces:**
- Consumes: `reconcile`, keyed `h()`.
- Produces: Branches pane updates in place.

- [ ] **Step 1: Apply the Conversion Recipe**

- app.js:2611 `node.innerHTML = "";` → `const next = document.createElement("div");`
- Redirect every `node.append(` in `render` → `next.append(`.
- Insert `reconcile(node, next);` before each `return` in `render` and at its end.
- If `paint()` (app.js:2700) repaints a sub-container (e.g. the branch list) via its own `innerHTML=""`+append, convert that sub-container too: build a detached `nextList` and `reconcile(listContainer, nextList)`.

- [ ] **Step 2: Add keys**

- Branch rows: key by branch name, `key: "br:" + branch.name` (or the local/remote-qualified name) on each row element.
- Section wrappers (Local / Remote): `key: "sec:local"` / `key: "sec:remote"`.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Driven verification**

Reload. On Branches: scroll the branch list, then trigger a refresh (press `r`) or a checkout. Expected: list scroll holds, no flash; the filter input keeps focus/caret if focused.

- [ ] **Step 5: Commit**

```bash
git add app.js
git commit -m "feat: Branches tab updates in place via reconcile"
```

---

### Task 5: Convert Sync tab

**Files:**
- Modify: `app.js:3117-3200` (`syncTab.render`)

- [ ] **Step 1: Apply the Conversion Recipe**

- app.js:3120 `node.innerHTML = "";` → `const next = document.createElement("div");`
- Redirect `node.append(` → `next.append(`; add `reconcile(node, next);` before each return and at the end.

- [ ] **Step 2: Add keys**

- Key the top-level cards/sections so refresh reuses them: e.g. `key: "summary"` on the `h("div", { class: "sync-summary" })` (app.js:3123), `key: "actions"` on the action-buttons block, `key: "commits"` on any ahead/behind commit list, and per-commit rows `key: "c:" + sha`.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Driven verification**

Reload. On Sync: press `r` to refresh. Expected: no flash of the summary block; button focus preserved if focused.

- [ ] **Step 5: Commit**

```bash
git add app.js
git commit -m "feat: Sync tab updates in place via reconcile"
```

---

### Task 6: Convert History tab

**Files:**
- Modify: `app.js:3545-3694` (`historyTab.render`, `renderDetail` at app.js:3516)

- [ ] **Step 1: Apply the Conversion Recipe to `render`**

- app.js:3548 `node.innerHTML = "";` → `const next = document.createElement("div");`
- Redirect `node.append(` → `next.append(`; add `reconcile(node, next);` before each return and at the end.
- If `renderDetail(detailNode, commit)` (app.js:3516) does `detailNode.innerHTML=""`+append, convert it: build `nextDetail` and `reconcile(detailNode, nextDetail)` so selecting commits doesn't flash the detail pane.

- [ ] **Step 2: Add keys**

- Commit rows keyed by sha: `key: "c:" + commit.sha` on each log row.
- The list container `key: "log"` and detail container `key: "detail"`.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Driven verification**

Reload. On History: scroll the log, click through commits (detail updates without list scroll jump), then press `r`. Expected: log scroll holds; detail pane morphs without flash.

- [ ] **Step 5: Commit**

```bash
git add app.js
git commit -m "feat: History tab updates in place via reconcile"
```

---

### Task 7: Convert Rebase tab

**Files:**
- Modify: `app.js:3776-3879` (`rebaseTab.render` — note: synchronous, no `opts`)

- [ ] **Step 1: Apply the Conversion Recipe**

- app.js:3777 `node.innerHTML = "";` → `const next = document.createElement("div");`
- Redirect every `node.append(` (there are several conditional branches: in-progress banner vs todo editor) → `next.append(`.
- Add `reconcile(node, next);` before each `return` and at the end. Since branches return early, each branch must reconcile before returning.

- [ ] **Step 2: Add keys**

- Todo rows keyed by their commit sha / line index: `key: "todo:" + sha` (fall back to index if no sha).
- Banner block `key: "banner"`, editor block `key: "editor"`.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Driven verification**

Reload. On Rebase (in a repo mid-rebase, or the todo editor): reorder/toggle a row action then let it repaint. Expected: no full flash; rows not being changed keep identity.

- [ ] **Step 5: Commit**

```bash
git add app.js
git commit -m "feat: Rebase tab updates in place via reconcile"
```

---

### Task 8: Convert Stash tab

**Files:**
- Modify: `app.js:4027-4141` (`stashTab.render`, `paint` at app.js:4069)

- [ ] **Step 1: Apply the Conversion Recipe**

- app.js:4030 `node.innerHTML = "";` → `const next = document.createElement("div");`
- Redirect `node.append(` → `next.append(`; add `reconcile(node, next);` before each return and at the end.
- If `paint()` (app.js:4069) repaints the stash list via `innerHTML=""`, convert that sub-container with its own `reconcile`.

- [ ] **Step 2: Add keys**

- Stash rows keyed by stash ref: `key: "stash:" + entry.ref` (e.g. `stash@{0}`) — but since refs renumber on drop, prefer keying by the stash message+index composite if ref is unstable; use `key: "stash:" + index`.
- List container `key: "stash-list"`, message input `key: "stash-msg"`.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Driven verification**

Reload. On Stash: type in the message input, scroll the list, apply/drop a stash. Expected: input caret preserved, list scroll holds, no flash.

- [ ] **Step 5: Commit**

```bash
git add app.js
git commit -m "feat: Stash tab updates in place via reconcile"
```

---

### Task 9: Convert Tags tab

**Files:**
- Modify: `app.js:4217-4286` (`tagsTab.render`)

- [ ] **Step 1: Apply the Conversion Recipe**

- app.js:4220 `node.innerHTML = "";` → `const next = document.createElement("div");`
- Redirect `node.append(` → `next.append(`; add `reconcile(node, next);` before each return and at the end.

- [ ] **Step 2: Add keys**

- Tag rows keyed by tag name: `key: "tag:" + tag.name`.
- Name input `key: "tag-name"`, list container `key: "tag-list"`.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Driven verification**

Reload. On Tags: type in the tag name input, scroll the tag list, create/delete a tag. Expected: input caret preserved, list scroll holds, no flash.

- [ ] **Step 5: Commit**

```bash
git add app.js
git commit -m "feat: Tags tab updates in place via reconcile"
```

---

### Task 10: Convert PR tab + remove stale caret hack

**Files:**
- Modify: `app.js:4619-4688` (`prTab.render`, `renderDetail` at app.js:4464)
- Modify: `app.js:2140,2164` (remove the now-redundant `caretPos` save/restore in Status filter)

**Interfaces:**
- Consumes: `reconcile`, keyed `h()`.
- Produces: PR pane in place; cleanup of the pre-reconcile caret workaround.

- [ ] **Step 1: Apply the Conversion Recipe to `prTab.render`**

- app.js:4622 `node.innerHTML = "";` → `const next = document.createElement("div");`
- Note app.js:4623 sets `listEl = detailEl = null;` then later assigns them — keep that; just redirect `node.append(` → `next.append(` and reconcile before each return / at end.
- If `renderDetail(node, num, opts)` (app.js:4464) uses `innerHTML=""`, convert its target container with its own `reconcile`.

- [ ] **Step 2: Add keys**

- PR rows keyed by number: `key: "pr:" + pr.number`.
- List container `key: "pr-list"`, detail container `key: "pr-detail"`.

- [ ] **Step 3: Remove the redundant caret hack in Status**

Now that the filter `<input>` persists across reconcile, the manual caret save/restore is dead weight. In `statusTab.render`:
- app.js:2140: change `onInput: (e) => { caretPos = e.target.selectionStart; state.fileFilter = e.target.value; render(); }` → `onInput: (e) => { state.fileFilter = e.target.value; render(); }`
- app.js:2164: delete the `if (caretPos != null) { ... }` restore line.
- Remove the now-unused `let caretPos = null;` declaration (app.js:1131).
- Give the filter input a key so it persists: add `key: "status-filter"` to the `h("input", { class: "status-filter", ... })` at app.js:2136.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Driven verification**

Reload. On PR: scroll the PR list, open a PR (detail morphs), press `r`. Expected: list scroll holds, no flash. Back on Status: type continuously in the filter while results narrow — caret never jumps (now handled by node persistence, not the removed hack).

- [ ] **Step 6: Commit**

```bash
git add app.js
git commit -m "feat: PR tab in place via reconcile; drop stale Status caret hack"
```

---

### Task 11: Guard third-party/imperative subtrees (mermaid, highlight)

**Files:**
- Modify: `app.js` diff/preview render paths — `renderDiffInto` (app.js:1501), `renderFilePreview` (app.js:1573), mermaid wrappers (`.md-mermaid`, referenced app.js:100-118)

**Interfaces:**
- Consumes: `data-static` support in `h()`/reconcile (Tasks 1-2).
- Produces: generated SVG/highlight subtrees survive reconcile untouched; they replace cleanly only when their content changes.

- [ ] **Step 1: Mark generated subtrees static with content-derived keys**

- Mermaid wrapper: where `.md-mermaid` is built (in `md-util.js`/`app.js` md render), add `static: true` and `key: "mermaid:" + <stable-id-or-content-hash>` so reconcile syncs its attributes (e.g. `data-mermaid-scale`) but never rebuilds the injected SVG, and a genuinely new diagram gets a new key → clean replace.
- Highlighted diff hunk bodies: on the hunk body wrapper (`renderUnifiedHunkBody`/`renderSplitHunkBody`, app.js:1686/1721), add `key: "hunk:" + filePath + ":" + hunkIndex` and `static: true` if the highlighted content is imperatively injected and must not be morphed line-by-line.

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Driven verification**

Reload. Open a diff that contains a mermaid block in a markdown preview: zoom the mermaid (changes `data-mermaid-scale`), then stage an unrelated file to force a Status reconcile. Expected: the mermaid keeps its zoom and rendered SVG (not rebuilt/reset). Open a large highlighted diff, scroll it, stage another file — highlight intact, scroll held.

- [ ] **Step 4: Commit**

```bash
git add app.js md-util.js
git commit -m "feat: keep mermaid/highlight subtrees static across reconcile"
```

---

### Task 12: Full regression pass + version bump

**Files:**
- Modify: `package.json` (version bump), `CHANGELOG.md`

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: PASS — all suites including `dom-util.test.mjs`.

- [ ] **Step 2: Cross-tab driven regression**

Reload. For each tab (Status, Branches, Sync, History, Rebase, Stash, Tags, PR): activate it, scroll, perform its primary mutating action, press `r`. Expected everywhere: no full-pane flash, scroll/focus/caret preserved, actions still work exactly as before.

- [ ] **Step 3: Update CHANGELOG + bump version**

Add a CHANGELOG entry describing "smooth in-place updates (no full-page refresh) on stage/unstage/refresh across all tabs" and bump `package.json` version (next patch after 0.7.53).

- [ ] **Step 4: Commit**

```bash
git add package.json CHANGELOG.md
git commit -m "chore: release notes for in-place reconcile updates"
```

---

## Self-Review Notes

- **Spec coverage:** reconcile module (Task 1) ✓; `__on`/key/static in `h()` (Task 2) ✓; Status hot path (Task 3) ✓; all other tabs (Tasks 4-10) ✓; focus/scroll preserved via node persistence + caret-hack removal (Task 10) ✓; third-party DOM via `data-static` (Task 11) ✓; testing story — node:test with in-file shim (Task 1) + driven checks each task ✓; zero-dependency constraint honored (no jsdom) ✓.
- **Naming consistency:** `reconcile`, `swapHandlers`, `el.__on`, `data-key`/`key`, `data-static`/`static` used identically across tasks.
- **Line numbers** are anchors from the current tree (app.js ~4800 lines); executors should confirm the nearby code matches before editing, since edits in earlier tasks shift later line numbers within app.js.
