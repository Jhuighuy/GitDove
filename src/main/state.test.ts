import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const paths = vi.hoisted(() => ({ userData: "" }));
vi.mock("electron", () => ({ app: { getPath: () => paths.userData } }));
const log = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("electron-log/main", () => ({ default: log }));

/** A fresh `state` module: it caches what it read at module level. */
const load = async () => {
  vi.resetModules();
  return import("./state");
};

const write = (name: string, data: unknown) =>
  writeFileSync(join(paths.userData, name), typeof data === "string" ? data : JSON.stringify(data));
const read = (name: string) => JSON.parse(readFileSync(join(paths.userData, name), "utf8"));

beforeEach(() => {
  paths.userData = mkdtempSync(join(tmpdir(), "gitdove-state-"));
});
afterEach(() => rmSync(paths.userData, { recursive: true, force: true }));

describe("app state", () => {
  it("is empty without a state file", async () => {
    const { loadState } = await load();
    expect(loadState()).toEqual({ tabs: [], activeTab: null, recent: [] });
  });

  it("is empty when the state file is corrupt, and keeps the corrupt file aside", async () => {
    write("state.json", "{not json");
    const { loadState } = await load();
    expect(loadState()).toEqual({ tabs: [], activeTab: null, recent: [] });
    const aside = readdirSync(paths.userData).filter((f) => f.startsWith("state.json.corrupt-"));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(paths.userData, aside[0]!), "utf8")).toBe("{not json");
    expect(log.warn).toHaveBeenCalled();
  });

  it("drops malformed fields", async () => {
    write("state.json", { tabs: ["local:/a", 7, null], activeTab: 3, recent: "local:/b" });
    const { loadState } = await load();
    expect(loadState()).toEqual({ tabs: ["local:/a"], activeTab: null, recent: [] });
  });

  it("drops malformed repository ids, duplicates and a stray active tab", async () => {
    write("state.json", {
      tabs: ["local:/a", "ssh://h", "garbage", "local:/a", "ssh://-oX/srv"],
      activeTab: "garbage",
      recent: ["local:", "local:/c"],
      extra: 1,
    });
    const { loadState } = await load();
    expect(loadState()).toEqual({ tabs: ["local:/a"], activeTab: null, recent: ["local:/c"] });
  });

  it("reads a valid state file once", async () => {
    const state = { tabs: ["local:/a", "ssh://h/b"], activeTab: "ssh://h/b", recent: ["local:/c"] };
    write("state.json", state);
    const { loadState } = await load();
    expect(loadState()).toEqual(state);
    write("state.json", { tabs: [], activeTab: null, recent: [] });
    expect(loadState()).toEqual(state);
  });

  it("saves atomically, keeps the latest 30 recent repositories and caches the result", async () => {
    const { flushState, loadState, saveState } = await load();
    const recent = Array.from({ length: 40 }, (_, i) => `local:/r${i}`);
    saveState({ tabs: ["local:/a"], activeTab: "local:/a", recent });
    const saved = { tabs: ["local:/a"], activeTab: "local:/a", recent: recent.slice(0, 30) };
    flushState();
    expect(read("state.json")).toEqual(saved);
    expect(loadState()).toEqual(saved);
    // A fresh process reads it back.
    expect((await load()).loadState()).toEqual(saved);
  });
});

