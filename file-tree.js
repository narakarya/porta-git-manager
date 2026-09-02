(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GMTree = factory();
})(typeof self !== "undefined" ? self : this, function () {
  /**
   * Nest a flat list of `{ path, ... }` into a directory tree.
   *
   *   fileTree([{path:"a/b/c.ts"}, {path:"a/d.ts"}])
   *   → { name:"", dirs: Map { a → { dirs: Map { b → {…} }, files:[d.ts] } }, files:[] }
   *
   * The returned file nodes preserve the original object plus `_name` (the
   * trailing path segment) so callers can render the basename without
   * re-splitting.
   */
  function fileTree(files) {
    const root = { name: "", dirs: new Map(), files: [] };
    for (const f of files) {
      let parts = (f.path || "?").split("/");
      // Paths ending in "/" — `git status --porcelain` reports untracked
      // directories like ".claude/". Treat them as one selectable leaf at
      // parent level, but mark them so renderers can show folder UI.
      let trailingSlash = false;
      if (parts.length > 1 && parts[parts.length - 1] === "") {
        parts = parts.slice(0, -1);
        trailingSlash = true;
      }
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i];
        if (!node.dirs.has(seg)) node.dirs.set(seg, { name: seg, dirs: new Map(), files: [] });
        node = node.dirs.get(seg);
      }
      const tail = parts[parts.length - 1];
      const _name = trailingSlash ? tail + "/" : tail;
      node.files.push(Object.assign({ _name, _isDirectory: trailingSlash }, f));
    }
    return root;
  }

  /**
   * Filter by path, matching every whitespace-separated term in any order
   * (see `GMText.matchesQuery`). Empty query returns all.
   *
   * The matcher is passed in rather than imported so this module stays
   * dependency-free for its own tests; callers hand it `GMText.matchesQuery`.
   */
  function filterFiles(files, query, matcher) {
    const q = String(query == null ? "" : query).trim();
    if (!q) return files.slice();
    const match = matcher || defaultMatch;
    return files.filter((f) => match(f.path || "", q));
  }

  function defaultMatch(text, query) {
    const lower = String(text).toLowerCase();
    return String(query).trim().toLowerCase().split(/\s+/).filter(Boolean)
      .every((t) => lower.includes(t));
  }

  return { fileTree, filterFiles };
});
