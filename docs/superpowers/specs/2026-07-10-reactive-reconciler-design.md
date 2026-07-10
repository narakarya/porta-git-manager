# Reactive reconciler for smooth in-place updates

Date: 2026-07-10
Status: Approved (design)

## Problem

Every tab's `render(opts)` rebuilds its whole pane:

```
node.innerHTML = "";
// ...build fresh subtree with h() and append...
```

Because `h()` (app.js:122) creates **real DOM elements**, wiping `innerHTML` throws
away the entire subtree and rebuilds it from scratch on every action. Consequences,
felt hardest on the Status tab but present in all tabs:

- File-list scroll position resets to top.
- Diff pane scroll resets.
- The commit `<textarea>` is recreated (value is restored from `state.commitMsg`,
  but caret/selection is lost).
- Visible flicker as the whole pane repaints.

Every mutating action funnels through this path: stage/unstage/discard/commit and
the global `refresh()` (app.js:4757) all call `render({ force: true })` via
`renderActiveTab` (app.js:1120). So the fix must live at the render/paint layer,
not in each action.

## Goal

Make stage / unstage / discard / commit / refresh — and the equivalent actions in
every other tab — update the DOM **in place**, preserving scroll, focus, caret, and
text selection, with no flicker. Keep the app zero-dependency and keep the `h()`
call-sites essentially unchanged.

## Non-goals

- No framework / build step (user chose in-house keyed reconciler over pulling a
  library).
- No rewrite of the `h()` hyperscript API surface — call-sites keep using
  `h(tag, props, ...children)`.
- No change to git logic, action semantics, or the per-tab caches.

## Architecture

New module `dom-util.js`, loaded as a global `<script>` in index.html **before**
`app.js` (same pattern as the other util modules) and also exporting via
`module.exports` for node tests.

It exposes one primary function:

```js
reconcile(liveNode, freshNode)  // morph liveNode's children to match freshNode's
```

### How render() changes

Per tab, instead of:

```js
const node = pane();
node.innerHTML = "";
node.append(toolbar, split, commitArea);
```

we build the fresh tree into a **detached** container and reconcile:

```js
const node = pane();
const next = h("div", { class: node.className }, toolbar, split, commitArea);
reconcile(node, next);   // morphs node's children in place
```

`h()` is still used to build `next`. The only structural requirement is that
repeatable children carry a stable `key`.

### The reconcile algorithm (morph, keyed)

For a `(live, fresh)` element pair:

1. If tag differs → replace `live` with `fresh` wholesale (rare; different node type).
2. If `fresh` has `data-static` → leave `live`'s subtree untouched (see Third-party
   DOM). Still sync attributes on the element itself.
3. Sync attributes/props: copy `class`, `value`, `checked`, `disabled`, dataset,
   style, plain attributes from `fresh` → `live`; remove attributes present on `live`
   but absent on `fresh`. `value`/`checked` are set as **properties** (form state),
   and only when they differ, so typing is never clobbered.
4. Swap event handlers (see below).
5. Reconcile children:
   - Build a key→node map of `live`'s keyed children.
   - Walk `fresh`'s children in order. For each:
     - keyed & found in live map → reuse that live node, recurse, move into place.
     - keyed & not found, or unkeyed → recurse against the live child at the same
       cursor position if that child is also unkeyed/compatible; otherwise mount the
       fresh node.
   - Remove any live children not consumed.
   - Reordering is done by `insertBefore` against the current cursor node — a keyed
     map plus an ordered walk, no LIS needed for our list sizes.

Text nodes: if both are text, update `nodeValue` only when different.

### Event handlers — the risky part

`h()` currently attaches listeners with `addEventListener` (app.js:130), capturing
state in a closure. When reconcile **reuses** a node, the old node's listeners are
stale closures over stale state.

Solution (native semantics preserved, no global delegation rewrite):

- `h()` records handlers on the element: `el.__on = { click: fn, mousedown: fn, ... }`
  **in addition to** calling `addEventListener` as today. Capture/bubble,
  `stopPropagation`, and `preventDefault` all keep working natively.
- When reconcile reuses a node, for each event type it does
  `live.removeEventListener(type, live.__on[type])` then
  `live.addEventListener(type, fresh.__on[type])` (and updates `live.__on`). It only
  touches types that actually changed identity, and only when a handler exists.

This keeps every call-site (`onClick`, `onInput`, ...) exactly as written.

### Focus / scroll / selection

These need **no explicit save-restore**: because reused nodes stay attached to the
document, the browser preserves their scrollTop, `:focus`, textarea caret, and text
selection through the morph. The existing `caretPos` save/restore for the filter
input (app.js:2140,2164) becomes unnecessary once the input node persists, but we
leave it in as a harmless safety net until the input is confirmed keyed and stable,
then remove it.

## Third-party / imperative DOM

Some subtrees are built imperatively and must not be morphed:

- Mermaid renders (`.md-mermaid`, app.js:100+) hold `data-mermaid-scale` and injected
  SVG.
- Syntax-highlighted diff bodies.

Mitigation: give such wrappers a stable `key` and mark them `data-static` so
reconcile syncs the wrapper's own attributes but never descends into or rebuilds the
generated subtree. When the underlying data genuinely changes, the render code
assigns a new `key` (e.g. include a content hash / file path + hunk index), which
forces a clean replace of that one subtree.

## Rollout (incremental, verify each step)

1. **Foundation** — add `dom-util.js` (`reconcile`), extend `h()` to record `__on`
   and pass `key` through as `data-key`. No call-site adopts reconcile yet; app
   behaves exactly as before. Land + verify no regression.
2. **Status tab** (hot path) — convert `render()` (app.js:2105) to build-into-fragment
   + `reconcile`. Add `key` to: toolbar, each file section, each file/dir row
   (`source:path` key already computed at app.js:2185), the diff container, and the
   commit area / textarea. Verify: long file list, stage one file → list scroll and
   diff scroll stay put, no flicker, commit textarea caret survives.
3. **Remaining tabs** — apply the identical pattern to `branches, sync, history,
   rebase, stash, tags, pr` one at a time, verifying each. Their `render`/`paint`
   functions and `invalidate()` caches are unchanged except for the paint mechanism.
4. `refresh()` (app.js:4757) and every `await refresh()` / `render({force:true})`
   call site are **unchanged** — they become smooth for free because the paint
   underneath is now a morph.

## Testing

- `test/dom-util.test.mjs` (node:test, no framework — matches existing tests):
  - keyed reuse: a node present before and after reconcile keeps identity (`===`).
  - insertion/removal/reorder produce correct final child order.
  - attribute morph: class/value/checked/disabled sync; stale attrs removed.
  - `__on` swap: reused node ends up with the fresh handler reference.
  - `data-static`: subtree left untouched.
  - Uses a minimal in-test DOM shim (small node objects with `childNodes`,
    `setAttribute`, `insertBefore`, `removeChild`) to stay zero-dependency, mirroring
    how existing util tests run headless.
- End-to-end manual verification in the running Porta extension per rollout step
  (scroll + stage + observe), since real browser layout/scroll can't be asserted in
  node.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Stale event closures on reused nodes | `__on` record + remove/add swap in reconcile |
| Wrong cross-section node reuse | explicit stable `key` per row/section/container |
| Imperative subtrees (mermaid/highlight) clobbered | `data-static` + content-derived `key` |
| Property vs attribute for form state | set `value`/`checked` as properties, only on diff |
| Large blast radius | staged rollout, Status first, verify each tab before next |

## Validation chain

Before claiming done at each step: `npm test` (node --test test/*.test.mjs) green,
plus the driven end-to-end check for the tab just converted.
