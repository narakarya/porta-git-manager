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

  // Escape first, then wrap matches of `query` (case-insensitive) in <mark>.
  // Operates on the ORIGINAL string for matching, emits escaped segments.
  function highlightMatches(text, query) {
    const src = String(text);
    if (!query) return escapeHtml(src);
    const q = String(query).toLowerCase();
    const lower = src.toLowerCase();
    let out = "";
    let i = 0;
    while (i < src.length) {
      const hit = lower.indexOf(q, i);
      if (hit === -1) { out += escapeHtml(src.slice(i)); break; }
      out += escapeHtml(src.slice(i, hit));
      out += '<mark class="hl">' + escapeHtml(src.slice(hit, hit + q.length)) + "</mark>";
      i = hit + q.length;
    }
    return out;
  }

  return { escapeHtml, highlightMatches };
});
