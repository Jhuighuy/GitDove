import type { EditableHistory, RebaseCommit } from "@shared/domain";
import { describe, expect, it } from "vitest";
import {
  contiguous,
  dropPlan,
  editable,
  editorSteps,
  editorSummary,
  editPlan,
  type EditorRow,
  movePlan,
  rebaseBase,
  rowProblems,
  squashPlan,
} from "./plan";

// Newest first: d is HEAD, "base" is below a.
const history: EditableHistory = {
  head: "d",
  commits: ["d", "c", "b", "a"],
  bottom: "base",
  unpushed: 4,
};

const actions = (p: ReturnType<typeof dropPlan>) =>
  p?.steps.map((s) => `${s.action} ${s.hash}${s.message ? ` "${s.message}"` : ""}`);

describe("quick action plans", () => {
  it("knows which commits can be edited", () => {
    expect(editable(history, ["a", "c"])).toBe(true);
    expect(editable(history, ["x"])).toBe(false);
    expect(editable(undefined, ["a"])).toBe(false);
    expect(contiguous(history, ["c", "b"])).toBe(true);
    expect(contiguous(history, ["d", "b"])).toBe(false);
    expect(rebaseBase(history, ["c", "b"])).toBe("a");
    expect(rebaseBase(history, ["a"])).toBe("base");
  });

  it("drops commits", () => {
    const p = dropPlan(history, ["c", "a"]);
    expect(p?.base).toBe("base");
    expect(actions(p)).toEqual(["drop a", "pick b", "drop c", "pick d"]);
    expect(dropPlan(history, ["d"])?.label).toBe("Drop commit");
    expect(dropPlan(history, ["x"])).toBeNull();
  });

  it("moves commits up and down", () => {
    expect(movePlan(history, ["b"], "up")).toMatchObject({ base: "a", label: "Move commit up" });
    expect(actions(movePlan(history, ["b"], "up"))).toEqual(["pick c", "pick b", "pick d"]);
    expect(actions(movePlan(history, ["b"], "down"))).toEqual([
      "pick b",
      "pick a",
      "pick c",
      "pick d",
    ]);
    expect(movePlan(history, ["b"], "down")?.base).toBe("base");
    expect(actions(movePlan(history, ["c", "b"], "up"))).toEqual(["pick d", "pick b", "pick c"]);
    expect(actions(movePlan(history, ["d", "c"], "down"))).toEqual(["pick c", "pick d", "pick b"]);
    expect(movePlan(history, ["d"], "up")).toBeNull();
    expect(movePlan(history, ["a"], "down")).toBeNull();
    expect(movePlan(history, ["d", "b"], "up")).toBeNull();
  });

  it("squashes into the oldest, moving the others to it", () => {
    const p = squashPlan(history, ["d", "b"], "Both");
    expect(p?.base).toBe("a");
    expect(actions(p)).toEqual(['pick b "Both"', "fixup d", "pick c"]);
    expect(squashPlan(history, ["d"], "One")).toBeNull();
  });

  it("stops to edit", () => {
    expect(actions(editPlan(history, "c", "C"))).toEqual(["edit c", "pick d"]);
  });
});

const commit = (hash: string): RebaseCommit => ({
  hash,
  subject: hash.toUpperCase(),
  message: `${hash.toUpperCase()}\n\nBody of ${hash}`,
  authorName: "T",
  authorEmail: "t@x",
  authorTime: 0,
  pushed: false,
});
const original = ["a", "b", "c"].map(commit);
const rows = (...specs: [string, EditorRow["action"], string?][]): EditorRow[] =>
  specs.map(([h, action, message]) => ({ commit: commit(h), action, message: message ?? null }));

describe("editor", () => {
  it("compiles rows into steps", () => {
    expect(editorSteps(rows(["a", "pick"], ["b", "pick"], ["c", "pick"]))).toEqual(
      original.map((c) => ({ hash: c.hash, action: "pick" })),
    );
    expect(editorSteps(rows(["a", "reword", "New"], ["c", "squash"], ["b", "drop"]))).toEqual([
      { hash: "a", action: "pick", message: "New" },
      { hash: "c", action: "fixup" },
      { hash: "b", action: "drop" },
    ]);
    // Without a message of its own, a squash adds the message of what is squashed.
    expect(editorSteps(rows(["a", "pick"], ["b", "squash"]))[0]).toEqual({
      hash: "a",
      action: "pick",
      message: "A\n\nBody of a\n\nB\n\nBody of b",
    });
    // Folding skips dropped commits; a reword that changes nothing is a pick.
    expect(
      editorSteps(rows(["a", "edit"], ["b", "drop"], ["c", "fixup"])).map((s) => s.action),
    ).toEqual(["edit", "drop", "fixup"]);
    expect(editorSteps(rows(["a", "reword", "A\n\nBody of a"]))).toEqual([
      { hash: "a", action: "pick" },
    ]);
  });

  it("finds problems", () => {
    expect([...rowProblems(rows(["a", "squash"], ["b", "pick"])).keys()]).toEqual([0]);
    expect([...rowProblems(rows(["a", "drop"], ["b", "fixup"])).keys()]).toEqual([1]);
    expect([...rowProblems(rows(["a", "reword", " "])).keys()]).toEqual([0]);
    expect(rowProblems(rows(["a", "pick"], ["b", "squash"])).size).toBe(0);
  });

  it("sums up the changes", () => {
    expect(editorSummary(original, rows(["a", "pick"], ["b", "pick"], ["c", "pick"])).changed).toBe(
      false,
    );
    expect(
      editorSummary(original, rows(["b", "pick"], ["a", "squash"], ["c", "reword", "New"])),
    ).toEqual({ moved: 2, squashed: 1, dropped: 0, edited: 0, reworded: 1, changed: true });
  });
});
