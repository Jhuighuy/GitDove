import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppState } from "@shared/domain";
import { isRepoId } from "@shared/ipc";
import { normalizeSettings as normalizeAppSettings, type Settings } from "@shared/settings";
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

// ---------------------------------------------------------------------------
// App settings
// ---------------------------------------------------------------------------

const appSettingsStore = jsonStore("settings.json", normalizeAppSettings);
const settingsListeners = new Set<(next: Settings, prev: Settings) => void>();

export const loadSettings = (): Settings => appSettingsStore.get();

/** Changes some settings, and tells the listeners if anything changed. */
export const updateSettings = (patch: Partial<Settings>): Settings => {
  const prev = appSettingsStore.get();
  const next = normalizeAppSettings({ ...prev, ...patch });
  if (JSON.stringify(next) === JSON.stringify(prev)) return prev;
  appSettingsStore.set(next);
  for (const listener of settingsListeners) listener(next, prev);
  return next;
};

/** Calls `listener` after each change of the settings; returns a function that stops it. */
export const onSettingsChange = (listener: (next: Settings, prev: Settings) => void) => {
  settingsListeners.add(listener);
  return () => void settingsListeners.delete(listener);
};

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WindowState {
  /** Where the window is when neither maximized nor full screen; null before it was saved. */
  readonly bounds: Rect | null;
  readonly maximized: boolean;
  readonly fullScreen: boolean;
}

const rect = (v: unknown): Rect | null => {
  const r = record(v);
  const [x, y, width, height] = [r.x, r.y, r.width, r.height].map((n) =>
    typeof n === "number" && Number.isFinite(n) ? Math.round(n) : Number.NaN,
  ) as [number, number, number, number];
  return [x, y, width, height].some(Number.isNaN) || width <= 0 || height <= 0
    ? null
    : { x, y, width, height };
};

export const normalizeWindowState = (raw: unknown): WindowState => {
  const r = record(raw);
  return {
    bounds: rect(r.bounds),
    maximized: r.maximized === true,
    fullScreen: r.fullScreen === true,
  };
};

const windowStore = jsonStore("window.json", normalizeWindowState);

export const loadWindowState = (): WindowState => windowStore.get();

export const saveWindowState = (state: WindowState): void =>
  windowStore.set(normalizeWindowState(state));

/**
 * Where to put a window last at `saved`, given the displays' work areas (the primary first):
 * on the display it overlaps most, moved and shrunk to fit it, or centered on the primary one
 * (no position) when it overlaps none, e.g. a display that was unplugged since.
 */
export const placeWindow = (
  saved: Rect,
  workAreas: readonly Rect[],
  min: { readonly width: number; readonly height: number },
): Partial<Rect> & Pick<Rect, "width" | "height"> => {
  const overlap = (a: Rect) =>
    Math.max(0, Math.min(saved.x + saved.width, a.x + a.width) - Math.max(saved.x, a.x)) *
    Math.max(0, Math.min(saved.y + saved.height, a.y + a.height) - Math.max(saved.y, a.y));
  const best = workAreas.reduce<Rect | undefined>(
    (b, a) => (overlap(a) > (b ? overlap(b) : 0) ? a : b),
    undefined,
  );
  const area = best ?? workAreas[0];
  // At least the minimum size, unless the display is smaller still: then it fills the display.
  const fit = (size: number, max: number, least: number) => Math.min(max, Math.max(least, size));
  const width = area ? fit(saved.width, area.width, min.width) : saved.width;
  const height = area ? fit(saved.height, area.height, min.height) : saved.height;
  if (!best) return { width, height };
  const clamp = (pos: number, size: number, start: number, length: number) =>
    Math.max(start, Math.min(pos, start + length - size));
  return {
    x: clamp(saved.x, width, best.x, best.width),
    y: clamp(saved.y, height, best.y, best.height),
    width,
    height,
  };
};

/** Writes pending changes now, e.g. before quitting. */
export const flushState = (): void => {
  stateStore.flush();
  settingsStore.flush();
  appSettingsStore.flush();
  windowStore.flush();
};
