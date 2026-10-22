/**
 * Hosts against a fake `ssh` on PATH that runs "remote" commands locally, so
 * the master connection, the runner and plain sessions are exercised for real.
 */
import { execFileSync } from "node:child_process";
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
import { join } from "node:path";
import { Deferred, Effect, Exit, Fiber, ManagedRuntime, RcMap } from "effect";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backoffTiming,
  type ExecOptions,
  getOrRetry,
  type Host,
  Hosts,
  invalidHostAlias,
  LOCAL_HOST,
  loginShellCommand,
  makeHostsLayer,
  sshConfigHosts,
  windowsShellCandidates,
} from "./hosts";

const FAKE_SSH = String.raw`#!/bin/sh
# Fake ssh: logs "<kind> <host>" and runs remote commands with the local sh. The host must
# come after "--"; its options are logged to "opts".
d=$GITDOVE_FAKE_SSH
master=; op=; host=; remote=; cp=
while [ $# -gt 0 ]; do
  case $1 in
    -o) shift; echo "$1" >>"$d/opts"; case $1 in ControlPath=*) cp=${"${1#ControlPath=}"} ;; esac ;;
    -F) shift ;;
    -M) master=1 ;;
    -N|-T|-t) ;;
    -O) shift; op=$1 ;;
    --) shift; host=$1; shift; remote=$1; break ;;
    *) echo "unexpected argument $1" >&2; exit 99 ;;
  esac
  shift
done
count() { n=$(cat "$d/$1" 2>/dev/null || echo 0); n=$((n + 1)); echo $n >"$d/$1"; echo $n; }
if [ -n "$master" ]; then
  echo "master $host" >>"$d/log"
  case $host in
    denied|down) echo "debug1: trying key" >&2; echo "Permission denied (publickey)." >&2; exit 255 ;;
    later) if [ "$(count later-masters)" = 1 ]; then
        echo "ssh: connect to host later port 22: Connection refused" >&2; exit 255
      fi ;;
  esac
  echo $$ >"$d/master-$host.pid"
  echo $$ >"$cp.pid"
  echo "$host" >"$cp.alias"
  exec sleep 600
fi
if [ "$op" = check ]; then
  # Like ssh -O check: succeeds once the master is up.
  kill -0 "$(cat "$cp.pid" 2>/dev/null)" 2>/dev/null || exit 255
fi
if [ -n "$op" ]; then
  echo "$op $(cat "$cp.alias" 2>/dev/null || echo "$cp")" >>"$d/log"
  exit 0
fi
case $host in
  denied|down) if [ "$cp" = none ]; then echo "Permission denied (publickey)." >&2; exit 255; fi ;;
esac
case $remote in
  *GDR-HELLO*)
    echo "runner $host" >>"$d/log"
    case $host in
      norunner*) echo "sh: mkfifo: not found" >&2; exit 127 ;;
      dying) if [ "$(count dying-runners)" = 1 ]; then
          printf '@GDR-HELLO 2\n'; read -r line; echo "lost" >&2; exit 1
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

const lines = (file: string) =>
  existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
const log = () => lines(join(state, "log"));
const opts = () => lines(join(state, "opts"));

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
const hostsRuntime = (multiplex = true) => {
  const runtime = ManagedRuntime.make(
    makeHostsLayer({ multiplex, controlDir: join(state, "control") }),
  );
  const run = <A, E>(f: (hosts: Hosts["Service"]) => Effect.Effect<A, E>) =>
    runtime.runPromise(Effect.flatMap(Hosts, f));
  const runExit = <A, E>(f: (hosts: Hosts["Service"]) => Effect.Effect<A, E>) =>
    runtime.runPromiseExit(Effect.flatMap(Hosts, f));
  return { runtime, run, runExit };
};
let current: ReturnType<typeof hostsRuntime> | null = null;
const hosts = (multiplex = true) => (current = hostsRuntime(multiplex));
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

describe("host aliases", () => {
  it("rejects what ssh would take as an option or that breaks repository ids", () => {
    for (const ok of ["fedora", "local", "me@box.example.com", "::1", "build_box-2"]) {
      expect(invalidHostAlias(ok), ok).toBeNull();
    }
    for (const bad of ["", "-oProxyCommand=x", "a b", "a\nb", "x;y", "$(id)", "a/b", LOCAL_HOST]) {
      expect(invalidHostAlias(bad), bad).not.toBeNull();
    }
  });
});

describe.skipIf(process.platform === "win32")("loginShellCommand", () => {
  const shells = ["/bin/sh", "/bin/bash", "/bin/zsh", "/bin/dash", "/bin/tcsh", "/bin/csh"];
  const script = `printf '%s|' "a b" 'it'"'"'s' "\\\\n %d" "é"\necho "$((1 + 2))" \`echo -n\``;
  it.each(shells.filter((s) => existsSync(s)))("runs scripts unchanged from %s", (shell) => {
    expect(execFileSync(shell, ["-c", loginShellCommand(script)]).toString()).toBe(
      execFileSync("/bin/sh", ["-c", script]).toString(),
    );
  });
});

