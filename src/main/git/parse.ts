/**
 * Pure parsers for git plumbing output. No I/O here so they are easy to test.
 */
import type {
  ChangeKind,
  DiffHunk,
  DiffLine,
  FileChange,
  FileContent,
  FileDiff,
  FileVersions,
  Ref,
  Remote,
  Stash,
  Submodule,
  WorkingStatus,
  Worktree,
} from "@shared/domain";

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

export const REFS_FORMAT = [
  "%(refname)",
  "%(objectname)",
  "%(*objectname)",
  "%(upstream)",
  "%(upstream:track,nobracket)",
  "%(HEAD)",
  "%(symref)",
].join("%00");

const parseTrack = (track: string) => {
  let ahead = 0;
  let behind = 0;
  const a = /ahead (\d+)/.exec(track);
  const b = /behind (\d+)/.exec(track);
  if (a) ahead = Number(a[1]);
  if (b) behind = Number(b[1]);
  return { ahead, behind, gone: track === "gone" };
};

export const parseRefs = (out: string): Ref[] => {
  const refs: Ref[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [name, oid, peeled, upstream, track, head, symref] = line.split("\0");
    if (!name || !oid || symref) continue;
    let kind: Ref["kind"];
    let short: string;
    let remote: string | null = null;
    if (name.startsWith("refs/heads/")) {
      kind = "branch";
      short = name.slice("refs/heads/".length);
    } else if (name.startsWith("refs/remotes/")) {
      kind = "remote";
      short = name.slice("refs/remotes/".length);
      remote = short.split("/")[0] ?? null;
    } else if (name.startsWith("refs/tags/")) {
      kind = "tag";
      short = name.slice("refs/tags/".length);
    } else {
      continue;
    }
    const t = parseTrack(track ?? "");
    refs.push({
      name,
      short,
      kind,
      hash: peeled || oid,
      upstream: upstream || null,
      ahead: t.ahead,
      behind: t.behind,
      upstreamGone: t.gone,
      isHead: head === "*",
      remote,
    });
  }
  return refs;
};

export const STASH_FORMAT = "%H%x00%P%x00%ct%x00%gs";

export interface StashEntry extends Stash {
  readonly parents: readonly string[];
}

export const parseStashes = (out: string): StashEntry[] =>
  out
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      const [hash, parents, time, subject] = line.split("\0");
      return {
        index,
        name: `stash@{${index}}`,
        hash: hash!,
        parents: parents ? parents.split(" ") : [],
        time: Number(time),
        message: subject ?? "",
      };
    });

export const parseRemotes = (out: string): Remote[] => {
  const map = new Map<string, { fetchUrl: string; pushUrl: string }>();
  for (const line of out.split("\n")) {
    const m = /^([^\t]+)\t(.*) \((fetch|push)\)$/.exec(line);
    if (!m) continue;
    const entry = map.get(m[1]!) ?? { fetchUrl: "", pushUrl: "" };
    if (m[3] === "fetch") entry.fetchUrl = m[2]!;
    else entry.pushUrl = m[2]!;
    map.set(m[1]!, entry);
  }
  return [...map].map(([name, e]) => ({ name, ...e }));
};

export const parseWorktrees = (out: string): Worktree[] => {
  const result: Worktree[] = [];
  for (const block of out.split("\n\n")) {
    if (!block.trim()) continue;
    let path = "";
    let hash: string | null = null;
    let branch: string | null = null;
    let locked = false;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice(9);
      else if (line.startsWith("HEAD ")) hash = line.slice(5);
      else if (line.startsWith("branch ")) branch = line.slice(7).replace(/^refs\/heads\//, "");
      else if (line === "locked" || line.startsWith("locked ")) locked = true;
    }
    result.push({ path, hash, branch, isMain: result.length === 0, locked });
  }
  return result;
};

export const parseSubmodules = (out: string): Submodule[] =>
  out
    .split("\n")
    .filter((l) => l.length > 41)
    .map((line) => {
      const flag = line[0];
      const [hash, path] = line.slice(1).trim().split(/\s+/);
      return {
        hash: hash!,
        path: path!,
        status:
          flag === "-"
            ? "uninitialized"
            : flag === "+"
              ? "modified"
              : flag === "U"
                ? "conflict"
                : "ok",
      };
    });

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const kindOf = (code: string): ChangeKind => {
  switch (code) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "typechange";
    case "U":
      return "conflicted";
    default:
      return "modified";
  }
};

const change = (path: string, kind: ChangeKind, oldPath: string | null = null): FileChange => ({
  path,
  oldPath,
  kind,
  additions: null,
  deletions: null,
  binary: false,
});

/** Parses `git status --porcelain=v2 -z`. */
export const parseStatus = (buf: string, limit = 20000): WorkingStatus => {
  const staged: FileChange[] = [];
  const unstaged: FileChange[] = [];
  const conflicted: FileChange[] = [];
  const parts = buf.split("\0");
  let truncated = false;
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (!entry) continue;
    if (staged.length + unstaged.length + conflicted.length >= limit) {
      truncated = true;
      break;
    }
    const type = entry[0];
    if (type === "1" || type === "2") {
      // 1 XY sub mH mI mW hH hI path
      // 2 XY sub mH mI mW hH hI Xscore path\0origPath
      const fields = entry.split(" ");
      const xy = fields[1]!;
      const pathStart = type === "1" ? 8 : 9;
      const path = fields.slice(pathStart).join(" ");
      const oldPath = type === "2" ? (parts[++i] ?? null) : null;
      const x = xy[0]!;
      const y = xy[1]!;
      if (x !== ".") staged.push(change(path, kindOf(x), x === "R" || x === "C" ? oldPath : null));
      if (y !== ".")
        unstaged.push(change(path, kindOf(y), y === "R" || y === "C" ? oldPath : null));
    } else if (type === "u") {
      const fields = entry.split(" ");
      conflicted.push(change(fields.slice(10).join(" "), "conflicted"));
    } else if (type === "?") {
      unstaged.push(change(entry.slice(2), "untracked"));
    }
  }
  const byPath = (a: FileChange, b: FileChange) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  staged.sort(byPath);
  unstaged.sort(byPath);
  conflicted.sort(byPath);
  return { staged, unstaged, conflicted, truncated };
};

