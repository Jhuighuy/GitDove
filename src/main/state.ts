import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppState } from "@shared/domain";
import { app } from "electron";

const EMPTY: AppState = { tabs: [], activeTab: null, recent: [] };

const file = () => join(app.getPath("userData"), "state.json");

let cached: AppState | null = null;

export const loadState = (): AppState => {
  if (cached) return cached;
  try {
    const parsed = JSON.parse(readFileSync(file(), "utf8")) as Partial<AppState>;
    cached = {
      tabs: Array.isArray(parsed.tabs) ? parsed.tabs.filter((t) => typeof t === "string") : [],
      activeTab: typeof parsed.activeTab === "string" ? parsed.activeTab : null,
      recent: Array.isArray(parsed.recent)
        ? parsed.recent.filter((t) => typeof t === "string")
        : [],
    };
  } catch {
    cached = EMPTY;
  }
  return cached;
};

export const saveState = (state: AppState): void => {
  cached = { ...state, recent: state.recent.slice(0, 30) };
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, JSON.stringify(cached, null, 2));
  renameSync(tmp, file());
};

// ---------------------------------------------------------------------------
// Per-repository settings
// ---------------------------------------------------------------------------

export interface RepoSettingsData {
  /** Refs hidden from the graph (see `@shared/visibility`). */
  readonly hidden: readonly string[];
}

const settingsFile = () => join(app.getPath("userData"), "repo-settings.json");
let settings: Record<string, RepoSettingsData> | null = null;

const loadSettings = (): Record<string, RepoSettingsData> => {
  if (settings) return settings;
  try {
    const parsed = JSON.parse(readFileSync(settingsFile(), "utf8")) as unknown;
    settings =
      parsed && typeof parsed === "object" ? (parsed as Record<string, RepoSettingsData>) : {};
  } catch {
    settings = {};
  }
  return settings;
};

export const repoSettings = (id: string): RepoSettingsData => {
  const s = loadSettings()[id];
  return { hidden: Array.isArray(s?.hidden) ? s.hidden.filter((h) => typeof h === "string") : [] };
};

export const updateRepoSettings = (id: string, patch: Partial<RepoSettingsData>): void => {
  const all = loadSettings();
  all[id] = { ...repoSettings(id), ...patch };
  const tmp = `${settingsFile()}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2));
  renameSync(tmp, settingsFile());
};
