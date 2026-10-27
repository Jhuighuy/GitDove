import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { UpdaterStatus } from "@shared/domain";

/** Relative to GitDove.app; see `scripts/sparkle.mjs`. */
const HELPER = "Contents/Frameworks/GitDove Updater.app/Contents/MacOS/GitDove Updater";

export interface SparkleHandlers {
  /** Whether Sparkle checks on startup and on its schedule (see {@link Sparkle.setAutomatic}). */
  readonly automatic: boolean;
  readonly onStatus: (status: UpdaterStatus) => void;
  readonly onLog: (message: string) => void;
}

/**
 * macOS updates through Sparkle, which runs in a helper process embedded in GitDove.app
 * (`native/macos/Updater.swift`). The helper checks on its own schedule, downloads and verifies
 * updates silently, and installs a downloaded update after GitDove quits.
 */
export class Sparkle {
  private readonly helper: ChildProcessWithoutNullStreams;
  private closed = false;

  constructor(
    bundle: string,
    { automatic, onStatus, onLog }: SparkleHandlers,
    executable = join(bundle, HELPER),
  ) {
    const helper = spawn(executable, [bundle, ...(automatic ? [] : ["--manual"])]);
    this.helper = helper;
    createInterface({ input: helper.stdout }).on("line", (line) => {
      const status = parseSparkleStatus(line);
      if (status) onStatus(status);
      else onLog(`Unexpected output from the updater: ${line}`);
    });
    createInterface({ input: helper.stderr }).on("line", onLog);
    helper.stdin.on("error", (e) => onLog(`Updater input failed: ${e.message}`));
    helper.on("error", (e) => {
      this.closed = true;
      onStatus({ kind: "error", message: `Updater failed: ${e.message}` });
    });
    helper.on("exit", (code, signal) => {
      if (this.closed) return;
      this.closed = true;
      onStatus({ kind: "error", message: `Updater stopped unexpectedly (${signal ?? code})` });
    });
  }

  /** Checks for updates now; answers with `idle`, `available`, `ready` or `error`. */
  check() {
    return this.send("check");
  }

  /** Turns Sparkle's own checks (on startup and on its schedule) on or off; on checks now. */
  setAutomatic(automatic: boolean) {
    this.send(automatic ? "automatic" : "manual");
  }

  /** Installs the downloaded update: Sparkle quits GitDove, then relaunches it. */
  install() {
    this.send("install");
  }

  /** Called when GitDove quits. Sparkle installs a downloaded update after GitDove has exited. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.helper.stdin.end();
  }

  /** Returns false if the helper is gone and will not answer. */
  private send(command: string) {
    if (this.closed) return false;
    this.helper.stdin.write(`${command}\n`);
    return true;
  }
}

export function parseSparkleStatus(line: string): UpdaterStatus | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const e = value as Record<string, unknown>;
  switch (e.kind) {
    case "checking":
    case "idle":
      return { kind: e.kind };
    case "available":
    case "ready":
      return typeof e.version === "string" ? { kind: e.kind, version: e.version } : null;
    case "downloading":
      return typeof e.percent === "number" ? { kind: e.kind, percent: e.percent } : null;
    case "error":
      return typeof e.message === "string" ? { kind: e.kind, message: e.message } : null;
    default:
      return null;
  }
}
