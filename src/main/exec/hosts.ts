import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { Context, Data, Effect, Layer, RcMap, Schedule, Semaphore } from "effect";
import { gitEnv, remoteGitEnv } from "./environment";
import { CommandError, SshError } from "./errors";
import { MAX_RUNNER_STDIN, Runner, RUNNER_SCRIPT, runOnRunner } from "./runner";
import { shellJoin, shellQuote } from "./shell";
import { spawn, type SpawnOptions, type SpawnResult } from "./spawn";

export type ExecOptions = Omit<SpawnOptions, "cwd" | "env" | "display"> & {
  readonly cwd?: string;
  /** The command only reads, so it may run again after a dropped SSH connection. */
  readonly idempotent?: boolean;
};

/** A machine that can run commands: the local one, or one reachable via SSH. */
export interface Host {
  /** `local` or the SSH host alias. */
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

export const LOCAL_HOST = "local";

// ---------------------------------------------------------------------------
// Local host
// ---------------------------------------------------------------------------

const localHost: Host = {
  id: LOCAL_HOST,
  kind: "local",
  exec: (program, args, options = {}) =>
    spawn(program, args, { ...options, env: gitEnv(), display: shellJoin([program, ...args]) }),
  sh: (script, options = {}) =>
    spawn("/bin/sh", ["-c", script], { ...options, env: gitEnv(), display: script }),
};

// ---------------------------------------------------------------------------
// SSH hosts
// ---------------------------------------------------------------------------

interface SshMaster {
  readonly host: string;
  readonly controlPath: string;
  readonly isAlive: () => boolean;
}

const controlDir = (): string => {
  // Unix socket paths are limited to ~104 bytes, so keep this short.
  const dir =
    process.platform === "win32"
      ? join(tmpdir(), "gitdove-ssh")
      : join("/tmp", `gitdove-${userInfo().uid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
};

const baseSshOptions = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=15",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
];

const muxOptions = (controlPath: string) => [
  "-o",
  `ControlPath=${controlPath}`,
  "-o",
  "ControlMaster=no",
];

/** Starts a long-lived SSH master connection that all commands multiplex over. */
const acquireMaster = (host: string) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const controlPath = join(controlDir(), "%C");
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
          host,
        ],
        { stdio: ["ignore", "ignore", "pipe"], env: process.env, windowsHide: true },
      );
      child.stderr?.on("data", (c: Buffer) => {
        if (stderr.length < 16384) stderr += c.toString("utf8");
      });
      child.on("exit", () => {
        exited = true;
      });
      child.on("error", (e) => {
        exited = true;
        stderr += e.message;
      });

      const master: SshMaster = { host, controlPath, isAlive: () => !exited };

      // Wait until the master accepts connections (or dies).
      const check = Effect.suspend((): Effect.Effect<unknown, { fatal: boolean }> =>
        exited
          ? Effect.fail({ fatal: true as const })
          : spawn("ssh", ["-o", `ControlPath=${controlPath}`, "-O", "check", host]).pipe(
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
              message: `Could not connect to ${host}: ${stderr.trim().split("\n").at(-1) ?? "connection failed"}`,
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
          yield* spawn("ssh", ["-o", `ControlPath=${master.controlPath}`, "-O", "exit", host]).pipe(
            Effect.ignore,
            Effect.timeout("2 seconds"),
            Effect.ignore,
          );
        }
        child.kill();
      }),
  ).pipe(Effect.map(({ master }) => master));

/**
 * Gets a cached resource. RcMap keeps a failed lookup like a successful one, so drop it: the
 * next call tries again (e.g. once the VPN is up) instead of failing until the entry expires.
 */
const getOrRetry = <A, E>(map: RcMap.RcMap<string, A, E>, host: string) =>
  RcMap.get(map, host).pipe(Effect.tapError(() => RcMap.invalidate(map, host)));

/** Returns the host's master connection, reconnecting if it died. */
const liveMaster = (masters: RcMap.RcMap<string, SshMaster, SshError>, host: string) =>
  Effect.gen(function* () {
    const master = yield* getOrRetry(masters, host);
    if (master.isAlive()) return master;
    yield* RcMap.invalidate(masters, host);
    return yield* getOrRetry(masters, host);
  });

/** The remote runner could not be started; commands fall back to plain sessions. */
class RunnerUnavailable extends Data.TaggedError("RunnerUnavailable")<{
  readonly message: string;
}> {}

/** Starts a persistent command runner (see `runner.ts`) over the host's master connection. */
const acquireRunner = (host: string, masters: RcMap.RcMap<string, SshMaster, SshError>) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const master = yield* liveMaster(masters, host);
      const runner = yield* Runner.start("ssh", [
        ...baseSshOptions,
        ...muxOptions(master.controlPath),
        "-T",
        host,
        "--",
        `exec /bin/sh -c ${shellQuote(RUNNER_SCRIPT)}`,
      ]).pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(
          (e) =>
            new RunnerUnavailable({ message: `Could not start runner on ${host}: ${e.message}` }),
        ),
      );
      yield* Effect.logInfo(`ssh runner started: ${host}`);
      return runner;
    }),
    (runner) => Effect.sync(() => runner.close()),
  );

/** `env` arguments that give remote programs and scripts the same git environment. */
const REMOTE_ENV = Object.entries(remoteGitEnv)
  .map(([k, v]) => `${k}=${shellQuote(v)}`)
  .join(" ");

const remoteCommand = (program: string, args: readonly string[], cwd: string | undefined) => {
  const cmd = `exec env ${REMOTE_ENV} ${shellJoin([program, ...args])}`;
  // Without a cwd, run in the home directory as a fresh SSH session would.
  return `cd -- ${cwd ? shellQuote(cwd) : '"$HOME"'} && ${cmd}`;
};

const remoteScript = (script: string, cwd: string | undefined) => {
  const inner = cwd ? `cd -- ${shellQuote(cwd)} && ${script}` : script;
  return `cd -- "$HOME" && exec env ${REMOTE_ENV} /bin/sh -c ${shellQuote(inner)}`;
};

/**
 * Retries after a lost connection only when that cannot repeat the command's effects:
 * it never reached the host, or it only reads.
 */
const retryable =
  (options: ExecOptions) =>
  (e: { readonly _tag: string; readonly mayHaveRun?: boolean }): boolean =>
    e._tag === "SshError" && (!e.mayHaveRun || options.idempotent === true);

/** How long to use plain sessions after the runner failed to start. */
const RUNNER_RETRY_MS = 60_000;

const makeSshHost = (
  host: string,
  masters: RcMap.RcMap<string, SshMaster, SshError>,
  runners: RcMap.RcMap<string, Runner, SshError | RunnerUnavailable>,
  /** When each host's runner may be tried again after it failed to start. */
  runnerRetryAt: Map<string, number>,
): Host => {
  // sshd allows 10 multiplexed sessions per connection by default (MaxSessions);
  // the runner holds one of them.
  const sessions = Semaphore.makeUnsafe(7);
  // Commands running concurrently on the runner.
  const runnerSlots = Semaphore.makeUnsafe(32);

  /** Runs a command in its own SSH session. */
  const viaSession = (remote: string, display: string, options: ExecOptions) =>
    Effect.scoped(
      Effect.gen(function* () {
        const master = yield* liveMaster(masters, host);
        const result = yield* spawn(
          "ssh",
          [...baseSshOptions, ...muxOptions(master.controlPath), "-T", host, "--", remote],
          {
            ...options,
            cwd: undefined,
            env: process.env,
            display,
            okCodes: options.okCodes,
          },
        ).pipe(
          Effect.mapError((e) =>
            e.exitCode === 255 && !master.isAlive()
              ? new SshError({
                  message: `Lost connection to ${host}`,
                  host,
                  stderr: e.stderr,
                  mayHaveRun: true,
                })
              : e,
          ),
        );
        return result;
      }),
    ).pipe(
      sessions.withPermits(1),
      // A dropped connection gets one transparent retry over a fresh master.
      Effect.retry({ while: retryable(options), times: 1 }),
    );

  /** Runs a command on the host's runner, starting it if needed. */
  const viaRunner = (remote: string, display: string, options: ExecOptions) =>
    Effect.scoped(
      Effect.gen(function* () {
        // A runner that failed to start is tried again after RUNNER_RETRY_MS (see `run`).
        let runner = yield* getOrRetry(runners, host);
        if (!runner.alive) {
          yield* RcMap.invalidate(runners, host);
          runner = yield* getOrRetry(runners, host);
        }
        return yield* runOnRunner(runner, host, remote, { ...options, display });
      }),
    ).pipe(
      runnerSlots.withPermits(1),
      // The runner died, before or with the command in flight (e.g. a dropped connection).
      Effect.retry({ while: retryable(options), times: 1 }),
      Effect.catchTag("RunnerUnavailable", (e) =>
        Effect.gen(function* () {
          runnerRetryAt.set(host, Date.now() + RUNNER_RETRY_MS);
          yield* Effect.logWarning(e.message);
          return yield* viaSession(remote, display, options);
        }),
      ),
    );

  const run = (remote: string, display: string, options: ExecOptions) => {
    // Streaming output and large stdin payloads need a session of their own.
    const useRunner =
      options.onStdout === undefined &&
      (options.stdin === undefined || Buffer.byteLength(options.stdin) <= MAX_RUNNER_STDIN) &&
      Date.now() >= (runnerRetryAt.get(host) ?? 0);
    return useRunner ? viaRunner(remote, display, options) : viaSession(remote, display, options);
  };

  return {
    id: host,
    kind: "ssh",
    exec: (program, args, options = {}) =>
      run(remoteCommand(program, args, options.cwd), shellJoin([program, ...args]), options),
    sh: (script, options = {}) => run(remoteScript(script, options.cwd), script, options),
  };
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class Hosts extends Context.Service<
  Hosts,
  {
    /** Returns the host for `local` or an SSH host alias. */
    readonly get: (id: string) => Host;
    /** Host aliases from `~/.ssh/config`. */
    readonly configuredSshHosts: Effect.Effect<string[]>;
    /** Ensures an SSH connection is up (useful to surface auth errors early). */
    readonly connect: (id: string) => Effect.Effect<void, SshError>;
  }
>()("gitdove/Hosts") {}

const parseSshConfigHosts = (text: string): string[] => {
  const hosts = new Set<string>();
  for (const line of text.split("\n")) {
    const m = /^\s*Host\s+(\S.*)$/i.exec(line);
    if (!m) continue;
    for (const h of m[1]!.split(/\s+/)) {
      if (h && !/[*?!]/.test(h)) hosts.add(h);
    }
  }
  return [...hosts];
};

export const HostsLive = Layer.effect(
  Hosts,
  Effect.gen(function* () {
    const masters = yield* RcMap.make({
      lookup: (host: string) => acquireMaster(host),
      idleTimeToLive: "10 minutes",
    });
    const runners = yield* RcMap.make({
      lookup: (host: string) => acquireRunner(host, masters),
      idleTimeToLive: "10 minutes",
    });
    const cache = new Map<string, Host>();
    const runnerRetryAt = new Map<string, number>();
    return {
      get: (id) => {
        if (id === LOCAL_HOST) return localHost;
        let h = cache.get(id);
        if (!h) {
          h = makeSshHost(id, masters, runners, runnerRetryAt);
          cache.set(id, h);
        }
        return h;
      },
      configuredSshHosts: Effect.sync(() => {
        try {
          return parseSshConfigHosts(readFileSync(join(homedir(), ".ssh", "config"), "utf8"));
        } catch {
          return [];
        }
      }),
      connect: (id) =>
        id === LOCAL_HOST
          ? Effect.void
          : Effect.scoped(getOrRetry(runners, id)).pipe(
              Effect.asVoid,
              // Commands will fall back to plain sessions for a while.
              Effect.catchTag("RunnerUnavailable", (e) =>
                Effect.sync(() => runnerRetryAt.set(id, Date.now() + RUNNER_RETRY_MS)).pipe(
                  Effect.andThen(Effect.logWarning(e.message)),
                ),
              ),
            ),
    };
  }),
);
