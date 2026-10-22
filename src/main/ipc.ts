import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import type { DirEntry, RepoId, RepoLocation } from "@shared/domain";
import {
  type ApiArgs,
  type ApiMethod,
  type ApiResult,
  EDIT_COMMANDS,
  IPC_INVOKE,
  isRepoId,
  isSshHost,
  MAX_GRAPH_ROWS,
  type RpcError,
  type RpcResult,
} from "@shared/ipc";
import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from "electron";
import log from "electron-log/main";
import { Cause, Context, Effect, Exit, type ManagedRuntime, Schema } from "effect";
import { type AppError, InvalidInputError } from "./exec/errors";
import { Hosts, LOCAL_HOST } from "./exec/hosts";
import { shellJoin, shellQuote } from "./exec/shell";
import type { Repository } from "./git/repository";
import { type Owner, RepoSettings, Repos } from "./services";
import { loadState, saveState } from "./state";
import { updater } from "./updater";

type Services = Repos | Hosts | RepoSettings;

/** Most hashes `repo.graphHashes` returns at once. */
const MAX_GRAPH_HASHES = 1 << 20;

/** The renderer a request came from. */
export class Caller extends Context.Service<Caller, { readonly webContents: WebContents }>()(
  "gitdove/Caller",
) {}

type Handlers = {
  [M in ApiMethod]: (
    ...args: ApiArgs<M>
  ) => Effect.Effect<ApiResult<M>, AppError, Services | Caller>;
};

// ---------------------------------------------------------------------------
// Argument schemas: the renderer is not trusted, so every request is decoded
// against the schema of its method before it reaches a handler.
// ---------------------------------------------------------------------------

const valid = <T>(test: (value: T) => boolean, message: string) =>
  Schema.makeFilter<T>((value) => test(value) || message);

const Str = Schema.String;
const Bool = Schema.Boolean;
const Index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Path = Str.check(valid((p: string) => p !== "" && !p.includes("\0"), "Invalid path"));
const Id = Str.check(valid(isRepoId, "Invalid repository id"));
const SshHost = Str.check(
  valid((h: string) => isSshHost(h) && h !== LOCAL_HOST, "Invalid SSH host"),
);
const Location = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("local"), path: Path }),
  Schema.Struct({ kind: Schema.Literal("ssh"), host: SshHost, path: Path }),
]);
const Target = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("unstaged"), path: Str, untracked: Schema.optional(Bool) }),
  Schema.Struct({ kind: Schema.Literal("staged"), path: Str, oldPath: Schema.optional(Str) }),
  Schema.Struct({
    kind: Schema.Literal("commit"),
    hash: Str,
    base: Schema.optional(Str),
    path: Str,
    oldPath: Schema.optional(Str),
  }),
]);
const State = Schema.Struct({
  tabs: Schema.Array(Str),
  activeTab: Schema.NullOr(Str),
  recent: Schema.Array(Str),
});
/** A graph row range of at most `max` rows. */
const RowRange = (max: number) =>
  Schema.Tuple([Id, Index, Index, Index]).check(
    valid(([, , start, end]) => end - start <= max, `At most ${max} rows can be requested`),
  );

const noArgs = Schema.Tuple([]);
const argsOf = <const E extends readonly Schema.Top[]>(...elements: E) => Schema.Tuple(elements);
const repoArgs = <const E extends readonly Schema.Top[]>(...elements: E) =>
  Schema.Tuple([Id, ...elements]);

