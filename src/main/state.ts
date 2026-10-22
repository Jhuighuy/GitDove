import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppState } from "@shared/domain";
import { isRepoId } from "@shared/ipc";
import { app } from "electron";
import log from "electron-log/main";

/** Writes are coalesced: tab switches and visibility toggles come in bursts. */
const WRITE_DELAY = 250;

/**
 * A JSON file in the user data directory. It is read once and normalized, so a hand-edited or
 * older file cannot break the app, and written atomically and durably (temporary file, fsync,
 * rename). A file that is not JSON is kept aside as `<name>.corrupt-<time>` for inspection.
 */
const jsonStore = <T>(name: string, normalize: (raw: unknown) => T) => {
  let value: T | undefined;
  let timer: NodeJS.Timeout | undefined;
  const path = () => join(app.getPath("userData"), name);

  const read = (): T => {
    let text: string;
    try {
      text = readFileSync(path(), "utf8");
    } catch {
      return normalize(undefined);
    }
    try {
      return normalize(JSON.parse(text));
    } catch {
      const aside = `${path()}.corrupt-${Date.now()}`;
      log.warn(`${name} is corrupt; moved to ${aside}`);
      try {
        renameSync(path(), aside);
      } catch {
        // Overwritten on the next save.
      }
      return normalize(undefined);
    }
  };

  const write = () => {
    clearTimeout(timer);
    timer = undefined;
    const tmp = `${path()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(value, null, 2), { flush: true });
      renameSync(tmp, path());
    } catch (e) {
      log.warn(`Cannot save ${name}`, e);
    }
  };

  return {
    get: (): T => (value ??= read()),
    set: (next: T) => {
      value = next;
      timer ??= setTimeout(write, WRITE_DELAY);
    },
    /** Writes a pending change now. */
    flush: () => {
      if (timer) write();
    },
  };
};

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

/** Most recent repositories remembered. */
const MAX_RECENT = 30;

/** Keeps well-formed repository ids only: a bad one must not break the window on every launch. */
export const normalizeState = (raw: unknown): AppState => {
  const r = record(raw);
  const ids = (v: unknown) => [...new Set(strings(v).filter(isRepoId))];
  const tabs = ids(r.tabs);
  return {
    tabs,
    activeTab: typeof r.activeTab === "string" && tabs.includes(r.activeTab) ? r.activeTab : null,
    recent: ids(r.recent).slice(0, MAX_RECENT),
  };
};

const stateStore = jsonStore("state.json", normalizeState);

export const loadState = (): AppState => stateStore.get();

export const saveState = (state: AppState): void => stateStore.set(normalizeState(state));

// ---------------------------------------------------------------------------
// Per-repository settings
// ---------------------------------------------------------------------------

export interface RepoSettingsData {
  /** Refs hidden from the graph (see `@shared/visibility`). */
  readonly hidden: readonly string[];
}

const normalizeSettings = (raw: unknown): RepoSettingsData => ({
  hidden: strings(record(raw).hidden),
});

const settingsStore = jsonStore("repo-settings.json", (raw): Record<string, RepoSettingsData> =>
  Object.fromEntries(Object.entries(record(raw)).map(([id, s]) => [id, normalizeSettings(s)])),
);

export const repoSettings = (id: string): RepoSettingsData =>
  (Object.hasOwn(settingsStore.get(), id) && settingsStore.get()[id]) || { hidden: [] };

export const updateRepoSettings = (id: string, patch: Partial<RepoSettingsData>): void => {
  const all = settingsStore.get();
  const next = normalizeSettings({ ...repoSettings(id), ...patch });
  settingsStore.set({ ...all, [id]: next });
};

/** Writes pending changes now, e.g. before quitting. */
export const flushState = (): void => {
  stateStore.flush();
  settingsStore.flush();
};