describe("windowsShellCandidates", () => {
  it("looks next to Git for Windows' exec path and its directories on PATH", () => {
    expect(
      windowsShellCandidates(
        "C:/Program Files/Git/mingw64/libexec/git-core",
        "C:\\Windows;C:\\Program Files\\Git\\cmd",
      ),
    ).toEqual([
      "C:\\Program Files\\Git\\bin\\sh.exe",
      "C:\\Program Files\\Git\\usr\\bin\\sh.exe",
      "C:\\bin\\sh.exe",
      "C:\\usr\\bin\\sh.exe",
      "C:\\Windows\\sh.exe",
      "C:\\Program Files\\Git\\cmd\\sh.exe",
    ]);
  });
});

describe.skipIf(process.platform === "win32")("Hosts", () => {
  describe("local host", () => {
    it("runs programs and scripts with the git environment", async () => {
      const { run } = hosts();
      const local = await run((h) => Effect.succeed(h.get(LOCAL_HOST)));
      expect(local).toMatchObject({ id: LOCAL_HOST, kind: "local" });
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
    it("lists concrete aliases from ~/.ssh/config and the files it includes", async () => {
      const home = join(dir, "home");
      process.env.HOME = home;
      mkdirSync(join(home, ".ssh", "config.d"), { recursive: true });
      writeFileSync(
        join(home, ".ssh", "config"),
        [
          "Include config.d/*",
          "Host fedora build-box",
          "  HostName 10.0.0.2",
          "host *.internal web? !bastion",
          "Match host foo",
          "  Host  nested\tother ",
          "Host fedora",
          "HostName notahost",
          "Host=equals -bad",
          "Include ~/.ssh/missing /nonexistent/*",
        ].join("\n"),
      );
      writeFileSync(join(home, ".ssh", "config.d", "b"), "Host from-b\nInclude ../config\n");
      writeFileSync(join(home, ".ssh", "config.d", "a"), "Host from-a\n");
      const { run } = hosts();
      expect(await run((h) => h.configuredSshHosts)).toEqual([
        "from-a",
        "from-b",
        "fedora",
        "build-box",
        "nested",
        "other",
        "equals",
      ]);
      expect(sshConfigHosts(join(home, ".ssh", "nope"), home)).toEqual([]);
    });

    it("is empty without a config file", async () => {
      process.env.HOME = join(dir, "nobody");
      const { run } = hosts();
      expect(await run((h) => h.configuredSshHosts)).toEqual([]);
    });
  });

  describe("SSH host", () => {
    it("caches hosts by alias, and an alias named local is an SSH host", async () => {
      const { run } = hosts();
      const [a, b, c, local] = await run((h) =>
        Effect.succeed([h.get("good"), h.get("good"), h.get("other"), h.get("local")]),
      );
      expect(a).toBe(b);
      expect(a).not.toBe(c);
      expect(a).toMatchObject({ id: "good", kind: "ssh" });
      expect(local).toMatchObject({ id: "local", kind: "ssh" });
    });

    it("refuses invalid aliases without running ssh", async () => {
      const { runExit } = hosts();
      for (const alias of ["-oProxyCommand=touch x", "a b"]) {
        expect(failure(await runExit((h) => h.get(alias).sh("true")))).toMatchObject({
          _tag: "SshError",
          mayHaveRun: false,
        });
        expect(failure(await runExit((h) => h.connect(alias)))).toMatchObject({
          _tag: "SshError",
        });
      }
      expect(log()).toEqual([]);
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

    it("keeps the user's forwardings and remote command out of its connections", async () => {
      const { run } = hosts();
      await run((h) => h.connect("good"));
      await run((h) => h.connect("other"));
      for (const o of ["ClearAllForwardings=yes", "RemoteCommand=none", "BatchMode=yes"]) {
        expect(opts().filter((x) => x === o).length, o).toBeGreaterThanOrEqual(4);
      }
      // A control socket per alias, even if two aliases lead to the same machine.
      const paths = new Set(opts().filter((o) => o.startsWith("ControlPath=")));
      expect(paths.size).toBe(2);
      for (const p of paths)
        expect(p.startsWith(`ControlPath=${join(state, "control")}/`)).toBe(true);
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

    it("streams output and sends large stdin over the runner too", async () => {
      const { run } = hosts();
      const good = await run((h) => Effect.succeed(h.get("good")));
      const chunks: string[] = [];
      const r = await run(() =>
        good.sh("printf a; sleep 0.1; printf b", { onStdout: (c) => chunks.push(c.toString()) }),
      );
      expect(chunks.join("")).toBe("ab");
      expect(r.stdout).toHaveLength(0);
      const payload = "x".repeat(300 * 1024 + 1);
      expect(await run(() => shOut(good, "wc -c | tr -d ' '", { stdin: payload, cwd: dir }))).toBe(
        `${payload.length}\n`,
      );
      expect(log()).toEqual(["master good", "check good", "runner good"]);
    });

    it("reports authentication failures, and does not retry them right away", async () => {
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
      expect(log()).toEqual(["master denied"]);
    });

    it("backs off after failed connection attempts", async () => {
      const { runExit } = hosts();
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      // E.g. the watcher polling a host that is down: one attempt, not one per command.
      for (let i = 0; i < 3; i++) {
        expect(failure(await runExit((h) => h.get("down").sh("true")))._tag).toBe("SshError");
      }
      expect(log()).toEqual(["master down"]);
      clock.mockReturnValue(now + backoffTiming.minMs);
      await runExit((h) => h.get("down").sh("true"));
      expect(log()).toEqual(["master down", "master down"]);
      // The wait doubles.
      clock.mockReturnValue(now + 2 * backoffTiming.minMs);
      await runExit((h) => h.get("down").sh("true"));
      expect(log()).toHaveLength(2);
      // The user asking to connect tries again right away.
      await runExit((h) => h.connect("down"));
      expect(log()).toHaveLength(3);
    });

    it("runs scripts with the git environment, like programs", async () => {
      const { run } = hosts();
      const env = "echo $GIT_OPTIONAL_LOCKS $GIT_TERMINAL_PROMPT $GIT_EDITOR $LC_MESSAGES";
      // The watcher's `git status` must not take index.lock on the host.
      expect(await run((h) => shOut(h.get("good"), env))).toBe("0 0 true C\n");
      expect(await run((h) => out(h.get("good"), "/bin/sh", ["-c", env]))).toBe("0 0 true C\n");
      expect(await run((h) => shOut(h.get("norunner"), env))).toBe("0 0 true C\n");
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
      // The second runner checks that the master is still up first.
      expect(log()).toEqual([
        "master dying",
        "check dying",
        "runner dying",
        "check dying",
        "runner dying",
      ]);
    });

    it("does not repeat other commands when the runner died with them in flight", async () => {
      const { run, runExit } = hosts();
      const exit = await runExit((h) => h.get("dying").sh("echo once"));
      expect(failure(exit)).toMatchObject({
        _tag: "SshError",
        message: "Lost connection to dying",
        host: "dying",
        mayHaveRun: true,
      });
      expect(log()).toEqual(["master dying", "check dying", "runner dying"]);
      // The next command gets a fresh runner.
      expect(await run((h) => shOut(h.get("dying"), "echo next"))).toBe("next\n");
      expect(log().at(-1)).toBe("runner dying");
    });

    /** The first run kills the master and fails like ssh does (255); later runs print ok. */
    const dropOnce = (host: string) => {
      const marker = join(state, "dropped");
      return `if [ ! -f '${marker}' ]; then touch '${marker}'; kill "$(cat '${state}/master-${host}.pid')"; sleep 0.5; exit 255; fi; echo ok`;
    };

    it("retries a read-only session once over a fresh master after losing the connection", async () => {
      const { run } = hosts();
      const host = await run((h) => Effect.succeed(h.get("norunner-flaky")));
      await run((h) => h.connect("norunner-flaky"));
      expect(await run(() => shOut(host, dropOnce("norunner-flaky"), { idempotent: true }))).toBe(
        "ok\n",
      );
      expect(log().slice(3)).toEqual([
        "session norunner-flaky",
        "master norunner-flaky",
        "check norunner-flaky",
        "session norunner-flaky",
      ]);
    });

    it("does not retry a read-only command once it streamed output", async () => {
      const { runExit } = hosts();
      await runExit((h) => h.connect("norunner-flaky"));
      const chunks: string[] = [];
      const script = `echo first; ${dropOnce("norunner-flaky")}`;
      const exit = await runExit((h) =>
        h.get("norunner-flaky").sh(script, {
          idempotent: true,
          onStdout: (c) => chunks.push(c.toString()),
        }),
      );
      expect(failure(exit)).toMatchObject({ _tag: "SshError", mayHaveRun: true });
      expect(chunks.join("")).toBe("first\n");
    });

    it("reports a lost connection instead of repeating other commands", async () => {
      const { runExit } = hosts();
      await runExit((h) => h.connect("norunner-flaky"));
      const exit = await runExit((h) => h.get("norunner-flaky").sh(dropOnce("norunner-flaky")));
      expect(failure(exit)).toMatchObject({
        _tag: "SshError",
        message: "Lost connection to norunner-flaky",
        host: "norunner-flaky",
        mayHaveRun: true,
      });
      expect(log().filter((l) => l.startsWith("session"))).toHaveLength(1);
    });

    it("keeps exit code 255 as a command failure while the connection is up", async () => {
      const { run, runExit } = hosts();
      await run((h) => h.connect("norunner"));
      const exit = await runExit((h) => h.get("norunner").sh("exit 255"));
      expect(failure(exit)).toMatchObject({ _tag: "CommandError", exitCode: 255 });
      // On the runner, too.
      const onRunner = await runExit((h) => h.get("good").sh("exit 255"));
      expect(failure(onRunner)).toMatchObject({ _tag: "CommandError", exitCode: 255 });
    });

    it("closes the master connection on shutdown", async () => {
      const { run, runtime } = hosts();
      await run((h) => h.connect("good"));
      await runtime.dispose();
      current = null;
      expect(log()).toEqual(["master good", "check good", "runner good", "exit good"]);
    });

    it("closes masters left behind by app instances that are gone", async () => {
      // An instance that crashed (no such process id), and this one.
      const orphan = join(state, "control", "zzzz");
      mkdirSync(orphan, { recursive: true });
      writeFileSync(join(orphan, "socket"), "");
      writeFileSync(join(orphan, "socket.alias"), "old");
      const own = join(state, "control", process.pid.toString(36));
      mkdirSync(own, { recursive: true });
      const { run } = hosts();
      await run((h) => h.connect("good"));
      await expect.poll(() => existsSync(orphan), { timeout: 10_000 }).toBe(false);
      expect(log()).toContain("exit old");
      expect(existsSync(own)).toBe(true);
    });
  });

  describe("SSH host without multiplexing", () => {
    it("runs commands over the runner's own connection", async () => {
      const { run } = hosts(false);
      const good = await run((h) => Effect.succeed(h.get("good")));
      expect(await run(() => shOut(good, "echo one"))).toBe("one\n");
      expect(await run(() => shOut(good, "echo two"))).toBe("two\n");
      expect(log()).toEqual(["runner good"]);
      expect(opts()).toContain("ControlPath=none");
    });

    it("reports connection failures, backing off", async () => {
      const { runExit } = hosts(false);
      const exit = await runExit((h) => h.connect("denied"));
      expect(failure(exit)).toMatchObject({
        _tag: "SshError",
        message: "Could not connect to denied: Permission denied (publickey).",
        mayHaveRun: false,
      });
      expect(failure(await runExit((h) => h.get("denied").sh("true")))._tag).toBe("SshError");
      expect(log()).toEqual([]);
    });

    it("falls back to sessions of their own", async () => {
      const { run } = hosts(false);
      expect(await run((h) => shOut(h.get("norunner"), "echo one"))).toBe("one\n");
      expect(log()).toEqual(["runner norunner", "session norunner"]);
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
