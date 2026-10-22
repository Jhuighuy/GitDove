/**
 * Hosts against a fake `ssh` on PATH that runs "remote" commands locally, so
 * the master connection, the runner and plain sessions are exercised for real.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Deferred, Effect, Exit, Fiber, ManagedRuntime, RcMap } from "effect";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type ExecOptions, getOrRetry, type Host, Hosts, HostsLive, LOCAL_HOST } from "./hosts";
import { MAX_RUNNER_STDIN } from "./runner";

const FAKE_SSH = String.raw`#!/bin/sh
# Fake ssh: logs "<kind> <host>" and runs remote commands with the local sh.
d=$GITDOVE_FAKE_SSH
master=; op=; host=; remote=; cp=
while [ $# -gt 0 ]; do
  case $1 in
    -o) shift; case $1 in ControlPath=*) cp=$(printf %s "$1" | sed 's/^ControlPath=//') ;; esac ;;
    -M) master=1 ;;
    -N|-T|-t) ;;
    -O) shift; op=$1 ;;
    --) shift; remote=$1; break ;;
    *) host=$1 ;;
  esac
  shift
done
count() { n=$(cat "$d/$1" 2>/dev/null || echo 0); n=$((n + 1)); echo $n >"$d/$1"; echo $n; }
if [ -n "$master" ]; then
  echo "master $host" >>"$d/log"
  echo "master $cp" >>"$d/paths"
  case $host in
    denied) echo "debug1: trying key" >&2; echo "Permission denied (publickey)." >&2; exit 255 ;;
    later) if [ "$(count later-masters)" = 1 ]; then
        echo "ssh: connect to host later port 22: Connection refused" >&2; exit 255
      fi ;;
  esac
  echo $$ >"$d/master-$host.pid"
  exec sleep 600
fi
if [ "$op" = check ]; then
  # Like ssh -O check: succeeds once the master is up.
  kill -0 "$(cat "$d/master-$host.pid" 2>/dev/null)" 2>/dev/null || exit 255
fi
if [ -n "$op" ]; then
  echo "$op $host" >>"$d/log"
  echo "$op $cp" >>"$d/paths"
  exit 0
fi
case $remote in
  *GDR-HELLO*)
    echo "runner $host" >>"$d/log"
    case $host in
      norunner) echo "sh: mkfifo: not found" >&2; exit 127 ;;
      dying) if [ "$(count dying-runners)" = 1 ]; then
          printf '@GDR-HELLO 1\n'; read -r line; echo "lost" >&2; exit 1
        fi ;;
    esac ;;
  *) echo "session $host" >>"$d/log" ;;
esac
exec /bin/sh -c "$remote"
`;

let dir = "";
let state = "";
const saved = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  FAKE: process.env.GITDOVE_FAKE_SSH,
};

const log = () => readFileSync(join(state, "log"), "utf8").split("\n").filter(Boolean);

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "gitdove-hosts-")));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "ssh"), FAKE_SSH);
  chmodSync(join(dir, "bin", "ssh"), 0o755);
  process.env.PATH = `${join(dir, "bin")}:${saved.PATH}`;
});
afterAll(() => {
  process.env.PATH = saved.PATH;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  state = mkdtempSync(join(dir, "state-"));
  writeFileSync(join(state, "log"), "");
  process.env.GITDOVE_FAKE_SSH = state;
});
afterEach(() => {
  process.env.GITDOVE_FAKE_SSH = saved.FAKE;
  process.env.HOME = saved.HOME;
  vi.restoreAllMocks();
});

/** A fresh `Hosts` service; disposing it closes all connections. */
const hostsRuntime = () => {
  const runtime = ManagedRuntime.make(HostsLive);
  const run = <A, E>(f: (hosts: Hosts["Service"]) => Effect.Effect<A, E>) =>
    runtime.runPromise(Effect.flatMap(Hosts, f));
  const runExit = <A, E>(f: (hosts: Hosts["Service"]) => Effect.Effect<A, E>) =>
    runtime.runPromiseExit(Effect.flatMap(Hosts, f));
  return { runtime, run, runExit };
};
let current: ReturnType<typeof hostsRuntime> | null = null;
const hosts = () => (current = hostsRuntime());
afterEach(async () => {
  await current?.runtime.dispose();
  current = null;
});

const out = (h: Host, program: string, args: string[], options?: ExecOptions) =>
  Effect.map(h.exec(program, args, options), (r) => r.stdout.toString());
const shOut = (h: Host, script: string, options?: ExecOptions) =>
  Effect.map(h.sh(script, options), (r) => r.stdout.toString());

