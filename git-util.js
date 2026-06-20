(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GMGitUtil = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const FIELD_SEP = "\x1f";
  const RECORD_SEP = "\x1e";

  function shellQuote(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
  }

  function splitFirst(s, sep) {
    const i = s.indexOf(sep);
    return i === -1 ? [s, ""] : [s.slice(0, i), s.slice(i + sep.length)];
  }

  function cleanRecord(record) {
    return String(record || "").replace(/^\n+/, "");
  }

  function cleanMessage(message) {
    return String(message || "").replace(/\s+$/, "");
  }

  function subjectOf(message) {
    return cleanMessage(message).split(/\r?\n/, 1)[0] || "";
  }

  function bodyOf(message) {
    const lines = cleanMessage(message).split(/\r?\n/);
    if (lines.length <= 1) return "";
    return lines.slice(1).join("\n").replace(/^\n/, "");
  }

  function todoSubject(message) {
    return subjectOf(message).replace(/\s+/g, " ").trim();
  }

  function parseRebaseLog(text, fieldSep = FIELD_SEP, recordSep = RECORD_SEP) {
    return String(text || "")
      .split(recordSep)
      .map(cleanRecord)
      .filter(Boolean)
      .map((record) => {
        const [sha, rawMessage] = splitFirst(record, fieldSep);
        const msg = cleanMessage(rawMessage);
        return { sha, msg, subject: subjectOf(msg), op: "pick" };
      })
      .filter((commit) => commit.sha);
  }

  function parseHistoryLog(text, fieldSep = FIELD_SEP, recordSep = RECORD_SEP) {
    return String(text || "")
      .split(recordSep)
      .map(cleanRecord)
      .filter(Boolean)
      .map((record) => {
        let rest = record;
        const fields = [];
        for (let i = 0; i < 5; i++) {
          const pair = splitFirst(rest, fieldSep);
          fields.push(pair[0]);
          rest = pair[1];
        }
        const fullMessage = cleanMessage(rest);
        return {
          sha: fields[0],
          author: fields[1],
          when: fields[2],
          fullSha: fields[3],
          parents: (fields[4] || "").trim(),
          msg: subjectOf(fullMessage),
          body: bodyOf(fullMessage),
          fullMessage,
        };
      })
      .filter((commit) => commit.sha);
  }

  function buildRebaseTodo(plan, opts = {}) {
    const messagePathFor = opts.messagePathFor || ((_commit, index) => "porta-reword-" + index + ".txt");
    const lines = [];
    const messageFiles = [];

    for (let i = 0; i < plan.length; i++) {
      const c = plan[i];
      if (c.op === "drop") continue;

      const subject = todoSubject(c.subject || c.msg);
      if (c.op === "reword") {
        const message = cleanMessage(c.newMsg);
        if (!message.trim()) {
          throw new Error(`Commit ${c.sha} is marked reword but has no new message. Re-select to enter one.`);
        }
        const path = messagePathFor(c, messageFiles.length);
        messageFiles.push({ path, message });
        lines.push(`pick ${c.sha} ${subject}`);
        lines.push(`exec git commit --amend -F ${shellQuote(path)}`);
      } else {
        lines.push(`${c.op} ${c.sha} ${subject}`);
      }
    }

    return { todo: lines.join("\n"), messageFiles };
  }

  function buildResetCommand(commitRef, mode) {
    const normalizedMode = String(mode || "").trim();
    if (!["soft", "mixed", "hard"].includes(normalizedMode)) {
      throw new Error("Unsupported reset mode: " + normalizedMode);
    }
    const ref = String(commitRef || "").trim();
    if (!ref) throw new Error("Reset target is required.");
    return "reset --" + normalizedMode + " " + shellQuote(ref);
  }

  return {
    FIELD_SEP,
    RECORD_SEP,
    buildResetCommand,
    buildRebaseTodo,
    parseHistoryLog,
    parseRebaseLog,
    shellQuote,
    subjectOf,
    bodyOf,
  };
});
