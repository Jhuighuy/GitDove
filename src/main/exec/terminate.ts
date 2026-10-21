import { execFile, spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { Effect } from "effect";

/** How long a process tree gets to exit after SIGTERM before it gets SIGKILL. */
const GRACE_MS = 3000;
const POLL_MS = 50;

/**
 * Processes started by `spawn` lead their own process group on POSIX (see `detached`), so a
 * signal to the group reaches everything they started too, e.g. the `git merge` behind a
 * `git pull`.
 */
export const OWN_PROCESS_GROUP = process.platform !== "win32";

const signalGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
};

/**
 * Whether `ps -A -o pgid= -o stat=` output lists a live member of process group `pgid`.
 * Zombies don't count: where PID 1 doesn't reap orphans (some containers), they stay in the
 * group forever, and no signal removes them.
 */
export const groupHasLiveMember = (psOutput: string, pgid: number): boolean =>
  psOutput.split("\n").some((line) => {
    const [group, state = ""] = line.trim().split(/\s+/);
    return Number(group) === pgid && !state.startsWith("Z");
  });

/** Whether any process of the group led by `pid` is still running. */
const groupAlive = (pid: number): Effect.Effect<boolean> =>
  Effect.suspend(() => {
    try {
      process.kill(-pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EPERM") return Effect.succeed(false);
    }
    // The group exists, but maybe only as zombies: ask ps (without ps, assume it runs).
    return Effect.callback<boolean>((resume) => {
      execFile("ps", ["-A", "-o", "pgid=", "-o", "stat="], (error, stdout) =>
        resume(Effect.succeed(error ? true : groupHasLiveMember(stdout, pid))),
      );
    });
  });

/** Waits until `done` holds, checking every POLL_MS; false if `ms` passed first. */
const until = (done: Effect.Effect<boolean>, ms = Infinity) =>
  Effect.gen(function* () {
    const start = Date.now();
    for (;;) {
      if (yield* done) return true;
      if (Date.now() - start >= ms) return false;
      yield* Effect.sleep(POLL_MS);
    }
  });

/** Sends SIGTERM (POSIX) to the process and everything it started. */
export const signalTree = (child: ChildProcess): void => {
  if (child.pid === undefined) return;
  if (OWN_PROCESS_GROUP) signalGroup(child.pid, "SIGTERM");
  else child.kill();
};

/**
 * Stops a process and everything it started, and waits until all of it is gone: callers
 * holding a lock (see Repository.write) must not release it while git still runs. On POSIX
 * the process group gets SIGTERM, then SIGKILL after GRACE_MS; on Windows the tree is
 * killed with taskkill.
 */
export const terminateTree = (child: ChildProcess): Effect.Effect<void> =>
  Effect.suspend(() => {
    const pid = child.pid;
    if (pid === undefined) return Effect.void;
    const exited = Effect.sync(() => child.exitCode !== null || child.signalCode !== null);
    if (!OWN_PROCESS_GROUP) {
      return Effect.callback<void>((resume) => {
        const killer = nodeSpawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        // Without taskkill, kill the process itself; either way, then wait for it to exit.
        killer.on("error", () => {
          child.kill();
          resume(Effect.void);
        });
        killer.on("exit", () => resume(Effect.void));
      }).pipe(Effect.andThen(until(exited)), Effect.asVoid);
    }
    signalGroup(pid, "SIGTERM");
    const gone = Effect.map(groupAlive(pid), (alive) => !alive);
    return until(gone, GRACE_MS).pipe(
      Effect.flatMap((done) =>
        done
          ? Effect.void
          : // SIGKILL cannot be ignored, so this wait ends.
            Effect.sync(() => signalGroup(pid, "SIGKILL")).pipe(Effect.andThen(until(gone))),
      ),
      Effect.asVoid,
    );
  });
