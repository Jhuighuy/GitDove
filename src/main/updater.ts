import { dirname } from "node:path";
import type { UpdaterStatus } from "@shared/domain";
import { app, dialog, type MenuItemConstructorOptions } from "electron";
import log from "electron-log/main";
import electronUpdater from "electron-updater";
import { Sparkle } from "./sparkle";

const { autoUpdater } = electronUpdater;

let status: UpdaterStatus = { kind: "idle" };
let listener: ((s: UpdaterStatus) => void) | null = null;
let sparkle: Sparkle | null = null;
/** Whether updates are checked for in the background (the `autoUpdate` setting). */
let automatic = true;
/** Callers of `check()` waiting for its outcome. */
let waiting: ((s: UpdaterStatus) => void)[] = [];

/** A check that hears nothing back for this long answers with the current status. */
const CHECK_TIMEOUT = 60 * 1000;

const set = (next: UpdaterStatus) => {
  // Checks go on while an update is ready (#49), and leave it on offer unless they find a newer
  // version, which then downloads in its place.
  const newer =
    status.kind === "ready" && next.kind === "available" && next.version !== status.version;
  if (status.kind === "ready" && next.kind !== "ready" && !newer) {
    if (next.kind === "error") log.warn(`updater: a check failed: ${next.message}`);
    if (next.kind !== "checking" && next.kind !== "downloading") settle(status);
    return;
  }
  // Renderers show whole percents; finer progress events would only be noise.
  const s: UpdaterStatus =
    next.kind === "downloading" ? { kind: "downloading", percent: Math.floor(next.percent) } : next;
  const changed = JSON.stringify(s) !== JSON.stringify(status);
  status = s;
  if (changed) listener?.(s);
  if (s.kind !== "checking" && s.kind !== "downloading") settle(s);
};

const settle = (s: UpdaterStatus) => {
  for (const done of waiting) done(s);
  waiting = [];
};

/**
 * Over-the-air updates from GitHub releases: Sparkle on macOS (see `sparkle.ts`), electron-updater
 * elsewhere. Updates download in the background and install on restart or quit. Without automatic
 * checks, only "Check for Updates…" looks for (and downloads) them.
 */
export const updater = {
  status: () => status,

  init(onStatus: (s: UpdaterStatus) => void, checkAutomatically: boolean) {
    listener = onStatus;
    automatic = checkAutomatically;
    if (!app.isPackaged) return;
    if (process.platform === "darwin") {
      // Sparkle checks on startup and every 4 hours (`SUScheduledCheckInterval`).
      // GitDove.app/Contents/MacOS/GitDove
      sparkle = new Sparkle(dirname(dirname(dirname(app.getPath("exe")))), {
        automatic,
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
    if (automatic) void this.check();
    setInterval(
      () => {
        if (automatic) void this.check();
      },
      4 * 60 * 60 * 1000,
    ).unref();
  },

  /** Turns background checks on or off; turning them on checks now. */
  setAutomatic(value: boolean) {
    if (value === automatic) return;
    automatic = value;
    if (sparkle) sparkle.setAutomatic(value);
    else if (value) void this.check();
  },

  /** Checks for updates now; resolves with the outcome (`downloading` if already underway). */
  check(): Promise<UpdaterStatus> {
    if (!app.isPackaged) return Promise.resolve(status);
    // Sparkle does not check again once an update is ready to install: it would only resume
    // installing that one. electron-updater does, and downloads a newer one if there is.
    if (sparkle ? status.kind === "ready" : status.kind === "downloading")
      return Promise.resolve(status);
    const outcome = new Promise<UpdaterStatus>((done) => {
      const finish = (s: UpdaterStatus) => {
        clearTimeout(timer);
        done(s);
      };
      // E.g. the helper is alive but silent: do not wait forever.
      const timer = setTimeout(() => {
        waiting = waiting.filter((w) => w !== finish);
        done(status);
      }, CHECK_TIMEOUT);
      timer.unref();
      waiting.push(finish);
    });
    // Without a check under way, nothing will report back: answer with the current status.
    if (sparkle) {
      if (!sparkle.check()) settle(status);
    } else {
      autoUpdater.checkForUpdates().then(
        (result) => {
          if (!result) settle(status); // The updater is inactive, e.g. outside an AppImage.
        },
        (e: unknown) => set({ kind: "error", message: e instanceof Error ? e.message : String(e) }),
      );
    }
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

/** The "Check for Updates…" menu item: checks now and reports the outcome in a dialog. */
export const checkForUpdatesMenuItem = (): MenuItemConstructorOptions => ({
  label: "Check for Updates…",
  enabled: app.isPackaged,
  click: () => void checkForUpdatesFromMenu(),
});

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
    case "checking":
      // The check timed out (see `check`), but goes on.
      await dialog.showMessageBox({
        message: "Still checking for updates",
        detail: `${current} The update server has not answered yet; GitDove will offer to restart if it finds an update.`,
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
