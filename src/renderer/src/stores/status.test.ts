import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { APP, NOTICE_MS, notify, useStatusStore } from "./status";

const notices = () => useStatusStore.getState().notices;

beforeEach(() => {
  vi.useFakeTimers();
  useStatusStore.setState({ notices: {}, activity: null });
});
afterEach(() => vi.useRealTimers());

it("shows a notice per repository for a while", () => {
  notify("local:/a", "Pushed main");
  notify(APP, "Commit SHA copied", "info");
  expect(notices()["local:/a"]).toMatchObject({ text: "Pushed main", kind: "success" });
  expect(notices()[APP]).toMatchObject({ text: "Commit SHA copied", kind: "info" });
  vi.advanceTimersByTime(NOTICE_MS);
  expect(notices()).toEqual({});
});

it("keeps a newer notice when the older one's time is up", () => {
  notify("local:/a", "Fetched");
  vi.advanceTimersByTime(NOTICE_MS - 100);
  notify("local:/a", "Pulled");
  vi.advanceTimersByTime(100);
  expect(notices()["local:/a"]?.text).toBe("Pulled");
  vi.advanceTimersByTime(NOTICE_MS);
  expect(notices()["local:/a"]).toBeUndefined();
});

it("tracks app-wide activity", () => {
  useStatusStore.getState().setActivity("Connecting to fedora…");
  expect(useStatusStore.getState().activity).toBe("Connecting to fedora…");
  useStatusStore.getState().setActivity(null);
  expect(useStatusStore.getState().activity).toBeNull();
});
