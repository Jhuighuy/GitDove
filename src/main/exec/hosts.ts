import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { isAbsolute, join, win32 } from "node:path";
import { Context, Data, Effect, Layer, RcMap, Schedule, Semaphore } from "effect";
import { gitEnv, REMOTE_ENV_SCRIPT } from "./environment";
import { CommandError, SshError } from "./errors";
import { Runner, RUNNER_SCRIPT, RunnerExitError, runOnRunner } from "./runner";
import { shellJoin, shellQuote } from "./shell";
import { spawn, type SpawnOptions, type SpawnResult } from "./spawn";

export type ExecOptions = Omit<SpawnOptions, "cwd" | "env" | "display"> & {
  readonly cwd?: string;
  /** The command only reads, so it may run again after a dropped SSH connection. */
  readonly idempotent?: boolean;
};

/** A machine that can run commands: the local one, or one reachable via SSH. */
export interface Host {
  /** `LOCAL_HOST` or the SSH host alias. */
  readonly id: string;
  readonly kind: "local" | "ssh";
  /** Runs a program with the given argv on the host. */
  exec(
    program: string,
    args: readonly string[],
    options?: ExecOptions,
  ): Effect.Effect<SpawnResult, CommandError | SshError>;
  /** Runs a POSIX shell script on the host. */
  sh(script: string, options?: ExecOptions): Effect.Effect<SpawnResult, CommandError | SshError>;
}

/** The id of the local machine; no SSH host alias can be the same (see `invalidHostAlias`). */
export const LOCAL_HOST = "<local>";

/**
 * Why `alias` cannot be an SSH host alias, or null if it can. Like recent OpenSSH, this
 * rejects shell metacharacters; a leading "-" would be an option, "/" would break repository
 * ids.
 */
