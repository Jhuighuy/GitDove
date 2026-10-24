/** Merges, rebases, cherry-picks and reverts that stop on conflicts, and how they end. See `repository.fixture.ts` for the setup. */
import { findConflicts, resolvePatch } from "@shared/diff/conflicts";
import { describe, expect, it } from "vitest";
import { noShell, targets, useRepoFixture } from "./repository.fixture";

describe.skipIf(noShell).each(targets)("Repository conflicts on %s", (hostId) => {
  const t = useRepoFixture(hostId);
  const { run, fails, sh } = t;

  describe("conflicts", () => {
    /** Leaves `main` and `side` with conflicting edits to f.txt. */
    const diverge = async () => {
      await run(t.repo.createBranch("side", "HEAD", true));
      await sh("echo side > f.txt && git commit -qam side");
      await run(t.repo.checkout("main"));
      await sh("echo main > f.txt && git commit -qam main");
    };
    const state = async () => (await run(t.repo.info())).state;
    const resolve = async () => {
      await sh("echo resolved > f.txt");
      await run(t.repo.stage(["f.txt"]));
    };

    it("aborts and continues a merge", async () => {
      await diverge();
      expect((await fails(t.repo.merge("side", {})))._tag).toBe("CommandError");
      expect(await state()).toBe("merging");
      expect((await run(t.repo.status())).conflicted.map((f) => f.path)).toEqual(["f.txt"]);
      await run(t.repo.abortOperation());
      expect(await state()).toBe("clean");

      await fails(t.repo.merge("side", {}));
      await resolve();
      await run(t.repo.continueOperation());
      expect(await state()).toBe("clean");
      expect(await sh("git log -1 --format=%p")).toContain(" ");
    });

    it("shows a conflicted file against ours, read-only", async () => {
      await diverge();
      await fails(t.repo.merge("side", {}));
      expect((await run(t.repo.status())).conflicted).toMatchObject([
        { path: "f.txt", conflict: "UU" },
      ]);
      const working = await run(t.repo.diff({ kind: "unstaged", path: "f.txt" }));
      expect(working.readOnly).toBe("conflict");
      const lines = working.hunks.flatMap((h) => h.lines.map((l) => [l.kind, l.text]));
      expect(lines).toContainEqual(["add", "<<<<<<< HEAD"]);
      expect(lines).toContainEqual(["context", "main"]);
      expect(lines).toContainEqual(["add", "side"]);
      expect(working.hunks[0]!.oldStart).toBe(1);
      const staged = await run(t.repo.diff({ kind: "staged", path: "f.txt" }));
      expect(staged).toMatchObject({ hunks: [], readOnly: "conflict" });
    });

    it("resolves blocks of conflict markers with patches", async () => {
      await run(t.repo.createBranch("side", "HEAD", true));
      await sh("printf 'a\\nS1\\nc\\nd\\ne\\nf\\ng\\nh\\nS2\\n' > f.txt && git commit -qam side");
      await run(t.repo.checkout("main"));
      await sh("printf 'a\\nM1\\nc\\nd\\ne\\nf\\ng\\nh\\nM2\\n' > f.txt && git commit -qam main");
      await fails(t.repo.merge("side", {}));
      const target = { kind: "unstaged", path: "f.txt" } as const;
      const diff = await run(t.repo.diff(target));
      const conflicts = findConflicts(diff);
      expect(conflicts.map((c) => [c.current, c.incoming])).toEqual([
        ["HEAD", "side"],
        ["HEAD", "side"],
      ]);
      // One block, then the other in the diff made after.
      await run(
        t.repo.applyPatch(resolvePatch(diff, [{ conflict: conflicts[1]!, choice: "both" }])!, {
          cached: false,
          reverse: false,
        }),
      );
      const next = await run(t.repo.diff(target));
      const [first] = findConflicts(next);
      await run(
        t.repo.applyPatch(resolvePatch(next, [{ conflict: first!, choice: "incoming" }])!, {
          cached: false,
          reverse: false,
        }),
      );
      expect(await sh("cat f.txt")).toBe("a\nS1\nc\nd\ne\nf\ng\nh\nM2\nS2");
      // The file stays conflicted until it is marked resolved.
      expect((await run(t.repo.status())).conflicted.map((f) => f.path)).toEqual(["f.txt"]);
      // A patch from an outdated diff does not apply.
      await fails(
        t.repo.applyPatch(resolvePatch(diff, [{ conflict: conflicts[0]!, choice: "current" }])!, {
          cached: false,
          reverse: false,
        }),
      );
      expect(await sh("cat f.txt")).toContain("S1");
    });

    it("resolves conflicts in a file without a final newline, with any marker size", async () => {
      const target = { kind: "unstaged", path: "f.txt" } as const;
      const resolveFirst = async (choice: "current" | "incoming" | "both") => {
        const diff = await run(t.repo.diff(target));
        const [conflict] = findConflicts(diff);
        expect(conflict).toBeDefined();
        await run(
          t.repo.applyPatch(resolvePatch(diff, [{ conflict: conflict!, choice }])!, {
            cached: false,
            reverse: false,
          }),
        );
      };
      await sh("echo 'f.txt conflict-marker-size=3' > .gitattributes && git add .gitattributes");
      await sh("printf 'a\\nend' > f.txt && git commit -qam base");
      await run(t.repo.createBranch("side", "HEAD", true));
      await sh("printf 'S\\nend' > f.txt && git commit -qam side");
      await run(t.repo.checkout("main"));
      await sh("printf 'M\\nend' > f.txt && git commit -qam main");
      for (const choice of ["current", "incoming", "both"] as const) {
        await fails(t.repo.merge("side", {}));
        expect(await sh("head -1 f.txt")).toBe("<<< HEAD");
        await resolveFirst(choice);
        // Still without a final newline.
        expect(await sh("tail -c 4 f.txt | tr '\\n' /")).toBe("/end");
        await run(t.repo.abortOperation());
      }
      await fails(t.repo.merge("side", {}));
      await resolveFirst("both");
      expect(await sh("cat f.txt; echo '|'")).toBe("M\nS\nend|");
    });

    it("aborts and continues a rebase", async () => {
      await diverge();
      await fails(t.repo.rebase("side"));
      expect(await state()).toBe("rebasing");
      await run(t.repo.abortOperation());
      expect(await state()).toBe("clean");
      expect(await sh("git log -1 --format=%s")).toBe("main");

      await fails(t.repo.rebase("side"));
      await resolve();
      await sh("git config core.editor true");
      await run(t.repo.continueOperation());
      expect(await state()).toBe("clean");
      expect(await sh("git log -2 --format=%s")).toBe("main\nside");
    });

    it("aborts and continues a cherry-pick", async () => {
      await diverge();
      await fails(t.repo.cherryPick(["side"]));
      expect(await state()).toBe("cherry-picking");
      await run(t.repo.abortOperation());
      expect(await state()).toBe("clean");

      await fails(t.repo.cherryPick(["side"]));
      await resolve();
      await sh("git config core.editor true");
      await run(t.repo.continueOperation());
      expect(await state()).toBe("clean");
      expect(await sh("git log -1 --format=%s")).toBe("side");
    });

    it("aborts and continues a revert", async () => {
      await sh("echo three > f.txt && git commit -qam three");
      await fails(t.repo.revert(["HEAD~1"]));
      expect(await state()).toBe("reverting");
      await run(t.repo.abortOperation());
      expect(await state()).toBe("clean");

      await fails(t.repo.revert(["HEAD~1"]));
      await resolve();
      await sh("git config core.editor true");
      await run(t.repo.continueOperation());
      expect(await state()).toBe("clean");
      expect(await sh("git log -1 --format=%s")).toBe('Revert "two"');
    });

    it("resets a bisect and ignores a clean state", async () => {
      await run(t.repo.abortOperation());
      await run(t.repo.continueOperation());
      await sh("git bisect start HEAD HEAD~1");
      expect(await state()).toBe("bisecting");
      await run(t.repo.continueOperation()); // Nothing to continue.
      expect(await state()).toBe("bisecting");
      await run(t.repo.abortOperation());
      expect(await state()).toBe("clean");
    });
  });
});
