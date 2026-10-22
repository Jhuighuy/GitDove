/**
 * Pure parsers for git plumbing output. No I/O here so they are easy to test.
 */
import type {
  ChangeKind,
  ConflictCode,
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

/**
 * Parses `for-each-ref --format=REFS_FORMAT`. A remote ref's remote is the longest of
 * `remotes` that its name starts with (a remote's name may contain `/`), or else its first
 * path component.
 */
export const parseRefs = (out: string, remotes: readonly string[] = []): Ref[] => {
  const byLength = remotes.toSorted((a, b) => b.length - a.length);
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
      remote = byLength.find((r) => short.startsWith(`${r}/`)) ?? short.split("/")[0] ?? null;
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

/** Parses `git remote -v`; a partial clone's fetch line ends with its filter, e.g. `[blob:none]`. */
export const parseRemotes = (out: string): Remote[] => {
  const map = new Map<string, { fetchUrl: string; pushUrl: string }>();
  for (const line of out.split("\n")) {
    const m = /^([^\t]+)\t(.*) \((fetch|push)\)(?: \[[^\]]*\])?$/.exec(line);
    if (!m) continue;
    const entry = map.get(m[1]!) ?? { fetchUrl: "", pushUrl: "" };
    if (m[3] === "fetch") entry.fetchUrl = m[2]!;
    else entry.pushUrl = m[2]!;
    map.set(m[1]!, entry);
  }
  return [...map].map(([name, e]) => ({ name, ...e }));
};

/**
 * The remote that a branch without an upstream is pushed to (by `git push`, and by `push -u`
 * here): `branch.<name>.pushRemote`, else `remote.pushDefault`, else `origin`, else the first
 * remote. `config` is `git config --get-regexp` output with those keys; settings that name no
 * remote in `remotes` are skipped. Null without remotes.
 */
export const pushRemoteOf = (
  config: string,
  remotes: readonly string[],
  branch: string | null,
): string | null => {
  let pushDefault: string | null = null;
  let branchRemote: string | null = null;
  // The last value wins, as in git.
  for (const line of config.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    const key = line.slice(0, sp);
    const value = line.slice(sp + 1);
    if (key.toLowerCase() === "remote.pushdefault") pushDefault = value;
    else if (branch !== null && key === `branch.${branch}.pushremote`) branchRemote = value;
  }
  return (
    [branchRemote, pushDefault, "origin", remotes[0]].find(
      (r): r is string => r != null && remotes.includes(r),
    ) ?? null
  );
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

/**
 * Parses `git submodule status`: a flag, the commit, the path (which may contain spaces) and,
 * for initialized submodules, ` (<describe>)`.
 */
export const parseSubmodules = (out: string): Submodule[] =>
  out.split("\n").flatMap((line): Submodule[] => {
    const m = /^(.)([0-9a-f]{40,64}) (.+?)(?: \([^()]*\))?$/.exec(line);
    if (!m) return [];
    const flag = m[1];
    return [
      {
        hash: m[2]!,
        path: m[3]!,
        status:
          flag === "-"
            ? "uninitialized"
            : flag === "+"
              ? "modified"
              : flag === "U"
                ? "conflict"
                : "ok",
      },
    ];
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

const CONFLICT_CODES = new Set<string>(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

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
      const sub = fields[2]!;
      const pathStart = type === "1" ? 8 : 9;
      const path = fields.slice(pathStart).join(" ");
      const oldPath = type === "2" ? (parts[++i] ?? null) : null;
      const x = xy[0]!;
      const y = xy[1]!;
      if (x !== ".") staged.push(change(path, kindOf(x), x === "R" || x === "C" ? oldPath : null));
      // A submodule (`S<c><m><u>`) whose commit did not change only has changes inside it,
      // which staging it cannot take: they are committed in the submodule.
      const subContentOnly = sub.startsWith("S.");
      if (y !== "." && !subContentOnly)
        unstaged.push(change(path, kindOf(y), y === "R" || y === "C" ? oldPath : null));
    } else if (type === "u") {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const fields = entry.split(" ");
      const xy = fields[1]!;
      conflicted.push({
        ...change(fields.slice(10).join(" "), "conflicted"),
        ...(CONFLICT_CODES.has(xy) ? { conflict: xy as ConflictCode } : {}),
      });
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

/** Changed files, at most `limit` of them, and how many there are in all. */
export interface ChangedFiles {
  readonly files: FileChange[];
  readonly total: number;
}

/**
 * Parses `-z --raw --numstat` diff output: `:<modes> <oids> <status>\0<path>\0[<path>\0]` per
 * file, then `<added>\t<deleted>\t<path>\0` (or `\t\0<old>\0<new>\0` for a rename) per file.
 */
export const parseRawChanges = (out: string, limit = Infinity): ChangedFiles => {
  const parts = out.split("\0");
  const files: FileChange[] = [];
  const stats = new Map<string, { additions: number | null; deletions: number | null }>();
  let total = 0;
  for (let i = 0; i < parts.length;) {
    const head = parts[i++]!.replace(/^\n+/, "");
    if (!head) continue;
    if (head.startsWith(":")) {
      const code = head.slice(head.lastIndexOf(" ") + 1)[0] ?? "M";
      const first = parts[i++] ?? "";
      const second = code === "R" || code === "C" ? (parts[i++] ?? "") : null;
      if (total++ < limit) {
        files.push(
          second === null ? change(first, kindOf(code)) : change(second, kindOf(code), first),
        );
      }
      continue;
    }
    const [a, d, path] = head.split("\t");
    let p = path;
    if (p === "") {
      i++; // old path
      p = parts[i++];
    }
    if (p === undefined || d === undefined) continue;
    stats.set(p, {
      additions: a === "-" ? null : Number(a),
      deletions: d === "-" ? null : Number(d),
    });
  }
  return {
    files: files.map((f) => {
      const s = stats.get(f.path);
      return s
        ? { ...f, additions: s.additions, deletions: s.deletions, binary: s.additions === null }
        : f;
    }),
    total,
  };
};

/** `git show` format for {@link parseCommitShow}: the body is followed by a NUL. */
export const COMMIT_FORMAT = "%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%B%x00";

/**
 * Parses `git show -z --format=COMMIT_FORMAT --raw --numstat`: the commit's fields and message,
 * then its changes (see {@link parseRawChanges}).
 */
export const parseCommitShow = (out: string, limit = Infinity) => {
  const fields: string[] = [];
  let pos = 0;
  for (let k = 0; k < 9; k++) {
    const end = out.indexOf("\0", pos);
    if (end < 0) throw new Error("Malformed commit output");
    fields.push(out.slice(pos, end));
    pos = end + 1;
  }
  const [hash, parents, an, ae, at, cn, ce, ct, message] = fields as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  return {
    hash,
    parents: parents ? parents.split(" ") : [],
    author: { name: an, email: ae, time: Number(at) },
    committer: { name: cn, email: ce, time: Number(ct) },
    message,
    changes: parseRawChanges(out.slice(pos), limit),
  };
};

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/**
 * A hunk header: `@@ -1,2 +1,3 @@` in a plain diff, `@@@ -1,2 -1,4 +1,3 @@@` (one `-` range
 * per parent, one more `@` than parents) in a combined diff of a conflicted file.
 */
const HUNK_RE = /^(@{2,}) ((?:-\d+(?:,\d+)? )+)\+(\d+)(?:,(\d+))? @{2,}/;
const RANGE_RE = /-(\d+)(?:,(\d+))?/;

/** Starts a file's section in `git diff` output. */
const SECTION_RE = /^diff --(?:git|cc|combined) /;

const GITLINK_MODE = "160000";

const utf8 = new TextDecoder("utf-8", { fatal: true });
const lossyUtf8 = new TextDecoder("utf-8");

/**
 * Decodes diff output. Invalid UTF-8 is replaced, and reported, since a patch built from the
 * replaced text would write the replacement characters into the file. A diff cut short at the
 * size limit is decoded up to its last complete line.
 */
export const decodeDiff = (
  bytes: Uint8Array,
  truncated: boolean,
): { readonly text: string; readonly lossy: boolean } => {
  const end = truncated ? bytes.lastIndexOf(10) + 1 : bytes.length;
  const complete = bytes.subarray(0, end);
  try {
    return { text: utf8.decode(complete), lossy: false };
  } catch {
    return { text: lossyUtf8.decode(complete), lossy: true };
  }
};

/** A path from a `---`/`+++` line or an extended header, unquoting C-style quoted names. */
const headerPath = (s: string): string => {
  if (!s.startsWith('"') || !s.endsWith('"')) return s;
  const bytes: number[] = [];
  const escapes: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };
  const encoder = new TextEncoder();
  for (let i = 1; i < s.length - 1; i++) {
    const c = s[i]!;
    if (c !== "\\") {
      bytes.push(...encoder.encode(c));
      continue;
    }
    const n = s[++i] ?? "";
    if (/[0-7]/.test(n)) {
      bytes.push(Number.parseInt(s.slice(i, i + 3), 8));
      i += 2;
    } else bytes.push(escapes[n] ?? n.charCodeAt(0));
  }
  return lossyUtf8.decode(new Uint8Array(bytes));
};

/** `path` without its `a/` or `b/` prefix. */
const unprefixed = (path: string, prefix: string) =>
  path.startsWith(prefix) ? path.slice(prefix.length) : path;

/** Whether a diff section is about `path`: its new side, or its old side for a deletion. */
const isSectionOf = (lines: readonly string[], path: string): boolean => {
  // Without `---`/`+++` lines (e.g. an empty file), only the `diff --git` line names it.
  if (lines[0] === `diff --git a/${path} b/${path}`) return true;
  let oldSide: string | null = null;
  for (const line of lines) {
    if (line.startsWith("@@")) break;
    // A name with a space ends with a tab, in the style of GNU diff.
    const name = (from: number) => headerPath(line.slice(from).replace(/\t$/, ""));
    if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
      return name(line.indexOf(" ", "diff --".length) + 1) === path;
    }
    if (line.startsWith("+++ ") && line !== "+++ /dev/null")
      return unprefixed(name(4), "b/") === path;
    if (line.startsWith("rename to ")) return name("rename to ".length) === path;
    if (line.startsWith("--- ") && line !== "--- /dev/null") oldSide = unprefixed(name(4), "a/");
  }
  return oldSide === path;
};

/**
 * Parses the diff of a single file. Output with several sections (e.g. a staged rename below
 * the similarity threshold, which diffs as a deletion and an addition) is narrowed to the
 * section of `path`. A combined diff of a conflicted file (`diff --cc`) is shown against the
 * first parent ("ours") and is read-only, as are submodules and text that is not valid UTF-8.
 * When the output was cut short, the last, incomplete hunk is dropped.
 */
export const parseDiff = (
  raw: string | Uint8Array,
  path: string,
  oldPath: string | null,
  truncated: boolean,
): FileDiff => {
  const decoded =
    typeof raw === "string" ? { text: raw, lossy: false } : decodeDiff(raw, truncated);
  const all = decoded.text.split("\n");
  if (all.at(-1) === "") all.pop();

  // Split into sections, and note unmerged paths (`diff --cached` prints no diff for them).
  let unmerged = false;
  const sections: string[][] = [];
  const preamble: string[] = [];
  for (const line of all) {
    if (SECTION_RE.test(line)) sections.push([line]);
    else if (line.startsWith("* Unmerged path ")) unmerged = true;
    else (sections.at(-1) ?? preamble).push(line);
  }
  const lines = sections.find((s) => isSectionOf(s, path)) ?? sections[0] ?? preamble;

  const hunks: DiffHunk[] = [];
  let binary = false;
  let created = false;
  let deleted = false;
  let combined = false;
  let mode: string | undefined;
  let gitlink = false;
  let current: {
    header: string;
    lines: DiffLine[];
    os: number;
    ol: number;
    ns: number;
    nl: number;
    /** Prefix columns: one per parent. */
    width: number;
    /** Old and new lines seen so far, to tell whether the hunk is complete. */
    seenOld: number;
    seenNew: number;
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
  for (const line of lines) {
    // Hunk lines start with one prefix character per parent, so only a header starts with "@@".
    if (line.startsWith("@@")) {
      flush();
      const m = HUNK_RE.exec(line);
      const first = RANGE_RE.exec(m?.[2] ?? "");
      const os = Number(first?.[1] ?? 0);
      const ns = Number(m?.[3] ?? 0);
      current = {
        header: line,
        lines: [],
        os,
        ol: first?.[2] === undefined ? 1 : Number(first[2]),
        ns,
        nl: m?.[4] === undefined ? 1 : Number(m[4]),
        width: m ? m[1]!.length - 1 : 1,
        seenOld: 0,
        seenNew: 0,
      };
      oldNo = os;
      newNo = ns;
      continue;
    }
    if (!current) {
      if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) binary = true;
      else if (line.startsWith("diff --cc ") || line.startsWith("diff --combined "))
        combined = true;
      else if (line.startsWith("new file mode ")) {
        created = true;
        mode = line.slice("new file mode ".length);
      } else if (line.startsWith("deleted file mode ")) {
        deleted = true;
        mode = line.slice("deleted file mode ".length);
      } else if (line.startsWith("index ") && line.endsWith(` ${GITLINK_MODE}`)) {
        gitlink = true;
      }
      continue;
    }
    if (line.startsWith("\\")) {
      current.lines.push({ kind: "meta", oldNo: null, newNo: null, text: line.slice(2) });
      continue;
    }
    const prefix = line.slice(0, current.width);
    const text = line.slice(current.width);
    if (current.width === 1) {
      if (prefix === "+") {
        current.lines.push({ kind: "add", oldNo: null, newNo: newNo++, text });
        current.seenNew++;
      } else if (prefix === "-") {
        current.lines.push({ kind: "del", oldNo: oldNo++, newNo: null, text });
        current.seenOld++;
      } else {
        current.lines.push({ kind: "context", oldNo: oldNo++, newNo: newNo++, text });
        current.seenOld++;
        current.seenNew++;
      }
      continue;
    }
    // A combined diff, seen from the first parent: a line is in the result unless a column
    // says `-` (it is in that parent only), and in the first parent unless its column says `+`.
    if (prefix.includes("-")) {
      if (prefix.startsWith("-")) {
        current.lines.push({ kind: "del", oldNo: oldNo++, newNo: null, text });
        current.seenOld++;
      }
    } else if (prefix.startsWith("+")) {
      current.lines.push({ kind: "add", oldNo: null, newNo: newNo++, text });
      current.seenNew++;
    } else {
      current.lines.push({ kind: "context", oldNo: oldNo++, newNo: newNo++, text });
      current.seenOld++;
      current.seenNew++;
    }
  }
  // Cut short at the size limit: the last hunk may be missing lines.
  if (truncated && current && current.width === 1) {
    if (current.seenOld < current.ol || current.seenNew < current.nl) current = null;
  }
  flush();
  if (mode === GITLINK_MODE) gitlink = true;

  const readOnly =
    combined || unmerged
      ? "conflict"
      : gitlink
        ? "submodule"
        : decoded.lossy
          ? "encoding"
          : undefined;
  return {
    path,
    oldPath,
    binary,
    hunks,
    truncated,
    ...(created ? { created } : {}),
    ...(deleted ? { deleted } : {}),
    ...(mode !== undefined && (created || deleted) ? { mode } : {}),
    ...(readOnly ? { readOnly } : {}),
  };
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