export const invalidHostAlias = (alias: string): string | null =>
  alias.length === 0
    ? "Host name is empty"
    : alias.length > 255
      ? "Host name is too long"
      : alias.startsWith("-") || /[\0-\x20\x7f'"`$\\;&<>|(){}/]/.test(alias)
        ? `Invalid host name: ${JSON.stringify(alias)}`
        : null;

// ---------------------------------------------------------------------------
// Local host
// ---------------------------------------------------------------------------

/**
 * Where Windows may have a POSIX `sh`: the one that comes with Git for Windows, found from
 * `git --exec-path` (`<git>/mingw64/libexec/git-core`) or from PATH (`<git>/cmd`).
 */
export const windowsShellCandidates = (execPath: string | null, path: string): string[] => {
  const roots = execPath ? [win32.resolve(execPath, "..", "..", "..")] : [];
  for (const dir of path.split(";").filter(Boolean)) roots.push(win32.resolve(dir, ".."));
  const candidates = roots.flatMap((r) => [
    win32.join(r, "bin", "sh.exe"),
    win32.join(r, "usr", "bin", "sh.exe"),
  ]);
  for (const dir of path.split(";").filter(Boolean)) candidates.push(win32.join(dir, "sh.exe"));
  return [...new Set(candidates)];
};

let localShellPath: Promise<string> | undefined;

/** The POSIX shell for scripts on the local machine. */
const localShell: Effect.Effect<string> = Effect.suspend(() => {
  if (process.platform !== "win32") return Effect.succeed("/bin/sh");
  localShellPath ??= Effect.runPromise(
    spawn("git", ["--exec-path"], { env: gitEnv() }).pipe(
      Effect.map((r) => r.stdout.toString("utf8").trim() || null),
      Effect.orElseSucceed(() => null),
      Effect.map(
        (execPath) =>
          windowsShellCandidates(execPath, process.env.PATH ?? "").find((f) => existsSync(f)) ??
          "sh",
      ),
    ),
  );
  return Effect.promise(() => localShellPath!);
});

const localHost: Host = {
  id: LOCAL_HOST,
  kind: "local",
  exec: (program, args, options = {}) =>
    spawn(program, args, { ...options, env: gitEnv(), display: shellJoin([program, ...args]) }),
  sh: (script, options = {}) =>
    Effect.flatMap(localShell, (shell) =>
      spawn(shell, ["-c", script], { ...options, env: gitEnv(), display: script }),
    ),
};

// ---------------------------------------------------------------------------
// SSH hosts
// ---------------------------------------------------------------------------

/**
 * Whether commands share one master connection per host. Win32-OpenSSH has no connection
 * multiplexing: there, the runner (which carries almost all commands) gets a connection of its
 * own, and so does every command that falls back to a session.
 */
const MULTIPLEX = process.platform !== "win32";

interface SshMaster {
  /** The master's socket; null without multiplexing. */
  readonly controlPath: string | null;
  readonly isAlive: () => boolean;
}

/** The connection without multiplexing: nothing to set up, every command connects. */
const DIRECT: SshMaster = { controlPath: null, isAlive: () => true };

/**
 * The directory for this user's control sockets, which must be private: a mux client hands
 * its stdio to whatever listens on the socket.
 */
const controlRoot = (dir?: string): string => {
  const uid = userInfo().uid;
  // Unix socket paths are limited to ~104 bytes, so keep this short.
  const runtime = process.env.XDG_RUNTIME_DIR;
  const root =
    dir ??
    (process.platform === "linux" && runtime && isAbsolute(runtime)
      ? join(runtime, "gitdove")
      : join(process.platform === "darwin" ? "/tmp" : tmpdir(), `gitdove-${uid}`));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const st = lstatSync(root);
  if (!st.isDirectory() || st.uid !== uid) {
    throw new Error(`${root} is not a directory of ours`);
  }
  if ((st.mode & 0o077) !== 0) chmodSync(root, 0o700);
  return root;
};

/** This app instance's socket directory (`<root>/<pid>`), so instances do not share masters. */
const controlDir = (root?: string): string => {
  const dir = join(controlRoot(root), process.pid.toString(36));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
};

/**
 * Closes the masters of app instances that are gone (say, it crashed): `ssh -M -N` does not
 * end with them.
 */
const closeOrphanedMasters = (rootDir?: string) =>
  Effect.gen(function* () {
    const root = yield* Effect.try(() => controlRoot(rootDir));
    const list = (dir: string) =>
      Effect.try(() => readdirSync(dir)).pipe(Effect.orElseSucceed(() => []));
    for (const entry of yield* list(root)) {
      if (!/^[0-9a-z]{1,6}$/.test(entry)) continue;
      try {
        process.kill(parseInt(entry, 36), 0);
        continue;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") continue;
      }
      const stale = join(root, entry);
      for (const socket of yield* list(stale)) {
        // Which alias it was is unknown: skip the config file, which only matters for those.
        yield* spawn("ssh", [
          "-F",
          "/dev/null",
          "-o",
          `ControlPath=${join(stale, socket)}`,
          "-O",
          "exit",
          "--",
          "x",
        ]).pipe(Effect.timeout("2 seconds"), Effect.ignore);
      }
      yield* Effect.try(() => rmSync(stale, { recursive: true, force: true }));
    }
  }).pipe(Effect.ignore);

/** `Hosts` layers built so far, so that two in one process (as in tests) never share a master. */
let layers = 0;

/**
 * The socket of `host`'s master in one `Hosts` layer: named after the alias, not after where it
 * leads, so that closing one master never closes another's.
 */
const controlPathFor = (host: string, layer: number, root?: string) =>
  join(
    controlDir(root),
    `${layer.toString(36)}-${createHash("sha256").update(host).digest("hex").slice(0, 16)}`,
  );

const baseSshOptions = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=15",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
  // The user's forwardings belong to their own sessions (and would clash with them), and a
  // RemoteCommand (say, attaching tmux) cannot be combined with ours.
  "-o",
  "ClearAllForwardings=yes",
  "-o",
  "PermitLocalCommand=no",
  "-o",
  "RemoteCommand=none",
];

const muxOptions = (master: SshMaster) =>
  master.controlPath === null
    ? ["-o", "ControlMaster=no", "-o", "ControlPath=none"]
    : ["-o", `ControlPath=${master.controlPath}`, "-o", "ControlMaster=no"];

