import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    quit: vi.fn(),
    getPath: vi.fn(() => "/Applications/GitDove.app/Contents/MacOS/GitDove"),
  },
  handlers: new Map<string, (...args: any[]) => void>(),
  auto: { on: vi.fn(), checkForUpdates: vi.fn(), quitAndInstall: vi.fn() },
  native: { check: vi.fn(), install: vi.fn(), dispose: vi.fn() },
  Sparkle: vi.fn(),
}));
vi.mock("electron", () => ({ app: mocks.app }));
vi.mock("electron-log/main", () => ({ default: { warn: vi.fn() } }));
vi.mock("electron-updater", () => ({ default: { autoUpdater: mocks.auto } }));
vi.mock("./sparkle", () => ({ SparkleUpdater: mocks.Sparkle }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  mocks.app.isPackaged = true;
  mocks.handlers.clear();
  mocks.auto.on.mockImplementation((event, callback) => mocks.handlers.set(event, callback));
  mocks.auto.checkForUpdates.mockResolvedValue(null);
  mocks.native.check.mockResolvedValue(undefined);
  mocks.Sparkle.mockImplementation(function () {
    return mocks.native;
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  Object.defineProperty(process, "platform", platform);
});

describe("updater", () => {
  it("leaves development builds alone", async () => {
    mocks.app.isPackaged = false;
    const { updater } = await import("./updater");
    updater.init(vi.fn());
    await updater.check();
    updater.install();
    updater.dispose();
    expect(mocks.auto.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.Sparkle).not.toHaveBeenCalled();
    expect(updater.status()).toEqual({ kind: "idle" });
  });

  it("uses Sparkle only on macOS and keeps the downloaded update ready", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    const { updater } = await import("./updater");
    const listener = vi.fn();
    updater.init(listener);
    await Promise.resolve();
    updater.init(listener);
    expect(mocks.Sparkle).toHaveBeenCalledTimes(1);
    const set = mocks.Sparkle.mock.calls[0]![1];
    updater.install();
    expect(mocks.native.install).not.toHaveBeenCalled();
    set({ kind: "ready", version: "1.0.2" });
    await updater.check();
    updater.install();
    expect(updater.status()).toEqual({ kind: "ready", version: "1.0.2" });
    expect(listener).toHaveBeenLastCalledWith({ kind: "ready", version: "1.0.2" });
    expect(mocks.native.check).toHaveBeenCalledTimes(1);
    expect(mocks.native.install).toHaveBeenCalledOnce();
    mocks.Sparkle.mock.calls[0]![3]();
    expect(mocks.app.quit).toHaveBeenCalledOnce();
    updater.dispose();
    expect(mocks.native.dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps electron-updater events and scheduled checks on other platforms", async () => {
    const { updater } = await import("./updater");
    const listener = vi.fn();
    updater.init(listener);
    await Promise.resolve();
    for (const [event, args, status] of [
      ["checking-for-update", undefined, { kind: "checking" }],
      ["update-available", { version: "1.0.2" }, { kind: "available", version: "1.0.2" }],
      ["download-progress", { percent: 25 }, { kind: "downloading", percent: 25 }],
      ["error", new Error("offline"), { kind: "error", message: "offline" }],
      ["update-not-available", undefined, { kind: "idle" }],
    ] as const) {
      mocks.handlers.get(event)!(args);
      expect(listener).toHaveBeenLastCalledWith(status);
    }
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
    expect(mocks.auto.checkForUpdates).toHaveBeenCalledTimes(2);
    mocks.handlers.get("update-downloaded")!({ version: "1.0.2" });
    updater.install();
    expect(mocks.auto.quitAndInstall).toHaveBeenCalledOnce();
    updater.dispose();
  });

  it("does not overlap checks or replace an active download", async () => {
    let finish!: () => void;
    mocks.auto.checkForUpdates.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const { updater } = await import("./updater");
    updater.init(vi.fn());
    await updater.check();
    expect(mocks.auto.checkForUpdates).toHaveBeenCalledOnce();
    finish();
    await Promise.resolve();
    mocks.handlers.get("download-progress")!({ percent: 10 });
    await updater.check();
    expect(mocks.auto.checkForUpdates).toHaveBeenCalledOnce();
    updater.dispose();
  });

  it.each([new Error("offline"), "unavailable"])("reports check failures %s", async (error) => {
    mocks.auto.checkForUpdates.mockRejectedValue(error);
    const { updater } = await import("./updater");
    const listener = vi.fn();
    updater.init(listener);
    await Promise.resolve();
    expect(listener).toHaveBeenLastCalledWith({
      kind: "error",
      message: error instanceof Error ? error.message : error,
    });
    updater.dispose();
  });
});
