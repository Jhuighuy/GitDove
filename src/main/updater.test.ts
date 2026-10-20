import { EventEmitter } from "node:events";
import type { UpdaterStatus } from "@shared/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    getPath: () => "/Applications/GitDove.app/Contents/MacOS/GitDove",
    getVersion: () => "0.1.5",
  },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
}));
const sparkle = vi.hoisted(() => ({
  instance: null as null | { onStatus: (s: UpdaterStatus) => void; bundle: string },
  check: vi.fn(),
  install: vi.fn(),
  close: vi.fn(),
}));
const autoUpdater = vi.hoisted(() => ({ emitter: null as unknown }));

vi.mock("electron", () => electron);
vi.mock("electron-log/main", () => ({ default: { warn: vi.fn() } }));
vi.mock("electron-updater", async () => {
  const { EventEmitter } = await import("node:events");
  const updater = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(async () => {
      updater.emit("update-not-available");
    }),
    quitAndInstall: vi.fn(),
  });
  autoUpdater.emitter = updater;
  return { default: { autoUpdater: updater } };
});
vi.mock("./sparkle", () => ({
  Sparkle: class {
    constructor(bundle: string, { onStatus }: { onStatus: (s: UpdaterStatus) => void }) {
      sparkle.instance = { onStatus, bundle };
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

beforeEach(() => vi.clearAllMocks());
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
});

describe("updater elsewhere", () => {
  it("checks through electron-updater", async () => {
    const { updater, checkForUpdatesFromMenu, statuses } = await load("linux");
    const emitter = autoUpdater.emitter as EventEmitter;
    await expect(updater.check()).resolves.toEqual({ kind: "idle" });
    expect(statuses.at(-1)).toEqual({ kind: "idle" });
    await checkForUpdatesFromMenu();
    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ message: "GitDove is up to date" }),
    );
    emitter.emit("update-downloaded", { version: "0.1.6" });
    expect(updater.status()).toEqual({ kind: "ready", version: "0.1.6" });
  });
});
