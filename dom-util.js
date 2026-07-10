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
    // Snapshot fresh's children up front: mounting an unmatched fresh child via
    // insertBefore detaches it from `fresh`, shrinking a live childNodes list
    // mid-loop and skipping subsequent children. liveKids stays LIVE on purpose
    // so the trailing-removal cleanup below sees post-mutation state.
    const freshKids = Array.from(fresh.childNodes);

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
