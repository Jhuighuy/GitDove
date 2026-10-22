/**
 * The runner script under one shell, run locally. Each shell has a test file of its own
 * (`runner.<shell>.test.ts`), so they run in parallel.
 */
import { spawn as nodeSpawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import { ResponseParser, RUNNER_SCRIPT, Runner, runOnRunner, type RunnerEvent } from "./runner";

export const runnerSuite = (sh: string) =>
  describe.skipIf(process.platform === "win32" || !existsSync(sh))(
    `runner script under ${sh}`,
    () => {
      const start = (prefix = "") => Runner.start(sh, ["-c", prefix + RUNNER_SCRIPT]);
      const withRunner = <A, E>(f: (runner: Runner) => Effect.Effect<A, E>) =>
        Effect.runPromise(
          Effect.acquireUseRelease(start(), f, (r) => Effect.sync(() => r.close())),
        );
      const run = (
        runner: Runner,
        command: string,
        options: {
          stdin?: string | Buffer;
          okCodes?: number[];
          maxBytes?: number;
          onStdout?: (chunk: Buffer) => void;
        } = {},
      ) => runOnRunner(runner, "test", command, { ...options, display: command });
      const tmp = () => mkdtempSync(join(tmpdir(), "gitdove-runner-"));

      it("runs commands with stdin, exit codes and binary output", async () => {
        await withRunner((runner) =>
          Effect.gen(function* () {
            const r = yield* run(runner, "echo out; echo err >&2; exit 3", { okCodes: [3] });
            expect([r.stdout.toString(), r.stderr, r.exitCode]).toEqual(["out\n", "err\n", 3]);

            const bin = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
            const cat = yield* run(runner, "cat", { stdin: bin });
            expect(cat.stdout.equals(bin)).toBe(true);

            const empty = yield* run(runner, "cat");
            expect(empty.stdout).toHaveLength(0);

            const cwd = yield* run(runner, "cd -- /tmp && pwd -P");
            expect(cwd.stdout.toString().trim()).toBe(
              execFileSync("pwd", ["-P"], { cwd: "/tmp" }).toString().trim(),
            );

            const fail = yield* run(runner, "echo 'fatal: nope' >&2; exit 128").pipe(Effect.flip);
            expect(fail).toMatchObject({ _tag: "CommandError", exitCode: 128, message: "nope" });
          }),
        );
      });

      it("transfers large stdin and output exactly", async () => {
        const input = randomBytes(1536 * 1024 + 7);
        await withRunner((runner) =>
          Effect.gen(function* () {
            const [cat, count, small] = yield* Effect.all(
              [
                run(runner, "cat", { stdin: input }),
                run(runner, "wc -c", { stdin: input }),
                run(runner, "cat", { stdin: "x".repeat(5000) }),
              ],
              { concurrency: "unbounded" },
            );
            expect(cat.stdout.equals(input)).toBe(true);
            expect(Number(count.stdout.toString())).toBe(input.length);
            expect(small.stdout.toString()).toBe("x".repeat(5000));
          }),
        );
      });

      it("pipelines concurrent commands", async () => {
        await withRunner((runner) =>
          Effect.gen(function* () {
            const results = yield* Effect.all(
              Array.from({ length: 40 }, (_, i) =>
                run(
                  runner,
                  `sleep 0.0${i % 5}; i=0; while [ $i -lt ${i * 50} ]; do echo ${i}; i=$((i+1)); done`,
                ),
              ),
              { concurrency: "unbounded" },
            );
            results.forEach((r, i) => expect(r.stdout.toString()).toBe(`${i}\n`.repeat(i * 50)));
          }),
        );
      });

      it("streams output while the command runs", async () => {
        const marker = join(tmp(), "got-a");
        await withRunner((runner) =>
          Effect.gen(function* () {
            const chunks: string[] = [];
            // The command only goes on once we got its first output.
            const r = yield* run(
              runner,
              `printf a; while [ ! -f '${marker}' ]; do sleep 0.02; done; printf b`,
              {
                onStdout: (c) => {
                  chunks.push(c.toString());
                  writeFileSync(marker, "");
                },
              },
            );
            expect(chunks.join("")).toBe("ab");
            expect(r.stdout).toHaveLength(0);
            // Large streams arrive complete and in order.
            const parts: Buffer[] = [];
            yield* run(runner, "i=0; while [ $i -lt 20000 ]; do echo line$i; i=$((i+1)); done", {
              onStdout: (c) => parts.push(c),
            });
            const lines = Buffer.concat(parts).toString().split("\n");
            expect(lines).toHaveLength(20001);
            expect(lines[19999]).toBe("line19999");
          }),
        );
      });

      it("keeps the protocol intact whatever writes to a command's output", async () => {
        await withRunner((runner) =>
          Effect.gen(function* () {
            // Something left running in the background keeps writing after the command exited.
            const r = yield* run(
              runner,
              "echo b; (i=0; while [ $i -lt 100 ]; do echo late; echo late >&2; sleep 0.01; i=$((i+1)); done) &",
            );
            expect(r.stdout.toString().startsWith("b\n")).toBe(true);
            // Output files that shrink, or vanish.
            yield* run(runner, 'echo gone; for f in *.o; do : >"$f"; done');
            const results = yield* Effect.all(
              Array.from({ length: 20 }, (_, i) =>
                run(runner, `head -c ${(i + 1) * 9000} /dev/zero`),
              ),
              { concurrency: "unbounded" },
            );
            results.forEach((x, i) => expect(x.stdout).toHaveLength((i + 1) * 9000));
            expect(runner.alive).toBe(true);
          }),
        );
      });

      it("makes do with a dd that does not report and a head without -c", async () => {
        const bin = tmp();
        const which = (p: string) =>
          execFileSync("/bin/sh", ["-c", `command -v ${p}`])
            .toString()
            .trim();
        writeFileSync(join(bin, "dd"), `#!/bin/sh\nexec ${which("dd")} "$@" 2>/dev/null\n`);
        writeFileSync(
          join(bin, "head"),
          `#!/bin/sh\ncase $1 in -c*) exit 1 ;; esac\nexec ${which("head")} "$@"\n`,
        );
        chmodSync(join(bin, "dd"), 0o755);
        chmodSync(join(bin, "head"), 0o755);
        const runner = await Effect.runPromise(start(`PATH='${bin}':$PATH; export PATH\n`));
        try {
          const input = randomBytes(700 * 1024);
          const [cat, cut, err] = await Effect.runPromise(
            Effect.all(
              [
                run(runner, "cat", { stdin: input }),
                run(runner, "while :; do echo xxxxxxxxxxxxxxx; done", { maxBytes: 100000 }),
                run(runner, "echo oops >&2; exit 1").pipe(Effect.flip),
              ],
              { concurrency: "unbounded" },
            ),
          );
          expect(cat.stdout.equals(input)).toBe(true);
          expect([cut.truncated, cut.stdout.length]).toEqual([true, 100000]);
          expect(err).toMatchObject({ _tag: "CommandError", message: "oops" });
        } finally {
          runner.close();
        }
      });

      it("caps stderr", async () => {
        await withRunner((runner) =>
          Effect.gen(function* () {
            const e = yield* run(runner, "head -c 200000 /dev/zero | tr '\\0' x >&2; exit 1").pipe(
              Effect.flip,
            );
            expect(e._tag === "CommandError" && e.stderr.length).toBe(64 * 1024);
          }),
        );
      });

      it("ignores what the login shell prints before the runner starts", async () => {
        const runner = await Effect.runPromise(start("echo Welcome; echo '@GDR 1 X 0 0'; "));
        try {
          const r = await Effect.runPromise(run(runner, "echo ok"));
          expect(r.stdout.toString()).toBe("ok\n");
        } finally {
          runner.close();
        }
      });

      it("reports stdin it could not store instead of running the command", async () => {
        // A raw request that announces stdin which never came.
        const child = nodeSpawn(sh, ["-c", RUNNER_SCRIPT], { stdio: ["pipe", "pipe", "ignore"] });
        const events: RunnerEvent[] = [];
        const parser = new ResponseParser(
          (e) => events.push(e),
          () => {},
        );
        child.stdout.on("data", (c: Buffer) => parser.push(c));
        child.stdin.write("X 1 0 0 999 echo\\040ran\nX 2 0 0 - echo\\040ok\n");
        const done = () => events.filter((e) => e.kind !== "output");
        await expect.poll(() => done().length, { timeout: 10_000 }).toBe(3);
        child.stdin.end();
        expect(done()).toEqual(
          expect.arrayContaining([
            { kind: "hello" },
            { kind: "failed", id: 1, reason: "input" },
            expect.objectContaining({ kind: "exit", id: 2, exitCode: 0 }),
          ]),
        );
      });

      it("truncates at maxBytes", async () => {
        await withRunner((runner) =>
          Effect.gen(function* () {
            const big = yield* run(runner, "while :; do echo xxxxxxxxxxxxxxx; done", {
              maxBytes: 100000,
            });
            expect(big.truncated).toBe(true);
            expect(big.stdout).toHaveLength(100000);
            expect(big.exitCode).toBe(0);
            const small = yield* run(runner, "echo hi", { maxBytes: 3 });
            expect([small.truncated, small.stdout.toString()]).toEqual([false, "hi\n"]);
            expect((yield* run(runner, "echo ok")).stdout.toString()).toBe("ok\n");
          }),
        );
      });

      it("kills interrupted commands", async () => {
        await withRunner((runner) =>
          Effect.gen(function* () {
            const pidFile = join(tmp(), "pid");
            const fiber = yield* Effect.forkChild(
              run(runner, `exec /bin/sh -c 'echo $$ >"$1"; exec sleep 5' sh ${pidFile}`),
            );
            let pid = "";
            while (!pid) {
              yield* Effect.sleep("20 millis");
              pid = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : "";
            }
            yield* Fiber.interrupt(fiber);
            expect(() => process.kill(Number(pid), 0)).toThrow();
            // The runner keeps working.
            expect((yield* run(runner, "echo ok")).stdout.toString()).toBe("ok\n");
          }),
        );
      });

      it("waits for an interrupted command to exit on the host", async () => {
        await withRunner((runner) =>
          Effect.gen(function* () {
            const dir = tmp();
            const marker = join(dir, "cleaned-up");
            const started = join(dir, "started");
            const fiber = yield* Effect.forkChild(
              run(
                runner,
                `trap 'sleep 0.4; touch "${marker}"; exit 1' TERM; touch '${started}'; while :; do sleep 0.05; done`,
              ),
            );
            while (!existsSync(started)) yield* Effect.sleep("20 millis");
            yield* Fiber.interrupt(fiber);
            expect(existsSync(marker)).toBe(true);
            expect((yield* run(runner, "echo ok")).stdout.toString()).toBe("ok\n");
          }),
        );
      });

      it("stops what an interrupted command started on the host, too", async () => {
        await withRunner((runner) =>
          Effect.gen(function* () {
            const pidFile = join(tmp(), "grandchild.pid");
            const fiber = yield* Effect.forkChild(
              run(runner, `sh -c 'echo $$ > "${pidFile}"; exec sleep 30' & wait`),
            );
            while (!existsSync(pidFile)) yield* Effect.sleep("20 millis");
            yield* Fiber.interrupt(fiber);
            const pid = Number(readFileSync(pidFile, "utf8"));
            expect(() => process.kill(pid, 0)).toThrow();
            expect((yield* run(runner, "echo ok")).stdout.toString()).toBe("ok\n");
          }),
        );
      });

      it("keeps waiting while a killed command's processes may still run", async () => {
        // A ps that reports every process as running under the same command, as if the kill
        // could not be confirmed (e.g. a process stuck in the kernel).
        const bin = mkdtempSync(join(tmpdir(), "gitdove-ps-"));
        writeFileSync(
          join(bin, "ps"),
          `#!/bin/sh\ncase "$*" in *stat=*) echo S ;; *comm=*) echo pinned ;; *) exec /bin/ps "$@" ;; esac\n`,
        );
        chmodSync(join(bin, "ps"), 0o755);
        const path = process.env.PATH;
        process.env.PATH = `${bin}:${path}`;
        try {
          const runner = await Effect.runPromise(start());
          const outcome = await Effect.runPromise(
            Effect.gen(function* () {
              const fiber = yield* Effect.forkChild(run(runner, "sleep 30 & wait"));
              yield* Effect.sleep("200 millis");
              const interrupt = yield* Effect.forkChild(Fiber.interrupt(fiber));
              // Not confirmed gone: the interruption (and a write lock held around it) waits.
              const early = yield* Fiber.join(interrupt).pipe(Effect.timeoutOption("1500 millis"));
              runner.close();
              yield* Fiber.join(interrupt);
              return early._tag;
            }),
          );
          expect(outcome).toBe("None");
        } finally {
          process.env.PATH = path;
        }
      });

      it("fails pending commands when the runner dies", async () => {
        const exit = await Effect.runPromiseExit(
          Effect.gen(function* () {
            const runner = yield* start();
            const fiber = yield* Effect.forkChild(run(runner, "sleep 5"));
            yield* Effect.sleep("100 millis");
            runner.close();
            return yield* Fiber.join(fiber);
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).toContain("SshError");
      });

      it("tells whether a failed command may have run", async () => {
        const [inFlight, never] = await Effect.runPromise(
          Effect.gen(function* () {
            const runner = yield* start();
            const fiber = yield* Effect.forkChild(Effect.flip(run(runner, "sleep 5")));
            yield* Effect.sleep("100 millis");
            runner.close();
            const lost = yield* Fiber.join(fiber);
            // Sent to a runner that is already dead, the command never reaches the host.
            const unsent = yield* Effect.flip(run(runner, "echo hi"));
            return [lost, unsent];
          }),
        );
        expect(inFlight).toMatchObject({
          _tag: "SshError",
          message: "Lost connection to test",
          mayHaveRun: true,
        });
        expect(never).toMatchObject({ _tag: "SshError", mayHaveRun: false });
      });
    },
  );
