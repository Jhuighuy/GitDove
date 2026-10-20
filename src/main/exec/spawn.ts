import { spawn as nodeSpawn } from "node:child_process";
import { Effect } from "effect";
import { CommandError } from "./errors";

export interface SpawnOptions {
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly stdin?: string | Buffer | undefined;
  /** Exit codes considered successful. Defaults to `[0]`. */
  readonly okCodes?: readonly number[] | undefined;
  /** Kill the process once stdout exceeds this many bytes (output is truncated). */
  readonly maxBytes?: number | undefined;
  /**
   * Streaming consumer. When set, stdout chunks are handed over as they arrive
   * and are *not* accumulated in the result.
   */
  readonly onStdout?: ((chunk: Buffer) => void) | undefined;
  /** Human readable command for error messages. */
  readonly display?: string | undefined;
}

export interface SpawnResult {
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly exitCode: number;
  readonly truncated: boolean;
}

const MAX_STDERR = 64 * 1024;

/**
 * Spawns a process and collects its output. Interrupting the returned effect
 * kills the process.
 */
export const spawn = (
  file: string,
  args: readonly string[],
  options: SpawnOptions = {},
): Effect.Effect<SpawnResult, CommandError> =>
  Effect.callback<SpawnResult, CommandError>((resume) => {
    const display = options.display ?? [file, ...args].join(" ");
    const okCodes = options.okCodes ?? [0];
    const child = nodeSpawn(file, args as string[], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let stderr = "";
    let done = false;

    const finish = (effect: Effect.Effect<SpawnResult, CommandError>) => {
      if (done) return;
      done = true;
      resume(effect);
    };

    child.stdout.on("data", (chunk: Buffer) => {
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
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finish(
        Effect.fail(
          new CommandError({
            message: `Failed to run ${file}: ${error.message}`,
            command: display,
            exitCode: null,
            stderr: "",
          }),
        ),
      );
    });
    child.on("close", (code, signal) => {
      finish(
        completion(
          { stdout: Buffer.concat(chunks), stderr, code, signal, truncated },
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

    return Effect.sync(() => {
      if (!done && child.exitCode === null) child.kill();
    });
  });

/**
 * Turns a finished process into a result, or a `CommandError` when its exit
 * code is not one of `okCodes`. Truncated output always counts as success
 * since the process was killed on purpose.
 */
export const completion = (
  r: {
    readonly stdout: Buffer;
    readonly stderr: string;
    readonly code: number | null;
    readonly signal?: string | null | undefined;
    readonly truncated: boolean;
  },
  okCodes: readonly number[],
  display: string,
): Effect.Effect<SpawnResult, CommandError> => {
  const { stdout, stderr, code, signal, truncated } = r;
  if (truncated) return Effect.succeed({ stdout, stderr, exitCode: code ?? 0, truncated });
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
