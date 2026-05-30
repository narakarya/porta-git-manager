// Minimal, dependency-free GitHub-flavored Markdown renderer.
//
// Built for rendering PR descriptions inside the Porta webview, so the input
// is UNTRUSTED. Every code path escapes HTML first and only emits a fixed set
// of safe tags; URLs are scheme-checked so `javascript:`/`data:` never make it
// into an href/src. Covers the constructs that show up in real PR bodies:
// headings, bold/italic/strike, inline + fenced code (highlighted via GMHi when
// a language is known), links, images, blockquotes, hr, ordered/unordered lists
// (incl. GitHub task lists), tables, and autolinks. Not a spec-complete CommonMark
// parser — it intentionally favors small + safe over exhaustive.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GMMd = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function unescapeHtml(s) {
    return String(s)
      .replace(/&quot;/g, '"')
      .replace(/&gt;/g, ">")
      .replace(/&lt;/g, "<")
      .replace(/&amp;/g, "&");
  }

  // Allow only safe schemes. Returns a usable URL or null (caller falls back to text).
  function safeUrl(raw) {
    const u = unescapeHtml((raw || "").trim());
    if (!u) return null;
    if (/^(https?:\/\/|mailto:|tel:|#|\/|\.{1,2}\/)/i.test(u)) return u;
    if (/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(u)) return "mailto:" + u; // bare email
    if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) return u; // scheme-less relative path
    return null; // has a scheme we don't trust (javascript:, data:, …)
  }

  // Syntax highlight a code block when GMHi is present and the lang is known.
  function highlight(code, lang) {
    const Hi = typeof window !== "undefined" && window.GMHi;
    const map = { sh: "shell", bash: "shell", zsh: "shell", py: "python", rb: "ruby", ex: "elixir", exs: "elixir", rs: "rust", ts: "js", tsx: "js", jsx: "js", javascript: "js", typescript: "js" };
    const l = map[lang] || lang;
    if (!Hi || !l) return escapeHtml(code);
    try {
      return Hi.tokenize(code, l)
        .map((t) => (t.type ? '<span class="syn-' + t.type + '">' + escapeHtml(t.t) + "</span>" : escapeHtml(t.t)))
        .join("");
    } catch (_) {
      return escapeHtml(code);
    }
  }

  // ── Inline ────────────────────────────────────────────────────────────────
  // Inline-code spans are extracted first so their contents are never treated
  // as markdown; everything else is escaped then marked up.
  function inline(text) {
    const out = [];
    const re = /(`+)([\s\S]*?)\1/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      out.push(inlineMarkup(text.slice(last, m.index)));
      out.push("<code>" + escapeHtml(m[2].replace(/^ (.*) $/, "$1")) + "</code>");
      last = m.index + m[0].length;
    }
    out.push(inlineMarkup(text.slice(last)));
    return out.join("");
  }

  function inlineMarkup(t) {
    let s = escapeHtml(t);
    // images: ![alt](url "title")
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (mm, alt, url) => {
      const u = safeUrl(url);
      return u ? '<img class="md-img" src="' + escapeHtml(u) + '" alt="' + alt + '" />' : alt;
    });
    // links: [text](url "title")
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (mm, txt, url) => {
      const u = safeUrl(url);
      return u ? '<a href="' + escapeHtml(u) + '" target="_blank" rel="noopener noreferrer">' + txt + "</a>" : mm;
    });
    s = s.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_]+?)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^\w])_([^_\s][^_]*?)_(?=[^\w]|$)/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~]+?)~~/g, "<del>$1</del>");
    // bare-URL autolink (skip ones already inside an href="…")
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (mm, pre, url) =>
      pre + '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + url + "</a>");
    return s;
  }

  // ── Block helpers ───────────────────────────────────────────────────────────
  const leading = (l) => (/^(\s*)/.exec(l)[1] || "").replace(/\t/g, "    ").length;
  function listMarker(l) {
    const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(l);
    if (!m) return null;
    return { ordered: /\d/.test(m[1]), text: m[2] };
  }
  function isBlockStart(l) {
    return (
      /^\s*(#{1,6})\s/.test(l) ||
      /^\s*(`{3,}|~{3,})/.test(l) ||
      /^\s*>/.test(l) ||
      /^\s*([-*_])(\s*\1){2,}\s*$/.test(l) ||
      !!listMarker(l)
    );
  }
  function splitRow(l) {
    return l.replace(/^\s*\|?/, "").replace(/\|?\s*$/, "").split("|").map((c) => c.trim());
  }

  // ── Block ───────────────────────────────────────────────────────────────────
  function render(src) {
    const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (/^\s*$/.test(line)) { i++; continue; }

      // fenced code
      const fence = /^\s*(`{3,}|~{3,})\s*([\w+#-]*)\s*$/.exec(line);
      if (fence) {
        const ch = fence[1][0], len = fence[1].length, lang = fence[2];
        const close = new RegExp("^\\s*\\" + ch + "{" + len + ",}\\s*$");
        const buf = [];
        i++;
        while (i < lines.length && !close.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // closing fence
        out.push('<pre class="md-pre"><code>' + highlight(buf.join("\n"), lang.toLowerCase()) + "</code></pre>");
        continue;
      }

      // heading
      const hd = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (hd) { const lv = hd[1].length; out.push("<h" + lv + ' class="md-h md-h' + lv + '">' + inline(hd[2]) + "</h" + lv + ">"); i++; continue; }

      // horizontal rule
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr class="md-hr" />'); i++; continue; }

      // blockquote
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
        out.push('<blockquote class="md-quote">' + render(buf.join("\n")) + "</blockquote>");
        continue;
      }

      // table (header row + |---|---| separator)
      if (line.includes("|") && i + 1 < lines.length &&
          /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
        const header = splitRow(line);
        const align = splitRow(lines[i + 1]).map((c) => {
          const l = c.startsWith(":"), r = c.endsWith(":");
          return l && r ? "center" : r ? "right" : l ? "left" : "";
        });
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && !/^\s*$/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
        out.push(renderTable(header, align, rows));
        continue;
      }

      // list
      if (listMarker(line)) {
        const r = parseList(lines, i);
        out.push(r.html);
        i = r.next;
        continue;
      }

      // paragraph
      const buf = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) { buf.push(lines[i]); i++; }
      out.push('<p class="md-p">' + inline(buf.join("\n")).replace(/\n/g, "<br />") + "</p>");
    }

    return out.join("\n");
  }

  function renderTable(header, align, rows) {
    const al = (i) => (align[i] ? ' style="text-align:' + align[i] + '"' : "");
    const head = "<tr>" + header.map((c, i) => "<th" + al(i) + ">" + inline(c) + "</th>").join("") + "</tr>";
    const body = rows.map((r) =>
      "<tr>" + header.map((_, i) => "<td" + al(i) + ">" + inline(r[i] || "") + "</td>").join("") + "</tr>"
    ).join("");
    return '<table class="md-table"><thead>' + head + "</thead><tbody>" + body + "</tbody></table>";
  }

  function parseList(lines, start) {
    const base = leading(lines[start]);
    const ordered = listMarker(lines[start]).ordered;
    const items = [];
    let i = start;

    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*$/.test(line)) {
        const nxt = lines[i + 1];
        if (nxt != null && (listMarker(nxt) || leading(nxt) > base) && !/^\s*$/.test(nxt)) { i++; continue; }
        break;
      }
      const mk = listMarker(line);
      const indent = leading(line);
      if (mk && indent <= base + 1) {
        items.push([mk.text]);
        i++;
      } else if (items.length && indent > base) {
        items[items.length - 1].push(line.slice(Math.min(indent, base + 2)));
        i++;
      } else break;
    }

    const lis = items.map((content) => "<li>" + renderItemBody(content.join("\n")) + "</li>");
    const tag = ordered ? "ol" : "ul";
    return { html: "<" + tag + ' class="md-list">' + lis.join("") + "</" + tag + ">", next: i };
  }

  function renderItemBody(text) {
    // GitHub task list
    const task = /^\s*\[([ xX])\]\s+([\s\S]*)$/.exec(text);
    if (task) {
      const checked = task[1].toLowerCase() === "x";
      return '<input class="md-check" type="checkbox" disabled' + (checked ? " checked" : "") + " /> " + renderItemBody(task[2]);
    }
    const ls = text.split("\n");
    const hasNested = ls.some((l, idx) => idx > 0 && (listMarker(l) || isBlockStart(l)));
    if (hasNested) {
      return render(text).replace(/^<p class="md-p">/, "").replace(/<\/p>(\n|$)/, "$1");
    }
    return inline(text);
  }

  return { render: render, escapeHtml: escapeHtml, safeUrl: safeUrl };
});
