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

  return { parseHunkHeader, numberHunkLines, wordDiff };
});
