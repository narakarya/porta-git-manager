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
  assert.equal(langFromPath("lib/foo.ex"), "elixir");
  assert.equal(langFromPath("Gemfile"), "ruby");
  assert.equal(langFromPath("Dockerfile"), "dockerfile");
  assert.equal(langFromPath("schema.sql"), "sql");
  assert.equal(langFromPath("config.yml"), "yaml");
  assert.equal(langFromPath("main.go"), "go");
});

test("langFromPath returns null for unknown", () => {
  assert.equal(langFromPath("a.xyz"), null);
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

test("tokenize handles broader language families", () => {
  assert.equal(tokenize("defmodule A do\n# comment\nend", "elixir").find(t => t.t === "defmodule")?.type, "keyword");
  assert.equal(tokenize("SELECT * FROM users -- note", "sql").find(t => t.t === "SELECT")?.type, "keyword");
  assert.equal(tokenize("name: app", "yaml").find(t => t.t === "name")?.type, "type");
  assert.equal(tokenize("<div class=\"x\">", "html").find(t => t.t === "class")?.type, "type");
});
