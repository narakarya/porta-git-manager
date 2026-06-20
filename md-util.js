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
    const map = { shell: "shell", sh: "shell", bash: "shell", zsh: "shell", py: "python", rb: "ruby", ex: "elixir", exs: "elixir", elixir: "elixir", rs: "rust", ts: "js", tsx: "js", jsx: "js", javascript: "js", typescript: "js", yml: "yaml" };
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

  function renderCodeBlock(code, lang) {
    const label = (lang || "").trim().toLowerCase();
    const cls = "md-pre" + (label ? " md-pre-lang" : "");
    const attr = label ? ' data-lang="' + escapeHtml(label) + '"' : "";
    return '<pre class="' + cls + '"' + attr + "><code>" + highlight(code, label) + "</code></pre>";
  }

  function mermaidBodyLines(src) {
    return String(src || "").replace(/\r\n?/g, "\n").split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !/^%%/.test(line) && !/^title\s*:/i.test(line));
  }

  function mermaidTheme(src) {
    const allowed = new Set(["soft", "graphite", "console", "paper", "forest", "contrast"]);
    const text = String(src || "");
    const comment = text.match(/^%%\s*theme\s*:\s*([a-z0-9_-]+)\s*$/im);
    const init = text.match(/^%%\{[\s\S]*?"theme"\s*:\s*"([^"]+)"[\s\S]*?\}%%\s*$/im);
    const raw = ((comment && comment[1]) || (init && init[1]) || "soft").toLowerCase();
    return allowed.has(raw) ? raw : "soft";
  }

  function mermaidWrap(src, classes, width, height, label, body) {
    const theme = mermaidTheme(src);
    return '<div class="' + classes + '" data-mermaid-theme="' + theme + '" data-mermaid-scale="1" style="--mermaid-w:' + width + 'px;--mermaid-h:' + height + 'px;--mermaid-scale:1;">'
      + '<div class="md-mermaid-toolbar">'
      + '<button class="md-mermaid-control" type="button" data-mermaid-action="zoom-out" title="Zoom out" aria-label="Zoom out">-</button>'
      + '<button class="md-mermaid-control" type="button" data-mermaid-action="zoom-in" title="Zoom in" aria-label="Zoom in">+</button>'
      + '<button class="md-mermaid-control" type="button" data-mermaid-action="zoom-reset" title="Reset zoom" aria-label="Reset zoom">100%</button>'
      + '<button class="md-mermaid-control" type="button" data-mermaid-action="fullscreen" title="Fullscreen" aria-label="Fullscreen">[]</button>'
      + '</div>'
      + '<div class="md-mermaid-viewport"><svg width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + " " + height + '" role="img" aria-label="' + label + '">' + body + "</svg></div></div>";
  }

  function stripMermaidQuotes(s) {
    const out = String(s || "").trim();
    return (/^".*"$/.test(out) || /^\[.*\]$/.test(out)) ? out.slice(1, -1).trim() : out;
  }

  function svgText(text, x, y, opts) {
    const lines = String(text || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
    const attr = opts || "";
    const dy = lines.length > 1 ? -((lines.length - 1) * 7) : 0;
    return '<text x="' + x + '" y="' + (y + dy) + '"' + attr + ">"
      + (lines.length ? lines : [""]).map((line, index) =>
        '<tspan x="' + x + '" dy="' + (index ? 14 : 0) + '">' + escapeHtml(line) + "</tspan>"
      ).join("")
      + "</text>";
  }

  function wrapMermaidLabel(text, maxChars) {
    const chunks = String(text || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
    const out = [];
    const limit = Math.max(8, maxChars || 26);
    for (const chunk of chunks.length ? chunks : [""]) {
      const words = chunk.split(/\s+/).filter(Boolean);
      let line = "";
      for (const word of words) {
        if (!line) {
          line = word;
        } else if ((line + " " + word).length <= limit) {
          line += " " + word;
        } else {
          out.push(line);
          line = word;
        }
        while (line.length > limit + 6) {
          out.push(line.slice(0, limit));
          line = line.slice(limit);
        }
      }
      if (line || !words.length) out.push(line);
    }
    return out.length ? out : [""];
  }

  function svgTextLines(lines, x, firstY, lineHeight, opts) {
    const attr = opts || "";
    return '<text x="' + x + '" y="' + firstY + '"' + attr + ">"
      + (lines.length ? lines : [""]).map((line, index) =>
        '<tspan x="' + x + '" dy="' + (index ? lineHeight : 0) + '">' + escapeHtml(line) + "</tspan>"
      ).join("")
      + "</text>";
  }

  function estimateTextWidth(s, min, max) {
    const longest = Math.max(...String(s || "").replace(/<br\s*\/?>/gi, "\n").split(/\n+/).map((line) => line.trim().length), 1);
    return Math.max(min, Math.min(max, 28 + longest * 7));
  }

  function renderMermaid(src) {
    const lines = mermaidBodyLines(src);
    if (/^erDiagram\b/i.test(lines[0] || "")) return renderMermaidEr(lines, src);
    if (/^stateDiagram(?:-v2)?\b/i.test(lines[0] || "")) return renderMermaidState(lines, src);
    if (/^sequenceDiagram\b/i.test(lines[0] || "")) return renderMermaidSequence(lines, src);
    if (!/^(flowchart|graph)\b/i.test(lines[0] || "")) return renderCodeBlock(src, "mermaid");

    const nodes = new Map();
    const edges = [];

    function nodeId(raw) {
      return String(raw || "")
        .trim()
        .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, "")
        .replace(/^["']|["']$/g, "")
        .trim();
    }

    function nodeLabel(raw) {
      const s = String(raw || "").trim();
      const opens = [s.indexOf("["), s.indexOf("("), s.indexOf("{")].filter((idx) => idx >= 0);
      const open = opens.length ? Math.min(...opens) : -1;
      if (open < 0) return nodeId(s);
      const closeChar = s[open] === "[" ? "]" : s[open] === "(" ? ")" : "}";
      const close = s.lastIndexOf(closeChar);
      return close > open ? stripMermaidQuotes(s.slice(open + 1, close)) : nodeId(s);
    }

    function parseFlowEdge(line) {
      const match = /^(.+?)\s*(-->|---|==>|-.->)\s*(?:(?:\|([^|]+)\|)\s*)?(.+?)(?:\s*$|\s*;\s*$)/.exec(line);
      if (match) return { from: match[1], to: match[4], label: match[3] || "" };
      const labeled = /^(.+?)\s*--\s*(.+?)\s*-->\s*(.+?)(?:\s*$|\s*;\s*$)/.exec(line);
      return labeled ? { from: labeled[1], to: labeled[3], label: labeled[2] || "" } : null;
    }

    for (const line of lines.slice(1)) {
      if (/^(subgraph|end\b|direction\b)/i.test(line)) continue;
      const edge = parseFlowEdge(line);
      if (!edge) continue;
      const from = nodeId(edge.from);
      const to = nodeId(edge.to);
      if (!from || !to) continue;
      if (!nodes.has(from)) nodes.set(from, nodeLabel(edge.from));
      if (!nodes.has(to)) nodes.set(to, nodeLabel(edge.to));
      edges.push([from, to, stripMermaidQuotes(edge.label)]);
    }

    if (!nodes.size) return '<pre class="md-pre"><code>' + escapeHtml(src) + "</code></pre>";

    const ids = Array.from(nodes.keys());
    const nodeMeta = new Map(ids.map((id) => {
      const lines = wrapMermaidLabel(nodes.get(id), 28);
      const longest = Math.max(...lines.map((line) => line.length), 1);
      const w = Math.max(180, Math.min(290, 30 + longest * 7));
      const h = Math.max(46, 24 + lines.length * 15);
      return [id, { lines, w, h }];
    }));
    const gapY = 70;
    let y = 28;
    let maxW = 0;
    ids.forEach((id) => {
      const meta = nodeMeta.get(id);
      y += meta.h + gapY;
      maxW = Math.max(maxW, meta.w);
    });
    const x = 52;
    y = 28;
    const positions = new Map();
    ids.forEach((id) => {
      const meta = nodeMeta.get(id);
      positions.set(id, { x: x + (maxW - meta.w) / 2, y, w: meta.w, h: meta.h });
      y += meta.h + gapY;
    });
    const width = Math.max(340, x + maxW + 150);
    const height = Math.max(120, y - gapY + 28);
    const marker = '<defs><marker id="md-mermaid-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/></marker></defs>';
    const edgeSvg = edges.map(([from, to, label]) => {
      const a = positions.get(from);
      const b = positions.get(to);
      if (!a || !b) return "";
      const x1 = a.x + a.w / 2;
      const y1 = a.y + a.h;
      const x2 = b.x + b.w / 2;
      const y2 = b.y;
      const my = (y1 + y2) / 2;
      return '<path class="md-mermaid-edge" d="M' + x1 + " " + y1 + " C" + x1 + " " + (y1 + 34) + " " + x2 + " " + (y2 - 34) + " " + x2 + " " + y2 + '" fill="none" stroke-width="1.5" marker-end="url(#md-mermaid-arrow)" />'
        + (label ? '<text class="md-mermaid-rel-label" x="' + (Math.max(x1, x2) + 16) + '" y="' + (my + 4) + '">' + escapeHtml(label) + "</text>" : "");
    }).join("");
    const nodeSvg = ids.map((id) => {
      const p = positions.get(id);
      const meta = nodeMeta.get(id);
      const firstY = (p.h - (meta.lines.length - 1) * 15) / 2 + 4;
      return '<g class="md-mermaid-node" transform="translate(' + p.x + " " + p.y + ')"><rect width="' + p.w + '" height="' + p.h + '" rx="6"/>'
        + svgTextLines(meta.lines, p.w / 2, firstY, 15, ' text-anchor="middle"')
        + "<title>" + escapeHtml(id) + "</title></g>";
    }).join("");
    return mermaidWrap(src, "md-mermaid", width, height, "Mermaid diagram", marker + edgeSvg + nodeSvg);
  }

  function renderMermaidState(lines, src) {
    const states = new Map();
    const edges = [];

    function stateName(raw) {
      const s = String(raw || "").trim();
      if (s === "[*]") return "start";
      return s.replace(/^["']|["']$/g, "");
    }

    for (const raw of lines.slice(1)) {
      const line = raw.trim();
      if (!line || /^direction\b/i.test(line) || /^note\b/i.test(line) || /^end note\b/i.test(line)) continue;
      const rel = /^(.+?)\s*-->\s*(.+?)(?:\s*:\s*(.+))?$/.exec(line);
      if (!rel) continue;
      const from = stateName(rel[1]);
      const to = stateName(rel[2]);
      if (!states.has(from)) states.set(from, from === "start" ? "" : from);
      if (!states.has(to)) states.set(to, to === "start" ? "" : to);
      edges.push({ from, to, label: rel[3] || "" });
    }

    if (!states.size) return renderCodeBlock(src, "mermaid");

    const ids = Array.from(states.keys());
    const minWidth = 640;
    const nodeH = 42;
    const centerY = 110;
    const positions = new Map();
    let x = 24;
    ids.forEach((id, index) => {
      const nodeW = id === "start" ? 24 : estimateTextWidth(states.get(id), 130, 190);
      const h = id === "start" ? 24 : nodeH;
      positions.set(id, { x, y: centerY - h / 2, w: nodeW, h });
      const next = ids[index + 1];
      const labels = next ? edges
        .filter((edge) => edge.from === id && edge.to === next && edge.label)
        .flatMap((edge) => wrapMermaidLabel(edge.label, 26))
        : [];
      const labelW = labels.length ? Math.max(...labels.map((label) => estimateTextWidth(label, 0, 190))) : 0;
      x += nodeW + Math.max(88, labelW + 28);
    });
    const actualWidth = Math.max(minWidth, x + 8);
    const marker = '<defs><marker id="md-mermaid-state-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/></marker></defs>';
    const edgeSvg = edges.map((edge) => {
      const a = positions.get(edge.from);
      const b = positions.get(edge.to);
      if (!a || !b) return "";
      const x1 = a.x + a.w;
      const y1 = a.y + a.h / 2;
      const x2 = b.x;
      const y2 = b.y + b.h / 2;
      const mx = (x1 + x2) / 2;
      const labelLines = edge.label ? wrapMermaidLabel(edge.label, 26) : [];
      const labelY = centerY - 62 + (labelLines.length === 1 ? 8 : 0);
      return '<path class="md-mermaid-edge" d="M' + x1 + " " + y1 + " C" + mx + " " + y1 + " " + mx + " " + y2 + " " + x2 + " " + y2 + '" fill="none" stroke-width="1.5" marker-end="url(#md-mermaid-state-arrow)" />'
        + (edge.label ? svgTextLines(labelLines, mx, labelY, 15, ' class="md-mermaid-rel-label" text-anchor="middle"') : "");
    }).join("");
    const nodeSvg = ids.map((id) => {
      const p = positions.get(id);
      if (id === "start") return '<circle class="md-mermaid-start" cx="' + (p.x + 12) + '" cy="' + (p.y + 12) + '" r="9"/>';
      return '<g class="md-mermaid-node md-mermaid-state-node" transform="translate(' + p.x + " " + p.y + ')"><rect width="' + p.w + '" height="' + p.h + '" rx="8"/>'
        + svgText(states.get(id), p.w / 2, 26, ' text-anchor="middle"') + "</g>";
    }).join("");
    return mermaidWrap(src, "md-mermaid md-mermaid-state", actualWidth, 180, "Mermaid state diagram", marker + edgeSvg + nodeSvg);
  }

  function renderMermaidSequence(lines, src) {
    const participants = [];
    const aliases = new Map();
    const messages = [];

    function ensure(name) {
      const key = String(name || "").trim();
      if (!key) return null;
      if (!aliases.has(key)) {
        aliases.set(key, key);
        participants.push(key);
      }
      return key;
    }

    for (const raw of lines.slice(1)) {
      const line = raw.trim();
      if (!line || /^note\b/i.test(line) || /^loop\b/i.test(line) || /^end\b/i.test(line)) continue;
      const part = /^participant\s+(\S+)(?:\s+as\s+(.+))?$/i.exec(line);
      if (part) {
        const key = ensure(part[1]);
        aliases.set(key, stripMermaidQuotes(part[2] || part[1]));
        continue;
      }
      const msg = /^(\S+)\s*(-{1,2}>>\+?|-->>\+?|->>\+?)\s*(\S+)\s*:\s*(.+)$/.exec(line);
      if (!msg) continue;
      const from = ensure(msg[1]);
      const to = ensure(msg[3]);
      messages.push({ from, to, text: msg[4] });
    }

    if (!participants.length || !messages.length) return renderCodeBlock(src, "mermaid");

    const colW = 170;
    const left = 34;
    const top = 26;
    const width = left * 2 + Math.max(1, participants.length - 1) * colW;
    const height = top + 56 + messages.length * 42 + 24;
    const xFor = (id) => left + participants.indexOf(id) * colW;
    const marker = '<defs><marker id="md-mermaid-seq-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/></marker></defs>';
    const lifelines = participants.map((id) => {
      const x = xFor(id);
      return '<g class="md-mermaid-seq-participant">' + svgText(aliases.get(id), x, top + 16, ' text-anchor="middle"')
        + '<line x1="' + x + '" x2="' + x + '" y1="' + (top + 32) + '" y2="' + (height - 14) + '"/></g>';
    }).join("");
    const msgSvg = messages.map((msg, index) => {
      const y = top + 62 + index * 42;
      const x1 = xFor(msg.from);
      const x2 = xFor(msg.to);
      const labelX = (x1 + x2) / 2;
      return '<path class="md-mermaid-edge" d="M' + x1 + " " + y + " L" + x2 + " " + y + '" fill="none" stroke-width="1.5" marker-end="url(#md-mermaid-seq-arrow)" />'
        + '<text class="md-mermaid-rel-label" x="' + labelX + '" y="' + (y - 7) + '" text-anchor="middle">' + escapeHtml(msg.text) + "</text>";
    }).join("");
    return mermaidWrap(src, "md-mermaid md-mermaid-sequence", width, height, "Mermaid sequence diagram", marker + lifelines + msgSvg);
  }

  function renderMermaidEr(lines, src) {
    const entities = new Map();
    const relations = [];
    let current = null;

    function ensureEntity(name) {
      const key = String(name || "").trim();
      if (!key) return null;
      if (!entities.has(key)) entities.set(key, []);
      return key;
    }

    for (const raw of lines.slice(1)) {
      const line = raw.trim();
      if (!line || /^%%/.test(line)) continue;
      const open = /^([A-Za-z_][\w-]*)\s*\{\s*$/.exec(line);
      if (open) { current = ensureEntity(open[1]); continue; }
      if (/^\}\s*$/.test(line)) { current = null; continue; }
      if (current) {
        const field = /^(\S+)\s+(.+?)\s*$/.exec(line);
        if (field) entities.get(current).push({ type: field[1], name: field[2] });
        continue;
      }
      const rel = /^([A-Za-z_][\w-]*)\s+([|o}{]+--[|o}{]+)\s+([A-Za-z_][\w-]*)(?:\s*:\s*"?([^"]*)"?\s*)?$/.exec(line);
      if (rel) {
        ensureEntity(rel[1]);
        ensureEntity(rel[3]);
        relations.push({ from: rel[1], to: rel[3], label: rel[4] || rel[2] });
      }
    }

    if (!entities.size) return renderCodeBlock(src, "mermaid");

    const ids = Array.from(entities.keys());
    const cols = ids.length > 2 ? 2 : 1;
    const cardW = 250;
    const gapX = 44;
    const gapY = 34;
    const heights = new Map();
    ids.forEach((id) => {
      const fields = entities.get(id);
      const h = Math.max(74, 42 + fields.length * 22);
      heights.set(id, h);
    });
    const rows = Math.ceil(ids.length / cols);
    const rowHeights = Array.from({ length: rows }, (_, row) => {
      const rowIds = ids.slice(row * cols, row * cols + cols);
      return Math.max(...rowIds.map((id) => heights.get(id)));
    });
    const rowY = [];
    rowHeights.reduce((y, h, index) => {
      rowY[index] = y;
      return y + h + gapY;
    }, 18);
    const positions = new Map();
    ids.forEach((id, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      positions.set(id, { x: 18 + col * (cardW + gapX), y: rowY[row] });
    });
    const width = 36 + cols * cardW + (cols - 1) * gapX;
    const height = rows ? rowY[rows - 1] + rowHeights[rows - 1] + 18 : 120;

    const edgeSvg = relations.map((rel) => {
      const a = positions.get(rel.from);
      const b = positions.get(rel.to);
      if (!a || !b) return "";
      const ah = heights.get(rel.from);
      const bh = heights.get(rel.to);
      const ax = a.x + cardW;
      const ay = a.y + ah / 2;
      const bx = b.x;
      const by = b.y + bh / 2;
      const sameCol = Math.abs(ax - bx) < 10;
      const x1 = sameCol ? a.x + cardW / 2 : ax;
      const y1 = sameCol ? a.y + ah : ay;
      const x2 = sameCol ? b.x + cardW / 2 : bx;
      const y2 = sameCol ? b.y : by;
      const mx = sameCol ? x1 : (x1 + x2) / 2;
      const my = sameCol ? (y1 + y2) / 2 : (y1 + y2) / 2 - 4;
      return '<path class="md-mermaid-edge" d="M' + x1 + " " + y1 + " C" + mx + " " + y1 + " " + mx + " " + y2 + " " + x2 + " " + y2 + '" fill="none" stroke-width="1.5" />'
        + (rel.label ? '<text class="md-mermaid-rel-label" x="' + mx + '" y="' + my + '" text-anchor="middle">' + escapeHtml(rel.label) + "</text>" : "");
    }).join("");

    const nodeSvg = ids.map((id) => {
      const p = positions.get(id);
      const fields = entities.get(id);
      const h = heights.get(id);
      const rows = fields.map((field, index) =>
        '<text class="md-mermaid-field" x="14" y="' + (64 + index * 22) + '"><tspan class="md-mermaid-field-type">' + escapeHtml(field.type) + '</tspan> ' + escapeHtml(field.name) + "</text>"
      ).join("");
      return '<g class="md-mermaid-node md-mermaid-er-node" transform="translate(' + p.x + " " + p.y + ')"><rect width="' + cardW + '" height="' + h + '" rx="6"/><line x1="0" x2="' + cardW + '" y1="38" y2="38"/><text class="md-mermaid-entity" x="14" y="25">' + escapeHtml(id) + "</text>" + rows + "</g>";
    }).join("");
    return mermaidWrap(src, "md-mermaid md-mermaid-er", width, height, "Mermaid ER diagram", edgeSvg + nodeSvg);
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
      const fence = /^\s*(`{3,}|~{3,})\s*([^`]*)$/.exec(line);
      if (fence) {
        const ch = fence[1][0], len = fence[1].length, info = (fence[2] || "").trim();
        const lang = (info.split(/\s+/)[0] || "").replace(/^\{\.?/, "").replace(/\}$/, "");
        const close = new RegExp("^\\s*\\" + ch + "{" + len + ",}\\s*$");
        const buf = [];
        i++;
        while (i < lines.length && !close.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // closing fence
        out.push(lang.toLowerCase() === "mermaid" ? renderMermaid(buf.join("\n")) : renderCodeBlock(buf.join("\n"), lang.toLowerCase()));
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
