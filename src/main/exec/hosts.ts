import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, RcMap, Schedule, Semaphore } from "effect";
import { gitEnv, remoteGitEnv } from "./environment";
import { CommandError, SshError } from "./errors";
import { shellJoin, shellQuote } from "./shell";
import { spawn, type SpawnOptions, type SpawnResult } from "./spawn";

export type ExecOptions = Omit<SpawnOptions, "cwd" | "env" | "display"> & {
  readonly cwd?: string | undefined;
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

const remoteCommand = (program: string, args: readonly string[], cwd: string | undefined) => {
  const env = Object.entries(remoteGitEnv).map(([k, v]) => `${k}=${shellQuote(v)}`);
  const cmd = `exec env ${env.join(" ")} ${shellJoin([program, ...args])}`;
  return cwd ? `cd -- ${shellQuote(cwd)} && ${cmd}` : cmd;
};

const remoteScript = (script: string, cwd: string | undefined) => {
  const inner = cwd ? `cd -- ${shellQuote(cwd)} && ${script}` : script;
  return `exec /bin/sh -c ${shellQuote(inner)}`;
};

const makeSshHost = (host: string, masters: RcMap.RcMap<string, SshMaster, SshError>): Host => {
  // sshd allows 10 multiplexed sessions per connection by default (MaxSessions).
  const sessions = Semaphore.makeUnsafe(8);
  const run = (remote: string, display: string, options: ExecOptions) =>
    Effect.scoped(
      Effect.gen(function* () {
        let master = yield* RcMap.get(masters, host);
        if (!master.isAlive()) {
          yield* RcMap.invalidate(masters, host);
          master = yield* RcMap.get(masters, host);
        }
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
              ? new SshError({ message: `Lost connection to ${host}`, host, stderr: e.stderr })
              : e,
          ),
        );
        return result;
      }),
    ).pipe(
      sessions.withPermits(1),
      // A dropped connection gets one transparent retry over a fresh master.
      Effect.retry({ while: (e) => e._tag === "SshError", times: 1 }),
    );

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
    const m = /^\s*Host\s+(.+)$/i.exec(line);
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
    const cache = new Map<string, Host>();
    return {
      get: (id) => {
        if (id === LOCAL_HOST) return localHost;
        let h = cache.get(id);
        if (!h) {
          h = makeSshHost(id, masters);
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
        id === LOCAL_HOST ? Effect.void : Effect.scoped(RcMap.get(masters, id)).pipe(Effect.asVoid),
    };
  }),
);
