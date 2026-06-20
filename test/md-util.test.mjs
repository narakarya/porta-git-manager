import { test } from "node:test";
import assert from "node:assert/strict";
import pkg from "../md-util.js";
const { render, safeUrl } = pkg;

test("renders headings and inline emphasis", () => {
  const h = render("# Title\n\nSome **bold** and *italic* and `code`.");
  assert.match(h, /<h1 class="md-h md-h1">Title<\/h1>/);
  assert.match(h, /<strong>bold<\/strong>/);
  assert.match(h, /<em>italic<\/em>/);
  assert.match(h, /<code>code<\/code>/);
});

test("escapes raw HTML in text", () => {
  const h = render("a <script>alert(1)</script> b");
  assert.doesNotMatch(h, /<script>/);
  assert.match(h, /&lt;script&gt;/);
});

test("links render with safe href and reject javascript:", () => {
  assert.match(render("[ok](https://example.com)"), /<a href="https:\/\/example\.com"[^>]*>ok<\/a>/);
  const bad = render("[x](javascript:alert(1))");
  assert.doesNotMatch(bad, /href="javascript:/);
  assert.match(bad, /\[x\]/); // left as literal text
});

test("safeUrl gates schemes", () => {
  assert.equal(safeUrl("https://a.com"), "https://a.com");
  assert.equal(safeUrl("/relative/path"), "/relative/path");
  assert.equal(safeUrl("docs/readme.md"), "docs/readme.md");
  assert.equal(safeUrl("mailto:a@b.com"), "mailto:a@b.com");
  assert.equal(safeUrl("a@b.com"), "mailto:a@b.com");
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("data:text/html,x"), null);
});

test("fenced code block escapes content", () => {
  const h = render("```js\nconst x = 1 < 2;\n```");
  assert.match(h, /<pre class="md-pre md-pre-lang" data-lang="js"><code>/);
  assert.match(h, /1 &lt; 2/);
});

test("fenced code block accepts info strings", () => {
  const h = render("```elixir title=example.ex\nfn -> :ok end\n```");
  assert.match(h, /data-lang="elixir"/);
  assert.match(h, /fn -&gt; :ok end/);
});

test("unordered + task lists", () => {
  const h = render("- a\n- b\n\n- [x] done\n- [ ] todo");
  assert.match(h, /<ul class="md-list">/);
  assert.match(h, /<li>a<\/li>/);
  assert.match(h, /type="checkbox" disabled checked/);
  assert.match(h, /type="checkbox" disabled \//); // unchecked has no "checked"
});

test("ordered list", () => {
  const h = render("1. one\n2. two");
  assert.match(h, /<ol class="md-list">/);
  assert.match(h, /<li>one<\/li>/);
});

test("blockquote and hr", () => {
  assert.match(render("> quoted"), /<blockquote class="md-quote">[\s\S]*quoted/);
  assert.match(render("---"), /<hr class="md-hr" \/>/);
});

test("table with alignment", () => {
  const h = render("| a | b |\n|:--|--:|\n| 1 | 2 |");
  assert.match(h, /<table class="md-table">/);
  assert.match(h, /<th style="text-align:left">a<\/th>/);
  assert.match(h, /<th style="text-align:right">b<\/th>/);
  assert.match(h, /<td[^>]*>1<\/td>/);
});

test("bare URL autolink", () => {
  assert.match(render("see https://example.com/x done"),
    /<a href="https:\/\/example\.com\/x"[^>]*>https:\/\/example\.com\/x<\/a>/);
});

test("renders basic mermaid flowcharts", () => {
  const h = render("```mermaid\nflowchart TD\n  A[Start] --> B[Done]\n```");
  assert.match(h, /class="md-mermaid"/);
  assert.match(h, /<svg/);
  assert.match(h, />Start</);
  assert.match(h, />Done</);
});

test("renders mermaid flowcharts with title comments and edge labels", () => {
  const h = render("```mermaid\n%% title: Which image is shown?\nflowchart TD\n  A[Store language<br/>NL] -->|Yes| B[Show NL version]\n```");
  assert.match(h, /class="md-mermaid"/);
  assert.match(h, /<svg/);
  assert.match(h, /Store language/);
  assert.match(h, /Show NL version/);
  assert.match(h, />Yes</);
});

test("renders mermaid theme comments", () => {
  const h = render("```mermaid\n%% theme: console\nflowchart TD\n  A[Start] --> B[Done]\n```");
  assert.match(h, /class="md-mermaid" data-mermaid-theme="console"/);
  assert.match(h, /<svg width="\d+" height="\d+"/);
  assert.match(h, />Done</);
});

test("wraps long mermaid flowchart labels inside nodes", () => {
  const h = render("```mermaid\nflowchart TD\n  A[GENERIC version<br/>no text — works for every language] --> B[LOCALIZED versions<br/>one per language: NL, DE, FR, ...]\n```");
  assert.match(h, /GENERIC version/);
  assert.match(h, /works for every/);
  assert.match(h, /language/);
  assert.match(h, /height="\d{3,}"/);
});

test("renders mermaid er diagrams", () => {
  const h = render("```mermaid\nerDiagram\n  products ||--o{ product_translations : \"has many\"\n  products {\n    string language\n    text description\n  }\n```");
  assert.match(h, /class="md-mermaid md-mermaid-er"/);
  assert.match(h, />products</);
  assert.match(h, /product_translations/);
  assert.match(h, /string/);
  assert.match(h, /description/);
});

test("renders mermaid state diagrams", () => {
  const h = render("```mermaid\nstateDiagram-v2\n  direction LR\n  [*] --> downloading: inserts row\n  downloading --> uploaded: Waffle.store ok\n```");
  assert.match(h, /class="md-mermaid md-mermaid-state"/);
  assert.match(h, /downloading/);
  assert.match(h, /uploaded/);
  assert.match(h, /inserts row/);
  assert.match(h, /height="180"/);
});

test("renders mermaid sequence diagrams", () => {
  const h = render("```mermaid\nsequenceDiagram\n  participant N as Nexus\n  participant I as Interblade\n  N->>I: POST /v1/batches\n  I-->>N: completed\n```");
  assert.match(h, /class="md-mermaid md-mermaid-sequence"/);
  assert.match(h, /Nexus/);
  assert.match(h, /Interblade/);
  assert.match(h, /POST \/v1\/batches/);
});

test("empty input yields empty string", () => {
  assert.equal(render(""), "");
  assert.equal(render(null), "");
});
