import { test } from "node:test";
import assert from "node:assert/strict";
import pkg from "../diff-util.js";
const { parseHunkHeader, numberHunkLines, wordDiff } = pkg;

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
