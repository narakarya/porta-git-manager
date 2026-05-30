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
      const parts = (f.path || "?").split("/");
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i];
        if (!node.dirs.has(seg)) node.dirs.set(seg, { name: seg, dirs: new Map(), files: [] });
        node = node.dirs.get(seg);
      }
      node.files.push(Object.assign({ _name: parts[parts.length - 1] }, f));
    }
    return root;
  }

  /** Case-insensitive substring filter over `f.path`. Empty query returns all. */
  function filterFiles(files, query) {
    const q = (query || "").toLowerCase();
    if (!q) return files.slice();
    return files.filter((f) => (f.path || "").toLowerCase().includes(q));
  }

  return { fileTree, filterFiles };
});