/** `ssh -O <op>` for a master. */
const control = (controlPath: string, op: "check" | "exit", host: string) =>
  spawn("ssh", ["-o", `ControlPath=${controlPath}`, "-O", op, "--", host]);

/** The last line of ssh's stderr, which says why it failed. */
const lastLine = (stderr: string) => stderr.trim().split("\n").at(-1)?.trim() ?? "";

/** Starts a long-lived SSH master connection that all commands multiplex over. */
const acquireMaster = (host: string, layer: number, root: string | undefined) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const controlPath = yield* Effect.try({
        try: () => controlPathFor(host, layer, root),
        catch: (e) =>
          new SshError({
            message: `Could not connect to ${host}: ${e instanceof Error ? e.message : String(e)}`,
            host,
            stderr: "",
            mayHaveRun: false,
          }),
      });
      let stderr = "";
      let exited = false;
      const child: ChildProcess = nodeSpawn(
        "ssh",
        [
          ...baseSshOptions,
          "-M",
          "-N",
          "-o",
          `ControlPath=${controlPath}`,
          "-o",
          "ControlPersist=no",
          "--",
          host,
        ],
        { stdio: ["ignore", "ignore", "pipe"], env: process.env, windowsHide: true },
      );
      child.stderr?.on("data", (c: Buffer) => {
        stderr = (stderr + c.toString("utf8")).slice(-16384);
      });
      child.on("exit", () => {
        exited = true;
      });
      child.on("error", (e) => {
        exited = true;
        stderr += e.message;
      });

      const master: SshMaster = { controlPath, isAlive: () => !exited };

      // Wait until the master accepts connections (or dies).
      const check = Effect.suspend((): Effect.Effect<unknown, { fatal: boolean }> =>
        exited
          ? Effect.fail({ fatal: true as const })
          : control(controlPath, "check", host).pipe(
              Effect.mapError(() => ({ fatal: false as const })),
            ),
      );
      yield* check.pipe(
        Effect.retry({
          while: (e) => !e.fatal,
          schedule: Schedule.spaced("100 millis"),
          times: 300,
        }),
        Effect.mapError(
          () =>
            new SshError({
              message: `Could not connect to ${host}: ${lastLine(stderr) || (exited ? "ssh failed" : "timed out")}`,
              host,
              stderr: stderr.trim(),
              mayHaveRun: false,
            }),
        ),
        Effect.onError(() => Effect.sync(() => child.kill())),
      );
      yield* Effect.logInfo(`ssh master connected: ${host}`);
      return { master, child };
    }),
    ({ child, master }) =>
      Effect.gen(function* () {
        yield* Effect.logInfo(`ssh master closing: ${host}`);
        if (master.isAlive()) {
          yield* control(master.controlPath!, "exit", host).pipe(
            Effect.ignore,
            Effect.timeout("2 seconds"),
            Effect.ignore,
          );
        }
        child.kill();
      }),
  ).pipe(Effect.map(({ master }) => master));

/** How many failed lookups each map has dropped per host, to drop each failure only once. */
const evictions = new WeakMap<object, Map<string, number>>();

/**
 * Gets a cached resource. RcMap keeps a failed lookup like a successful one, so drop it: the
 * next call tries again (e.g. once the VPN is up) instead of failing until the entry expires.
 * Callers that shared the failed lookup drop it once: a later one must not drop the new
 * attempt that an earlier one has started meanwhile.
 */
export const getOrRetry = <A, E>(map: RcMap.RcMap<string, A, E>, host: string) =>
  Effect.suspend(() => {
    let counts = evictions.get(map);
    if (!counts) {
      counts = new Map();
      evictions.set(map, counts);
    }
    const seen = counts.get(host) ?? 0;
    return RcMap.get(map, host).pipe(
      Effect.tapError(() => {
        if ((counts.get(host) ?? 0) !== seen) return Effect.void;
        counts.set(host, seen + 1);
        return RcMap.invalidate(map, host);
      }),
    );
  });

