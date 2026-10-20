import { EventEmitter } from "node:events";
import type { UpdaterStatus } from "@shared/domain";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const electron = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    getPath: () => "/Applications/GitDove.app/Contents/MacOS/GitDove",
    getVersion: () => "0.1.5",
  },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
}));
const sparkle = vi.hoisted(() => ({
  instance: null as null | {
    bundle: string;
    onStatus: (s: UpdaterStatus) => void;
    onLog: (message: string) => void;
  },
  check: vi.fn(),
  install: vi.fn(),
  close: vi.fn(),
}));
type AutoUpdater = EventEmitter & { checkForUpdates: Mock; quitAndInstall: Mock };
/** The mocked electron-updater `autoUpdater` of the last loaded module. */
const mocked = vi.hoisted(() => ({ autoUpdater: null as unknown as AutoUpdater }));

vi.mock("electron", () => electron);
const log = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("electron-log/main", () => ({ default: log }));
vi.mock("electron-updater", async () => {
  const { EventEmitter } = await import("node:events");
  const updater = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(async () => {
      updater.emit("update-not-available");
    }),
    quitAndInstall: vi.fn(),
  });
  mocked.autoUpdater = updater;
  return { default: { autoUpdater: updater } };
});
vi.mock("./sparkle", () => ({
  Sparkle: class {
    constructor(
      bundle: string,
      handlers: { onStatus: (s: UpdaterStatus) => void; onLog: (message: string) => void },
    ) {
      sparkle.instance = { bundle, ...handlers };
    }
    check = sparkle.check;
    install = sparkle.install;
    close = sparkle.close;
  },
}));

const platform = process.platform;
const setPlatform = (value: string) => Object.defineProperty(process, "platform", { value });

/** A fresh `updater` module: it keeps its state at module level. */
async function load(on: string) {
  setPlatform(on);
  vi.resetModules();
  const module = await import("./updater");
  const statuses: UpdaterStatus[] = [];
  module.updater.init((s) => statuses.push(s));
  return { ...module, statuses };
}

beforeEach(() => {
  vi.clearAllMocks();
  sparkle.check.mockReturnValue(true);
});
afterEach(() => setPlatform(platform));

describe("updater on macOS", () => {
  it("runs Sparkle for the app bundle and relays its statuses", async () => {
    const { updater, statuses } = await load("darwin");
    expect(sparkle.instance?.bundle).toBe("/Applications/GitDove.app");
    sparkle.instance?.onStatus({ kind: "ready", version: "0.1.6" });
    expect(statuses).toEqual([{ kind: "ready", version: "0.1.6" }]);
    expect(updater.status()).toEqual({ kind: "ready", version: "0.1.6" });
  });

  it("resolves a check with its outcome", async () => {
    const { updater } = await load("darwin");
    const outcome = updater.check();
    expect(sparkle.check).toHaveBeenCalled();
    sparkle.instance?.onStatus({ kind: "checking" });
    sparkle.instance?.onStatus({ kind: "available", version: "0.1.6" });
    await expect(outcome).resolves.toEqual({ kind: "available", version: "0.1.6" });
  });

  it("installs only a downloaded update", async () => {
    const { updater } = await load("darwin");
    updater.install();
    expect(sparkle.install).not.toHaveBeenCalled();
    sparkle.instance?.onStatus({ kind: "ready", version: "0.1.6" });
    await expect(updater.check()).resolves.toEqual({ kind: "ready", version: "0.1.6" });
    expect(sparkle.check).not.toHaveBeenCalled();
    updater.install();
    expect(sparkle.install).toHaveBeenCalled();
    updater.dispose();
    expect(sparkle.close).toHaveBeenCalled();
  });

  it("logs the helper's messages", async () => {
    await load("darwin");
    sparkle.instance?.onLog("hello");
    expect(log.warn).toHaveBeenCalledWith("updater: hello");
  });

  it("answers a check at once when the helper is gone", async () => {
    const { updater } = await load("darwin");
    sparkle.instance?.onStatus({ kind: "error", message: "Updater stopped unexpectedly (1)" });
    sparkle.check.mockReturnValue(false);
    await expect(updater.check()).resolves.toEqual({
      kind: "error",
      message: "Updater stopped unexpectedly (1)",
    });
  });

  it("offers to restart from the menu", async () => {
    const { checkForUpdatesFromMenu } = await load("darwin");
    const done = checkForUpdatesFromMenu();
    sparkle.instance?.onStatus({ kind: "ready", version: "0.1.6" });
    await done;
    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ message: "GitDove 0.1.6 is ready to install" }),
    );
    expect(sparkle.install).toHaveBeenCalled();
  });

  it("reports errors from the menu", async () => {
    const { checkForUpdatesFromMenu } = await load("darwin");
    const done = checkForUpdatesFromMenu();
    sparkle.instance?.onStatus({ kind: "error", message: "offline" });
    await done;
    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", detail: "offline" }),
    );
  });

  it("reports a download from the menu", async () => {
    const { checkForUpdatesMenuItem } = await load("darwin");
    const item = checkForUpdatesMenuItem();
    expect(item).toMatchObject({ label: "Check for Updates…", enabled: true });
    (item.click as () => void)();
    sparkle.instance?.onStatus({ kind: "available", version: "0.1.6" });
    await expect
      .poll(() => electron.dialog.showMessageBox.mock.calls.at(0)?.at(0))
      .toMatchObject({ message: "Downloading GitDove 0.1.6" });
  });
});

describe("updater elsewhere", () => {
  it("checks through electron-updater", async () => {
    const { updater, checkForUpdatesFromMenu, statuses } = await load("linux");
    await expect(updater.check()).resolves.toEqual({ kind: "idle" });
    expect(statuses.at(-1)).toEqual({ kind: "idle" });
    await checkForUpdatesFromMenu();
    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ message: "GitDove is up to date" }),
    );
    mocked.autoUpdater.emit("update-downloaded", { version: "0.1.6" });
    expect(updater.status()).toEqual({ kind: "ready", version: "0.1.6" });
    updater.install();
    expect(mocked.autoUpdater.quitAndInstall).toHaveBeenCalled();
  });

  it("answers a check at once when electron-updater is inactive", async () => {
    const { updater } = await load("linux");
    mocked.autoUpdater.checkForUpdates.mockResolvedValueOnce(null);
    await expect(updater.check()).resolves.toEqual({ kind: "idle" });
  });

  it("reports a failed check", async () => {
    const { updater } = await load("linux");
    mocked.autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error("offline"));
    await expect(updater.check()).resolves.toEqual({ kind: "error", message: "offline" });
  });
});
