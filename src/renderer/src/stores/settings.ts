import { DEFAULT_SETTINGS, type Settings } from "@shared/settings";
import { create } from "zustand";
import { api } from "@/lib/api";

interface SettingsState {
  readonly settings: Settings;
  readonly loaded: boolean;
  readonly load: () => Promise<void>;
  /** Changes some settings: here at once, then in the main process and every other window. */
  readonly update: (patch: Partial<Settings>) => Promise<void>;
}

let listening = false;

/** The app's settings, kept by the main process (`settings.json`). */
export const useSettingsStore = create<SettingsState>()((set) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,

  async load() {
    if (!listening) {
      listening = true;
      window.gitdove.on("settings.changed", (settings) => set({ settings }));
    }
    try {
      set({ settings: await api("settings.get") });
    } catch (e) {
      // Start with the defaults rather than a spinner forever.
      console.error("Could not load the settings", e);
    }
    set({ loaded: true });
  },

  async update(patch) {
    set((s) => ({ settings: { ...s.settings, ...patch } }));
    try {
      set({ settings: await api("settings.set", patch) });
    } catch (e) {
      console.error("Could not change the settings", e);
      set({ settings: await api("settings.get").catch(() => DEFAULT_SETTINGS) });
    }
  },
}));

export const useSettings = <T>(select: (s: Settings) => T): T =>
  useSettingsStore((s) => select(s.settings));

export const updateSettings = (patch: Partial<Settings>) =>
  useSettingsStore.getState().update(patch);
