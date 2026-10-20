import { describe, expect, it } from "vitest";
import { activity } from "./activity";

describe("activity", () => {
  it("starts active and follows window focus", () => {
    expect(activity.isActive()).toBe(true);
    activity.setFocused(false);
    expect(activity.isActive()).toBe(false);
    activity.setFocused(true);
    expect(activity.isActive()).toBe(true);
  });
});
