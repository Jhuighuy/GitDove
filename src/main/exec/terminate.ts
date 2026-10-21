import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
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

/** Whether any process of the group led by `pid` is still there. */
const groupAlive = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Waits until `done()` holds, checking every POLL_MS; false if `ms` passed first. */
const until = (done: () => boolean, ms = Infinity) =>
  Effect.callback<boolean>((resume) => {
    const start = Date.now();
    const check = () => {
      if (done()) resume(Effect.succeed(true));
      else if (Date.now() - start >= ms) resume(Effect.succeed(false));
      else timer = setTimeout(check, POLL_MS);
    };
    let timer = setTimeout(check, 0);
    return Effect.sync(() => clearTimeout(timer));
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
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    if (!OWN_PROCESS_GROUP) {
      return Effect.callback<void>((resume) => {
        const killer = nodeSpawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        // taskkill failing (e.g. the process just exited) falls back to killing the process.
        killer.on("error", () => child.kill());
        killer.on("exit", () => resume(Effect.void));
      }).pipe(Effect.andThen(until(exited)), Effect.asVoid);
    }
    signalGroup(pid, "SIGTERM");
    return until(() => !groupAlive(pid), GRACE_MS).pipe(
      Effect.flatMap((gone) =>
        gone
          ? Effect.void
          : // SIGKILL cannot be ignored, so this wait ends.
            Effect.sync(() => signalGroup(pid, "SIGKILL")).pipe(
              Effect.andThen(until(() => !groupAlive(pid))),
            ),
      ),
      Effect.asVoid,
    );
  });
