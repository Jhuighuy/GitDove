import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { Effect } from "effect";
import { environmentReady } from "./environment";
import { CommandError } from "./errors";
import { OWN_PROCESS_GROUP, terminateTree } from "./terminate";

/** Data written to a command's stdin. */
export type Stdin = string | Buffer;

export interface SpawnOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: Stdin;
  /** Exit codes considered successful. Defaults to `[0]`. */
  readonly okCodes?: readonly number[];
  /** Kill the process once stdout exceeds this many bytes (output is truncated). */
  readonly maxBytes?: number;
  /**
   * Streaming consumer. When set, stdout chunks are handed over as they arrive
   * and are *not* accumulated in the result.
   */
  readonly onStdout?: (chunk: Buffer) => void;
  /** Human readable command for error messages. */
  readonly display?: string;
}

export interface SpawnResult {
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly exitCode: number;
  readonly truncated: boolean;
}

/** How much of a command's stderr is kept. */
export const MAX_STDERR = 64 * 1024;

export const spawnTiming = {
  /**
   * After the process exits, how long its output may stay quiet before the pipes are closed:
   * something it left running in the background (e.g. a hook's `task &`) may hold them open.
   */
  drainMs: 200,
  /** The longest wait for such pipes after the process exited. */
  maxDrainMs: 5000,
};

/**
 * Spawns a process and collects its output. Interrupting the returned effect
 * kills the process. Waits for the login shell's environment first (`loadEnvironment`).
 */
export const spawn = (
  file: string,
  args: readonly string[],
  options: SpawnOptions = {},
): Effect.Effect<SpawnResult, CommandError> =>
  Effect.andThen(
    environmentReady,
    Effect.callback<SpawnResult, CommandError>((resume) => {
      const display = options.display ?? [file, ...args].join(" ");
      const okCodes = options.okCodes ?? [0];
      const child = nodeSpawn(file, args as string[], {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // Its own process group, so stopping it stops what it started too (see terminate.ts).
        detached: OWN_PROCESS_GROUP,
      });

      const chunks: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      const stderr: Buffer[] = [];
      let stderrBytes = 0;
      let done = false;
      let lastOutput = Date.now();
      let drain: NodeJS.Timeout | undefined;

      const finish = (effect: Effect.Effect<SpawnResult, CommandError>) => {
        if (done) return;
        done = true;
        clearTimeout(drain);
        resume(effect);
      };
      /** Closes our ends of the pipes; "close" follows once the process has exited. */
      const closePipes = () => {
        child.stdout.destroy();
        child.stderr.destroy();
      };

      child.stdout.on("data", (chunk: Buffer) => {
        lastOutput = Date.now();
        if (truncated) return;
        if (options.onStdout) {
          options.onStdout(chunk);
          return;
        }
        bytes += chunk.length;
        if (options.maxBytes !== undefined && bytes > options.maxBytes) {
          const keep = chunk.length - (bytes - options.maxBytes);
          if (keep > 0) chunks.push(chunk.subarray(0, keep));
          truncated = true;
          // SIGTERM, then SIGKILL if it does not exit. Children it started may still hold the
          // pipes open, which would delay "close" until they exit; ours are not needed anymore
          // (and a writer left behind gets SIGPIPE).
          Effect.runFork(terminateTree(child));
          closePipes();
          return;
        }
        chunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        lastOutput = Date.now();
        if (stderrBytes >= MAX_STDERR) return;
        const part = chunk.subarray(0, MAX_STDERR - stderrBytes);
        stderr.push(part);
        stderrBytes += part.length;
      });
      child.on("error", (error) => {
        const missingCwd =
          (error as NodeJS.ErrnoException).code === "ENOENT" &&
          options.cwd !== undefined &&
          !existsSync(options.cwd);
        finish(
          Effect.fail(
            new CommandError({
              message: missingCwd
                ? `Directory not found: ${options.cwd}`
                : `Failed to run ${file}: ${error.message}`,
              command: display,
              exitCode: null,
              stderr: "",
            }),
          ),
        );
      });
      child.on("exit", () => {
        const exitedAt = Date.now();
        const wait = () => {
          drain = setTimeout(
            // Output that is already waiting in the pipes is read before an immediate runs.
            () =>
              setImmediate(() => {
                if (done) return;
                const now = Date.now();
                if (
                  now - lastOutput < spawnTiming.drainMs &&
                  now - exitedAt < spawnTiming.maxDrainMs
                )
                  wait();
                else closePipes();
              }),
            spawnTiming.drainMs,
          );
        };
        wait();
      });
      child.on("close", (code, signal) => {
        finish(
          completion(
            {
              stdout: Buffer.concat(chunks),
              stderr: Buffer.concat(stderr).toString("utf8"),
              code,
              signal,
              truncated,
            },
            okCodes,
            display,
          ),
        );
      });

      child.stdin.on("error", () => {
        // Ignore EPIPE when the process exits before consuming stdin.
      });
      if (options.stdin !== undefined) child.stdin.end(options.stdin);
      else child.stdin.end();

      // Interrupting stops the process and what it started, and waits until all of it is gone.
      return Effect.suspend(() => {
        if (done) return Effect.void;
        done = true;
        clearTimeout(drain);
        return terminateTree(child);
      });
    }),
  );

/**
 * Turns a finished process into a result, or a `CommandError` when its exit
 * code is not one of `okCodes`. Truncated output always counts as success
 * (exit code 0) since the process was killed on purpose.
 */
export const completion = (
  r: {
    readonly stdout: Buffer;
    readonly stderr: string;
    readonly code: number | null;
    readonly signal?: string | null;
    readonly truncated: boolean;
  },
  okCodes: readonly number[],
  display: string,
): Effect.Effect<SpawnResult, CommandError> => {
  const { stdout, stderr, code, signal, truncated } = r;
  if (truncated) return Effect.succeed({ stdout, stderr, exitCode: 0, truncated });
  const exitCode = code ?? -1;
  if (code !== null && okCodes.includes(code)) {
    return Effect.succeed({ stdout, stderr, exitCode, truncated });
  }
  return Effect.fail(
    new CommandError({
      message:
        summarizeStderr(stderr) ??
        (signal ? `${display} was killed by ${signal}` : `${display} exited with ${exitCode}`),
      command: display,
      exitCode: code,
      stderr: stderr.trim(),
    }),
  );
};

/**
 * Picks the most informative line of git's stderr: the first `fatal:`/`error:`
 * line (git often ends with a bare "Aborting"), else the last non-empty line.
 */
export const summarizeStderr = (stderr: string): string | undefined => {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const important = lines.find((l) => /^(fatal|error):/i.test(l));
  return (important ?? lines.at(-1))?.replace(/^(fatal|error):\s*/i, "");
};
