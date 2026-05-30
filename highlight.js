(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GMHi = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const EXT = {
    js: "js", jsx: "js", ts: "js", tsx: "js", mjs: "js", cjs: "js",
    java: "java", kt: "java", kts: "java", scala: "java",
    c: "c", h: "c", cpp: "c", cc: "c", cxx: "c", hpp: "c", cs: "c",
    go: "go",
    php: "php",
    rb: "ruby", erb: "ruby", rake: "ruby",
    ex: "elixir", exs: "elixir", heex: "html", eex: "html",
    json: "json", css: "css", scss: "css", less: "css",
    yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini", env: "shell",
    sql: "sql", ddl: "sql",
    html: "html", htm: "html", xml: "html", vue: "html", svelte: "html",
    md: "md", markdown: "md",
    sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
    dockerfile: "dockerfile",
    rs: "rust", py: "python",
  };
  function langFromPath(p) {
    const base = String(p || "").split("/").pop().toLowerCase();
    if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
    if (base === "makefile" || base.endsWith(".mk")) return "make";
    if (base === "gemfile" || base === "rakefile") return "ruby";
    const i = p.lastIndexOf(".");
    if (i === -1) return null;
    return EXT[p.slice(i + 1).toLowerCase()] || null;
  }

  const KEYWORDS = {
    js: /\b(const|let|var|function|return|if|else|for|while|of|in|new|class|extends|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|this|super|null|undefined|true|false|switch|case|break|continue|do|yield|delete|void)\b/,
    java: /\b(class|interface|enum|extends|implements|public|private|protected|static|final|void|return|if|else|for|while|do|switch|case|break|continue|try|catch|finally|throw|throws|new|this|super|null|true|false|package|import|var|val|fun|object|when|sealed|data)\b/,
    c: /\b(auto|break|case|char|const|continue|default|do|double|else|enum|extern|float|for|if|inline|int|long|register|restrict|return|short|signed|sizeof|static|struct|switch|typedef|union|unsigned|void|volatile|while|class|namespace|template|typename|using|public|private|protected|virtual|override|nullptr|true|false|new|delete)\b/,
    go: /\b(break|default|func|interface|select|case|defer|go|map|struct|chan|else|goto|package|switch|const|fallthrough|if|range|type|continue|for|import|return|var|nil|true|false)\b/,
    php: /\b(abstract|and|array|as|break|callable|case|catch|class|clone|const|continue|declare|default|do|echo|else|elseif|empty|enddeclare|endfor|endforeach|endif|endswitch|endwhile|extends|final|finally|fn|for|foreach|function|global|if|implements|include|instanceof|interface|isset|namespace|new|or|private|protected|public|require|return|static|switch|throw|trait|try|use|var|while|yield|null|true|false)\b/,
    ruby: /\b(BEGIN|END|alias|and|begin|break|case|class|def|defined\?|do|else|elsif|end|ensure|false|for|if|in|module|next|nil|not|or|redo|rescue|retry|return|self|super|then|true|undef|unless|until|when|while|yield)\b/,
    elixir: /\b(def|defp|defmodule|defmacro|defdelegate|defstruct|defprotocol|defimpl|alias|import|require|use|case|cond|if|else|unless|try|rescue|catch|after|for|with|do|end|fn|true|false|nil|when|and|or|not|in)\b/,
    rust: /\b(fn|let|mut|const|pub|use|mod|struct|enum|impl|trait|match|if|else|for|while|loop|return|self|Self|crate|super|where|async|await|move|ref|as|dyn|true|false|Some|None|Ok|Err)\b/,
    python: /\b(def|class|return|if|elif|else|for|while|import|from|as|with|try|except|finally|raise|lambda|yield|async|await|pass|break|continue|in|is|not|and|or|None|True|False|self)\b/,
    css: /[.#]?[-\w]+(?=\s*\{)|[-a-z]+(?=\s*:)/,
    json: /\btrue\b|\bfalse\b|\bnull\b/,
    html: /<\/?[a-zA-Z][\w-]*|[\w:-]+(?=\=)/,
    md: /^#{1,6}\s.*$/m,
    shell: /\b(if|then|fi|else|elif|for|while|do|done|case|esac|function|return|export|local|echo|cd|in)\b/,
    dockerfile: /\b(FROM|RUN|CMD|LABEL|MAINTAINER|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL|AS)\b/,
    make: /^[A-Za-z0-9_.-]+(?=\s*:)|\b(ifneq|ifeq|ifdef|ifndef|else|endif|include|define|endef|export|override|private|vpath)\b/,
    sql: /\b(SELECT|FROM|WHERE|JOIN|INNER|LEFT|RIGHT|FULL|OUTER|ON|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|ALTER|DROP|TABLE|VIEW|INDEX|PRIMARY|KEY|FOREIGN|REFERENCES|CONSTRAINT|NOT|NULL|DEFAULT|UNIQUE|CHECK|AND|OR|AS|DISTINCT|UNION|ALL|CASE|WHEN|THEN|ELSE|END|WITH|RETURNING|TRUE|FALSE)\b/i,
    yaml: /^[\w.-]+(?=\s*:)|\b(true|false|null|yes|no|on|off)\b/i,
    toml: /^[\w.-]+(?=\s*=)|\b(true|false)\b/i,
    ini: /^[\w.-]+(?=\s*=)|^\s*\[[^\]]+\]/,
  };

  const C_LIKE = new Set(["js", "java", "c", "go", "php", "rust"]);
  const HASH_COMMENT = new Set(["python", "shell", "ruby", "elixir", "yaml", "toml", "ini", "dockerfile", "make"]);
  const DASH_COMMENT = new Set(["sql"]);

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
      if (C_LIKE.has(lang) && rest.startsWith("//")) {
        const nl = rest.indexOf("\n"); const end = nl === -1 ? rest.length : nl;
        push(rest.slice(0, end), "comment"); i += end; continue;
      }
      if (C_LIKE.has(lang) && rest.startsWith("/*")) {
        const end = rest.indexOf("*/", 2);
        const len = end === -1 ? rest.length : end + 2;
        push(rest.slice(0, len), "comment"); i += len; continue;
      }
      if (HASH_COMMENT.has(lang) && rest[0] === "#") {
        const nl = rest.indexOf("\n"); const end = nl === -1 ? rest.length : nl;
        push(rest.slice(0, end), "comment"); i += end; continue;
      }
      if (DASH_COMMENT.has(lang) && rest.startsWith("--")) {
        const nl = rest.indexOf("\n"); const end = nl === -1 ? rest.length : nl;
        push(rest.slice(0, end), "comment"); i += end; continue;
      }
      if ((m = /^(["'`])(?:\\.|(?!\1)[^\\])*\1?/.exec(rest))) { push(m[0], "string"); i += m[0].length; continue; }
      if ((m = /^\b\d[\d_.eE+-]*\b/.exec(rest))) { push(m[0], "number"); i += m[0].length; continue; }
      if (lang === "html" && (m = /^<\/?[A-Za-z][\w:-]*/.exec(rest))) { push(m[0], "keyword"); i += m[0].length; continue; }
      if (lang === "html" && (m = /^[\w:-]+(?=\=)/.exec(rest))) { push(m[0], "type"); i += m[0].length; continue; }
      if ((lang === "yaml" || lang === "toml" || lang === "ini") && (m = /^[A-Za-z0-9_.-]+(?=\s*[:=])/.exec(rest))) { push(m[0], "type"); i += m[0].length; continue; }
      if (lang === "css" && (m = /^--[-\w]+|^[-a-z]+(?=\s*:)/.exec(rest))) { push(m[0], "type"); i += m[0].length; continue; }
      if ((lang === "ruby" || lang === "elixir") && (m = /^:[A-Za-z_]\w*[!?=]?/.exec(rest))) { push(m[0], "number"); i += m[0].length; continue; }
      if (kw && (m = new RegExp("^(?:" + kw.source + ")").exec(rest)) && m[0]) { push(m[0], "keyword"); i += m[0].length; continue; }
      if ((m = /^[A-Za-z_]\w*/.exec(rest))) { push(m[0], null); i += m[0].length; continue; }
      if ((m = /^\s+/.exec(rest))) { push(m[0], null); i += m[0].length; continue; }
      push(rest[0], null); i += 1;
    }
    return toks;
  }

  return { langFromPath, tokenize };
});
