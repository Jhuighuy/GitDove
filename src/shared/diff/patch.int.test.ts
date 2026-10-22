import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileDiff } from "@shared/domain";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseDiff } from "../../main/git/parse";
import { buildPatch } from "./patch";

describe("buildPatch with git apply", () => {
  let dir: string;
  const git = (args: string[], input?: string) =>
    execFileSync("git", args, { cwd: dir, input, encoding: "utf8" });
  const show = (spec: string) => git(["show", spec]);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gitdove-patch-"));
    git(["init", "-q"]);
    git(["config", "user.name", "T"]);
    git(["config", "user.email", "t@x"]);
    // Keep line endings as written regardless of the machine's global config.
    git(["config", "core.autocrlf", "false"]);
    const base = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(dir, "f"), base.join("\n") + "\n");
    git(["add", "f"]);
    git(["commit", "-qm", "init"]);
    const edited = [...base];
    edited.splice(1, 2, "LINE 2", "LINE 3", "inserted");
    edited.splice(25, 1); // line 25
    edited.push("tail 1", "tail 2");
    writeFileSync(join(dir, "f"), edited.join("\n") + "\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const apply = (patch: string, opts: string[]) =>
    git(["apply", "--whitespace=nowarn", "--recount", ...opts, "-"], patch);
  const diff = (args: string[]) => parseDiff(git(["diff", ...args, "--", "f"]), "f", null, false);
  const select = (d: FileDiff, texts: string[]) => (h: number, i: number) =>
    texts.includes(d.hunks[h]!.lines[i]!.text);

  it("stages, unstages and discards individual lines", () => {
    const unstaged = diff([]);
    expect(unstaged.hunks.length).toBeGreaterThan(1);
    // Stage one replacement pair, the deletion near the end and one tail line.
    apply(
      buildPatch(unstaged, select(unstaged, ["line 2", "LINE 2", "line 25", "tail 2"]), false)!,
      ["--cached"],
    );
    const index = show(":f").split("\n");
    expect(index.slice(0, 4)).toEqual(["line 1", "LINE 2", "line 3", "line 4"]);
    expect(index).not.toContain("line 25");
    expect(index).not.toContain("tail 1");
    expect(index.slice(-2)).toEqual(["tail 2", ""]);

    // Unstage the tail line again.
    const staged = diff(["--cached"]);
    apply(buildPatch(staged, select(staged, ["tail 2"]), true)!, ["--cached", "--reverse"]);
    expect(show(":f")).not.toContain("tail");

    // Discard the inserted line from the working tree only.
    const rest = diff([]);
    apply(buildPatch(rest, select(rest, ["inserted"]), true)!, ["--reverse"]);
    const work = readFileSync(join(dir, "f"), "utf8").split("\n");
    expect(work).not.toContain("inserted");
    expect(work).toContain("LINE 3");
    expect(work).toContain("tail 1");
  });
});

/**
 * Applies patches of random line selections from random edits with `git apply`, the way the app
 * does, and checks the result: the selected lines and only those are staged, unstaged or
 * discarded, and files end with a newline unless their last line had none. Covers missing final
 * newlines and created and deleted files.
 */
