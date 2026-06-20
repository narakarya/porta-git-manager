import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../git-util.js";

const { FIELD_SEP, RECORD_SEP, buildRebaseTodo, buildResetCommand, parseHistoryLog, parseRebaseLog } = pkg;

test("parseRebaseLog preserves full multiline commit messages", () => {
  const raw = [
    "a1b2c3" + FIELD_SEP + "Subject one\n\nBody line one\nBody line two" + RECORD_SEP,
    "\n" + "d4e5f6" + FIELD_SEP + "Subject two" + RECORD_SEP,
  ].join("");

  assert.deepEqual(parseRebaseLog(raw), [
    { sha: "a1b2c3", msg: "Subject one\n\nBody line one\nBody line two", subject: "Subject one", op: "pick" },
    { sha: "d4e5f6", msg: "Subject two", subject: "Subject two", op: "pick" },
  ]);
});

test("parseHistoryLog keeps subject and body separately", () => {
  const raw = "a1b2c3" + FIELD_SEP + "Ada" + FIELD_SEP + "2 days ago" + FIELD_SEP
    + "a1b2c3full" + FIELD_SEP + "parent1 parent2" + FIELD_SEP
    + "Subject\n\nLonger commit body\nwith detail" + RECORD_SEP;

  assert.deepEqual(parseHistoryLog(raw), [{
    sha: "a1b2c3",
    author: "Ada",
    when: "2 days ago",
    fullSha: "a1b2c3full",
    parents: "parent1 parent2",
    msg: "Subject",
    body: "Longer commit body\nwith detail",
    fullMessage: "Subject\n\nLonger commit body\nwith detail",
  }]);
});

test("buildRebaseTodo uses message files for multiline reword messages", () => {
  const result = buildRebaseTodo([
    { sha: "a1b2c3", msg: "Original subject\n\nOriginal body", op: "reword", newMsg: "New subject\n\nNew body" },
    { sha: "d4e5f6", msg: "Keep this", op: "pick" },
  ], { messagePathFor: (_commit, index) => "/tmp/reword-" + index + ".txt" });

  assert.equal(result.todo, [
    "pick a1b2c3 Original subject",
    "exec git commit --amend -F '/tmp/reword-0.txt'",
    "pick d4e5f6 Keep this",
  ].join("\n"));
  assert.deepEqual(result.messageFiles, [
    { path: "/tmp/reword-0.txt", message: "New subject\n\nNew body" },
  ]);
});

test("buildResetCommand builds reset commands for supported modes", () => {
  assert.equal(buildResetCommand("abc123", "soft"), "reset --soft 'abc123'");
  assert.equal(buildResetCommand("abc123", "mixed"), "reset --mixed 'abc123'");
  assert.equal(buildResetCommand("abc123", "hard"), "reset --hard 'abc123'");
});

test("buildResetCommand rejects unsupported modes and empty refs", () => {
  assert.throws(() => buildResetCommand("abc123", "mixex"), /Unsupported reset mode/);
  assert.throws(() => buildResetCommand("", "soft"), /Reset target is required/);
});

test("buildResetCommand reset modes behave correctly against a real repo", () => {
  const repo = mkdtempSync(join(tmpdir(), "pgm-reset-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const runBuiltReset = (target, mode) => {
    execFileSync("sh", ["-lc", "git " + buildResetCommand(target, mode)], { cwd: repo, encoding: "utf8" });
  };
  const commit = (message, content) => {
    writeFileSync(join(repo, "file.txt"), content);
    git("add", "file.txt");
    git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  };

  git("init");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test User");
  git("config", "commit.gpgsign", "false");
  const base = commit("base", "base\n");
  commit("second", "second\n");
  const tip = commit("third", "third\n");

  runBuiltReset(base, "soft");
  assert.equal(git("rev-parse", "HEAD"), base);
  assert.equal(git("diff", "--cached", "--name-only"), "file.txt");
  assert.equal(git("diff", "--name-only"), "");

  runBuiltReset(tip, "hard");
  runBuiltReset(base, "mixed");
  assert.equal(git("rev-parse", "HEAD"), base);
  assert.equal(git("diff", "--cached", "--name-only"), "");
  assert.equal(git("diff", "--name-only"), "file.txt");

  runBuiltReset(tip, "hard");
  runBuiltReset(base, "hard");
  assert.equal(git("rev-parse", "HEAD"), base);
  assert.equal(git("diff", "--cached", "--name-only"), "");
  assert.equal(git("diff", "--name-only"), "");
  assert.equal(git("show", "--format=", "--name-only", "HEAD"), "file.txt");
});
