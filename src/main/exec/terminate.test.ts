import { describe, expect, it } from "vitest";
import { groupHasLiveMember } from "./terminate";

describe("groupHasLiveMember", () => {
  const ps = ["  100 Ss", "  100 Z", "  200 S+", "  300 Z+", "", "garbage"].join("\n");

  it("finds running members of the group", () => {
    expect(groupHasLiveMember(ps, 100)).toBe(true);
    expect(groupHasLiveMember(ps, 200)).toBe(true);
  });

  it("ignores zombies, which no signal removes, and other groups", () => {
    expect(groupHasLiveMember(ps, 300)).toBe(false);
    expect(groupHasLiveMember(ps, 400)).toBe(false);
    expect(groupHasLiveMember("", 100)).toBe(false);
  });
});