type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const argSchemas = {
  "app.getState": noArgs,
  "app.setState": argsOf(State),
  "app.version": noArgs,
  "app.edit": argsOf(Schema.Literals(EDIT_COMMANDS)),
  "dialog.pickDirectory": noArgs,
  "shell.openTerminal": repoArgs(),
  "shell.revealInFinder": repoArgs(Schema.optional(Str)),
  "shell.openExternal": argsOf(Str),
  "ssh.hosts": noArgs,
  "ssh.listDir": argsOf(SshHost, Schema.NullOr(Str)),
  "repo.open": argsOf(Location),
  "repo.close": repoArgs(),
  "repo.init": argsOf(Location),
  "repo.clone": argsOf(Str, Location),
  "repo.info": repoArgs(),
  "repo.refs": repoArgs(),
  "repo.graphInfo": repoArgs(),
  "repo.graphRows": RowRange(MAX_GRAPH_ROWS),
  "repo.graphHashes": RowRange(MAX_GRAPH_HASHES),
  "repo.findCommit": repoArgs(Index, Str),
  "repo.search": repoArgs(Str),
  "repo.status": repoArgs(),
  "repo.commitDetails": repoArgs(Str),
  "repo.compare": repoArgs(Schema.NullOr(Str), Str),
  "repo.diff": repoArgs(Target),
  "repo.fileVersions": repoArgs(Target),
  "repo.stage": repoArgs(Schema.Array(Str)),
  "repo.stageAll": repoArgs(),
  "repo.unstage": repoArgs(Schema.Array(Str)),
  "repo.unstageAll": repoArgs(),
  "repo.discard": repoArgs(Schema.Array(Str), Schema.Array(Str)),
  "repo.applyPatch": repoArgs(Str, Schema.Struct({ cached: Bool, reverse: Bool })),
  "repo.commit": repoArgs(Str, Schema.Struct({ amend: Bool })),
  "repo.lastCommitMessage": repoArgs(),
  "repo.checkout": repoArgs(Str),
  "repo.checkoutRemote": repoArgs(Str, Str),
  "repo.createBranch": repoArgs(Str, Str, Bool),
  "repo.deleteBranch": repoArgs(Str, Bool),
  "repo.deleteRemoteBranch": repoArgs(Str, Str),
  "repo.renameBranch": repoArgs(Str, Str),
  "repo.setUpstream": repoArgs(Str, Schema.NullOr(Str)),
  "repo.createTag": repoArgs(Str, Str, Schema.NullOr(Str)),
  "repo.deleteTag": repoArgs(Str),
  "repo.merge": repoArgs(
    Str,
    Schema.Struct({ ffOnly: Schema.optional(Bool), noFf: Schema.optional(Bool) }),
  ),
  "repo.rebase": repoArgs(Str),
  "repo.cherryPick": repoArgs(Str),
  "repo.revert": repoArgs(Str),
  "repo.reset": repoArgs(Str, Schema.Literals(["soft", "mixed", "hard"])),
  "repo.abortOperation": repoArgs(),
  "repo.continueOperation": repoArgs(),
  "repo.cancel": repoArgs(),
  "repo.hiddenRefs": repoArgs(),
  "repo.setHiddenRefs": repoArgs(Schema.Array(Str)),
  "repo.addWorktree": repoArgs(Str, Str, Schema.NullOr(Str)),
  "repo.removeWorktree": repoArgs(Str, Bool),
  "repo.pruneWorktrees": repoArgs(),
  "repo.updateSubmodule": repoArgs(Str),
  "repo.stash": repoArgs(Schema.NullOr(Str), Bool),
  "repo.stashPop": repoArgs(Index),
  "repo.stashApply": repoArgs(Index),
  "repo.stashDrop": repoArgs(Index),
  "repo.fetch": repoArgs(Schema.NullOr(Str)),
  "repo.pull": repoArgs(Schema.Literals(["ff-only", "merge", "rebase"])),
  "repo.push": repoArgs(Schema.Struct({ force: Bool, setUpstream: Bool })),
  "repo.pushBranch": repoArgs(Str, Bool),
  "repo.fastForwardBranch": repoArgs(Str),
  "repo.pushTag": repoArgs(Str, Str),
  "repo.deleteRemoteTag": repoArgs(Str, Str),
  "repo.setRemoteUrl": repoArgs(Str, Str),
  "repo.addRemote": repoArgs(Str, Str),
  "repo.removeRemote": repoArgs(Str),
  "updater.status": noArgs,
  "updater.check": noArgs,
  "updater.install": noArgs,
} satisfies { readonly [M in ApiMethod]: Schema.Codec<unknown, unknown> };

