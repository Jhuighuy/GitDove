import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseSparkleStatus, SparkleUpdater } from "./sparkle";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

function setup() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn(),
  });
  spawn.mockReturnValue(child);
  const status = vi.fn();
  const logger = { warn: vi.fn() };
  const installing = vi.fn();
  const bundle = join(tmpdir(), "GitDove Test.app");
  return {
    child,
    status,
    logger,
    installing,
    bundle,
    updater: new SparkleUpdater(join(bundle, "Contents/MacOS/GitDove"), status, logger, installing),
  };
}

beforeEach(() => vi.clearAllMocks());

describe("Sparkle bridge", () => {
  it("starts the bundled helper once and reads fragmented status messages", async () => {
    const { child, updater, status, installing, bundle } = setup();
    const checked = updater.check();
    void updater.check();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      expect.stringContaining(join("GitDoveUpdater.app", "Contents/MacOS/GitDoveUpdater")),
      [bundle],
      { stdio: "pipe" },
    );
    child.stdout.write('{"kind":"check');
    child.stdout.write('ing"}\n{"kind":"available","version":"1.0.2"}\n');
    await checked;
    expect(status.mock.calls.map(([value]) => value)).toEqual([
      { kind: "checking" },
      { kind: "available", version: "1.0.2" },
    ]);
    child.stdout.write('{"kind":"ready","version":"1.0.2"}\n');
    updater.install();
    expect(child.stdin.read().toString()).toBe("install\n");
    child.stdout.write('{"kind":"installing"}\n{"kind":"installed","relaunched":true}\n');
    expect(installing).toHaveBeenCalledOnce();
    child.emit("close", 0);
    expect(status).toHaveBeenLastCalledWith({ kind: "ready", version: "1.0.2" });
  });

  it("finishes an empty check and can check again later", async () => {
    const { child, updater, status } = setup();
    const checked = updater.check();
    child.stdout.write('{"kind":"idle"}\n');
    child.emit("close", 0);
    await checked;
    expect(status).toHaveBeenLastCalledWith({ kind: "idle" });
    void updater.check();
    expect(spawn).toHaveBeenCalledTimes(2);
    updater.dispose();
  });

  it("reports helper errors and logs native diagnostics", async () => {
    const { child, updater, status, logger } = setup();
    const checked = updater.check();
    child.stderr.write("signature verification failed\n");
    child.stdout.write('{"kind":"error","message":"Update signature is invalid"}\n');
    child.emit("close", 1);
    await checked;
    expect(status).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith({ kind: "error", message: "Update signature is invalid" });
    expect(logger.warn).toHaveBeenCalledWith("signature verification failed");
  });

  it("handles a missing executable and broken input pipe", async () => {
    const { child, updater, status } = setup();
    const checked = updater.check();
    child.emit("error", new Error("ENOENT"));
    await checked;
    expect(status).toHaveBeenLastCalledWith({
      kind: "error",
      message: "Could not start the macOS updater: ENOENT",
    });
    child.stdin.emit("error", new Error("EPIPE"));
    expect(status).toHaveBeenLastCalledWith({ kind: "error", message: "EPIPE" });
  });

  it.each(["not-json\n", "x".repeat(65537)])(
    "rejects invalid or oversized protocol output",
    async (response) => {
      const { child, updater, status } = setup();
      const checked = updater.check();
      child.stdout.write(response);
      await checked;
      expect(child.kill).toHaveBeenCalled();
      expect(status).toHaveBeenLastCalledWith({
        kind: "error",
        message: "Invalid response from the macOS updater",
      });
    },
  );

  it("reports crashes even after an update was found", async () => {
    const { child, updater, status } = setup();
    const checked = updater.check();
    child.stdout.write('{"kind":"available","version":"1.0.2"}\n');
    await checked;
    child.emit("close", 1);
    expect(status).toHaveBeenLastCalledWith({
      kind: "error",
      message: "The macOS updater exited unexpectedly (1)",
    });
  });

  it("closes input without killing the installer when the app quits", async () => {
    const { child, updater, status } = setup();
    const checked = updater.check();
    updater.dispose();
    child.emit("close", 0);
    await checked;
    expect(child.stdin.writableEnded).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    const inactive = setup();
    inactive.updater.install();
    inactive.updater.dispose();
  });
});

describe("Sparkle status validation", () => {
  it.each([
    null,
    false,
    [],
    {},
    { kind: "ready" },
    { kind: "error", message: 7 },
    { kind: "downloading", percent: Infinity },
  ])("ignores malformed status %j", (value) => {
    expect(parseSparkleStatus(value)).toBeNull();
  });
  it("clamps progress and keeps only the typed protocol fields", () => {
    expect(parseSparkleStatus({ kind: "downloading", percent: -1 })).toEqual({
      kind: "downloading",
      percent: 0,
    });
    expect(parseSparkleStatus({ kind: "downloading", percent: 105 })).toEqual({
      kind: "downloading",
      percent: 100,
    });
    expect(parseSparkleStatus({ kind: "downloading", percent: 50 })).toEqual({
      kind: "downloading",
      percent: 50,
    });
    expect(parseSparkleStatus({ kind: "idle", extra: true })).toEqual({ kind: "idle" });
  });
});
