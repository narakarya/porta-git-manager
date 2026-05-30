import { test } from "node:test";
import assert from "node:assert/strict";
import pkg from "../file-tree.js";
const { fileTree, filterFiles } = pkg;

test("fileTree nests files into directories by /-separated path", () => {
  const files = [
    { path: "src/components/Button.tsx" },
    { path: "src/components/Card.tsx" },
    { path: "src/lib/helper.ts" },
    { path: "README.md" },
  ];
  const root = fileTree(files);
  assert.equal(root.name, "");
  assert.equal(root.files.length, 1);
  assert.equal(root.files[0]._name, "README.md");
  assert.deepEqual([...root.dirs.keys()], ["src"]);
  const src = root.dirs.get("src");
  assert.deepEqual([...src.dirs.keys()], ["components", "lib"]);
  assert.equal(src.dirs.get("components").files.length, 2);
  assert.equal(src.dirs.get("components").files[0]._name, "Button.tsx");
});

test("fileTree assigns _name as the final path segment", () => {
  const root = fileTree([{ path: "a/b/c.txt" }]);
  const c = root.dirs.get("a").dirs.get("b").files[0];
  assert.equal(c._name, "c.txt");
  assert.equal(c.path, "a/b/c.txt");
});

test("fileTree handles a root-only file (no slash)", () => {
  const root = fileTree([{ path: "single.md" }]);
  assert.equal(root.files.length, 1);
  assert.equal(root.dirs.size, 0);
});

test("fileTree preserves arbitrary file payload", () => {
  const root = fileTree([{ path: "a.js", hunks: [{ header: "@@" }], extra: 42 }]);
  const f = root.files[0];
  assert.equal(f.extra, 42);
  assert.equal(f.hunks.length, 1);
});

test("filterFiles keeps files whose path includes the query (case-insensitive)", () => {
  const files = [
    { path: "src/Foo.ts" },
    { path: "src/bar.ts" },
    { path: "docs/foo.md" },
  ];
  assert.deepEqual(filterFiles(files, "foo").map((f) => f.path),
    ["src/Foo.ts", "docs/foo.md"]);
  assert.deepEqual(filterFiles(files, "").map((f) => f.path),
    ["src/Foo.ts", "src/bar.ts", "docs/foo.md"]);
});
