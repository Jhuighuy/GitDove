import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { APP, NOTICE_MS, notify, useStatusStore } from "./status";

const notices = () => useStatusStore.getState().notices;

beforeEach(() => {
  vi.useFakeTimers();
  useStatusStore.setState({ notices: {}, activities: [] });
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

it("tracks overlapping app-wide activities, each ended by its own caller", () => {
  const texts = () => useStatusStore.getState().activities.map((a) => a.text);
  const endFirst = useStatusStore.getState().startActivity("Connecting to fedora…");
  const endSecond = useStatusStore.getState().startActivity("Opening repository…");
  expect(texts()).toEqual(["Connecting to fedora…", "Opening repository…"]);
  // The first finishing does not clear the one still pending.
  endFirst();
  expect(texts()).toEqual(["Opening repository…"]);
  endFirst();
  expect(texts()).toEqual(["Opening repository…"]);
  endSecond();
  expect(texts()).toEqual([]);
});
