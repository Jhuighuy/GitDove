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
      const stdout = Buffer.concat(chunks);
      if (truncated) {
        finish(Effect.succeed({ stdout, stderr, exitCode: code ?? 0, truncated }));
        return;
      }
      const exitCode = code ?? -1;
      if (code !== null && okCodes.includes(code)) {
        finish(Effect.succeed({ stdout, stderr, exitCode, truncated }));
      } else {
        const firstLine = stderr.trim().split("\n").filter(Boolean).at(-1);
        finish(
          Effect.fail(
            new CommandError({
              message:
                firstLine ??
                (signal
                  ? `${display} was killed by ${signal}`
                  : `${display} exited with ${exitCode}`),
              command: display,
              exitCode: code,
              stderr: stderr.trim(),
            }),
          ),
        );
      }
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
