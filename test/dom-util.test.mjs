import { test } from "node:test";
import assert from "node:assert/strict";
import pkg from "../dom-util.js";
const { reconcile } = pkg;

// ── Minimal DOM shim ──────────────────────────────────────────────────────
let idSeq = 0;
class FakeNode {
  constructor(tag) {
    this.nodeType = tag === "#text" ? 3 : 1;
    this.tagName = tag === "#text" ? undefined : tag.toUpperCase();
    this.childNodes = [];
    this.attrs = new Map();
    this.listeners = {};     // type -> [fn]
    this.__on = undefined;
    this.parentNode = null;
    this.nodeValue = "";
    this._id = ++idSeq;      // stable identity marker for reuse assertions
  }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get className() { return this.attrs.get("class") || ""; }
  set className(v) { this.attrs.set("class", v); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  getAttributeNames() { return [...this.attrs.keys()]; }
  appendChild(n) { return this.insertBefore(n, null); }
  append(...ns) { for (const n of ns) this.insertBefore(n, null); }
  insertBefore(n, ref) {
    if (n.parentNode) n.parentNode.removeChild(n);
    const i = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    this.childNodes.splice(i === -1 ? this.childNodes.length : i, 0, n);
    n.parentNode = this;
    return n;
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i !== -1) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  replaceChild(nw, old) {
    const i = this.childNodes.indexOf(old);
    if (i !== -1) { this.childNodes.splice(i, 1, nw); old.parentNode = null; nw.parentNode = this; }
    return old;
  }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener(t, fn) {
    const a = this.listeners[t]; if (!a) return;
    const i = a.indexOf(fn); if (i !== -1) a.splice(i, 1);
  }
}
function el(tag, attrs = {}, ...kids) {
  const n = new FakeNode(tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  for (const c of kids) n.appendChild(typeof c === "string" ? txt(c) : c);
  return n;
}
function txt(s) { const n = new FakeNode("#text"); n.nodeValue = s; return n; }
const ids = (node) => node.children.map((c) => c._id);
const keys = (node) => node.children.map((c) => c.getAttribute("data-key"));

// ── Tests ─────────────────────────────────────────────────────────────────
test("keyed nodes are reused (identity preserved) across reconcile", () => {
  const live = el("div", {}, el("li", { "data-key": "a" }), el("li", { "data-key": "b" }));
  const [aId, bId] = ids(live);
  const fresh = el("div", {}, el("li", { "data-key": "a" }), el("li", { "data-key": "b" }));
  reconcile(live, fresh);
  assert.deepEqual(ids(live), [aId, bId]);
});

test("reorder by key keeps identities and fixes order", () => {
  const live = el("div", {}, el("li", { "data-key": "a" }), el("li", { "data-key": "b" }), el("li", { "data-key": "c" }));
  const map = Object.fromEntries(live.children.map((c) => [c.getAttribute("data-key"), c._id]));
  const fresh = el("div", {}, el("li", { "data-key": "c" }), el("li", { "data-key": "a" }), el("li", { "data-key": "b" }));
  reconcile(live, fresh);
  assert.deepEqual(keys(live), ["c", "a", "b"]);
  assert.deepEqual(ids(live), [map.c, map.a, map.b]);
});

test("removed keys are dropped, new keys inserted", () => {
  const live = el("div", {}, el("li", { "data-key": "a" }), el("li", { "data-key": "b" }));
  const fresh = el("div", {}, el("li", { "data-key": "a" }), el("li", { "data-key": "c" }));
  reconcile(live, fresh);
  assert.deepEqual(keys(live), ["a", "c"]);
});

test("attributes sync: added, changed, removed", () => {
  const live = el("div", {}, el("li", { "data-key": "a", class: "old", title: "gone" }));
  const fresh = el("div", {}, el("li", { "data-key": "a", class: "new", role: "row" }));
  reconcile(live, fresh);
  const row = live.children[0];
  assert.equal(row.getAttribute("class"), "new");
  assert.equal(row.getAttribute("role"), "row");
  assert.equal(row.getAttribute("title"), null);
});

test("text node content updates without replacing element", () => {
  const live = el("div", {}, el("span", { "data-key": "s" }, "before"));
  const spanId = live.children[0]._id;
  const fresh = el("div", {}, el("span", { "data-key": "s" }, "after"));
  reconcile(live, fresh);
  assert.equal(live.children[0]._id, spanId);
  assert.equal(live.children[0].firstChild.nodeValue, "after");
});

test("swapHandlers: reused node ends up with fresh handler", () => {
  const live = el("li", { "data-key": "a" });
  const oldFn = () => "old"; live.__on = { click: oldFn }; live.addEventListener("click", oldFn);
  const fresh = el("li", { "data-key": "a" });
  const newFn = () => "new"; fresh.__on = { click: newFn };
  const parentLive = el("div", {}, live);
  reconcile(parentLive, el("div", {}, fresh));
  const row = parentLive.children[0];
  assert.equal(row.__on.click, newFn);
  assert.deepEqual(row.listeners.click, [newFn]);
});

test("data-static: children are not touched", () => {
  const live = el("div", {}, el("figure", { "data-key": "m", "data-static": "1" }, el("svg", { id: "kept" })));
  const svgId = live.children[0].children[0]._id;
  const fresh = el("div", {}, el("figure", { "data-key": "m", "data-static": "1" })); // no children
  reconcile(live, fresh);
  assert.equal(live.children[0].children[0]._id, svgId); // subtree untouched
});

test("tag change replaces the node", () => {
  const live = el("div", {}, el("span", { "data-key": "x" }));
  const oldId = live.children[0]._id;
  const fresh = el("div", {}, el("div", { "data-key": "x" }));
  reconcile(live, fresh);
  assert.equal(live.children[0].tagName, "DIV");
  assert.notEqual(live.children[0]._id, oldId);
});

test("unkeyed insert at non-terminal position preserves later existing node", () => {
  const live = el("div", {}, el("li", { "data-key": "a" }), el("span", {}, "orig"));
  const map = Object.fromEntries(live.children.map((c) => [c.getAttribute("data-key"), c._id]));
  const fresh = el("div", {}, el("span", {}, "new"), el("li", { "data-key": "a" }));
  reconcile(live, fresh);
  assert.deepEqual(live.children.map((c) => c.tagName), ["SPAN", "LI"]);
  assert.equal(live.children[0].firstChild.nodeValue, "new");
  assert.equal(live.children[1].getAttribute("data-key"), "a");
  assert.equal(live.children[1]._id, map.a); // pre-existing keyed node survived
});

test("keyed insert at non-terminal position preserves later existing keys", () => {
  const live = el("div", {}, el("li", { "data-key": "a" }), el("li", { "data-key": "b" }));
  const map = Object.fromEntries(live.children.map((c) => [c.getAttribute("data-key"), c._id]));
  const fresh = el("div", {}, el("li", { "data-key": "c" }), el("li", { "data-key": "a" }), el("li", { "data-key": "b" }));
  reconcile(live, fresh);
  assert.deepEqual(keys(live), ["c", "a", "b"]);
  assert.equal(live.children[1]._id, map.a); // existing a survived
  assert.equal(live.children[2]._id, map.b); // existing b survived
});
