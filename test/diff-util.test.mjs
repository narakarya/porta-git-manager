import { test } from "node:test";
import assert from "node:assert/strict";
import pkg from "../diff-util.js";
const { parseHunkHeader, numberHunkLines, wordDiff, toSplitRows } = pkg;

test("parseHunkHeader reads both ranges", () => {
  assert.deepEqual(parseHunkHeader("@@ -12,6 +12,7 @@ render()"),
    { oldStart: 12, oldCount: 6, newStart: 12, newCount: 7 });
});

test("parseHunkHeader defaults count to 1 when omitted", () => {
  assert.deepEqual(parseHunkHeader("@@ -5 +6 @@"),
    { oldStart: 5, oldCount: 1, newStart: 6, newCount: 1 });
});

test("numberHunkLines assigns running old/new numbers", () => {
  const lines = [" ctx", "-gone", "+new", " tail"];
  const rows = numberHunkLines(lines, { oldStart: 10, newStart: 10 });
  assert.deepEqual(rows, [
    { kind: "ctx", text: " ctx",  oldNo: 10, newNo: 10 },
    { kind: "del", text: "-gone", oldNo: 11, newNo: null },
    { kind: "add", text: "+new",  oldNo: null, newNo: 11 },
    { kind: "ctx", text: " tail", oldNo: 12, newNo: 12 },
  ]);
});

test("numberHunkLines marks no-newline meta lines", () => {
  const rows = numberHunkLines(["\\ No newline at end of file"], { oldStart: 1, newStart: 1 });
  assert.equal(rows[0].kind, "meta");
  assert.equal(rows[0].oldNo, null);
  assert.equal(rows[0].newNo, null);
});

test("wordDiff marks only changed tokens", () => {
  const r = wordDiff("-let total = 0", "+let sum = 0");
  const changedDel = r.del.filter(x => x.changed).map(x => x.t).join("");
  const changedAdd = r.add.filter(x => x.changed).map(x => x.t).join("");
  assert.equal(changedDel, "total");
  assert.equal(changedAdd, "sum");
  assert.equal(r.del.map(x => x.t).join(""), "let total = 0");
  assert.equal(r.add.map(x => x.t).join(""), "let sum = 0");
});

test("wordDiff on identical bodies marks nothing changed", () => {
  const r = wordDiff("-same line", "+same line");
  assert.ok(r.del.every(x => !x.changed));
  assert.ok(r.add.every(x => !x.changed));
});

test("wordDiff returns null for oversized lines (guards O(n*m) blowup)", () => {
  // ~700 tokens/side → matrix exceeds the cell budget. The naive LCS would
  // allocate a multi-million-cell table and freeze the UI; the guard bails.
  const big = (seed) => "x" + Array.from({ length: 350 }, (_, i) => "a" + ((i + seed) % 2) + ",").join("");
  const start = process.hrtime.bigint();
  const r = wordDiff("-" + big(0), "+" + big(1));
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(r, null, "oversized line pair should skip word-level diff");
  assert.ok(ms < 50, `guard should bail fast, took ${ms.toFixed(1)}ms`);
});

test("wordDiff stays under the cell budget for normal lines", () => {
  // Sanity: ordinary code lines still get word-level diffs.
  const r = wordDiff("-let total = compute(a, b)", "+let sum = compute(a, c)");
  assert.notEqual(r, null);
  assert.equal(r.del.filter(x => x.changed).map(x => x.t).join(""), "totalb");
  assert.equal(r.add.filter(x => x.changed).map(x => x.t).join(""), "sumc");
});

test("toSplitRows leaves _wd null when paired lines are oversized", () => {
  const big = (seed) => Array.from({ length: 350 }, (_, i) => "a" + ((i + seed) % 2) + ",").join("");
  const numbered = [
    { kind: "del", text: "-" + big(0), oldNo: 1, newNo: null },
    { kind: "add", text: "+" + big(1), oldNo: null, newNo: 1 },
  ];
  const rows = toSplitRows(numbered);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].left._wd, null);
  assert.equal(rows[0].right._wd, null);
});

test("toSplitRows pairs adjacent del/add into left/right cells", () => {
  const numbered = [
    { kind: "ctx", text: " hi",   oldNo: 1, newNo: 1 },
    { kind: "del", text: "-old",  oldNo: 2, newNo: null },
    { kind: "add", text: "+new",  oldNo: null, newNo: 2 },
    { kind: "ctx", text: " bye",  oldNo: 3, newNo: 3 },
  ];
  const rows = toSplitRows(numbered);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].left.kind, "ctx");
  assert.equal(rows[0].right.kind, "ctx");
  assert.equal(rows[1].left.kind, "del");
  assert.equal(rows[1].right.kind, "add");
  // Paired del/add gets word-diff attached
  assert.ok(rows[1].left._wd);
  assert.ok(rows[1].right._wd);
  assert.equal(rows[1].left._wd.cls, "wd-del");
  assert.equal(rows[1].right._wd.cls, "wd-add");
});

test("toSplitRows handles uneven dels/adds (longer side spills)", () => {
  const numbered = [
    { kind: "del", text: "-a", oldNo: 1, newNo: null },
    { kind: "del", text: "-b", oldNo: 2, newNo: null },
    { kind: "add", text: "+x", oldNo: null, newNo: 1 },
  ];
  const rows = toSplitRows(numbered);
  assert.equal(rows.length, 2);
  // First row has both sides
  assert.equal(rows[0].left.kind, "del");
  assert.equal(rows[0].right.kind, "add");
  // Second row has only the leftover del; right is null
  assert.equal(rows[1].left.kind, "del");
  assert.equal(rows[1].right, null);
});

test("toSplitRows ignores meta rows", () => {
  const numbered = [
    { kind: "meta", text: "\\ No newline at end of file", oldNo: null, newNo: null },
    { kind: "ctx",  text: " x", oldNo: 1, newNo: 1 },
  ];
  const rows = toSplitRows(numbered);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].left.kind, "ctx");
});