/** The first and the longest wait before connecting again after a failed attempt. */
export const backoffTiming = { minMs: 1000, maxMs: 30_000 };

/**
 * Failed connection attempts per host: until `until`, commands fail right away instead of
 * connecting again, e.g. every 2 seconds for the watcher of a host that is down or rejects
 * our keys (which can trip fail2ban). A user's `connect` tries again right away.
 */
class Backoff {
  private readonly failures = new Map<
    string,
    { readonly until: number; readonly delay: number; readonly error: SshError }
  >();

  /** Runs `connect` unless `host` is backing off; records its outcome. */
  guard<A, E, R>(host: string, connect: Effect.Effect<A, E, R>): Effect.Effect<A, E | SshError, R> {
    return Effect.suspend((): Effect.Effect<A, E | SshError, R> => {
      const f = this.failures.get(host);
      if (f && Date.now() < f.until) return Effect.fail(f.error);
      return connect.pipe(
        Effect.tap(() => Effect.sync(() => this.failures.delete(host))),
        Effect.tapError((e) =>
          Effect.sync(() => {
            if (!(e instanceof SshError)) return;
            const delay = f ? Math.min(f.delay * 2, backoffTiming.maxMs) : backoffTiming.minMs;
            this.failures.set(host, { until: Date.now() + delay, delay, error: e });
          }),
        ),
      );
    });
  }

  reset(host: string): void {
    this.failures.delete(host);
  }
}

/** The remote runner could not be started; commands fall back to plain sessions. */
class RunnerUnavailable extends Data.TaggedError("RunnerUnavailable")<{
  readonly message: string;
}> {}

/**
 * Encodes a script so that every login shell passes it on to `/bin/sh` unchanged: ssh runs
 * the remote command with the user's shell, and csh/tcsh (newlines in quotes) or fish
 * (backslashes in quotes) read quoted text differently than sh. Only letters, digits and
 * `_./-` appear literally; all else (`\`, `%`, quotes, spaces, newlines) is an octal escape.
 */
export const loginShellCommand = (script: string): string => {
  const bytes = Buffer.from(script, "utf8");
  let encoded = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    const plain = /[A-Za-z0-9_./-]/.test(String.fromCharCode(b)) && !(i === 0 && b === 0x2d);
    encoded += plain ? String.fromCharCode(b) : `\\${b.toString(8).padStart(3, "0")}`;
  }
  return `exec /bin/sh -c 'eval "$(printf "$0")"' '${encoded}'`;
};

/** Starts a persistent command runner (see `runner.ts`) over the host's connection. */
const acquireRunner = <R>(host: string, master: Effect.Effect<SshMaster, SshError, R>) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const m = yield* master;
      const runner = yield* Runner.start("ssh", [
        ...baseSshOptions,
        ...muxOptions(m),
        "-T",
        "--",
        host,
        loginShellCommand(`${REMOTE_ENV_SCRIPT}\n${RUNNER_SCRIPT}`),
      ]).pipe(
        Effect.timeout("30 seconds"),
        Effect.mapError((e) =>
          // ssh itself failed: the connection, not the runner.
          e instanceof RunnerExitError && e.exitCode === 255
            ? new SshError({
                message: `Could not connect to ${host}: ${e.message.replace(/^Runner exited with 255(: )?/, "") || "ssh failed"}`,
                host,
                stderr: e.message,
                mayHaveRun: false,
              })
            : new RunnerUnavailable({
                message: `Could not start runner on ${host}: ${e.message}`,
              }),
        ),
      );
      yield* Effect.logInfo(`ssh runner started: ${host}`);
      return runner;
    }),
    (runner) => Effect.sync(() => runner.close()),
  );

const remoteCommand = (program: string, args: readonly string[], cwd: string | undefined) =>
  // Without a cwd, run in the home directory as a fresh SSH session would.
  `cd -- ${cwd ? shellQuote(cwd) : '"$HOME"'} && exec ${shellJoin([program, ...args])}`;