describe("repository settings", () => {
  it("defaults to nothing hidden", async () => {
    const { repoSettings } = await load();
    expect(repoSettings("local:/a")).toEqual({ hidden: [] });
  });

  it("ignores a corrupt or non-object settings file", async () => {
    write("repo-settings.json", "[[[");
    expect((await load()).repoSettings("local:/a")).toEqual({ hidden: [] });
    write("repo-settings.json", "null");
    expect((await load()).repoSettings("local:/a")).toEqual({ hidden: [] });
  });

  it("can save settings after reading an array", async () => {
    write("repo-settings.json", "[]");
    const { flushState, updateRepoSettings } = await load();
    updateRepoSettings("local:/a", { hidden: ["refs/heads/x"] });
    flushState();
    expect(read("repo-settings.json")).toEqual({ "local:/a": { hidden: ["refs/heads/x"] } });
  });

  it("coalesces writes", async () => {
    vi.useFakeTimers();
    try {
      const { updateRepoSettings } = await load();
      updateRepoSettings("local:/a", { hidden: ["refs/heads/x"] });
      updateRepoSettings("local:/a", { hidden: ["refs/heads/y"] });
      expect(readdirSync(paths.userData)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(read("repo-settings.json")).toEqual({ "local:/a": { hidden: ["refs/heads/y"] } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("filters malformed hidden refs", async () => {
    write("repo-settings.json", {
      "local:/a": { hidden: ["refs/heads/x", 1, null] },
      "local:/b": { hidden: "refs/heads/y" },
    });
    const { repoSettings } = await load();
    expect(repoSettings("local:/a")).toEqual({ hidden: ["refs/heads/x"] });
    expect(repoSettings("local:/b")).toEqual({ hidden: [] });
  });

  it("updates one repository and persists all of them", async () => {
    write("repo-settings.json", { "local:/a": { hidden: ["refs/heads/x"] } });
    const { flushState, repoSettings, updateRepoSettings } = await load();
    updateRepoSettings("local:/b", { hidden: ["refs/tags/t"] });
    expect(repoSettings("local:/b")).toEqual({ hidden: ["refs/tags/t"] });
    flushState();
    expect(read("repo-settings.json")).toEqual({
      "local:/a": { hidden: ["refs/heads/x"] },
      "local:/b": { hidden: ["refs/tags/t"] },
    });
    updateRepoSettings("local:/a", {});
    flushState();
    expect((await load()).repoSettings("local:/a")).toEqual({ hidden: ["refs/heads/x"] });
  });
});

describe("app settings", () => {
  it("keeps what is valid of a settings file", async () => {
    write("settings.json", { theme: "dark", zoom: 7 });
    const { loadSettings } = await load();
    expect(loadSettings()).toMatchObject({ theme: "dark", zoom: 1 });
  });

  it("persists changes and tells the listeners about real ones", async () => {
    const { flushState, loadSettings, onSettingsChange, updateSettings } = await load();
    const changes: [string, string][] = [];
    const stop = onSettingsChange((next, prev) => changes.push([prev.theme, next.theme]));
    expect(updateSettings({ theme: "light" }).theme).toBe("light");
    updateSettings({ theme: "light" });
    updateSettings({ codeFontSize: 99 });
    expect(changes).toEqual([["system", "light"]]);
    stop();
    updateSettings({ theme: "dark" });
    expect(changes).toHaveLength(1);
    flushState();
    expect(read("settings.json")).toMatchObject({ theme: "dark", codeFontSize: 12 });
    expect((await load()).loadSettings()).toEqual(loadSettings());
  });
});

describe("window state", () => {
  const none = { bounds: null, maximized: false, fullScreen: false };

  it("is unset without a file, and drops malformed fields", async () => {
    expect((await load()).loadWindowState()).toEqual(none);
    write("window.json", { bounds: { x: 1, y: "2", width: 3, height: 4 }, maximized: "yes" });
    expect((await load()).loadWindowState()).toEqual(none);
    write("window.json", { bounds: { x: 1, y: 2, width: 0, height: 4 } });
    expect((await load()).loadWindowState()).toEqual(none);
  });

  it("saves and reads back the bounds, rounded", async () => {
    const { flushState, saveWindowState } = await load();
    saveWindowState({
      bounds: { x: 10.4, y: -20, width: 1000.6, height: 700 },
      maximized: true,
      fullScreen: false,
    });
    flushState();
    expect((await load()).loadWindowState()).toEqual({
      bounds: { x: 10, y: -20, width: 1001, height: 700 },
      maximized: true,
      fullScreen: false,
    });
  });

  describe("placement", () => {
    const min = { width: 900, height: 560 };
    const primary = { x: 0, y: 25, width: 1440, height: 875 };
    const right = { x: 1440, y: 0, width: 2560, height: 1440 };

    it("keeps a window that fits where it was", async () => {
      const { placeWindow } = await load();
      const saved = { x: 1600, y: 100, width: 1200, height: 800 };
      expect(placeWindow(saved, [primary, right], min)).toEqual(saved);
    });

    it("moves and shrinks a window into the display it overlaps most", async () => {
      const { placeWindow } = await load();
      expect(
        placeWindow({ x: 1000, y: 0, width: 2000, height: 1000 }, [primary, right], min),
      ).toEqual({ x: 1440, y: 0, width: 2000, height: 1000 });
      expect(placeWindow({ x: -50, y: 0, width: 2000, height: 1000 }, [primary], min)).toEqual(
        primary,
      );
    });

    it("centers a window whose display is gone, keeping its size within the primary one", async () => {
      const { placeWindow } = await load();
      expect(placeWindow({ x: 3000, y: 100, width: 1200, height: 1000 }, [primary], min)).toEqual({
        width: 1200,
        height: 875,
      });
    });

    it("keeps the minimum size where the display has room for it", async () => {
      const { placeWindow } = await load();
      expect(placeWindow({ x: 0, y: 25, width: 400, height: 300 }, [primary], min)).toEqual({
        x: 0,
        y: 25,
        width: 900,
        height: 560,
      });
    });

    it("fits a window into a display smaller than the minimum size", async () => {
      const { placeWindow } = await load();
      const small = { x: 0, y: 0, width: 800, height: 500 };
      expect(placeWindow({ x: 0, y: 0, width: 1000, height: 700 }, [small], min)).toEqual(small);
    });
  });
});