const failure = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  const reason = exit.cause.reasons[0];
  if (reason?._tag !== "Fail") throw new Error(`expected a typed failure, got ${reason?._tag}`);
  return reason.error;
};

describe.skipIf(process.platform === "win32")("Hosts", () => {
  describe("local host", () => {
    it("runs programs and scripts with the git environment", async () => {
      const { run } = hosts();
      const local = await run((h) => Effect.succeed(h.get(LOCAL_HOST)));
      expect(local).toMatchObject({ id: "local", kind: "local" });
      expect(
        await run(() => out(local, "/bin/sh", ["-c", 'printf %s "$GIT_TERMINAL_PROMPT"'])),
      ).toBe("0");
      expect(await run(() => shOut(local, "pwd", { cwd: dir }))).toBe(`${dir}\n`);
      expect(await run((h) => h.connect(LOCAL_HOST))).toBeUndefined();
      expect(log()).toEqual([]);
    });

    it("reports failures with the command line", async () => {
      const { runExit } = hosts();
      const exit = await runExit((h) => h.get(LOCAL_HOST).exec("/bin/sh", ["-c", "exit 2", "x y"]));
      expect(failure(exit)).toMatchObject({
        _tag: "CommandError",
        command: "/bin/sh -c 'exit 2' 'x y'",
        exitCode: 2,
      });
      const script = await runExit((h) => h.get(LOCAL_HOST).sh("echo 'fatal: nope' >&2; exit 1"));
      expect(failure(script)).toMatchObject({
        message: "nope",
        command: "echo 'fatal: nope' >&2; exit 1",
      });
    });
  });

  describe("configured SSH hosts", () => {
    it("lists concrete aliases from ~/.ssh/config", async () => {
      process.env.HOME = join(dir, "home");
      mkdirSync(join(dir, "home", ".ssh"), { recursive: true });
      writeFileSync(
        join(dir, "home", ".ssh", "config"),
        [
          "Host fedora build-box",
          "  HostName 10.0.0.2",
          "host *.internal web? !bastion",
          "Match host foo",
          "  Host  nested\tother ",
          "Host fedora",
          "HostName notahost",
        ].join("\n"),
      );
      const { run } = hosts();
      expect(await run((h) => h.configuredSshHosts)).toEqual([
        "fedora",
        "build-box",
        "nested",
        "other",
      ]);
    });

    it("is empty without a config file", async () => {
      process.env.HOME = join(dir, "nobody");
      const { run } = hosts();
      expect(await run((h) => h.configuredSshHosts)).toEqual([]);
    });
  });

  describe("SSH host", () => {
    it("caches hosts by alias", async () => {
      const { run } = hosts();
      const [a, b, c] = await run((h) =>
        Effect.succeed([h.get("good"), h.get("good"), h.get("other")]),
      );
      expect(a).toBe(b);
      expect(a).not.toBe(c);
      expect(a).toMatchObject({ id: "good", kind: "ssh" });
    });

    it("runs commands over one master connection and one runner", async () => {
      const { run } = hosts();
      const good = await run((h) => Effect.succeed(h.get("good")));
      await run((h) => h.connect("good"));
      expect(log()).toEqual(["master good", "check good", "runner good"]);

      expect(await run(() => out(good, "pwd", [], { cwd: dir }))).toBe(`${dir}\n`);
      expect(await run(() => out(good, "pwd", []))).toBe(`${process.env.HOME}\n`);
      expect(
        await run(() => out(good, "sh", ["-c", 'printf "%s %s" "$GIT_PAGER" "$1"', "-", "it's"])),
      ).toBe("cat it's");
      expect(await run(() => shOut(good, 'printf "%s" "$PWD"', { cwd: dir }))).toBe(dir);
      expect(await run(() => shOut(good, "pwd"))).toBe(`${process.env.HOME}\n`);
      expect(await run(() => shOut(good, "cat", { stdin: "small stdin" }))).toBe("small stdin");
      // All commands went through the runner.
      expect(log()).toEqual(["master good", "check good", "runner good"]);
    });

    it("gives every master its own control socket", async () => {
      // Two apps (or test workers) on one host: closing one must not close the other's master.
      const a = hostsRuntime();
      const b = hostsRuntime();
      await a.run((h) => h.connect("good"));
      await b.run((h) => h.connect("good"));
      const paths = (kind: string) =>
        readFileSync(join(state, "paths"), "utf8")
          .split("\n")
          .filter((l) => l.startsWith(`${kind} `))
          .map((l) => l.slice(kind.length + 1));
      const [first, second] = paths("master");
      expect(first).not.toBe(second);
      await a.runtime.dispose();
      expect(paths("exit")).toEqual([first]);
      expect(existsSync(dirname(first!))).toBe(false);
      expect(existsSync(dirname(second!))).toBe(true);
      await b.runtime.dispose();
      expect(existsSync(dirname(second!))).toBe(false);
    });

    it("keeps command semantics on the runner", async () => {
      const { run, runExit } = hosts();
      const good = await run((h) => Effect.succeed(h.get("good")));
      const r = await run(() => good.sh("echo x; exit 1", { okCodes: [0, 1] }));
      expect(r).toMatchObject({ exitCode: 1, truncated: false });
      const big = await run(() => good.sh("printf 0123456789", { maxBytes: 4 }));
      expect(big.stdout.toString()).toBe("0123");
      expect(big.truncated).toBe(true);
      const exit = await runExit(() => good.exec("git", ["--no-such-option"]));
      expect(failure(exit)).toMatchObject({
        _tag: "CommandError",
        command: "git --no-such-option",
      });
    });

    it("streams output and sends large stdin over sessions of their own", async () => {
      const { run } = hosts();
      const good = await run((h) => Effect.succeed(h.get("good")));
      const chunks: string[] = [];
      const r = await run(() =>
        good.sh("printf a; sleep 0.1; printf b", { onStdout: (c) => chunks.push(c.toString()) }),
      );
      expect(chunks.join("")).toBe("ab");
      expect(r.stdout).toHaveLength(0);
      const payload = "x".repeat(MAX_RUNNER_STDIN + 1);
      expect(await run(() => shOut(good, "wc -c | tr -d ' '", { stdin: payload, cwd: dir }))).toBe(
        `${payload.length}\n`,
      );
      expect(await run(() => out(good, "pwd", [], { cwd: dir, onStdout: () => {} }))).toBe("");
      expect(log()).toEqual([
        "master good",
        "check good",
        "session good",
        "session good",
        "session good",
      ]);
    });

    it("reports authentication failures", async () => {
      const { runExit } = hosts();
      const exit = await runExit((h) => h.connect("denied"));
      expect(failure(exit)).toMatchObject({
        _tag: "SshError",
        host: "denied",
        message: "Could not connect to denied: Permission denied (publickey).",
        stderr: "debug1: trying key\nPermission denied (publickey).",
      });
      const cmd = await runExit((h) => h.get("denied").sh("true"));
      expect(failure(cmd)).toMatchObject({ _tag: "SshError", host: "denied", mayHaveRun: false });
    });

    it("runs scripts with the git environment, like programs", async () => {
      const { run } = hosts();
      const env = "echo $GIT_OPTIONAL_LOCKS $GIT_TERMINAL_PROMPT $GIT_EDITOR";
      // The watcher's `git status` must not take index.lock on the host.
      expect(await run((h) => shOut(h.get("good"), env))).toBe("0 0 true\n");
      expect(await run((h) => out(h.get("good"), "/bin/sh", ["-c", env]))).toBe("0 0 true\n");
    });

    it("only checks the master on connect while the runner is backed off", async () => {
      const { run } = hosts();
      await run((h) => h.connect("norunner"));
      await run((h) => h.connect("norunner"));
      // E.g. browsing folders: no new runner attempt (and its timeout) per request.
      expect(log().filter((l) => l === "runner norunner")).toHaveLength(1);
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
      await run((h) => h.connect("norunner"));
      expect(log().filter((l) => l === "runner norunner")).toHaveLength(2);
    });

    it("connects again after a failed connection", async () => {
      const { runExit } = hosts();
      expect(failure(await runExit((h) => h.connect("later")))).toMatchObject({
        _tag: "SshError",
        message:
          "Could not connect to later: ssh: connect to host later port 22: Connection refused",
      });
      // The host is reachable now (say, the VPN came up): the failure is not cached.
      expect(Exit.isSuccess(await runExit((h) => h.connect("later")))).toBe(true);
      expect((await runExit((h) => shOut(h.get("later"), "echo up"))).toJSON()).toMatchObject({
        value: "up\n",
      });
      expect(log().filter((l) => l === "master later")).toHaveLength(2);
    });

    it("falls back to plain sessions when the runner cannot start", async () => {
      const { run } = hosts();
      const host = await run((h) => Effect.succeed(h.get("norunner")));
      await run((h) => h.connect("norunner"));
      expect(await run(() => shOut(host, "echo one"))).toBe("one\n");
      expect(await run(() => shOut(host, "echo two"))).toBe("two\n");
      expect(log()).toEqual([
        "master norunner",
        "check norunner",
        "runner norunner",
        "session norunner",
        "session norunner",
      ]);
      // After the retry delay, starting the runner is tried again.
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
      expect(await run(() => shOut(host, "echo three"))).toBe("three\n");
      expect(log().slice(-2)).toEqual(["runner norunner", "session norunner"]);
    });

    it("restarts a runner that died with a read-only command in flight", async () => {
      const { run } = hosts();
      const host = await run((h) => Effect.succeed(h.get("dying")));
      expect(await run(() => shOut(host, "echo survived", { idempotent: true }))).toBe(
        "survived\n",
      );
      expect(log()).toEqual(["master dying", "check dying", "runner dying", "runner dying"]);
    });

    it("does not repeat other commands when the runner died with them in flight", async () => {
      const { run, runExit } = hosts();
      const exit = await runExit((h) => h.get("dying").sh("echo once"));
      expect(failure(exit)).toMatchObject({ _tag: "SshError", host: "dying", mayHaveRun: true });
      expect(log()).toEqual(["master dying", "check dying", "runner dying"]);
      // The next command gets a fresh runner.
      expect(await run((h) => shOut(h.get("dying"), "echo next"))).toBe("next\n");
      expect(log().at(-1)).toBe("runner dying");
    });

    /** The first run kills the master and fails like ssh does (255); later runs print ok. */
    const dropOnce = () => {
      const marker = join(state, "dropped");
      return `if [ ! -f '${marker}' ]; then touch '${marker}'; kill "$(cat '${state}/master-flaky.pid')"; sleep 0.5; exit 255; fi; echo ok`;
    };

    it("retries a read-only session once over a fresh master after losing the connection", async () => {
      const { run } = hosts();
      const host = await run((h) => Effect.succeed(h.get("flaky")));
      const chunks: string[] = [];
      await run(() =>
        host.sh(dropOnce(), { idempotent: true, onStdout: (c) => chunks.push(c.toString()) }),
      );
      expect(chunks.join("")).toBe("ok\n");
      expect(log()).toEqual([
        "master flaky",
        "check flaky",
        "session flaky",
        "master flaky",
        "check flaky",
        "session flaky",
      ]);
    });

    it("reports a lost connection instead of repeating other commands", async () => {
      const { runExit } = hosts();
      const exit = await runExit((h) => h.get("flaky").sh(dropOnce(), { onStdout: () => {} }));
      expect(failure(exit)).toMatchObject({
        _tag: "SshError",
        message: "Lost connection to flaky",
        host: "flaky",
        mayHaveRun: true,
      });
      expect(log()).toEqual(["master flaky", "check flaky", "session flaky"]);
    });

    it("keeps exit code 255 as a command failure while the connection is up", async () => {
      const { runExit } = hosts();
      const exit = await runExit((h) => h.get("good").sh("exit 255", { onStdout: () => {} }));
      expect(failure(exit)).toMatchObject({ _tag: "CommandError", exitCode: 255 });
      expect(log().filter((l) => l.startsWith("session"))).toHaveLength(1);
    });

    it("closes the master connection on shutdown", async () => {
      const { run, runtime } = hosts();
      await run((h) => h.connect("good"));
      await runtime.dispose();
      current = null;
      expect(log()).toEqual(["master good", "check good", "runner good", "exit good"]);
    });
  });
});