const remoteScript = (script: string, cwd: string | undefined) => {
  const inner = cwd ? `cd -- ${shellQuote(cwd)} && ${script}` : script;
  return `cd -- "$HOME" && exec /bin/sh -c ${shellQuote(inner)}`;
};

/**
 * Retries after a lost connection only when that cannot repeat the command's effects:
 * it never reached the host, or it only reads (and has not streamed output yet).
 */
const retryable =
  (options: ExecOptions, streamed: () => boolean) =>
  (e: { readonly _tag: string; readonly mayHaveRun?: boolean }): boolean =>
    e._tag === "SshError" && (!e.mayHaveRun || (options.idempotent === true && !streamed()));

/** Notes whether `onStdout` got output, which a retry would repeat. */
const watchStreaming = (options: ExecOptions) => {
  let streamed = false;
  const onStdout = options.onStdout;
  return {
    options: onStdout
      ? {
          ...options,
          onStdout: (chunk: Buffer) => {
            streamed = true;
            onStdout(chunk);
          },
        }
      : options,
    streamed: () => streamed,
  };
};

/** How long to use plain sessions after the runner failed to start. */
const RUNNER_RETRY_MS = 60_000;

interface SshContext {
  readonly masters: RcMap.RcMap<string, SshMaster, SshError>;
  readonly runners: RcMap.RcMap<string, Runner, SshError | RunnerUnavailable>;
  /** When each host's runner may be tried again after it failed to start. */
  readonly runnerRetryAt: Map<string, number>;
  readonly backoff: Backoff;
  readonly multiplex: boolean;
}

/** Returns the host's master connection, reconnecting if it died (or, with `verify`, hangs). */
const liveMaster = (ctx: SshContext, host: string, verify = false) =>
  // Without multiplexing, the runner's connection is the one that fails (and backs off).
  !ctx.multiplex
    ? Effect.succeed(DIRECT)
    : ctx.backoff.guard(
        host,
        Effect.gen(function* () {
          const master = yield* getOrRetry(ctx.masters, host);
          const alive =
            master.isAlive() &&
            (!verify ||
              master.controlPath === null ||
              (yield* control(master.controlPath, "check", host).pipe(
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              )));
          if (alive) return master;
          yield* RcMap.invalidate(ctx.masters, host);
          return yield* getOrRetry(ctx.masters, host);
        }),
      );

/** A host whose alias is not valid: every command fails before running ssh. */
const invalidHost = (host: string, message: string): Host => {
  const fail = Effect.fail(new SshError({ message, host, stderr: "", mayHaveRun: false }));
  return { id: host, kind: "ssh", exec: () => fail, sh: () => fail };
};

