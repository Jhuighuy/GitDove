import { resolve } from "node:path";
import type { UpdaterStatus } from "@shared/domain";
import { app, dialog } from "electron";
import log from "electron-log/main";
import electronUpdater from "electron-updater";
import { Sparkle } from "./sparkle";

const { autoUpdater } = electronUpdater;

let status: UpdaterStatus = { kind: "idle" };
let listener: ((s: UpdaterStatus) => void) | null = null;
let sparkle: Sparkle | null = null;
/** Callers of `check()` waiting for its outcome. */
let waiting: ((s: UpdaterStatus) => void)[] = [];

const set = (s: UpdaterStatus) => {
  status = s;
  listener?.(s);
  if (s.kind === "checking" || s.kind === "downloading") return;
  for (const done of waiting) done(s);
  waiting = [];
};

/**
 * Over-the-air updates from GitHub releases: Sparkle on macOS (see `sparkle.ts`), electron-updater
 * elsewhere. Updates download in the background and install on restart or quit.
 */
export const updater = {
  status: () => status,

  init(onStatus: (s: UpdaterStatus) => void) {
    listener = onStatus;
    if (!app.isPackaged) return;
    if (process.platform === "darwin") {
      // Sparkle checks on startup and every 4 hours (`SUScheduledCheckInterval`).
      sparkle = new Sparkle(resolve(app.getPath("exe"), "../../.."), {
        onStatus: set,
        onLog: (message) => log.warn(`updater: ${message}`),
      });
      return;
    }
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

  /** Checks for updates now; resolves with the outcome (`downloading` if already underway). */
  check(): Promise<UpdaterStatus> {
    if (!app.isPackaged) return Promise.resolve(status);
    if (status.kind === "ready" || (!sparkle && status.kind === "downloading"))
      return Promise.resolve(status);
    const outcome = new Promise<UpdaterStatus>((done) => waiting.push(done));
    if (sparkle) sparkle.check();
    else
      autoUpdater
        .checkForUpdates()
        .catch((e: unknown) =>
          set({ kind: "error", message: e instanceof Error ? e.message : String(e) }),
        );
    return outcome;
  },

  install() {
    if (status.kind !== "ready") return;
    if (sparkle) sparkle.install();
    else autoUpdater.quitAndInstall();
  },

  /** Called on quit; a downloaded update is installed once GitDove has exited. */
  dispose() {
    sparkle?.close();
  },
};

/** Help > Check for Updates: checks now and reports the outcome in a dialog. */
export async function checkForUpdatesFromMenu() {
  const s = await updater.check();
  const current = `You have GitDove ${app.getVersion()}.`;
  switch (s.kind) {
    case "ready": {
      const { response } = await dialog.showMessageBox({
        message: `GitDove ${s.version} is ready to install`,
        detail: `${current} Restart now, or the update will be installed when you quit.`,
        buttons: ["Restart", "Later"],
      });
      if (response === 0) updater.install();
      return;
    }
    case "available":
    case "downloading":
      await dialog.showMessageBox({
        message:
          s.kind === "available" ? `Downloading GitDove ${s.version}` : "Downloading an update",
        detail: `${current} GitDove will offer to restart once the update is ready.`,
      });
      return;
    case "error":
      await dialog.showMessageBox({
        type: "error",
        message: "Could not check for updates",
        detail: s.message,
      });
      return;
    default:
      await dialog.showMessageBox({ message: "GitDove is up to date", detail: current });
  }
}
