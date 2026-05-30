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

  // Word-level diff via LCS. Input lines include the leading -/+ which we strip.
  function wordDiff(delText, addText) {
    const a = tokenizeWords(delText.slice(1));
    const b = tokenizeWords(addText.slice(1));
    const n = a.length, m = b.length;
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
          lwd = d.del; lwd.cls = "wd-del";
          rwd = d.add; rwd.cls = "wd-add";
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

  return { parseHunkHeader, numberHunkLines, wordDiff, toSplitRows };
});
