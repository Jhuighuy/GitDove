import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const paths = vi.hoisted(() => ({ userData: "" }));
vi.mock("electron", () => ({ app: { getPath: () => paths.userData } }));

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

  it("is empty when the state file is corrupt", async () => {
    write("state.json", "{not json");
    const { loadState } = await load();
    expect(loadState()).toEqual({ tabs: [], activeTab: null, recent: [] });
  });

  it("drops malformed fields", async () => {
    write("state.json", { tabs: ["local:/a", 7, null], activeTab: 3, recent: "local:/b" });
    const { loadState } = await load();
    expect(loadState()).toEqual({ tabs: ["local:/a"], activeTab: null, recent: [] });
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
    const { loadState, saveState } = await load();
    const recent = Array.from({ length: 40 }, (_, i) => `local:/r${i}`);
    saveState({ tabs: ["local:/a"], activeTab: "local:/a", recent });
    const saved = { tabs: ["local:/a"], activeTab: "local:/a", recent: recent.slice(0, 30) };
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
    const { repoSettings, updateRepoSettings } = await load();
    updateRepoSettings("local:/b", { hidden: ["refs/tags/t"] });
    expect(repoSettings("local:/b")).toEqual({ hidden: ["refs/tags/t"] });
    expect(read("repo-settings.json")).toEqual({
      "local:/a": { hidden: ["refs/heads/x"] },
      "local:/b": { hidden: ["refs/tags/t"] },
    });
    updateRepoSettings("local:/a", {});
    expect((await load()).repoSettings("local:/a")).toEqual({ hidden: ["refs/heads/x"] });
  });
});
