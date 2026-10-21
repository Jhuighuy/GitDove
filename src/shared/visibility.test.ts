import { describe, expect, it } from "vitest";
import {
  authorKey,
  exceptionKey,
  hiddenAuthors,
  isFilteredOut,
  isHidden,
  setHiddenAuthors,
  showNames,
  toggleHidden,
} from "./visibility";

describe("visibility", () => {
  it("matches exact names and group prefixes", () => {
    const hidden = ["refs/heads/a", "refs/remotes/origin/"];
    expect(isHidden(hidden, "refs/heads/a")).toBe(true);
    expect(isHidden(hidden, "refs/heads/ab")).toBe(false);
    expect(isHidden(hidden, "refs/remotes/origin/main")).toBe(true);
    expect(isHidden(hidden, "refs/remotes/upstream/main")).toBe(false);
  });

  it("toggles single entries and splits groups", () => {
    expect(toggleHidden([], "refs/heads/a")).toEqual(["refs/heads/a"]);
    expect(toggleHidden(["refs/heads/a"], "refs/heads/a")).toEqual([]);
    const all = ["refs/heads/a", "refs/remotes/origin/main", "refs/remotes/origin/dev"];
    expect(toggleHidden(["refs/remotes/origin/"], "refs/remotes/origin/main", all)).toEqual([
      "refs/remotes/origin/dev",
    ]);
  });

  it("shows names covered by nested groups", () => {
    const all = [
      "refs/remotes/origin/main",
      "refs/remotes/origin/release/1",
      "refs/remotes/origin/release/2",
      "refs/remotes/upstream/main",
    ];
    const hidden = ["refs/remotes/origin/", "refs/remotes/origin/release/", "refs/heads/x"];
    // Showing one member keeps its siblings in both groups hidden.
    expect(showNames(hidden, ["refs/remotes/origin/release/1"], all).toSorted()).toEqual([
      "refs/heads/x",
      "refs/remotes/origin/main",
      "refs/remotes/origin/release/2",
    ]);
    // Showing a whole folder leaves the rest of the remote hidden.
    const folder = ["refs/remotes/origin/release/", ...all.slice(1, 3)];
    expect(showNames(hidden, folder, all).toSorted()).toEqual([
      "refs/heads/x",
      "refs/remotes/origin/main",
    ]);
    // Toggling an explicitly hidden name inside a hidden group shows it.
    expect(
      toggleHidden(["refs/remotes/origin/", "refs/remotes/origin/main"], all[0]!, all),
    ).toEqual(["refs/remotes/origin/release/1", "refs/remotes/origin/release/2"]);
  });

  it("filters branches whose owners are all hidden", () => {
    const hidden = [authorKey("Ann@x"), authorKey("bob@x")];
    expect(isFilteredOut(hidden, "refs/heads/a", ["ann@x"])).toBe(true);
    expect(isFilteredOut(hidden, "refs/heads/a", ["ann@x", "bob@x"])).toBe(true);
    expect(isFilteredOut(hidden, "refs/heads/a", ["ann@x", "cid@x"])).toBe(false);
    expect(isFilteredOut(hidden, "refs/heads/main", undefined)).toBe(false);
    expect(
      isFilteredOut([...hidden, exceptionKey("refs/heads/a")], "refs/heads/a", ["ann@x"]),
    ).toBe(false);
  });

  it("sets hidden contributors and drops stale exceptions", () => {
    const owners = { "refs/heads/a": ["ann@x"], "refs/heads/b": ["bob@x"] };
    const hidden = [
      "refs/heads/x",
      authorKey("ann@x"),
      authorKey("bob@x"),
      exceptionKey("refs/heads/a"),
      exceptionKey("refs/heads/b"),
    ];
    const next = setHiddenAuthors(hidden, ["ann@x"], owners);
    expect(next).toEqual(["refs/heads/x", exceptionKey("refs/heads/a"), authorKey("ann@x")]);
    expect(hiddenAuthors(next)).toEqual(["ann@x"]);
    expect(setHiddenAuthors(next, [], owners)).toEqual(["refs/heads/x"]);
  });
});