/** Fails to compile unless each schema decodes exactly the arguments its `Api` method takes. */
export type ArgSchemasMatchApi = Expect<{
  [M in ApiMethod]: Equals<(typeof argSchemas)[M]["Type"], DeepReadonly<ApiArgs<M>>>;
}>;
type Expect<T extends { readonly [M in ApiMethod]: true }> = T;

const decoders = new Map<string, (input: unknown) => Exit.Exit<unknown, Schema.SchemaError>>();
const decodeArgs = (method: ApiMethod, input: unknown) => {
  let decode = decoders.get(method);
  if (!decode) {
    decode = Schema.decodeUnknownExit(argSchemas[method] as Schema.Codec<unknown, unknown>);
    decoders.set(method, decode);
  }
  return decode(input);
};

/** The renderer that asked, which owns the repositories it uses (see `Repos`). */
const owner: Effect.Effect<Owner, never, Caller> = Effect.map(Caller, (c) => c.webContents.id);

const withRepo = <A, E, R = never>(id: RepoId, f: (repo: Repository) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const repos = yield* Repos;
    return yield* f(yield* repos.get(id, yield* owner));
  });

/** Opens a repository for the caller and returns its info. */
const openFor = (location: RepoLocation) =>
  Effect.gen(function* () {
    const repo = yield* (yield* Repos).open(location, yield* owner);
    return yield* repo.info();
  });

/**
 * Transports git must not use for a URL from the renderer: `ext::` runs arbitrary commands and
 * `fd::` talks to inherited file descriptors.
 */
const SAFE_TRANSPORTS = ["-c", "protocol.ext.allow=never", "-c", "protocol.fd.allow=never"];

/**
 * Prints the current directory, then its sub-directories marked `R` (a repository) or `D`, all
 * NUL-terminated since names may contain newlines. A `.git` directory is not listed: it is not
 * a work tree to open.
 */
const LIST_DIR_SCRIPT = String.raw`
printf '%s\0' "$PWD"
for f in * .[!.]* ..?*; do
  [ -d "$f" ] && [ "$f" != .git ] || continue
  if [ -e "$f/.git" ] || { [ -f "$f/HEAD" ] && [ -d "$f/objects" ]; }; then printf 'R%s\0' "$f"; else printf 'D%s\0' "$f"; fi
done
`;

/** A `cd` to a directory typed by the user, where `~` is the home directory. */
const cdTo = (path: string | null) => {
  if (!path || path === "~") return "cd";
  if (path.startsWith("~/")) return `cd -- "$HOME"/${shellQuote(path.slice(2))}`;
  return `cd -- ${shellQuote(path)}`;
};

/** Whether `url` is a web page that may be opened in the browser. */
export const isWebUrl = (url: string): boolean =>
  URL.canParse(url) && ["http:", "https:"].includes(new URL(url).protocol);

/** A detached program to start, e.g. a terminal emulator. */
interface Launch {
  readonly file: string;
  readonly args: readonly string[];
  readonly options?: SpawnOptions;
}

/** Starts a detached program; fails when it cannot be started (e.g. it is not installed). */
const launch = ({ file, args, options }: Launch) =>
  Effect.callback<void, Error>((resume) => {
    let child: ChildProcess;
    try {
      child = nodeSpawn(file, args, { ...options, detached: true, stdio: "ignore" });
    } catch (e) {
      resume(Effect.fail(e instanceof Error ? e : new Error(String(e))));
      return;
    }
    // Without an `error` listener, a missing program would crash the main process.
    child.on("error", (e) => resume(Effect.fail(e)));
    child.once("spawn", () => {
      child.unref();
      resume(Effect.void);
    });
  });

/** An AppleScript string literal. */
const appleScriptString = (s: string) => `"${s.replaceAll(/[\\"]/g, "\\$&")}"`;

