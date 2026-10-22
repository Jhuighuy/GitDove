import { describe, expect, it } from "vitest";
import {
  entryOf,
  Journal,
  mismatch,
  parseSnapshot,
  restoreCommands,
  type Snapshot,
} from "./journal";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const Z = "0".repeat(40);

const snap = (head: string, hash: string, refs: Record<string, string>): Snapshot => ({
  head,
  hash,
  refs: new Map(Object.entries(refs)),
});

describe("snapshots", () => {
  it("parses the snapshot script's output", () => {
    expect(
      parseSnapshot(`refs/heads/main\n${A}\nrefs/heads/main ${A}\nrefs/tags/v1 ${B}\n`),
    ).toEqual(snap("refs/heads/main", A, { "refs/heads/main": A, "refs/tags/v1": B }));
    expect(parseSnapshot("\n\n")).toEqual(snap("", "", {}));
  });

  it("records only what changed", () => {
    const before = snap("refs/heads/main", A, { "refs/heads/main": A, "refs/heads/x": C });
    expect(entryOf("Nothing", "keep", before, before)).toBeNull();
    const after = snap("refs/heads/main", B, { "refs/heads/main": B, "refs/heads/x": C });
    expect(entryOf("Commit", "soft", before, after)).toEqual({
      label: "Commit",
      mode: "soft",
      before: { head: "refs/heads/main", hash: A, refs: { "refs/heads/main": A } },
      after: { head: "refs/heads/main", hash: B, refs: { "refs/heads/main": B } },
    });
  });

  it("says what changed since", () => {
    const side = { head: "refs/heads/main", hash: A, refs: { "refs/tags/v1": B } };
    expect(mismatch(snap("refs/heads/main", A, { "refs/tags/v1": B }), side)).toBeNull();
    expect(mismatch(snap("refs/heads/x", A, {}), side)).toBe("x is checked out now");
    expect(mismatch(snap("", A, {}), side)).toBe("HEAD is detached now");
    expect(mismatch(snap("refs/heads/main", B, {}), side)).toBe("HEAD has moved since");
    expect(mismatch(snap("refs/heads/main", A, {}), side)).toBe("v1 has changed since");
  });
});

describe("restoreCommands", () => {
  it("moves the checked out branch, then the other refs", () => {
    const from = {
      head: "refs/heads/main",
      hash: B,
      refs: { "refs/heads/main": B, "refs/tags/t": B },
    };
    const to = {
      head: "refs/heads/main",
      hash: A,
      refs: { "refs/heads/main": A, "refs/tags/t": null },
    };
    expect(restoreCommands(from, to, "keep", "undo")).toEqual([
      ["read-tree", "-m", "-u", "HEAD", A],
      ["reset", "--soft", "-q", A],
      ["update-ref", "-m", "undo", "-d", "refs/tags/t", B],
    ]);
    expect(restoreCommands(from, to, "soft", "undo")[0]).toEqual(["reset", "--soft", "-q", A]);
  });

  it("switches branches, creating the one to check out first", () => {
    const from = {
      head: "refs/heads/new",
      hash: A,
      refs: { "refs/heads/new": A, "refs/heads/old": null },
    };
    const to = {
      head: "refs/heads/old",
      hash: A,
      refs: { "refs/heads/new": null, "refs/heads/old": A },
    };
    expect(restoreCommands(from, to, "keep", "undo")).toEqual([
      ["update-ref", "-m", "undo", "refs/heads/old", A, Z],
      ["switch", "-q", "--no-guess", "old"],
      ["update-ref", "-m", "undo", "-d", "refs/heads/new", A],
    ]);
    expect(restoreCommands(to, { head: "", hash: C, refs: {} }, "keep", "u")).toEqual([
      ["switch", "-q", "--detach", C],
    ]);
  });

  it("goes back to an unborn branch", () => {
    const from = { head: "refs/heads/main", hash: A, refs: { "refs/heads/main": A } };
    const to = { head: "refs/heads/main", hash: "", refs: { "refs/heads/main": null } };
    expect(restoreCommands(from, to, "soft", "u")).toEqual([
      ["update-ref", "-m", "u", "-d", "refs/heads/main"],
    ]);
  });
});

describe("Journal", () => {
  const entry = (label: string) => entryOf(label, "keep", snap("", A, {}), snap("", B, {}))!;

  it("keeps undo and redo stacks", () => {
    const j = new Journal();
    expect(j.state()).toEqual({ undo: null, redo: null });
    j.record(entry("one"));
    j.record(entry("two"));
    j.undone();
    expect(j.state()).toEqual({ undo: "one", redo: "two" });
    j.redone();
    expect(j.state()).toEqual({ undo: "two", redo: null });
    j.undone();
    j.record(entry("three"));
    expect(j.state()).toEqual({ undo: "three", redo: null });
    j.record(null);
    expect(j.peekUndo()?.label).toBe("three");
    j.clear();
    expect(j.state()).toEqual({ undo: null, redo: null });
  });

  it("forgets the oldest entries", () => {
    const j = new Journal();
    for (let i = 0; i < 150; i++) j.record(entry(String(i)));
    let count = 0;
    while (j.peekUndo()) {
      j.undone();
      count++;
    }
    expect(count).toBe(100);
  });
});