// ---------------------------------------------------------------------------
// Commit files
// ---------------------------------------------------------------------------

/** Parses `git diff-tree -z --name-status` output. */
export const parseNameStatus = (out: string): FileChange[] => {
  const parts = out.split("\0");
  const files: FileChange[] = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i++];
    if (!status) continue;
    const code = status[0]!;
    if (code === "R" || code === "C") {
      const oldPath = parts[i++]!;
      const path = parts[i++]!;
      files.push(change(path, kindOf(code), oldPath));
    } else {
      files.push(change(parts[i++]!, kindOf(code)));
    }
  }
  return files;
};

/** Parses `git diff-tree -z --numstat` output into a map keyed by new path. */
export const parseNumstat = (
  out: string,
): Map<string, { additions: number | null; deletions: number | null }> => {
  const parts = out.split("\0");
  const map = new Map<string, { additions: number | null; deletions: number | null }>();
  for (let i = 0; i < parts.length;) {
    const head = parts[i++];
    if (!head) continue;
    const [a, d, path] = head.split("\t");
    let p = path;
    if (p === "") {
      i++; // old path
      p = parts[i++];
    }
    if (p === undefined) continue;
    map.set(p, {
      additions: a === "-" ? null : Number(a),
      deletions: d === "-" ? null : Number(d),
    });
  }
  return map;
};

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parses a single-file unified diff. */
export const parseDiff = (
  text: string,
  path: string,
  oldPath: string | null,
  truncated: boolean,
): FileDiff => {
  const hunks: DiffHunk[] = [];
  let binary = false;
  let current: {
    header: string;
    lines: DiffLine[];
    os: number;
    ol: number;
    ns: number;
    nl: number;
  } | null = null;
  let oldNo = 0;
  let newNo = 0;
  const flush = () => {
    if (current) {
      hunks.push({
        header: current.header,
        oldStart: current.os,
        oldLines: current.ol,
        newStart: current.ns,
        newLines: current.nl,
        lines: current.lines,
      });
    }
  };
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (line.startsWith("@@")) {
      flush();
      const m = HUNK_RE.exec(line);
      const os = Number(m?.[1] ?? 0);
      const ns = Number(m?.[3] ?? 0);
      current = {
        header: line,
        lines: [],
        os,
        ol: m?.[2] === undefined ? 1 : Number(m[2]),
        ns,
        nl: m?.[4] === undefined ? 1 : Number(m[4]),
      };
      oldNo = os;
      newNo = ns;
      continue;
    }
    if (!current) {
      if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) binary = true;
      continue;
    }
    const c = line[0];
    if (c === "+")
      current.lines.push({ kind: "add", oldNo: null, newNo: newNo++, text: line.slice(1) });
    else if (c === "-")
      current.lines.push({ kind: "del", oldNo: oldNo++, newNo: null, text: line.slice(1) });
    else if (c === "\\")
      current.lines.push({ kind: "meta", oldNo: null, newNo: null, text: line.slice(2) });
    else
      current.lines.push({ kind: "context", oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
  }
  flush();
  return { path, oldPath, binary, hunks, truncated };
};

// ---------------------------------------------------------------------------
// File versions
// ---------------------------------------------------------------------------

/**
 * Parses the output of `FILE_VERSIONS_SCRIPT`: for each side a header line
 * (`missing`, `large <size>`, `blob <size>` followed by that many bytes, or
 * `file` followed by the rest of the output), old side first.
 */
export const parseFileVersions = (out: Uint8Array, truncated: boolean): FileVersions => {
  // Sides are copied out so that they do not keep the whole output alive.
  let pos = 0;
  const side = (): FileContent => {
    const nl = out.indexOf(10, pos);
    if (nl < 0) throw new Error("Malformed file versions output");
    const [kind, size] = new TextDecoder().decode(out.subarray(pos, nl)).split(" ");
    pos = nl + 1;
    switch (kind) {
      case "missing":
        return { kind: "missing" };
      case "large":
        return { kind: "large", size: Number(size) };
      case "blob": {
        const end = pos + Number(size);
        if (end > out.length) throw new Error("Malformed file versions output");
        const bytes = new Uint8Array(out.subarray(pos, end));
        pos = end;
        return { kind: "blob", bytes };
      }
      case "file": {
        // The working tree file is always last; it was cut short if it grew past the limit.
        const bytes = new Uint8Array(out.subarray(pos));
        pos = out.length;
        return truncated ? { kind: "large", size: bytes.length } : { kind: "blob", bytes };
      }
      default:
        throw new Error(`Malformed file versions output: ${kind}`);
    }
  };
  const old = side();
  return { old, new: side() };
};
