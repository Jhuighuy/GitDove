import type { UpdaterStatus } from "@shared/domain";
import { app } from "electron";
import log from "electron-log/main";
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;

let status: UpdaterStatus = { kind: "idle" };
let listener: ((s: UpdaterStatus) => void) | null = null;

const set = (s: UpdaterStatus) => {
  status = s;
  listener?.(s);
};

/** Over-the-air updates from GitHub releases (see `electron-builder.yml`). */
export const updater = {
  status: () => status,

  init(onStatus: (s: UpdaterStatus) => void) {
    listener = onStatus;
    if (!app.isPackaged) return;
    autoUpdater.logger = log;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("checking-for-update", () => set({ kind: "checking" }));
    autoUpdater.on("update-available", (i) => set({ kind: "available", version: i.version }));
    autoUpdater.on("update-not-available", () => set({ kind: "idle" }));
    autoUpdater.on("download-progress", (p) => set({ kind: "downloading", percent: p.percent }));
    autoUpdater.on("update-downloaded", (i) => set({ kind: "ready", version: i.version }));
    autoUpdater.on("error", (e) => set({ kind: "error", message: e.message }));
    void this.check();
    setInterval(() => void this.check(), 4 * 60 * 60 * 1000).unref();
  },

  async check() {
    if (!app.isPackaged) return;
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      set({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  },

  install() {
    if (status.kind === "ready") autoUpdater.quitAndInstall();
  },
};
