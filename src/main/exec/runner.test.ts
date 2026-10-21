import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import {
  encodePrintf,
  encodeRequest,
  ResponseParser,
  RUNNER_SCRIPT,
  Runner,
  runOnRunner,
  type RunnerEvent,
} from "./runner";

const frame = (id: number, code: number, out: string | Buffer, err = "") => {
  const o = Buffer.from(out);
  const e = Buffer.from(err);
  return Buffer.concat([Buffer.from(`@GDR ${id} ${code} ${o.length} ${e.length}\n`), o, e]);
};

const parse = (chunks: Buffer[]) => {
  const events: RunnerEvent[] = [];
  const errors: Error[] = [];
  const parser = new ResponseParser(
    (e) => events.push(e),
    (e) => errors.push(e),
  );
  for (const c of chunks) parser.push(c);
  return { events, errors };
};

const responses = (events: RunnerEvent[]) =>
  events.flatMap((e) =>
    e.kind === "response"
      ? [{ id: e.id, code: e.exitCode, out: e.stdout.toString(), err: e.stderr.toString() }]
      : [],
  );

describe("ResponseParser", () => {
  const stream = Buffer.concat([
    Buffer.from("@GDR-HELLO 1\n"),
    frame(1, 0, "hello\nworld\n", "warn\n"),
    frame(2, 128, "", "fatal: bad\n"),
    frame(3, 0, ""),
    frame(4, 1, "@GDR 9 9 9 9\n"),
  ]);
  const expected = [
    { id: 1, code: 0, out: "hello\nworld\n", err: "warn\n" },
    { id: 2, code: 128, out: "", err: "fatal: bad\n" },
    { id: 3, code: 0, out: "", err: "" },
    { id: 4, code: 1, out: "@GDR 9 9 9 9\n", err: "" },
  ];

  it("parses a stream in one chunk", () => {
    const { events, errors } = parse([stream]);
    expect(errors).toEqual([]);
    expect(events[0]).toEqual({ kind: "hello" });
    expect(responses(events)).toEqual(expected);
  });

  it("parses a stream split at every byte boundary", () => {
    for (let at = 1; at < stream.length; at++) {
      const { events, errors } = parse([stream.subarray(0, at), stream.subarray(at)]);
      expect(errors).toEqual([]);
      expect(responses(events)).toEqual(expected);
    }
    const { events } = parse([...stream].map((b) => Buffer.from([b])));
    expect(responses(events)).toEqual(expected);
  });

  it("keeps binary output intact", () => {
    const bin = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const { events } = parse([frame(7, 0, bin)]);
    expect(events[0]).toMatchObject({ kind: "response", id: 7 });
    expect((events[0] as { stdout: Buffer }).stdout.equals(bin)).toBe(true);
  });

  it("rejects garbage", () => {
    expect(parse([Buffer.from("bash: oops\n")]).errors).toHaveLength(1);
    expect(parse([Buffer.alloc(1000, 0x41)]).errors).toHaveLength(1);
    const { events, errors } = parse([frame(1, 0, "ok"), Buffer.from("junk\n"), frame(2, 0, "")]);
    expect(responses(events)).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });
});

describe("encodePrintf", () => {
  it("uses only printable, space-free ASCII", () => {
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    expect(encodePrintf(all)).toMatch(/^[\x21-\x7e]+$/);
    expect(encodePrintf("a b\n%\\")).toBe("a\\040b\\012%%\\\\");
    expect(encodePrintf("-n")).toBe("\\055n");
  });

  it("round-trips through the shell's printf", () => {
    const shells = ["/bin/sh", "/bin/dash", "/bin/bash"].filter((s) => existsSync(s));
    const samples = [
      Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
      Buffer.from("\x000123\n\x01\x07 -v x %s %% \\n \\0101 'q' \"dq\" $HOME `id` é"),
      Buffer.from("-v"),
    ];
    for (const sh of shells) {
      for (const s of samples) {
        const out = execFileSync(sh, ["-c", 'printf "$1"', "sh", encodePrintf(s)]);
        expect(out.equals(s), `${sh}: ${JSON.stringify(s.toString())}`).toBe(true);
      }
    }
  });

  it("builds request lines", () => {
    expect(encodeRequest(3, "git log", undefined, 0)).toBe("X 3 0 git\\040log\n");
    expect(encodeRequest(4, "cat", "a\0b", 10)).toBe("X 4 10 cat a\\000b\n");
    expect(encodeRequest(5, "cat", "", 0)).toBe("X 5 0 cat\n");
  });
});