describe("getOrRetry", () => {
  it("drops a shared failed lookup once, keeping a newer attempt", async () => {
    let attempts = 0;
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const failNow = yield* Deferred.make<void>();
          const map = yield* RcMap.make({
            lookup: (key: string) =>
              attempts++ === 0
                ? Deferred.await(failNow).pipe(Effect.andThen(Effect.fail("down")))
                : Effect.yieldNow.pipe(Effect.as(`${key}${attempts}`)),
            // Like the hosts' maps, keep entries after their last user is done.
            idleTimeToLive: "1 minute",
          });
          // Two callers wait on the same failing lookup; the first retries right away.
          const first = yield* Effect.forkChild(
            Effect.scoped(getOrRetry(map, "h")).pipe(Effect.retry({ times: 1 })),
          );
          const second = yield* Effect.forkChild(Effect.scoped(getOrRetry(map, "h")));
          yield* Effect.yieldNow;
          yield* Deferred.succeed(failNow, undefined);
          expect(yield* Fiber.join(first)).toBe("h2");
          expect(yield* Effect.flip(Fiber.join(second))).toBe("down");
          // The retry's entry survived the second caller's failure: no third lookup.
          expect(yield* Effect.scoped(getOrRetry(map, "h"))).toBe("h2");
        }),
      ),
    );
    expect(Exit.isSuccess(exit) ? "ok" : exit).toBe("ok");
    expect(attempts).toBe(2);
  });
});
