import { spawn as nodeSpawn } from "node:child_process";
import type { DirEntry, RepoId } from "@shared/domain";
import {
  type ApiArgs,
  type ApiMethod,
  type ApiResult,
  IPC_INVOKE,
  type RpcError,
  type RpcResult,
} from "@shared/ipc";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import log from "electron-log/main";
import { Cause, Effect, Exit, type ManagedRuntime } from "effect";
import { type AppError, InvalidInputError } from "./exec/errors";
import { Hosts } from "./exec/hosts";
import { shellQuote } from "./exec/shell";
import type { Repository } from "./git/repository";
import { RepoSettings, Repos } from "./services";
import { loadState, saveState } from "./state";
import { updater } from "./updater";

type Services = Repos | Hosts | RepoSettings;

type Handlers = {
  [M in ApiMethod]: (...args: ApiArgs<M>) => Effect.Effect<ApiResult<M>, AppError, Services>;
};

const withRepo = <A, E, R = never>(id: RepoId, f: (repo: Repository) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const repos = yield* Repos;
    return yield* f(yield* repos.get(id));
  });

const LIST_DIR_SCRIPT = String.raw`
for f in * .[!.]*; do
  [ -d "$f" ] || continue
  if [ -e "$f/.git" ] || { [ -f "$f/HEAD" ] && [ -d "$f/objects" ]; }; then printf 'R%s\n' "$f"; else printf 'D%s\n' "$f"; fi
done
`;

const openTerminal = (repo: Repository) =>
  Effect.sync(() => {
    const loc = repo.location;
    if (process.platform === "darwin") {
      const command =
        loc.kind === "local"
          ? `cd ${shellQuote(loc.path)}`
          : `ssh -t ${shellQuote(loc.host)} ${shellQuote(`cd ${shellQuote(loc.path)} && exec $SHELL -l`)}`;
      const script = `tell application "Terminal"
  activate
  do script ${JSON.stringify(command)}
end tell`;
      nodeSpawn("osascript", ["-e", script], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "win32") {
      const args =
        loc.kind === "local"
          ? ["/c", "start", "cmd", "/k", `cd /d "${loc.path}"`]
          : ["/c", "start", "ssh", "-t", loc.host, `cd ${shellQuote(loc.path)} && exec $SHELL -l`];
      nodeSpawn("cmd.exe", args, { detached: true, stdio: "ignore" }).unref();
    } else {
      const args =
        loc.kind === "local"
          ? []
          : ["-e", "ssh", "-t", loc.host, `cd ${shellQuote(loc.path)} && exec $SHELL -l`];
      nodeSpawn("x-terminal-emulator", args, {
        cwd: loc.kind === "local" ? loc.path : undefined,
        detached: true,
        stdio: "ignore",
      }).unref();
    }
  });

export const handlers: Handlers = {
  // App / window -------------------------------------------------------------
  "app.getState": () => Effect.sync(loadState),
  "app.setState": (state) => Effect.sync(() => saveState(state)),
  "app.version": () => Effect.succeed({ version: app.getVersion(), platform: process.platform }),
  "dialog.pickDirectory": () =>
    Effect.promise(async () => {
      const win = BrowserWindow.getFocusedWindow();
      const opts = { properties: ["openDirectory" as const, "createDirectory" as const] };
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      return r.canceled ? null : (r.filePaths[0] ?? null);
    }),
  "shell.openTerminal": (id) => withRepo(id, openTerminal),
  "shell.revealInFinder": (id, path) =>
    withRepo(id, (repo) =>
      Effect.sync(() => {
        if (repo.location.kind !== "local") return;
        const target = path ? `${repo.workTree}/${path}` : repo.workTree;
        if (path) shell.showItemInFolder(target);
        else void shell.openPath(target);
      }),
    ),
  "shell.openExternal": (url) =>
    /^https?:\/\//.test(url)
      ? Effect.promise(() => shell.openExternal(url))
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
      const cd = path ? `cd -- ${shellQuote(path)}` : "cd";
      const r = yield* host.sh(`${cd} && pwd && ${LIST_DIR_SCRIPT}`);
      const [cwd, ...rest] = r.stdout.toString("utf8").split("\n");
      const entries: DirEntry[] = rest
        .filter((l) => l.length > 1)
        .map((l) => ({ name: l.slice(1), isDir: true, isRepo: l[0] === "R" }))
        .toSorted((a, b) => a.name.localeCompare(b.name));
      return { path: cwd ?? "", entries };
    }),

  // Repository lifecycle -------------------------------------------------------
  "repo.open": (location) =>
    Effect.gen(function* () {
      const repos = yield* Repos;
      const repo = yield* repos.open(location);
      return yield* repo.info();
    }),
  "repo.close": (id) =>
    Effect.gen(function* () {
      yield* (yield* Repos).close(id);
    }),
  "repo.init": (location) =>
    Effect.gen(function* () {
      const hosts = yield* Hosts;
      const host = hosts.get(location.kind === "local" ? "local" : location.host);
      yield* host.exec("git", ["init", "--", location.path]);
      const repos = yield* Repos;
      const repo = yield* repos.open(location);
      return yield* repo.info();
    }),
  "repo.clone": (url, location) =>
    Effect.gen(function* () {
      if (url.startsWith("-"))
        return yield* Effect.fail(new InvalidInputError({ message: "Invalid URL" }));
      const hosts = yield* Hosts;
      const host = hosts.get(location.kind === "local" ? "local" : location.host);
      yield* host.exec("git", ["clone", "--", url, location.path]);
      const repos = yield* Repos;
      const repo = yield* repos.open(location);
      return yield* repo.info();
    }),

  // Queries ----------------------------------------------------------------------
  "repo.info": (id) => withRepo(id, (r) => r.info()),
  "repo.refs": (id) => withRepo(id, (r) => r.refs()),
  "repo.graphInfo": (id) => withRepo(id, (r) => r.graphInfo()),
  "repo.graphRows": (id, version, start, end) =>
    withRepo(id, (r) => r.graphRows(version, start, end)),
  "repo.findCommit": (id, version, hash) => withRepo(id, (r) => r.findCommit(version, hash)),
  "repo.search": (id, query) => withRepo(id, (r) => r.search(query)),
  "repo.status": (id) => withRepo(id, (r) => r.status()),
  "repo.commitDetails": (id, hash) => withRepo(id, (r) => r.commitDetails(hash)),
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

