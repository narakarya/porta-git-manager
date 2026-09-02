(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GMDiff = factory();
})(typeof self !== "undefined" ? self : this, function () {
  function parseHunkHeader(header) {
    const m = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
    if (!m) return { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 };
    return {
      oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2],
      newStart: +m[3], newCount: m[4] === undefined ? 1 : +m[4],
    };
  }

  // Walk hunk body lines, attach running old/new line numbers.
  function numberHunkLines(lines, range) {
    let oldNo = range.oldStart, newNo = range.newStart;
    const rows = [];
    for (const text of lines) {
      const c = text[0];
      if (c === "\\") { rows.push({ kind: "meta", text, oldNo: null, newNo: null }); continue; }
      if (c === "-") { rows.push({ kind: "del", text, oldNo: oldNo++, newNo: null }); continue; }
      if (c === "+") { rows.push({ kind: "add", text, oldNo: null, newNo: newNo++ }); continue; }
      rows.push({ kind: "ctx", text, oldNo: oldNo++, newNo: newNo++ });
    }
    return rows;
  }

  // Tokenize into words + separators so whitespace/punct align naturally.
  function tokenizeWords(s) {
    return s.match(/\w+|\s+|[^\w\s]/g) || [];
  }

  // Cap for the LCS table size (n*m cells). The table is allocated in full,
  // so a long minified/lockfile/JSON line pair (e.g. ~2000 tokens/side) would
  // build a ~64M-cell matrix and freeze the UI for ~0.3s *per line*. Above
  // this budget we skip word-level diffing entirely; callers fall back to
  // plain line-level syntax highlighting (cheap). 250k cells ≈ a couple ms.
  const WORD_DIFF_MAX_CELLS = 250000;

  // Word-level diff via LCS. Input lines include the leading -/+ which we strip.
  // Returns null when the line pair is too large to diff cheaply (see cap).
  function wordDiff(delText, addText) {
    const a = tokenizeWords(delText.slice(1));
    const b = tokenizeWords(addText.slice(1));
    const n = a.length, m = b.length;
    if (n * m > WORD_DIFF_MAX_CELLS) return null;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const del = [], add = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { del.push({ t: a[i], changed: false }); add.push({ t: b[j], changed: false }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { del.push({ t: a[i++], changed: true }); }
      else { add.push({ t: b[j++], changed: true }); }
    }
    while (i < n) del.push({ t: a[i++], changed: true });
    while (j < m) add.push({ t: b[j++], changed: true });
    return { del, add };
  }

  /**
   * Transform unified `numberHunkLines` output into split (side-by-side) rows.
   * Consecutive del/add runs are paired position-wise (1st del with 1st add,
   * etc.). Uneven runs spill into rows where the longer side has a non-null
   * cell and the shorter side is null (rendered as blank). Context lines
   * mirror on both sides. Meta rows are dropped (split layout has no place
   * to put a "\\ No newline at end of file" marker symmetrically).
   *
   * Returns: [{ left: cell|null, right: cell|null }, ...]
   * Cell shape: { kind, no, text, _wd? }
   */
  function toSplitRows(numbered) {
    const rows = [];
    let dels = [], adds = [];
    function flush() {
      const n = Math.max(dels.length, adds.length);
      for (let i = 0; i < n; i++) {
        const L = i < dels.length ? dels[i] : null;
        const R = i < adds.length ? adds[i] : null;
        let lwd = null, rwd = null;
        if (L && R) {
          const d = wordDiff(L.text, R.text);
          if (d) {
            lwd = d.del; lwd.cls = "wd-del";
            rwd = d.add; rwd.cls = "wd-add";
          }
        }
        rows.push({
          left:  L ? { kind: "del", no: L.oldNo, text: L.text, _wd: lwd } : null,
          right: R ? { kind: "add", no: R.newNo, text: R.text, _wd: rwd } : null,
        });
      }
      dels = []; adds = [];
    }
    for (const r of numbered) {
      if (r.kind === "del") dels.push(r);
      else if (r.kind === "add") adds.push(r);
      else if (r.kind === "meta") { /* dropped in split layout */ }
      else {
        flush();
        rows.push({
          left:  { kind: "ctx", no: r.oldNo, text: r.text },
          right: { kind: "ctx", no: r.newNo, text: r.text },
        });
      }
    }
    flush();
    return rows;
  }

  /**
   * The code a hunk contributes to one side of the change.
   *
   * `side` is "new" (context + additions — how the file reads after the
   * change), "old" (context + deletions — how it read before), or "patch"
   * (the hunk verbatim, header included, which is what `git apply` wants).
   *
   * For "old"/"new" the leading marker column is stripped, so the result is
   * real code you can paste into an editor rather than something that needs
   * cleaning up first. Git's `\ No newline at end of file` is an annotation
   * about the content, not content, so it is dropped from both sides — but
   * kept in "patch", where it is load-bearing.
   */
  function hunkText(hunk, side) {
    if (!hunk) return "";
    const lines = hunk.lines || [];
    if (side === "patch") return [hunk.header].concat(lines).join("\n");
    const keep = side === "old" ? "-" : "+";
    const out = [];
    for (const line of lines) {
      const c = line[0];
      if (c === "\\") continue;
      if (c === "+" || c === "-") {
        if (c === keep) out.push(line.slice(1));
        continue;
      }
      // Context. A completely empty line has no marker column to strip.
      out.push(line.startsWith(" ") ? line.slice(1) : line);
    }
    return out.join("\n");
  }

  /**
   * A whole file's diff as an applicable patch: its `diff --git` header
   * followed by every hunk.
   *
   * Deliberately the only file-level flavour. A diff holds changed regions and
   * their context, not the file — concatenating each hunk's "new" side would
   * produce something that *looks* like contiguous code while silently
   * omitting everything between the hunks, which is exactly the kind of paste
   * that goes wrong quietly.
   */
  function filePatch(file) {
    if (!file) return "";
    const parts = (file.header || []).slice();
    for (const hk of file.hunks || []) {
      parts.push(hk.header);
      for (const line of hk.lines || []) parts.push(line);
    }
    return parts.join("\n");
  }

  return { parseHunkHeader, numberHunkLines, wordDiff, toSplitRows, hunkText, filePatch };
});
