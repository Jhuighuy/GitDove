import { describe, expect, it } from "vitest";
import {
  authorKey,
  isEmailHidden,
  isFilteredOut,
  isHidden,
  personKey,
  personOf,
  setContributorFilter,
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

  const people = {
    "ann@x": { name: "Ann Lee", time: 0 },
    "ann@corp": { name: "ann  lée", time: 0 },
    "bob@x": { name: "Bob", time: 0 },
  };
  const owners = {
    byRef: {
      "refs/heads/a": ["ann@x"],
      "refs/heads/b": ["bob@x"],
      "refs/heads/ab": ["ann@corp", "bob@x"],
    },
    people,
  };

  it("groups emails by name", () => {
    expect(personOf("  Ann  LÉE ")).toBe("ann lee");
    const hidden = [personKey("ann lee")];
    expect(isEmailHidden(hidden, "ann@x", people)).toBe(true);
    expect(isEmailHidden(hidden, "ann@corp", people)).toBe(true);
    expect(isEmailHidden(hidden, "bob@x", people)).toBe(false);
    expect(isEmailHidden([authorKey("Bob@X")], "bob@x", people)).toBe(true);
  });

  it("filters branches whose owners are all hidden", () => {
    expect(isFilteredOut([personKey("ann lee")], "refs/heads/a", owners)).toBe(true);
    expect(isFilteredOut([personKey("ann lee")], "refs/heads/ab", owners)).toBe(false);
    expect(isFilteredOut([personKey("ann lee"), authorKey("bob@x")], "refs/heads/ab", owners)).toBe(
      true,
    );
    expect(isFilteredOut([personKey("ann lee")], "refs/heads/main", owners)).toBe(false);
    // A branch's own entry does not matter.
    expect(isFilteredOut([personKey("ann lee"), "refs/heads/a"], "refs/heads/a", owners)).toBe(
      true,
    );
  });

  it("looks names up in a compiled copy of the list", () => {
    const hidden = ["refs/heads/a", "refs/tags/"];
    expect(isHidden(hidden, "refs/tags/v1")).toBe(true);
    expect(isHidden(new Set(hidden), "refs/heads/a")).toBe(true);
    // A list changed in place is compiled again.
    hidden.push("refs/heads/b");
    expect(isHidden(hidden, "refs/heads/b")).toBe(true);
    // Without contributor entries no branch is filtered, whatever its owners.
    expect(isFilteredOut(hidden, "refs/heads/a", owners)).toBe(false);
    expect(isEmailHidden(hidden, "ann@x", people)).toBe(false);
  });

  it("checks many names against many entries quickly", () => {
    // E.g. after "Solo" then "Show all" on a group, or names of deleted branches.
    const hidden = Array.from({ length: 5000 }, (_, i) => `refs/heads/gone-${i}`);
    hidden.push("refs/remotes/origin/");
    const names = Array.from({ length: 5000 }, (_, i) => `refs/heads/b-${i}`);
    const start = performance.now();
    for (let k = 0; k < 20; k++) for (const n of names) isHidden(hidden, n);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("replaces the contributor filter", () => {
    const hidden = ["refs/heads/x", personKey("ann lee"), authorKey("bob@x")];
    expect(setContributorFilter(hidden, [authorKey("ann@x")])).toEqual([
      "refs/heads/x",
      authorKey("ann@x"),
    ]);
    expect(setContributorFilter(hidden, [])).toEqual(["refs/heads/x"]);
  });
});