/** Quotes an argument for a `cmd.exe` command line, which has no way to escape `"` or `%`. */
const cmdQuote = (s: string) => {
  if (/["%\r\n]/.test(s)) throw new Error(`Cannot pass ${JSON.stringify(s)} to cmd.exe`);
  return `"${s}"`;
};

/** Ways to open a terminal at a repository, in order of preference. */
export const terminalLaunches = (loc: RepoLocation): Launch[] => {
  const remoteShell = `cd ${shellQuote(loc.path)} && exec $SHELL -l`;
  const ssh = loc.kind === "ssh" ? ["ssh", "-t", "--", loc.host, remoteShell] : [];
  if (process.platform === "darwin") {
    const command = loc.kind === "local" ? `cd ${shellQuote(loc.path)}` : shellJoin(ssh);
    const script = `tell application "Terminal"
  activate
  do script ${appleScriptString(command)}
end tell`;
    return [{ file: "osascript", args: ["-e", script] }];
  }
  if (process.platform === "win32") {
    // `start` opens a new console window; the empty argument is its title.
    if (loc.kind === "local") {
      return [
        { file: "cmd.exe", args: ["/d", "/c", "start", "", "cmd.exe"], options: { cwd: loc.path } },
      ];
    }
    const line = `/d /s /c "start "" ${ssh.map(cmdQuote).join(" ")}"`;
    return [{ file: "cmd.exe", args: [line], options: { windowsVerbatimArguments: true } }];
  }
  const cwd = loc.kind === "local" ? { cwd: loc.path } : undefined;
  const emulators: [string | undefined, string][] = [
    [process.env.TERMINAL, "-e"],
    ["x-terminal-emulator", "-e"],
    ["gnome-terminal", "--"],
    ["konsole", "-e"],
    ["xfce4-terminal", "-x"],
    ["xterm", "-e"],
  ];
  return emulators.flatMap(([file, exec]) =>
    file ? [{ file, args: loc.kind === "local" ? [] : [exec, ...ssh], options: cwd }] : [],
  );
};

const openTerminal = (repo: Repository) =>
  Effect.try({
    try: () => terminalLaunches(repo.location),
    catch: (e) => new InvalidInputError({ message: (e as Error).message }),
  }).pipe(
    Effect.flatMap((launches) =>
      Effect.firstSuccessOf(launches.map(launch)).pipe(
        Effect.mapError(
          (e) =>
            new InvalidInputError({
              message:
                launches.length > 1
                  ? "No terminal emulator found. Set $TERMINAL to the one to use."
                  : `Could not open a terminal: ${e.message}`,
            }),
        ),
      ),
    ),
  );

export const handlers: Handlers = {
  // App / window -------------------------------------------------------------
  "app.getState": () => Effect.sync(loadState),
  "app.setState": (state) => Effect.sync(() => saveState(state)),
  "app.version": () => Effect.succeed({ version: app.getVersion(), platform: process.platform }),
  "app.edit": (command) =>
    EDIT_COMMANDS.includes(command)
      ? Effect.gen(function* () {
          (yield* Caller).webContents[command]();
        })
      : Effect.fail(new InvalidInputError({ message: `Unknown edit command: ${String(command)}` })),
  "dialog.pickDirectory": () =>
    Effect.gen(function* () {
      // Attached to the window that asked, which need not be focused.
      const win = BrowserWindow.fromWebContents((yield* Caller).webContents);
      const opts = { properties: ["openDirectory" as const, "createDirectory" as const] };
      const r = yield* Effect.promise(() =>
        win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts),
      );
      return r.canceled ? null : (r.filePaths[0] ?? null);
    }),
  "shell.openTerminal": (id) => withRepo(id, openTerminal),
  "shell.revealInFinder": (id, path) =>
    withRepo(id, (repo) =>
      Effect.gen(function* () {
        if (repo.location.kind !== "local") return;
        if (path) {
          const target = resolve(repo.workTree, path);
          const rel = relative(repo.workTree, target);
          if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
            return yield* new InvalidInputError({ message: `${path} is outside the repository` });
          }
          shell.showItemInFolder(target);
          return;
        }
        const error = yield* Effect.promise(() => shell.openPath(repo.workTree));
        if (error) return yield* new InvalidInputError({ message: error });
      }),
    ),
  "shell.openExternal": (url) =>
    isWebUrl(url)
      ? Effect.tryPromise({
          try: () => shell.openExternal(url),
          catch: (e) =>
            new InvalidInputError({ message: `Cannot open ${url}: ${(e as Error).message}` }),
        })
      : Effect.fail(new InvalidInputError({ message: `Refusing to open ${url}` })),

  // Remote hosts ---------------------------------------------------------------
  "ssh.hosts": () =>
    Effect.gen(function* () {
      return yield* (yield* Hosts).configuredSshHosts;
    }),
  "ssh.listDir": (hostId, path) =>
    Effect.gen(function* () {
      const hosts = yield* Hosts;
      const host = hosts.get(hostId);
      yield* hosts.connect(hostId);
      const r = yield* host.sh(`${cdTo(path)} && {${LIST_DIR_SCRIPT}}`, { idempotent: true });
      const [cwd, ...rest] = r.stdout.toString("utf8").split("\0");
      const entries: DirEntry[] = rest
        .filter((l) => l.length > 1)
        .map((l) => ({ name: l.slice(1), isDir: true, isRepo: l.startsWith("R") }))
        .toSorted((a, b) => a.name.localeCompare(b.name));
      return { path: cwd ?? "", entries };
    }),

  // Repository lifecycle -------------------------------------------------------
  "repo.open": openFor,
  "repo.close": (id) =>
    Effect.gen(function* () {
      yield* (yield* Repos).release(id, yield* owner);
    }),
  "repo.init": (location) =>
    Effect.gen(function* () {
      const hosts = yield* Hosts;
      const host = hosts.get(location.kind === "local" ? LOCAL_HOST : location.host);
      yield* host.exec("git", ["init", "--", location.path]);
      return yield* openFor(location);
    }),
  "repo.clone": (url, location) =>
    Effect.gen(function* () {
      if (url === "" || /^-|^(?:ext|fd)::/i.test(url))
        return yield* Effect.fail(new InvalidInputError({ message: "Invalid URL" }));
      const hosts = yield* Hosts;
      const host = hosts.get(location.kind === "local" ? LOCAL_HOST : location.host);
      yield* host.exec("git", [
        ...SAFE_TRANSPORTS,
        "clone",
        "--no-recurse-submodules",
        "--",
        url,
        location.path,
      ]);
      return yield* openFor(location);
    }),

  // Queries ----------------------------------------------------------------------
  "repo.info": (id) => withRepo(id, (r) => r.info()),
  "repo.refs": (id) => withRepo(id, (r) => r.refs()),
  "repo.graphInfo": (id) => withRepo(id, (r) => r.graphInfo()),
  "repo.graphRows": (id, version, start, end) =>
    withRepo(id, (r) => r.graphRows(version, start, end)),
  "repo.graphHashes": (id, version, start, end) =>
    withRepo(id, (r) => r.graphRows(version, start, end)).pipe(
      Effect.map((rows) => rows.map((row) => row.hash)),
    ),
  "repo.findCommit": (id, version, hash) => withRepo(id, (r) => r.findCommit(version, hash)),
  "repo.search": (id, query) => withRepo(id, (r) => r.search(query)),
  "repo.status": (id) => withRepo(id, (r) => r.status()),
  "repo.commitDetails": (id, hash) => withRepo(id, (r) => r.commitDetails(hash)),
  "repo.compare": (id, base, tip) => withRepo(id, (r) => r.compare(base, tip)),
  "repo.diff": (id, target) => withRepo(id, (r) => r.diff(target)),
  "repo.fileVersions": (id, target) => withRepo(id, (r) => r.fileVersions(target)),

  // Working tree -------------------------------------------------------------------
  "repo.stage": (id, paths) => withRepo(id, (r) => r.stage(paths)),
  "repo.stageAll": (id) => withRepo(id, (r) => r.stageAll()),
  "repo.unstage": (id, paths) => withRepo(id, (r) => r.unstage(paths)),
  "repo.unstageAll": (id) => withRepo(id, (r) => r.unstageAll()),
  "repo.discard": (id, paths, untracked) => withRepo(id, (r) => r.discard(paths, untracked)),
  "repo.applyPatch": (id, patch, opts) => withRepo(id, (r) => r.applyPatch(patch, opts)),
  "repo.commit": (id, message, opts) => withRepo(id, (r) => r.commit(message, opts)),
  "repo.lastCommitMessage": (id) => withRepo(id, (r) => r.lastCommitMessage()),

  // Branches and refs --------------------------------------------------------------
  "repo.checkout": (id, ref) => withRepo(id, (r) => r.checkout(ref)),
  "repo.checkoutRemote": (id, remoteRef, local) =>
    withRepo(id, (r) => r.checkoutRemote(remoteRef, local)),
  "repo.createBranch": (id, name, at, checkout) =>
    withRepo(id, (r) => r.createBranch(name, at, checkout)),
  "repo.deleteBranch": (id, name, force) => withRepo(id, (r) => r.deleteBranch(name, force)),
  "repo.deleteRemoteBranch": (id, remote, name) =>
    withRepo(id, (r) => r.deleteRemoteBranch(remote, name)),
  "repo.renameBranch": (id, a, b) => withRepo(id, (r) => r.renameBranch(a, b)),
  "repo.setUpstream": (id, branch, upstream) =>
    withRepo(id, (r) => r.setUpstream(branch, upstream)),
  "repo.createTag": (id, name, at, message) => withRepo(id, (r) => r.createTag(name, at, message)),
  "repo.deleteTag": (id, name) => withRepo(id, (r) => r.deleteTag(name)),
  "repo.merge": (id, ref, opts) => withRepo(id, (r) => r.merge(ref, opts)),
  "repo.rebase": (id, onto) => withRepo(id, (r) => r.rebase(onto)),
  "repo.cherryPick": (id, hash) => withRepo(id, (r) => r.cherryPick(hash)),
  "repo.revert": (id, hash) => withRepo(id, (r) => r.revert(hash)),
  "repo.reset": (id, hash, mode) => withRepo(id, (r) => r.reset(hash, mode)),
  "repo.abortOperation": (id) => withRepo(id, (r) => r.abortOperation()),
  "repo.continueOperation": (id) => withRepo(id, (r) => r.continueOperation()),
  "repo.cancel": (id) => withRepo(id, (r) => r.cancel()),

  // Graph visibility ---------------------------------------------------------------
  "repo.hiddenRefs": (id) =>
    withRepo(id, (r) =>
      Effect.gen(function* () {
        return [...(yield* RepoSettings).hidden(r.id)];
      }),
    ),
  "repo.setHiddenRefs": (id, hidden) =>
    withRepo(id, (r) =>
      Effect.gen(function* () {
        const clean = hidden.filter((h) => typeof h === "string");
        (yield* RepoSettings).setHidden(r.id, clean);
        r.setHiddenRefs(clean);
      }),
    ),

  // Worktrees and submodules -------------------------------------------------------
  "repo.addWorktree": (id, path, ref, newBranch) =>
    withRepo(id, (r) => r.addWorktree(path, ref, newBranch)),
  "repo.removeWorktree": (id, path, force) => withRepo(id, (r) => r.removeWorktree(path, force)),
  "repo.pruneWorktrees": (id) => withRepo(id, (r) => r.pruneWorktrees()),
  "repo.updateSubmodule": (id, path) => withRepo(id, (r) => r.updateSubmodule(path)),

  // Stash ----------------------------------------------------------------------------
  "repo.stash": (id, message, untracked) => withRepo(id, (r) => r.stash(message, untracked)),
  "repo.stashPop": (id, index) => withRepo(id, (r) => r.stashPop(index)),
  "repo.stashApply": (id, index) => withRepo(id, (r) => r.stashApply(index)),
  "repo.stashDrop": (id, index) => withRepo(id, (r) => r.stashDrop(index)),

  // Remotes --------------------------------------------------------------------------
  "repo.fetch": (id, remote) => withRepo(id, (r) => r.fetch(remote)),
  "repo.pull": (id, mode) => withRepo(id, (r) => r.pull(mode)),
  "repo.push": (id, opts) => withRepo(id, (r) => r.push(opts)),
  "repo.pushBranch": (id, branch, force) => withRepo(id, (r) => r.pushBranch(branch, force)),
  "repo.fastForwardBranch": (id, branch) => withRepo(id, (r) => r.fastForwardBranch(branch)),
  "repo.pushTag": (id, remote, tag) => withRepo(id, (r) => r.pushTag(remote, tag)),
  "repo.deleteRemoteTag": (id, remote, tag) => withRepo(id, (r) => r.deleteRemoteTag(remote, tag)),
  "repo.setRemoteUrl": (id, name, url) => withRepo(id, (r) => r.setRemoteUrl(name, url)),
  "repo.addRemote": (id, name, url) => withRepo(id, (r) => r.addRemote(name, url)),
  "repo.removeRemote": (id, name) => withRepo(id, (r) => r.removeRemote(name)),

  // Updater --------------------------------------------------------------------------
  "updater.status": () => Effect.sync(() => updater.status()),
  "updater.check": () => Effect.promise(() => updater.check()),
  "updater.install": () => Effect.sync(() => updater.install()),
};

