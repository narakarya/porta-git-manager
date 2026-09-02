(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GMText = factory();
})(typeof self !== "undefined" ? self : this, function () {
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * Split a query into search terms on whitespace.
   *
   * Terms are matched independently and in any order, so "panel comp" finds
   * `src/components/app/ExtensionPanel.tsx`. Typing a path prefix you half
   * remember, in the order you happen to think of it, is how people actually
   * search a file list — a single literal substring made you get the order
   * right or get nothing.
   */
  function queryTerms(query) {
    return String(query == null ? "" : query).trim().toLowerCase().split(/\s+/).filter(Boolean);
  }

  /** Does `text` contain every term? An empty query matches everything. */
  function matchesQuery(text, query) {
    const terms = queryTerms(query);
    if (!terms.length) return true;
    const lower = String(text == null ? "" : text).toLowerCase();
    return terms.every((t) => lower.includes(t));
  }

  // Escape first, then wrap matches of `query` (case-insensitive) in <mark>.
  // Operates on the ORIGINAL string for matching, emits escaped segments.
  // Every occurrence of every term is marked; overlapping hits are merged so
  // a <mark> can never open inside another one.
  function highlightMatches(text, query) {
    const src = String(text);
    const terms = queryTerms(query);
    if (!terms.length) return escapeHtml(src);
    const lower = src.toLowerCase();

    const ranges = [];
    for (const t of terms) {
      let i = lower.indexOf(t);
      while (i !== -1) {
        ranges.push([i, i + t.length]);
        i = lower.indexOf(t, i + t.length);
      }
    }
    if (!ranges.length) return escapeHtml(src);

    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [ranges[0]];
    for (let k = 1; k < ranges.length; k++) {
      const last = merged[merged.length - 1];
      if (ranges[k][0] <= last[1]) last[1] = Math.max(last[1], ranges[k][1]);
      else merged.push(ranges[k]);
    }

    let out = "";
    let i = 0;
    for (const [a, b] of merged) {
      out += escapeHtml(src.slice(i, a));
      out += '<mark class="hl">' + escapeHtml(src.slice(a, b)) + "</mark>";
      i = b;
    }
    return out + escapeHtml(src.slice(i));
  }

  return { escapeHtml, highlightMatches, queryTerms, matchesQuery };
});
