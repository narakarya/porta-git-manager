import { test } from "node:test";
import assert from "node:assert/strict";
import pkg from "../text-util.js";
const { escapeHtml, highlightMatches } = pkg;

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
