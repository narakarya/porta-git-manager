import { test } from "node:test";
import assert from "node:assert/strict";
import pkg from "../status-util.js";

const { parsePorcelain, parsePorcelainV2, statusClass, submoduleSummary } = pkg;

test("parsePorcelainV2 treats untracked directories as unstaged untracked files", () => {
  const s = parsePorcelainV2("? priv/\n");
  assert.deepEqual(s.staged, []);
  assert.deepEqual(s.unstaged, [{ code: "?", path: "priv/", untracked: true }]);
});

test("parsePorcelain keeps v1 double-question untracked paths intact", () => {
  const s = parsePorcelain("?? priv/\n");
  assert.deepEqual(s.unstaged, [{ code: "?", path: "priv/", untracked: true }]);
});

test("parsePorcelainV2 preserves submodule dirty details", () => {
  const s = parsePorcelainV2("1 .M S..U 160000 160000 160000 abc abc priv\n");
  assert.deepEqual(s.staged, []);
  assert.equal(s.unstaged.length, 1);
  assert.equal(s.unstaged[0].path, "priv");
  assert.equal(s.unstaged[0].code, "M");
  assert.equal(s.unstaged[0].submodule, true);
  assert.equal(s.unstaged[0].submoduleStatus, "S..U");
  assert.equal(s.unstaged[0].submoduleSummary, "untracked files");
});

test("parsePorcelainV2 keeps conflicted paths visible", () => {
  const s = parsePorcelainV2("u UU N... 100644 100644 100644 100644 abc def ghi conflict.txt\n");
  assert.deepEqual(s.staged, []);
  assert.deepEqual(s.unstaged, [{ code: "U", path: "conflict.txt" }]);
});

test("submoduleSummary combines modified and untracked flags", () => {
  assert.equal(submoduleSummary("S.MU"), "modified files, untracked files");
  assert.equal(submoduleSummary("SC.."), "commit changed");
});

test("statusClass maps untracked marker", () => {
  assert.equal(statusClass("?"), "untracked");
});
