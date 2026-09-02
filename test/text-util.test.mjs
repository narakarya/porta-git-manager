import { test } from "node:test";
import assert from "node:assert/strict";
import pkg from "../text-util.js";
const { escapeHtml, highlightMatches, queryTerms, matchesQuery } = pkg;

test("escapeHtml escapes the dangerous five", () => {
  assert.equal(escapeHtml(`<a href="x" id='y'>&</a>`),
    "&lt;a href=&quot;x&quot; id=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
});

test("highlightMatches with empty query just escapes", () => {
  assert.equal(highlightMatches("a<b>", ""), "a&lt;b&gt;");
});

test("highlightMatches wraps case-insensitive matches in mark", () => {
  assert.equal(highlightMatches("FooBar", "bar"),
    "Foo<mark class=\"hl\">Bar</mark>");
});

test("highlightMatches escapes before marking (no XSS via filename)", () => {
  assert.equal(highlightMatches("<script>", "script"),
    "&lt;<mark class=\"hl\">script</mark>&gt;");
});

test("highlightMatches handles multiple matches", () => {
  assert.equal(highlightMatches("aXaXa", "x"),
    "a<mark class=\"hl\">X</mark>a<mark class=\"hl\">X</mark>a");
});

// ── multi-term search ───────────────────────────────────────────────────────

test("queryTerms splits on whitespace and drops the empties", () => {
  assert.deepEqual(queryTerms("  panel   TSX "), ["panel", "tsx"]);
  assert.deepEqual(queryTerms(""), []);
  assert.deepEqual(queryTerms(null), []);
});

test("matchesQuery needs every term, in any order", () => {
  const path = "src/components/app/ExtensionPanel.tsx";
  assert.ok(matchesQuery(path, "panel comp"));
  assert.ok(matchesQuery(path, "comp panel"));
  assert.ok(matchesQuery(path, "PANEL"));
  assert.ok(!matchesQuery(path, "panel store"));
});

test("an empty query matches everything", () => {
  assert.ok(matchesQuery("anything", ""));
  assert.ok(matchesQuery("anything", "   "));
});

test("highlightMatches marks every term, not just the first", () => {
  const out = highlightMatches("src/app/panel.tsx", "app panel");
  assert.equal(out, 'src/<mark class="hl">app</mark>/<mark class="hl">panel</mark>.tsx');
});

test("highlightMatches merges overlapping hits instead of nesting marks", () => {
  // "anan" and "nana" both hit inside "banana", overlapping.
  const out = highlightMatches("banana", "anan nana");
  assert.equal(out, 'b<mark class="hl">anana</mark>');
  assert.equal((out.match(/<mark/g) || []).length, 1);
});

test("highlightMatches still escapes around and inside a mark", () => {
  const out = highlightMatches('<a href="x">&', "href");
  assert.ok(out.includes('<mark class="hl">href</mark>'));
  assert.ok(!out.includes("<a "));
  assert.ok(out.includes("&amp;"));
});

test("highlightMatches leaves text alone when no term hits", () => {
  assert.equal(highlightMatches("abc", "zzz"), "abc");
});
