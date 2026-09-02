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

test("fileTree treats trailing-slash paths (untracked dirs) as leaves with slash in _name", () => {
  // git status reports untracked directories as ".claude/". The naive
  // split would create a `.claude` dir node plus an empty-name file
  // child: two visual rows for one logical entry. The tree should keep
  // it as a single selectable leaf while still marking it as a directory.
  const root = fileTree([{ path: ".claude/" }, { path: "assets/js/hooks/" }]);
  assert.equal(root.files.length, 1);
  assert.equal(root.files[0]._name, ".claude/");
  assert.equal(root.files[0].path, ".claude/");
  assert.equal(root.files[0]._isDirectory, true);
  // Second one: parent dirs created, leaf at deepest dir.
  const assets = root.dirs.get("assets");
  const js = assets.dirs.get("js");
  assert.equal(js.files.length, 1);
  assert.equal(js.files[0]._name, "hooks/");
  assert.equal(js.files[0]._isDirectory, true);
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

test("filterFiles matches every term in any order", () => {
  const files = [
    { path: "src/components/app/ExtensionPanel.tsx" },
    { path: "src/store/subscriptions.ts" },
    { path: "src-tauri/src/log_rotation.rs" },
  ];
  assert.deepEqual(filterFiles(files, "panel comp").map((f) => f.path),
    ["src/components/app/ExtensionPanel.tsx"]);
  assert.deepEqual(filterFiles(files, "comp panel").map((f) => f.path),
    ["src/components/app/ExtensionPanel.tsx"]);
  assert.equal(filterFiles(files, "panel store").length, 0);
});

test("filterFiles returns a copy for an empty or blank query", () => {
  const files = [{ path: "a.ts" }];
  assert.deepEqual(filterFiles(files, "").map((f) => f.path), ["a.ts"]);
  assert.deepEqual(filterFiles(files, "   ").map((f) => f.path), ["a.ts"]);
  assert.notEqual(filterFiles(files, ""), files);
});

test("filterFiles uses the matcher it is handed", () => {
  const files = [{ path: "a.ts" }, { path: "b.ts" }];
  const only = (text) => text === "b.ts";
  assert.deepEqual(filterFiles(files, "x", only).map((f) => f.path), ["b.ts"]);
});