const makeSshHost = (host: string, ctx: SshContext): Host => {
  // sshd allows 10 multiplexed sessions per connection by default (MaxSessions);
  // the runner holds one of them.
  const sessions = Semaphore.makeUnsafe(7);
  // Commands running concurrently on the runner.
  const runnerSlots = Semaphore.makeUnsafe(32);

  /** Runs a command in its own SSH session (when the runner cannot start). */
  const viaSession = (remote: string, display: string, options: ExecOptions) => {
    const watched = watchStreaming(options);
    return Effect.scoped(
      Effect.gen(function* () {
        const master = yield* liveMaster(ctx, host);
        return yield* spawn(
          "ssh",
          [
            ...baseSshOptions,
            ...muxOptions(master),
            "-T",
            "--",
            host,
            loginShellCommand(`${REMOTE_ENV_SCRIPT}\n${remote}`),
          ],
          { ...watched.options, cwd: undefined, env: process.env, display },
        ).pipe(
          Effect.catchTag("CommandError", (e) =>
            Effect.gen(function* () {
              if (e.exitCode !== 255) return yield* Effect.fail(e);
              // ssh fails with 255, but so may the command: ask the master whether it is up.
              const up =
                master.controlPath !== null &&
                master.isAlive() &&
                (yield* control(master.controlPath, "check", host).pipe(
                  Effect.as(true),
                  Effect.orElseSucceed(() => false),
                ));
              if (up) return yield* Effect.fail(e);
              if (master.controlPath !== null) yield* RcMap.invalidate(ctx.masters, host);
              return yield* Effect.fail(
                new SshError({
                  message: `Lost connection to ${host}`,
                  host,
                  stderr: e.stderr,
                  mayHaveRun: true,
                }),
              );
            }),
          ),
        );
      }),
    ).pipe(
      sessions.withPermits(1),
      // A dropped connection gets one transparent retry over a fresh master.
      Effect.retry({ while: retryable(options, watched.streamed), times: 1 }),
    );
  };

  /** Runs a command on the host's runner, starting it if needed. */
  const viaRunner = (remote: string, display: string, options: ExecOptions) => {
    const watched = watchStreaming(options);
    return Effect.scoped(
      Effect.gen(function* () {
        // A runner that failed to start is tried again after RUNNER_RETRY_MS (see `run`).
        let runner = yield* getOrRetry(ctx.runners, host);
        if (!runner.alive) {
          yield* RcMap.invalidate(ctx.runners, host);
          runner = yield* getOrRetry(ctx.runners, host);
        }
        return yield* runOnRunner(runner, host, remote, { ...watched.options, display });
      }),
    ).pipe(
      runnerSlots.withPermits(1),
      // The runner died, before or with the command in flight (e.g. a dropped connection).
      Effect.retry({ while: retryable(options, watched.streamed), times: 1 }),
      Effect.catchTag("RunnerUnavailable", (e) =>
        Effect.gen(function* () {
          ctx.runnerRetryAt.set(host, Date.now() + RUNNER_RETRY_MS);
          yield* Effect.logWarning(e.message);
          return yield* viaSession(remote, display, options);
        }),
      ),
    );
  };

  const run = (remote: string, display: string, options: ExecOptions) =>
    Date.now() >= (ctx.runnerRetryAt.get(host) ?? 0)
      ? viaRunner(remote, display, options)
      : viaSession(remote, display, options);

  return {
    id: host,
    kind: "ssh",
    exec: (program, args, options = {}) =>
      run(remoteCommand(program, args, options.cwd), shellJoin([program, ...args]), options),
    sh: (script, options = {}) => run(remoteScript(script, options.cwd), script, options),
  };
};

// ---------------------------------------------------------------------------
// ~/.ssh/config
// ---------------------------------------------------------------------------

/** Files matching `pattern`, whose components may contain `*` and `?`, sorted. */
const glob = (pattern: string): string[] => {
  const parts = pattern.split("/");
  let paths = [parts[0] === "" ? "/" : parts[0]!];
  for (const part of parts.slice(1)) {
    if (!part) continue;
    if (!/[*?]/.test(part)) {
      paths = paths.map((p) => join(p, part));
      continue;
    }
    const re = new RegExp(
      `^${part
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replaceAll("*", ".*")
        .replaceAll("?", ".")}$`,
    );
    paths = paths.flatMap((p) => {
      try {
        return readdirSync(p)
          .filter((e) => re.test(e) && (part.startsWith(".") || !e.startsWith(".")))
          .toSorted()
          .map((e) => join(p, e));
      } catch {
        return [];
      }
    });
  }
  return paths;
};

/** Concrete host aliases (no patterns) of an ssh config file and the files it includes. */
export const sshConfigHosts = (file: string, home: string, seen = new Set<string>()): string[] => {
  if (seen.has(file) || seen.size > 64) return [];
  seen.add(file);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const hosts: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(Host|Include)(?:\s*=\s*|\s+)(\S.*)$/i.exec(line);
    if (!m) continue;
    const words = m[2]!.split(/\s+/).map((w) => w.replace(/^"(.*)"$/, "$1"));
    if (m[1]!.toLowerCase() === "host") {
      hosts.push(...words.filter((h) => h && !/[*?!]/.test(h)));
      continue;
    }
    for (const word of words) {
      if (!word) continue;
      const path = word.startsWith("~/")
        ? join(home, word.slice(2))
        : isAbsolute(word)
          ? word
          : join(home, ".ssh", word);
      for (const included of glob(path)) hosts.push(...sshConfigHosts(included, home, seen));
    }
  }
  return [...new Set(hosts)];
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class Hosts extends Context.Service<
  Hosts,
  {
    /** Returns the host for `LOCAL_HOST` or an SSH host alias. */
    readonly get: (id: string) => Host;
    /** Host aliases from `~/.ssh/config`. */
    readonly configuredSshHosts: Effect.Effect<string[]>;
    /**
     * Ensures an SSH connection is up (useful to surface auth errors early). It is the user's
     * request, so it does not wait for the backoff after failed attempts.
     */
    readonly connect: (id: string) => Effect.Effect<void, SshError>;
  }