const serializeError = (cause: Cause.Cause<AppError>): RpcError => {
  const failure = cause.reasons.find(Cause.isFailReason);
  if (failure) {
    const e = failure.error;
    return {
      tag: e._tag,
      message: e.message,
      ...("stderr" in e && e.stderr ? { detail: e.stderr } : {}),
    };
  }
  if (Cause.hasInterrupts(cause)) return { tag: "Interrupted", message: "Operation was cancelled" };
  log.error("Unexpected error", Cause.pretty(cause));
  return { tag: "Defect", message: Cause.pretty(cause).split("\n")[0] ?? "Unexpected error" };
};

/** Installs the single IPC entry point that dispatches to {@link handlers}. */
export const registerIpc = (runtime: ManagedRuntime.ManagedRuntime<Services, never>) => {
  ipcMain.handle(
    IPC_INVOKE,
    async (_event, method: unknown, args: unknown): Promise<RpcResult<unknown>> => {
      if (typeof method !== "string" || !Object.hasOwn(handlers, method) || !Array.isArray(args)) {
        return {
          ok: false,
          error: { tag: "BadRequest", message: `Unknown method ${String(method)}` },
        };
      }
      const handler = handlers[method as ApiMethod] as (
        ...a: unknown[]
      ) => Effect.Effect<unknown, AppError, Services>;
      const started = performance.now();
      const exit = await runtime.runPromiseExit(handler(...args));
      const ms = performance.now() - started;
      if (ms > 500) log.info(`${method} took ${ms.toFixed(0)}ms`);
      if (Exit.isSuccess(exit)) return { ok: true, value: exit.value };
      const error = serializeError(exit.cause);
      log.warn(`${method} failed: ${error.message}`);
      return { ok: false, error };
    },
  );
};
