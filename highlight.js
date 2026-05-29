(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GMHi = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const EXT = {
    js: "js", jsx: "js", ts: "js", tsx: "js", mjs: "js", cjs: "js",
    json: "json", css: "css", scss: "css", less: "css",
    html: "html", htm: "html", xml: "html", vue: "html", svelte: "html",
    md: "md", markdown: "md",
    sh: "shell", bash: "shell", zsh: "shell",
    rs: "rust", py: "python",
  };
  function langFromPath(p) {
    const i = p.lastIndexOf(".");
    if (i === -1) return null;
    return EXT[p.slice(i + 1).toLowerCase()] || null;
  }

  const KEYWORDS = {
    js: /\b(const|let|var|function|return|if|else|for|while|of|in|new|class|extends|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|this|super|null|undefined|true|false|switch|case|break|continue|do|yield|delete|void)\b/,
    rust: /\b(fn|let|mut|const|pub|use|mod|struct|enum|impl|trait|match|if|else|for|while|loop|return|self|Self|crate|super|where|async|await|move|ref|as|dyn|true|false|Some|None|Ok|Err)\b/,
    python: /\b(def|class|return|if|elif|else|for|while|import|from|as|with|try|except|finally|raise|lambda|yield|async|await|pass|break|continue|in|is|not|and|or|None|True|False|self)\b/,
    css: /[.#]?[-\w]+(?=\s*\{)|[-a-z]+(?=\s*:)/,
    json: /\btrue\b|\bfalse\b|\bnull\b/,
    html: /<\/?[a-zA-Z][\w-]*/,
    md: /^#{1,6}\s.*$/m,
    shell: /\b(if|then|fi|else|elif|for|while|do|done|case|esac|function|return|export|local|echo|cd|in)\b/,
  };

  // Ordered matchers shared across C-like langs; per-lang keyword swapped in.
  function tokenize(code, lang) {
    if (!lang) return [{ t: code, type: null }];
    const kw = KEYWORDS[lang];
    const toks = [];
    let i = 0;
    const push = (t, type) => { if (t) toks.push({ t, type }); };
    while (i < code.length) {
      const rest = code.slice(i);
      let m;
      if ((lang === "js" || lang === "css" || lang === "rust") && rest.startsWith("//")) {
        const nl = rest.indexOf("\n"); const end = nl === -1 ? rest.length : nl;
        push(rest.slice(0, end), "comment"); i += end; continue;
      }
      if ((lang === "python" || lang === "shell") && rest[0] === "#") {
        const nl = rest.indexOf("\n"); const end = nl === -1 ? rest.length : nl;
        push(rest.slice(0, end), "comment"); i += end; continue;
      }
      if ((m = /^(["'`])(?:\\.|(?!\1)[^\\])*\1?/.exec(rest))) { push(m[0], "string"); i += m[0].length; continue; }
      if ((m = /^\b\d[\d_.eE+-]*\b/.exec(rest))) { push(m[0], "number"); i += m[0].length; continue; }
      if (kw && (m = new RegExp("^(?:" + kw.source + ")").exec(rest)) && m[0]) { push(m[0], "keyword"); i += m[0].length; continue; }
      if ((m = /^[A-Za-z_]\w*/.exec(rest))) { push(m[0], null); i += m[0].length; continue; }
      if ((m = /^\s+/.exec(rest))) { push(m[0], null); i += m[0].length; continue; }
      push(rest[0], null); i += 1;
    }
    return toks;
  }

  return { langFromPath, tokenize };
});