>()("gitdove/Hosts") {}

/**
 * `Hosts`; `multiplex: false` gives every SSH command a connection of its own (as on Windows).
 * `controlDir` is where control sockets go (by default a private directory in /tmp or
 * `$XDG_RUNTIME_DIR`).
 */
export const makeHostsLayer = (
  options: { readonly multiplex?: boolean; readonly controlDir?: string } = {},
) =>
  Layer.effect(
    Hosts,
    Effect.gen(function* () {
      const multiplex = options.multiplex ?? MULTIPLEX;
      const layer = ++layers;
      if (multiplex) yield* Effect.forkDetach(closeOrphanedMasters(options.controlDir));
      const masters = yield* RcMap.make({
        lookup: (host: string) =>
          multiplex
            ? acquireMaster(host, layer, options.controlDir)
            : Effect.succeed(DIRECT as SshMaster),
        idleTimeToLive: "10 minutes",
      });
      const backoff = new Backoff();
      const runnerRetryAt = new Map<string, number>();
      const runnerStarted = new Set<string>();
      const ctx: SshContext = {
        masters,
        backoff,
        multiplex,
        runnerRetryAt,
        runners: yield* RcMap.make({
          lookup: (host: string) =>
            multiplex
              ? // A runner that died may have taken a master with it that still looks alive.
                acquireRunner(host, liveMaster(ctx, host, runnerStarted.has(host))).pipe(
                  Effect.tap(() => Effect.sync(() => runnerStarted.add(host))),
                )
              : // The runner's own connection is the one that may fail.
                backoff.guard(host, acquireRunner(host, Effect.succeed(DIRECT))),
          idleTimeToLive: "10 minutes",
        }),
      };
      const cache = new Map<string, Host>();
      return {
        get: (id) => {
          if (id === LOCAL_HOST) return localHost;
          let h = cache.get(id);
          if (!h) {
            const invalid = invalidHostAlias(id);
            h = invalid ? invalidHost(id, invalid) : makeSshHost(id, ctx);
            cache.set(id, h);
          }
          return h;
        },
        configuredSshHosts: Effect.sync(() =>
          sshConfigHosts(join(homedir(), ".ssh", "config"), homedir()).filter(
            (h) => invalidHostAlias(h) === null,
          ),
        ),
        connect: (id) =>
          Effect.suspend(() => {
            if (id === LOCAL_HOST) return Effect.void;
            const invalid = invalidHostAlias(id);
            if (invalid) {
              return Effect.fail(
                new SshError({ message: invalid, host: id, stderr: "", mayHaveRun: false }),
              );
            }
            backoff.reset(id);
            return Date.now() < (runnerRetryAt.get(id) ?? 0)
              ? // The runner is backed off: commands use plain sessions, which need just the master.
                Effect.scoped(liveMaster(ctx, id)).pipe(Effect.asVoid)
              : Effect.scoped(getOrRetry(ctx.runners, id)).pipe(
                  Effect.asVoid,
                  // Commands will fall back to plain sessions for a while.
                  Effect.catchTag("RunnerUnavailable", (e) =>
                    Effect.sync(() => runnerRetryAt.set(id, Date.now() + RUNNER_RETRY_MS)).pipe(
                      Effect.andThen(Effect.logWarning(e.message)),
                    ),
                  ),
                );
          }),
      };
    }),
  );

export const HostsLive = makeHostsLayer();
