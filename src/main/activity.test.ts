import { describe, expect, it, vi } from "vitest";
import { activity } from "./activity";

describe("activity", () => {
  it("starts active and follows window focus", () => {
    expect(activity.isActive()).toBe(true);
    activity.setFocused(false);
    expect(activity.isActive()).toBe(false);
    activity.setFocused(true);
    expect(activity.isActive()).toBe(true);
  });

  it("wakes listeners when the app becomes active again", () => {
    const listener = vi.fn();
    const stop = activity.onActive(listener);
    activity.setFocused(true); // Already active.
    expect(listener).not.toHaveBeenCalled();
    activity.setFocused(false);
    activity.setFocused(true);
    expect(listener).toHaveBeenCalledTimes(1);
    activity.wake();
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    activity.wake();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("does not wake listeners added while waking", () => {
    let calls = 0;
    const again = () => {
      calls++;
      activity.onActive(again);
    };
    const stop = activity.onActive(again);
    activity.wake();
    expect(calls).toBe(1);
    stop();
  });
});
