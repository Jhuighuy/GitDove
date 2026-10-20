import { describe, expect, it } from "vitest";
import { isHidden, toggleHidden } from "./visibility";

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
    const siblings = ["refs/remotes/origin/main", "refs/remotes/origin/dev"];
    expect(toggleHidden(["refs/remotes/origin/"], "refs/remotes/origin/main", siblings)).toEqual([
      "refs/remotes/origin/dev",
    ]);
  });
});
