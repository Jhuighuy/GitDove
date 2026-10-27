import { DEFAULT_SETTINGS } from "@shared/settings";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  listeners: new Map<string, (payload: unknown) => void>(),
}));
vi.mock("@/lib/api", () => ({ api: mocks.api }));
vi.stubGlobal("window", {
  gitdove: {
    on: (event: string, listener: (payload: unknown) => void) => {
      mocks.listeners.set(event, listener);
      return () => {};
    },
  },
});

const { updateSettings, useSettingsStore } = await import("./settings");

const s = () => useSettingsStore.getState();

beforeEach(() => {
  mocks.api.mockReset();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, loaded: false });
});

it("loads the settings, and follows changes from other windows", async () => {
  mocks.api.mockResolvedValue({ ...DEFAULT_SETTINGS, theme: "dark" });
  await s().load();
  expect(s()).toMatchObject({ loaded: true, settings: { theme: "dark" } });
  mocks.listeners.get("settings.changed")!({ ...DEFAULT_SETTINGS, zoom: 1.25 });
  expect(s().settings).toMatchObject({ theme: "system", zoom: 1.25 });
});

it("starts with the defaults when the settings cannot be loaded", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.api.mockRejectedValue(new Error("gone"));
  await s().load();
  expect(s()).toEqual(expect.objectContaining({ loaded: true, settings: DEFAULT_SETTINGS }));
});

it("changes settings at once, then takes what the main process kept", async () => {
  let answer: (v: unknown) => void = () => {};
  mocks.api.mockReturnValue(new Promise((r) => (answer = r)));
  const done = updateSettings({ codeFontSize: 14 });
  expect(s().settings.codeFontSize).toBe(14);
  expect(mocks.api).toHaveBeenCalledWith("settings.set", { codeFontSize: 14 });
  answer({ ...DEFAULT_SETTINGS, codeFontSize: 14, ligatures: false });
  await done;
  expect(s().settings).toMatchObject({ codeFontSize: 14, ligatures: false });
});

it("goes back to the saved settings when a change fails", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.api.mockImplementation(async (method: string) => {
    if (method === "settings.set") throw new Error("invalid");
    return DEFAULT_SETTINGS;
  });
  await updateSettings({ codeFont: "x" });
  expect(s().settings).toEqual(DEFAULT_SETTINGS);
});
