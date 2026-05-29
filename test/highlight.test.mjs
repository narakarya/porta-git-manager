import { test } from "node:test";
import assert from "node:assert/strict";
import pkg from "../highlight.js";
const { langFromPath, tokenize } = pkg;

test("langFromPath maps known extensions", () => {
  assert.equal(langFromPath("src/a.ts"), "js");
  assert.equal(langFromPath("src/a.tsx"), "js");
  assert.equal(langFromPath("a.json"), "json");
  assert.equal(langFromPath("a.css"), "css");
  assert.equal(langFromPath("a.rs"), "rust");
  assert.equal(langFromPath("a.py"), "python");
});

test("langFromPath returns null for unknown", () => {
  assert.equal(langFromPath("a.xyz"), null);
  assert.equal(langFromPath("Makefile"), null);
});

test("tokenize splits keyword/string/number/comment", () => {
  const toks = tokenize(`const x = "hi" // n`, "js");
  assert.equal(toks.map(t => t.t).join(""), `const x = "hi" // n`);
  const byType = Object.fromEntries(toks.filter(t => t.type).map(t => [t.t.trim(), t.type]));
  assert.equal(byType["const"], "keyword");
  assert.equal(byType['"hi"'], "string");
  assert.equal(byType["// n"], "comment");
});

test("tokenize unknown lang returns one plain token", () => {
  const toks = tokenize("anything at all", null);
  assert.deepEqual(toks, [{ t: "anything at all", type: null }]);
});
