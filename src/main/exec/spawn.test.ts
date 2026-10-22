import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Fiber } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CommandError } from "./errors";
import { completion, spawn, spawnTiming, summarizeStderr } from "./spawn";
import { terminateTiming } from "./terminate";

const sh = (script: string, options?: Parameters<typeof spawn>[2]) =>
  spawn("/bin/sh", ["-c", script], options);
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const fail = async <A>(effect: Effect.Effect<A, CommandError>) => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  const reason = exit.cause.reasons[0];
  if (reason?._tag !== "Fail") throw new Error("expected a typed failure");
  return reason.error;
};

let dir = "";
const graceMs = terminateTiming.graceMs;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "gitdove-spawn-"));
  // Processes that ignore SIGTERM get SIGKILL sooner.
  terminateTiming.graceMs = 1000;
});
afterAll(() => {
  terminateTiming.graceMs = graceMs;
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("spawn", () => {
  it("collects stdout and stderr in the given cwd and environment", async () => {
    const r = await run(
      sh('pwd; printf "%s" "$GD_VAR"; echo oops >&2', {
        cwd: dir,
        env: { ...process.env, GD_VAR: "value" },
      }),
    );
    expect(r.stdout.toString()).toBe(`${realpathSync(dir)}\nvalue`);
    expect(r.stderr).toBe("oops\n");
    expect(r.exitCode).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it("feeds stdin as a string or a buffer", async () => {
    expect((await run(sh("cat", { stdin: "hello" }))).stdout.toString()).toBe("hello");
    const bin = Buffer.from([0, 1, 2, 255]);
    expect((await run(sh("cat", { stdin: bin }))).stdout.equals(bin)).toBe(true);
  });

  it("ignores stdin the process does not read", async () => {
    const r = await run(sh("exit 0", { stdin: "x".repeat(1 << 20) }));
    expect(r.exitCode).toBe(0);
  });

  it("accepts the configured exit codes", async () => {
    const r = await run(sh("echo diff; exit 1", { okCodes: [0, 1] }));
    expect(r).toMatchObject({ exitCode: 1, truncated: false });
    expect(r.stdout.toString()).toBe("diff\n");
  });

  it("fails with git's most informative stderr line", async () => {
    const e = await fail(
      sh("echo 'hint: something' >&2; echo 'error: bad thing' >&2; echo Aborting >&2; exit 128", {
        display: "git merge x",
      }),
    );
    expect(e).toBeInstanceOf(CommandError);
    expect(e).toMatchObject({
      message: "bad thing",
      command: "git merge x",
      exitCode: 128,
      stderr: "hint: something\nerror: bad thing\nAborting",
    });
  });

  it("describes silent failures by exit code or signal", async () => {
    const exited = await fail(spawn("/bin/sh", ["-c", "exit 3"]));
    expect(exited.message).toBe("/bin/sh -c exit 3 exited with 3");
    const killed = await fail(sh("kill -TERM $$", { display: "self-kill" }));
    expect(killed).toMatchObject({ message: "self-kill was killed by SIGTERM", exitCode: null });
  });

  it("fails when the program cannot be started", async () => {
    const e = await fail(spawn(join(dir, "no-such-program"), [], { display: "nope" }));
    expect(e.message).toMatch(/^Failed to run .*no-such-program: .*ENOENT/);
    expect(e).toMatchObject({ command: "nope", exitCode: null, stderr: "" });
  });

  it("returns truncated output without waiting for children that hold stdout", async () => {
    // The shell is killed, but a background loop it started keeps writing to the pipe.
    const t0 = Date.now();
    const r = await run(sh("(while :; do echo xxxxxxxxxxxxxxx; done) & wait", { maxBytes: 1000 }));
    expect(r.truncated).toBe(true);
    expect(r.stdout).toHaveLength(1000);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("truncates stdout at maxBytes and kills the process", async () => {
    const r = await run(sh("printf 0123456789; exec sleep 30", { maxBytes: 4 }));
    expect(r.stdout.toString()).toBe("0123");
    expect(r.truncated).toBe(true);
  });

  it("truncates at a chunk boundary", async () => {
    const r = await run(sh("printf 0123; sleep 0.2; printf 4567; exec sleep 30", { maxBytes: 4 }));
    expect(r.stdout.toString()).toBe("0123");
    expect(r.truncated).toBe(true);
  });

  it("streams stdout instead of collecting it", async () => {
    const chunks: string[] = [];
    const r = await run(
      sh("printf a; sleep 0.1; printf b", { onStdout: (c) => chunks.push(c.toString()) }),
    );
    expect(chunks.join("")).toBe("ab");
    expect(r.stdout).toHaveLength(0);
  });

  it("caps collected stderr", async () => {
    const e = await fail(sh("head -c 200000 /dev/zero | tr '\\0' x >&2; exit 1"));
    expect(e.stderr.length).toBeGreaterThanOrEqual(64 * 1024);
    expect(e.stderr.length).toBeLessThan(200000);
  });

  it("kills the process when interrupted", async () => {
    const marker = join(dir, "interrupted");
    const fiber = Effect.runFork(sh(`sleep 0.5 && touch '${marker}'`));
    await new Promise((r) => setTimeout(r, 100));
    await run(Fiber.interrupt(fiber));
    await new Promise((r) => setTimeout(r, 800));
    expect(existsSync(marker)).toBe(false);
  });

  it("waits for an interrupted process to exit", async () => {
    // Exiting takes a while (like git cleaning up its locks): the interrupt waits for it.
    const marker = join(dir, "cleaned-up");
    const started = join(dir, "trapping");
    const fiber = Effect.runFork(
      sh(
        `trap 'sleep 0.2; touch "${marker}"; exit 1' TERM; touch '${started}'; while :; do sleep 0.05; done`,
      ),
    );
    while (!existsSync(started)) await new Promise((r) => setTimeout(r, 20));
    await run(Fiber.interrupt(fiber));
    expect(existsSync(marker)).toBe(true);
  });

  it("stops what an interrupted process started, too", async () => {
    // Like git pull, whose git merge would otherwise go on and commit.
    const pidFile = join(dir, "grandchild.pid");
    const fiber = Effect.runFork(sh(`sh -c 'echo $$ > "${pidFile}"; exec sleep 30' & wait`));
    while (!existsSync(pidFile)) await new Promise((r) => setTimeout(r, 20));
    await run(Fiber.interrupt(fiber));
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("kills a process that ignores SIGTERM", async () => {
    const pidFile = join(dir, "stubborn.pid");
    const fiber = Effect.runFork(
      sh(`trap '' TERM; echo $$ > "${pidFile}"; while :; do sleep 0.05; done`),
    );
    while (!existsSync(pidFile)) await new Promise((r) => setTimeout(r, 20));
    await run(Fiber.interrupt(fiber));
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("kills a truncated process that ignores SIGTERM", async () => {
    const r = await run(
      sh("trap '' TERM; while :; do echo xxxxxxxxxxxxxxx; done", { maxBytes: 100 }),
    );
    expect(r).toMatchObject({ truncated: true, exitCode: 0 });
    expect(r.stdout).toHaveLength(100);
  });

  it("does not wait for what the process left running in the background", async () => {
    // E.g. a hook doing `task &`, which holds stdout and stderr open.
    const t0 = Date.now();
    const r = await run(sh("(sleep 3) & echo hi"));
    expect(r.stdout.toString()).toBe("hi\n");
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it("still collects output written shortly after the process exited", async () => {
    // (Generously "shortly", for loaded machines.)
    const drainMs = spawnTiming.drainMs;
    spawnTiming.drainMs = 2000;
    try {
      const r = await run(sh("(sleep 0.05; echo late; echo err >&2) & echo early"));
      expect(r.stdout.toString()).toBe("early\nlate\n");
      expect(r.stderr).toBe("err\n");
    } finally {
      spawnTiming.drainMs = drainMs;
    }
  });

  it("decodes stderr as a whole, not per chunk", async () => {
    const e = await fail(sh("printf '\\303' >&2; sleep 0.1; printf '\\251' >&2; exit 1"));
    expect(e.stderr).toBe("é");
  });

  it("reports a missing working directory as such", async () => {
    const e = await fail(spawn("/bin/sh", ["-c", "true"], { cwd: join(dir, "gone") }));
    expect(e.message).toBe(`Directory not found: ${join(dir, "gone")}`);
  });
});

describe("completion", () => {
  const out = Buffer.from("out");

  it("treats truncated output as success", async () => {
    const r = await run(
      completion({ stdout: out, stderr: "", code: null, truncated: true }, [0], "x"),
    );
    expect(r).toEqual({ stdout: out, stderr: "", exitCode: 0, truncated: true });
  });

  it("succeeds for ok codes and fails otherwise", async () => {
    const ok = await run(
      completion({ stdout: out, stderr: "w", code: 2, truncated: false }, [2], "x"),
    );
    expect(ok.exitCode).toBe(2);
    const e = await fail(
      completion({ stdout: out, stderr: "", code: null, signal: null, truncated: false }, [0], "x"),
    );
    expect(e).toMatchObject({ message: "x exited with -1", exitCode: null });
  });
});

describe("summarizeStderr", () => {
  it("prefers the first fatal/error line without its prefix", () => {
    expect(summarizeStderr("warning: w\nfatal: not a git repository\nerror: later\n")).toBe(
      "not a git repository",
    );
    expect(summarizeStderr("ERROR:   loud")).toBe("loud");
  });

  it("falls back to the last non-empty line", () => {
    expect(summarizeStderr("first\n  last  \n\n")).toBe("last");
    expect(summarizeStderr(" \n\n")).toBeUndefined();
  });
});
