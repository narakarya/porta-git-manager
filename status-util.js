(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GMStatus = factory();
})(typeof self !== "undefined" ? self : this, function () {
  function cleanPath(path) {
    return String(path || "").replace(/^"|"$/g, "");
  }

  function codeFromXY(x, y) {
    if (x !== " " && x !== "." && x !== "?") return x;
    if (y !== " " && y !== ".") return y;
    return x === "?" ? "?" : "M";
  }

  function submoduleSummary(flags) {
    if (!flags || flags[0] !== "S") return "";
    const parts = [];
    if (flags[1] === "C") parts.push("commit changed");
    if (flags[2] === "M") parts.push("modified files");
    if (flags[3] === "U") parts.push("untracked files");
    return parts.join(", ") || "dirty";
  }

  function parsePorcelainV1(text) {
    const staged = [], unstaged = [];
    for (const line of String(text || "").split("\n").filter(Boolean)) {
      if (line.length < 3) continue;
      const x = line[0], y = line[1];
      const path = cleanPath(line.slice(3));
      if (x !== " " && x !== "?") staged.push({ code: x, path });
      if (y !== " " || x === "?") unstaged.push({ code: y === " " ? x : y, path, untracked: x === "?" });
    }
    return { staged, unstaged };
  }

  function parsePorcelainV2(text) {
    const staged = [], unstaged = [];
    for (const line of String(text || "").split("\n").filter(Boolean)) {
      const type = line[0];
      if (type === "?") {
        unstaged.push({ code: "?", path: cleanPath(line.slice(2)), untracked: true });
        continue;
      }
      if (type !== "1" && type !== "2" && type !== "u") continue;

      const parts = line.split(" ");
      const xy = parts[1] || "..";
      const sub = parts[2] || "N...";
      const pathIndex = type === "u" ? 10 : type === "2" ? 9 : 8;
      const rawPath = parts.slice(pathIndex).join(" ").split("\t")[0];
      const path = cleanPath(rawPath);
      const x = xy[0], y = xy[1];
      const file = {
        code: type === "u" ? "U" : codeFromXY(x, y),
        path,
      };
      if (sub[0] === "S") {
        file.submodule = true;
        file.submoduleStatus = sub;
        file.submoduleSummary = submoduleSummary(sub);
      }
      if (type === "u") {
        unstaged.push(file);
      } else {
        if (x !== "." && x !== "?") staged.push(Object.assign({}, file, { code: x }));
        if (y !== "." || file.submodule) unstaged.push(file);
      }
    }
    return { staged, unstaged };
  }

  function parsePorcelain(text) {
    const first = String(text || "").split("\n").find(Boolean) || "";
    return first[0] === "1" || first[0] === "2" || first.startsWith("? ") || first[0] === "u"
      ? parsePorcelainV2(text)
      : parsePorcelainV1(text);
  }

  function statusClass(code) {
    return ({ M: "modified", A: "added", D: "deleted", R: "renamed", U: "modified", "?": "untracked" })[code] || "modified";
  }

  return { parsePorcelain, parsePorcelainV1, parsePorcelainV2, statusClass, submoduleSummary };
});