describe("buildPatch property", () => {
  let dir: string;
  const git = (args: string[], input?: string) =>
    execFileSync("git", args, { cwd: dir, input, encoding: "utf8", stdio: "pipe" });
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "gitdove-patch-prop-"));
    git(["init", "-q"]);
    git(["config", "core.autocrlf", "false"]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // A deterministic generator, so that failures reproduce.
  let seed = 0;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const int = (n: number) => Math.floor(random() * n);
  const WORDS = ["a", "b", "}", "", "x"];
  const lines = (n: number) =>
    Array.from({ length: n }, () => (random() < 0.5 ? WORDS[int(WORDS.length)]! : `u${int(500)}`));
  const edit = (from: string[]) => {
    const out = [...from];
    for (let k = 1 + int(5); k > 0; k--) {
      const at = int(out.length + 1);
      const op = int(3);
      if (op === 0) out.splice(at, 0, ...lines(1 + int(3)));
      else if (op === 1) out.splice(at, 1 + int(3));
      else out.splice(at, 1 + int(2), ...lines(1 + int(3)));
    }
    return out;
  };
  const text = (ls: string[], newline: boolean) =>
    ls.length === 0 ? "" : ls.join("\n") + (newline ? "\n" : "");
  /** Lines of a file, and whether it ends with a newline. */
  const split = (s: string) => {
    const ls = s.split("\n");
    const newline = ls.at(-1) === "";
    if (newline) ls.pop();
    return { lines: s === "" ? [] : ls, newline: newline || s === "" };
  };
  const sorted = (ls: string[]) => ls.toSorted().join("\n");
  const setIndex = (content: string | null) => {
    if (content === null) {
      git(["update-index", "--force-remove", "f"]);
    } else {
      const blob = git(["hash-object", "-w", "--stdin"], content).trim();
      git(["update-index", "--add", "--cacheinfo", `100644,${blob},f`]);
    }
  };
  const readIndex = () => {
    try {
      return git(["show", ":f"]);
    } catch {
      return null;
    }
  };

  it.each([1, 2, 3])(
    "stages, unstages and discards random selections (seed %i)",
    (s) => {
      seed = s;
      const failures: string[] = [];
      for (let run = 0; run < 20; run++) {
        const kind = int(10);
        // Mostly edits; sometimes a created or deleted file.
        const oldLines = kind === 0 ? [] : lines(1 + int(20));
        const newLines = kind === 1 ? [] : edit(oldLines);
        const oldText = text(oldLines, random() < 0.6);
        const newText = text(newLines, random() < 0.6);
        if (oldText === newText) continue;
        const created = kind === 0;
        const deleted = kind === 1;
        const action = (["stage", "unstage", "discard"] as const)[int(3)]!;

        // The old side is in the index and the new one in the working tree. Unstaging applies the
        // same diff to an index holding the new side, as `git diff --cached` would show it.
        setIndex(created ? null : oldText);
        const path = join(dir, "f");
        if (deleted) rmSync(path, { force: true });
        else writeFileSync(path, newText);
        if (created) git(["add", "-N", "f"]);
        const raw = git(["diff", "--no-color", "--no-ext-diff", "--no-renames", "-U3", "--", "f"]);
        const diff = parseDiff(raw, "f", null, false);

        const picked = new Set<string>();
        diff.hunks.forEach((h, hi) =>
          h.lines.forEach((l, li) => {
            if ((l.kind === "add" || l.kind === "del") && random() < 0.5) picked.add(`${hi}:${li}`);
          }),
        );
        const patch = buildPatch(diff, (h, i) => picked.has(`${h}:${i}`), action !== "stage");
        if (!patch) continue;

        // What the selected lines should do to the side the patch applies to.
        const before = split(action === "stage" ? oldText : newText);
        const expected = [...before.lines];
        const remove = (t: string) => expected.splice(expected.indexOf(t), 1);
        diff.hunks.forEach((h, hi) =>
          h.lines.forEach((l, li) => {
            if (!picked.has(`${hi}:${li}`)) return;
            if (l.kind === (action === "stage" ? "del" : "add")) remove(l.text);
            else if (l.kind === (action === "stage" ? "add" : "del")) expected.push(l.text);
          }),
        );
        const gone = expected.length === 0 && (action === "stage" ? deleted : created);

        let result: string | null;
        try {
          if (action === "stage") {
            git(["apply", "--whitespace=nowarn", "--recount", "--cached", "-"], patch);
            result = readIndex();
          } else if (action === "unstage") {
            setIndex(deleted ? null : newText);
            git(["apply", "--whitespace=nowarn", "--recount", "--cached", "--reverse", "-"], patch);
            result = readIndex();
          } else {
            git(["apply", "--whitespace=nowarn", "--recount", "--reverse", "-"], patch);
            result = existsSync(path) ? readFileSync(path, "utf8") : null;
          }
        } catch (e) {
          failures.push(`${action}: ${(e as { stderr?: string }).stderr}\n${raw}\n${patch}`);
          continue;
        }
        const got = result === null ? null : split(result);
        const ok = gone
          ? got === null
          : got !== null &&
            sorted(got.lines) === sorted(expected) &&
            // Only a last line that had no newline on either side can lack one.
            (got.newline ||
              (!split(oldText).newline && got.lines.at(-1) === oldLines.at(-1)) ||
              (!split(newText).newline && got.lines.at(-1) === newLines.at(-1)));
        if (!ok) failures.push(`${action} gave ${JSON.stringify(result)}\n${raw}\n${patch}`);
        if (existsSync(path)) unlinkSync(path);
      }
      expect(failures.slice(0, 3)).toEqual([]);
    },
    120_000,
  );
});