const shells = ["/bin/sh", "/bin/dash", "/bin/bash"].filter((s) => existsSync(s));

describe.skipIf(process.platform === "win32").each(shells)("runner script under %s", (sh) => {
  const withRunner = <A, E>(f: (runner: Runner) => Effect.Effect<A, E>) =>
    Effect.runPromise(
      Effect.acquireUseRelease(Runner.start(sh, ["-c", RUNNER_SCRIPT]), f, (r) =>
        Effect.sync(() => r.close()),
      ),
    );
  const run = (
    runner: Runner,
    command: string,
    options: { stdin?: string | Buffer; okCodes?: number[]; maxBytes?: number } = {},
  ) => runOnRunner(runner, "test", command, { ...options, display: command });

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

  it("truncates at maxBytes", async () => {
    await withRunner((runner) =>
      Effect.gen(function* () {
        const big = yield* run(runner, "while :; do echo xxxxxxxxxxxxxxx; done", {
          maxBytes: 100000,
        });
        expect(big.truncated).toBe(true);
        expect(big.stdout).toHaveLength(100000);
        const small = yield* run(runner, "echo hi", { maxBytes: 3 });
        expect([small.truncated, small.stdout.toString()]).toEqual([false, "hi\n"]);
      }),
    );
  });

  it("kills interrupted commands", async () => {
    await withRunner((runner) =>
      Effect.gen(function* () {
        const pidFile = join(mkdtempSync(join(tmpdir(), "gitdove-runner-")), "pid");
        const fiber = yield* Effect.forkChild(
          run(runner, `exec /bin/sh -c 'echo $$ >"$1"; exec sleep 5' sh ${pidFile}`),
        );
        let pid = "";
        while (!pid) {
          yield* Effect.sleep("20 millis");
          pid = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : "";
        }
        yield* Fiber.interrupt(fiber);
        yield* Effect.sleep("200 millis");
        expect(() => process.kill(Number(pid), 0)).toThrow();
        // The runner keeps working.
        expect((yield* run(runner, "echo ok")).stdout.toString()).toBe("ok\n");
      }),
    );
  });

  it("waits for an interrupted command to exit on the host", async () => {
    await withRunner((runner) =>
      Effect.gen(function* () {
        const marker = join(mkdtempSync(join(tmpdir(), "gitdove-runner-")), "cleaned-up");
        const fiber = yield* Effect.forkChild(
          run(
            runner,
            `trap 'sleep 0.4; touch "${marker}"; exit 1' TERM; while :; do sleep 0.05; done`,
          ),
        );
        yield* Effect.sleep("200 millis");
        yield* Fiber.interrupt(fiber);
        expect(existsSync(marker)).toBe(true);
        expect((yield* run(runner, "echo ok")).stdout.toString()).toBe("ok\n");
      }),
    );
  });

  it("fails pending commands when the runner dies", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const runner = yield* Runner.start(sh, ["-c", RUNNER_SCRIPT]);
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
        const runner = yield* Runner.start(sh, ["-c", RUNNER_SCRIPT]);
        const fiber = yield* Effect.forkChild(Effect.flip(run(runner, "sleep 5")));
        yield* Effect.sleep("100 millis");
        runner.close();
        const lost = yield* Fiber.join(fiber);
        // Sent to a runner that is already dead, the command never reaches the host.
        const unsent = yield* Effect.flip(run(runner, "echo hi"));
        return [lost, unsent];
      }),
    );
    expect(inFlight).toMatchObject({ _tag: "SshError", mayHaveRun: true });
    expect(never).toMatchObject({ _tag: "SshError", mayHaveRun: false });
  });
});
