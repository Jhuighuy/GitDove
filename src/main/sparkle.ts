import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import type { UpdaterStatus } from "@shared/domain";

/** Sparkle owns download verification, replacement, permissions, and relaunch. */
export class SparkleUpdater {
  private child: ChildProcessWithoutNullStreams | null = null;
  private installing = false;
  private stopping = false;

  constructor(
    private readonly executable: string,
    private readonly onStatus: (status: UpdaterStatus) => void,
    private readonly logger: { warn: (message: string) => void },
    private readonly onInstalling: () => void = () => {},
  ) {}

  check() {
    if (this.child) return Promise.resolve();
    const bundle = resolve(dirname(this.executable), "../..");
    const helper = join(
      bundle,
      "Contents/Resources/sparkle/GitDoveUpdater.app/Contents/MacOS/GitDoveUpdater",
    );
    const child = spawn(helper, [bundle], { stdio: "pipe" });
    this.child = child;
    this.installing = false;
    this.stopping = false;
    let finishCheck = () => {};
    const checked = new Promise<void>((done) => {
      finishCheck = done;
    });
    let buffer = "";
    let receivedResult = false;
    const fail = (message: string) => {
      receivedResult = true;
      this.onStatus({ kind: "error", message });
      finishCheck();
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 65536) {
        fail("Invalid response from the macOS updater");
        child.kill();
        return;
      }
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const value: unknown = JSON.parse(line);
          if (
            this.installing &&
            value &&
            typeof value === "object" &&
            "kind" in value &&
            value.kind === "installing"
          ) {
            this.onInstalling();
          }
          const status = parseSparkleStatus(value);
          if (status) {
            receivedResult ||= status.kind === "idle" || status.kind === "error";
            this.onStatus(status);
            if (
              status.kind === "idle" ||
              status.kind === "error" ||
              status.kind === "available" ||
              status.kind === "ready"
            )
              finishCheck();
          }
        } catch {
          fail("Invalid response from the macOS updater");
          child.kill();
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (message: string) => this.logger.warn(message.trim()));
    child.stdin.on("error", (error: Error) => fail(error.message));
    child.on("error", (error) => fail(`Could not start the macOS updater: ${error.message}`));
    child.on("close", (code) => {
      if (this.child === child) this.child = null;
      if (!receivedResult && !this.installing && !this.stopping)
        fail(`The macOS updater exited unexpectedly (${code})`);
      finishCheck();
    });
    return checked;
  }

  install() {
    if (!this.child) return;
    this.installing = true;
    this.child.stdin.write("install\n");
  }

  dispose() {
    // Sparkle's installer must outlive Electron while replacing its bundle.
    this.stopping = true;
    this.child?.stdin.end();
  }
}

export function parseSparkleStatus(value: unknown): UpdaterStatus | null {
  if (!value || typeof value !== "object" || !("kind" in value)) return null;
  if (value.kind === "checking" || value.kind === "idle") return { kind: value.kind };
  if (
    (value.kind === "available" || value.kind === "ready") &&
    "version" in value &&
    typeof value.version === "string"
  ) {
    return { kind: value.kind, version: value.version };
  }
  if (
    value.kind === "downloading" &&
    "percent" in value &&
    typeof value.percent === "number" &&
    Number.isFinite(value.percent)
  ) {
    return { kind: "downloading", percent: Math.max(0, Math.min(100, value.percent)) };
  }
  if (value.kind === "error" && "message" in value && typeof value.message === "string") {
    return { kind: "error", message: value.message };
  }
  return null;
}