/** Longest error detail (e.g. stderr) sent to the renderer. */
const MAX_DETAIL = 16 * 1024;

const serializeError = (cause: Cause.Cause<AppError>): RpcError => {
  const failure = cause.reasons.find(Cause.isFailReason);
  if (failure) {
    const e = failure.error;
    const detail = "stderr" in e && e.stderr ? e.stderr : "";
    return {
      tag: e._tag,
      message: e.message,
      ...(detail
        ? { detail: detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL)}\n…` : detail }
        : {}),
    };
  }
  if (Cause.hasInterrupts(cause)) return { tag: "Interrupted", message: "Operation was cancelled" };
  log.error("Unexpected error", Cause.pretty(cause));
  return { tag: "Defect", message: Cause.pretty(cause).split("\n")[0] ?? "Unexpected error" };
};

/** Failures that are part of normal operation, not worth a warning. */
const EXPECTED = new Set(["StaleGraphError", "CancelledError", "Interrupted"]);

const badRequest = (message: string): RpcResult<never> => {
  log.warn(`Bad request: ${message}`);
  return { ok: false, error: { tag: "BadRequest", message } };
};

/** Installs the single IPC entry point that dispatches to {@link handlers}. */
export const registerIpc = (runtime: ManagedRuntime.ManagedRuntime<Services, never>) => {
  // Repositories a renderer used are released when it goes away (e.g. its window closed).
  const senders = new WeakSet<WebContents>();
  const track = (sender: WebContents) => {
    if (senders.has(sender)) return;
    senders.add(sender);
    const id = sender.id;
    sender.once("destroyed", () => {
      runtime
        .runPromise(Effect.flatMap(Repos, (repos) => repos.releaseAll(id)))
        .catch((e: unknown) => log.warn("Cannot release repositories", e));
    });
  };
  ipcMain.handle(
    IPC_INVOKE,
    async (event, method: unknown, input: unknown): Promise<RpcResult<unknown>> => {
      if (typeof method !== "string" || !Object.hasOwn(handlers, method)) {
        return badRequest(`Unknown method ${String(method).slice(0, 100)}`);
      }
      const args = decodeArgs(method as ApiMethod, input);
      if (Exit.isFailure(args)) {
        const reason = args.cause.reasons.find(Cause.isFailReason);
        const why = reason ? reason.error.message.replaceAll(/\s+/g, " ") : "malformed";
        return badRequest(`Invalid arguments for ${method}: ${why}`);
      }
      track(event.sender);
      const handler = handlers[method as ApiMethod] as (
        ...a: readonly unknown[]
      ) => Effect.Effect<unknown, AppError, Services | Caller>;
      const started = performance.now();
      const exit = await runtime.runPromiseExit(
        handler(...(args.value as readonly unknown[])).pipe(
          Effect.provideService(Caller, { webContents: event.sender }),
        ),
      );
      const ms = performance.now() - started;
      if (ms > 500) log.info(`${method} took ${ms.toFixed(0)}ms`);
      if (Exit.isSuccess(exit)) return { ok: true, value: exit.value };
      const error = serializeError(exit.cause);
      if (EXPECTED.has(error.tag)) log.debug(`${method}: ${error.message}`);
      else log.warn(`${method} failed: ${error.message}`);
      return { ok: false, error };
    },
  );
};
