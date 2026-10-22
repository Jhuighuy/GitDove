import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoLocation } from "@shared/domain";
import { IPC_INVOKE, type RpcResult } from "@shared/ipc";
import type { WebContents } from "electron";
import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CommandError,
  InvalidInputError,
  NotARepositoryError,
  StaleGraphError,
} from "./exec/errors";
import { type Host, Hosts, LOCAL_HOST } from "./exec/hosts";
import { spawn } from "./exec/spawn";
import type { Repository } from "./git/repository";
import { RepoSettings, Repos } from "./services";

const electron = vi.hoisted(() => ({
  app: { getVersion: () => "1.2.3" },
  BrowserWindow: { fromWebContents: vi.fn((): object | null => null) },
  dialog: {
    showOpenDialog: vi.fn(
      async (..._args: unknown[]): Promise<{ canceled: boolean; filePaths: string[] }> => ({
        canceled: false,
        filePaths: ["/picked"],
      }),
    ),
  },
  ipcMain: { handle: vi.fn() },
  shell: {
    showItemInFolder: vi.fn(),
    openPath: vi.fn(async () => ""),
    openExternal: vi.fn(async () => {}),
  },
}));
vi.mock("electron", () => electron);
const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("electron-log/main", () => ({ default: log }));
const state = vi.hoisted(() => ({ loadState: vi.fn(), saveState: vi.fn() }));
vi.mock("./state", () => state);
const updater = vi.hoisted(() => ({
  status: vi.fn(() => ({ kind: "idle" })),
  check: vi.fn(async () => {}),
  install: vi.fn(),
}));
vi.mock("./updater", () => ({ updater }));
const avatars = vi.hoisted(() => ({ isGitlab: vi.fn() }));
vi.mock("./avatars", () => avatars);
/** Terminal launchers are faked; everything else really runs. */
const terminals = vi.hoisted(() => ({
  /** Programs that are "not installed". */
  missing: new Set<string>(),
  spawn: vi.fn((file: string, ..._args: unknown[]) => {
    const child = Object.assign(new EventEmitter(), { unref: terminals.unref });
    const fail = terminals.missing.has(file);
    setImmediate(() =>
      fail
        ? child.emit("error", Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" }))
        : child.emit("spawn"),
    );
    return child;
  }),
  unref: vi.fn(),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const launchers = [
    "osascript",
    "cmd.exe",
    "x-terminal-emulator",
    "gnome-terminal",
    "konsole",
    "xfce4-terminal",
    "xterm",
    "my-term",
  ];
  return {
    ...real,
    spawn: (file: string, ...rest: unknown[]) =>
      launchers.includes(file)
        ? terminals.spawn(file, ...rest)
        : (real.spawn as (...a: unknown[]) => unknown)(file, ...rest),
  };
});

const { Caller, handlers, registerIpc } = await import("./ipc");

// ---------------------------------------------------------------------------
// Fake services
// ---------------------------------------------------------------------------

/** A repository whose methods echo their name and arguments. */
const fakeRepo = (location: RepoLocation, workTree = location.path) => {
  const fixed = {
    id:
      location.kind === "local"
        ? `local:${location.path}`
        : `ssh://${location.host}${location.path}`,
    location,
    workTree,
    setHiddenRefs: vi.fn(),
  };
  return new Proxy(fixed, {
    get: (target, prop) =>
      prop in target
        ? target[prop as keyof typeof target]
        : (...args: unknown[]) => Effect.succeed({ method: prop, args }),
  }) as unknown as Repository & typeof fixed;
};

const services = {
  repo: fakeRepo({ kind: "local", path: "/work/repo" }),
  getRepo: null as null | ((id: string) => Effect.Effect<Repository, never>),
  hosts: new Map<string, Host>(),
  connected: [] as string[],
  hidden: new Map<string, readonly string[]>(),
  /** Owners repositories were opened or used for. */
  owners: [] as number[],
};

/** A host that runs scripts with the local `/bin/sh` and records programs. */
const shellHost = (id: string) => {
  const execs: [string, readonly string[]][] = [];
  const shOptions: unknown[] = [];
  const host: Host = {
    id,
    kind: id === LOCAL_HOST ? "local" : "ssh",
    exec: (program, args) => {
      execs.push([program, args]);
      return Effect.succeed({ stdout: Buffer.alloc(0), stderr: "", exitCode: 0, truncated: false });
    },
    sh: (script, options) => {
      shOptions.push(options);
      return spawn("/bin/sh", ["-c", script], { cwd: options?.cwd });
    },
  };
  return Object.assign(host, { execs, shOptions });
};

const layer = Layer.mergeAll(
  Layer.succeed(Repos, {
    open: (location, owner) =>
      Effect.sync(() => {
        services.owners.push(owner);
        return fakeRepo(location);
      }),
    get: (id, owner) => {
      services.owners.push(owner);
      return services.getRepo ? services.getRepo(id) : Effect.succeed(services.repo);
    },
    release: (id, owner) =>
      Effect.sync(() => void services.connected.push(`close ${id} by ${owner}`)),
    releaseAll: (owner) => Effect.sync(() => void services.connected.push(`release ${owner}`)),
  }),
  Layer.succeed(Hosts, {
    get: (id) => {
      let h = services.hosts.get(id);
      if (!h) services.hosts.set(id, (h = shellHost(id)));
      return h;
    },
    configuredSshHosts: Effect.succeed(["fedora", "box"]),
    connect: (id) => Effect.sync(() => void services.connected.push(id)),
  }),
  Layer.succeed(RepoSettings, {
    hidden: (id) => services.hidden.get(id) ?? [],
    setHidden: (id, hidden) => void services.hidden.set(id, hidden),
  }),
);
const runtime = ManagedRuntime.make(layer);

type AnyHandler = (
  ...args: unknown[]
) => Effect.Effect<unknown, unknown, InstanceType<typeof Caller>>;
/** Calls a handler as the renderer with `webContents.id` 1. */
const asCaller = (method: string, args: unknown[]) =>
  (handlers as unknown as Record<string, AnyHandler>)[method]!(...args).pipe(
    Effect.provideService(Caller, { webContents: { id: 1 } as WebContents }),
  );
const call = (method: string, ...args: unknown[]) => runtime.runPromise(asCaller(method, args));
const callExit = (method: string, ...args: unknown[]) =>
  runtime.runPromiseExit(asCaller(method, args));

const platform = process.platform;
const setPlatform = (value: string) => Object.defineProperty(process, "platform", { value });

beforeEach(() => {
  vi.clearAllMocks();
  services.repo = fakeRepo({ kind: "local", path: "/work/repo" });
  services.getRepo = null;
  services.hosts.clear();
  services.connected.length = 0;
  services.hidden.clear();
  services.owners.length = 0;
  terminals.missing.clear();
  vi.stubEnv("TERMINAL", "");
});
afterEach(() => {
  setPlatform(platform);
  vi.unstubAllEnvs();
});
afterAll(() => runtime.dispose());

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

describe("app and dialog handlers", () => {
  it("loads and saves the app state", async () => {
    state.loadState.mockReturnValue({ tabs: ["local:/a"], activeTab: null, recent: [] });
    expect(await call("app.getState")).toEqual({ tabs: ["local:/a"], activeTab: null, recent: [] });
    const next = { tabs: [], activeTab: null, recent: ["local:/a"] };
    await call("app.setState", next);
    expect(state.saveState).toHaveBeenCalledWith(next);
  });

  it("reports the version and platform", async () => {
    expect(await call("app.version")).toEqual({ version: "1.2.3", platform: process.platform });
  });

  it("picks a directory, attached to the caller's window if any", async () => {
    expect(await call("dialog.pickDirectory")).toBe("/picked");
    expect(electron.dialog.showOpenDialog).toHaveBeenLastCalledWith({
      properties: ["openDirectory", "createDirectory"],
    });
    const win = { id: 1 };
    electron.BrowserWindow.fromWebContents.mockReturnValueOnce(win);
    await call("dialog.pickDirectory");
    expect(electron.BrowserWindow.fromWebContents).toHaveBeenLastCalledWith({ id: 1 });
    expect(electron.dialog.showOpenDialog).toHaveBeenLastCalledWith(win, expect.any(Object));

    electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await call("dialog.pickDirectory")).toBeNull();
    electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] });
    expect(await call("dialog.pickDirectory")).toBeNull();
  });
});

describe("shell handlers", () => {
  it("opens http(s) links only", async () => {
    await call("shell.openExternal", "https://example.org/x");
    await call("shell.openExternal", "HTTP://example.org/y");
    expect(electron.shell.openExternal).toHaveBeenCalledWith("https://example.org/x");
    expect(electron.shell.openExternal).toHaveBeenCalledWith("HTTP://example.org/y");
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "not a url"]) {
      const exit = await callExit("shell.openExternal", url);
      expect(exit).toEqual(
        Exit.fail(new InvalidInputError({ message: `Refusing to open ${url}` })),
      );
    }
    expect(electron.shell.openExternal).toHaveBeenCalledTimes(2);
  });

  it("reports links that cannot be opened", async () => {
    electron.shell.openExternal.mockRejectedValueOnce(new Error("no handler"));
    expect(await callExit("shell.openExternal", "https://x.org")).toEqual(
      Exit.fail(new InvalidInputError({ message: "Cannot open https://x.org: no handler" })),
    );
  });

  it("asks only plausible web origins whether they run GitLab", async () => {
    avatars.isGitlab.mockImplementation((origin: string) =>
      Effect.succeed(origin !== "https://git.other.io"),
    );
    expect(await call("web.isGitlab", "https://git.corp.io")).toBe(true);
    // With its own scheme and port.
    expect(await call("web.isGitlab", "http://code.corp.io:8443")).toBe(true);
    expect(await call("web.isGitlab", "https://git.other.io")).toBe(false);
    // Not asked: GitHub, ssh aliases, and anything that is not a bare http(s) origin.
    for (const origin of [
      "https://github.com",
      "https://fedora",
      "git.corp.io",
      "https://git.corp.io/path",
      "ftp://git.corp.io",
      "https://user@git.corp.io",
    ])
      expect(await call("web.isGitlab", origin)).toBe(false);
    expect(avatars.isGitlab.mock.calls).toEqual([
      ["https://git.corp.io"],
      ["http://code.corp.io:8443"],
      ["https://git.other.io"],
    ]);
  });

  it("reveals local files and folders", async () => {
    await call("shell.revealInFinder", "local:/work/repo", "src/a b.ts");
    expect(electron.shell.showItemInFolder).toHaveBeenCalledWith("/work/repo/src/a b.ts");
    await call("shell.revealInFinder", "local:/work/repo");
    expect(electron.shell.openPath).toHaveBeenCalledWith("/work/repo");
  });

  it("reveals nothing outside the repository and reports failures", async () => {
    for (const path of ["../etc/passwd", "a/../../x", "/etc/passwd", "."]) {
      const exit = await callExit("shell.revealInFinder", "local:/work/repo", path);
      expect(JSON.stringify(exit)).toContain("is outside the repository");
    }
    expect(electron.shell.showItemInFolder).not.toHaveBeenCalled();
    electron.shell.openPath.mockResolvedValueOnce("Failed to open");
    expect(await callExit("shell.revealInFinder", "local:/work/repo")).toEqual(
      Exit.fail(new InvalidInputError({ message: "Failed to open" })),
    );
  });

  it("does not reveal remote files", async () => {
    services.repo = fakeRepo({ kind: "ssh", host: "fedora", path: "/srv/repo" });
    await call("shell.revealInFinder", "ssh://fedora/srv/repo", "a");
    await call("shell.revealInFinder", "ssh://fedora/srv/repo");
    expect(electron.shell.showItemInFolder).not.toHaveBeenCalled();
    expect(electron.shell.openPath).not.toHaveBeenCalled();
  });

  const local = () => fakeRepo({ kind: "local", path: "/work/it's" });
  const remote = () => fakeRepo({ kind: "ssh", host: "fedora", path: "/srv/my repo" });
  const detached = { detached: true, stdio: "ignore" };

  it("opens Terminal.app on macOS", async () => {
    setPlatform("darwin");
    services.repo = local();
    await call("shell.openTerminal", services.repo.id);
    expect(terminals.spawn).toHaveBeenLastCalledWith(
      "osascript",
      [
        "-e",
        `tell application "Terminal"\n  activate\n  do script "cd '/work/it'\\\\''s'"\nend tell`,
      ],
      detached,
    );
    services.repo = remote();
    await call("shell.openTerminal", services.repo.id);
    const script = (terminals.spawn.mock.lastCall![1] as string[])[1]!;
    expect(script).toContain(
      `do script "ssh -t -- fedora 'cd '\\\\''/srv/my repo'\\\\'' && exec $SHELL -l'"`,
    );
    expect(terminals.unref).toHaveBeenCalledTimes(2);
  });

  it("opens cmd on Windows", async () => {
    setPlatform("win32");
    services.repo = local();
    await call("shell.openTerminal", services.repo.id);
    expect(terminals.spawn).toHaveBeenLastCalledWith(
      "cmd.exe",
      ["/d", "/c", "start", "", "cmd.exe"],
      { cwd: "/work/it's", ...detached },
    );
    services.repo = remote();
    await call("shell.openTerminal", services.repo.id);
    expect(terminals.spawn).toHaveBeenLastCalledWith(
      "cmd.exe",
      [`/d /s /c "start "" "ssh" "-t" "--" "fedora" "cd '/srv/my repo' && exec $SHELL -l""`],
      { windowsVerbatimArguments: true, ...detached },
    );
    // cmd.exe expands `%VAR%` even in quotes.
    services.repo = fakeRepo({ kind: "ssh", host: "fedora", path: "/srv/100%" });
    const exit = await callExit("shell.openTerminal", services.repo.id);
    expect(JSON.stringify(exit)).toContain("Cannot pass");
    expect(terminals.spawn).toHaveBeenCalledTimes(2);
  });

  it("opens the first available terminal emulator elsewhere", async () => {
    setPlatform("linux");
    services.repo = local();
    await call("shell.openTerminal", services.repo.id);
    expect(terminals.spawn).toHaveBeenLastCalledWith("x-terminal-emulator", [], {
      cwd: "/work/it's",
      ...detached,
    });
    services.repo = remote();
    terminals.missing.add("x-terminal-emulator");
    await call("shell.openTerminal", services.repo.id);
    expect(terminals.spawn).toHaveBeenLastCalledWith(
      "gnome-terminal",
      ["--", "ssh", "-t", "--", "fedora", "cd '/srv/my repo' && exec $SHELL -l"],
      detached,
    );
    vi.stubEnv("TERMINAL", "my-term");
    await call("shell.openTerminal", services.repo.id);
    expect(terminals.spawn).toHaveBeenLastCalledWith(
      "my-term",
      ["-e", "ssh", "-t", "--", "fedora", "cd '/srv/my repo' && exec $SHELL -l"],
      detached,
    );
  });

  it("fails, instead of crashing, without a terminal emulator", async () => {
    setPlatform("linux");
    for (const t of ["x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal", "xterm"])
      terminals.missing.add(t);
    const exit = await callExit("shell.openTerminal", services.repo.id);
    expect(exit).toEqual(
      Exit.fail(
        new InvalidInputError({
          message: "No terminal emulator found. Set $TERMINAL to the one to use.",
        }),
      ),
    );
    setPlatform("darwin");
    terminals.missing.add("osascript");
    expect(JSON.stringify(await callExit("shell.openTerminal", services.repo.id))).toContain(
      "Could not open a terminal: spawn osascript ENOENT",
    );
  });
});

describe.skipIf(process.platform === "win32")("ssh handlers", () => {
  let dir = "";
  const home = process.env.HOME;
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "gitdove-ipc-")));
    const browse = join(dir, "browse");
    for (const d of [
      "zeta",
      "Alpha",
      "repo/.git/objects",
      "bare.git/objects",
      ".hidden",
      "..dots",
      "new\nline",
      "linked",
    ]) {
      mkdirSync(join(browse, d), { recursive: true });
    }
    writeFileSync(join(browse, "bare.git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(browse, "repo", ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(browse, "linked", ".git"), "gitdir: /elsewhere\n");
    writeFileSync(join(browse, "file.txt"), "");
    mkdirSync(join(dir, "home", "projects"), { recursive: true });
  });
  afterAll(() => {
    process.env.HOME = home;
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists configured hosts", async () => {
    expect(await call("ssh.hosts")).toEqual(["fedora", "box"]);
  });

  it("lists sub-directories and marks repositories", async () => {
    const r = await call("ssh.listDir", "fedora", join(dir, "browse"));
    expect(services.connected).toEqual(["fedora"]);
    // Listing only reads, so it may be retried after a dropped connection.
    expect((services.hosts.get("fedora") as ReturnType<typeof shellHost>).shOptions).toEqual([
      { idempotent: true },
    ]);
    expect(r).toEqual({
      path: join(dir, "browse"),
      entries: [
        { name: "..dots", isDir: true, isRepo: false },
        { name: ".hidden", isDir: true, isRepo: false },
        { name: "Alpha", isDir: true, isRepo: false },
        { name: "bare.git", isDir: true, isRepo: true },
        { name: "linked", isDir: true, isRepo: true },
        { name: "new\nline", isDir: true, isRepo: false },
        { name: "repo", isDir: true, isRepo: true },
        { name: "zeta", isDir: true, isRepo: false },
      ],
    });
  });

  it("starts in the home directory", async () => {
    process.env.HOME = join(dir, "home");
    expect(await call("ssh.listDir", "fedora", "")).toEqual({
      path: join(dir, "home"),
      entries: [{ name: "projects", isDir: true, isRepo: false }],
    });
  });

  it("expands ~ to the home directory and hides .git", async () => {
    process.env.HOME = join(dir, "browse");
    expect(await call("ssh.listDir", "fedora", "~/repo")).toEqual({
      path: join(dir, "browse", "repo"),
      entries: [],
    });
    expect((await call("ssh.listDir", "fedora", "~")) as { path: string }).toMatchObject({
      path: join(dir, "browse"),
    });
  });

  it("fails for a missing directory", async () => {
    const exit = await callExit("ssh.listDir", "fedora", join(dir, "nope"));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("CommandError");
  });
});

describe("repository lifecycle handlers", () => {
  it("opens and closes repositories", async () => {
    expect(await call("repo.open", { kind: "local", path: "/a" })).toEqual({
      method: "info",
      args: [],
    });
    await call("repo.close", "local:/a");
    expect(services.connected).toEqual(["close local:/a by 1"]);
    expect(services.owners).toEqual([1]);
  });

  it("initializes a repository on its host, then opens it", async () => {
    expect(await call("repo.init", { kind: "ssh", host: "fedora", path: "/srv/new" })).toEqual({
      method: "info",
      args: [],
    });
    await call("repo.init", { kind: "local", path: "/tmp/new" });
    expect((services.hosts.get("fedora") as ReturnType<typeof shellHost>).execs).toEqual([
      ["git", ["init", "--", "/srv/new"]],
    ]);
    expect((services.hosts.get(LOCAL_HOST) as ReturnType<typeof shellHost>).execs).toEqual([
      ["git", ["init", "--", "/tmp/new"]],
    ]);
  });

  it("clones on the target host and refuses option-like URLs", async () => {
    const safe = ["-c", "protocol.ext.allow=never", "-c", "protocol.fd.allow=never"];
    await call("repo.clone", "git@github.com:a/b.git", {
      kind: "ssh",
      host: "fedora",
      path: "/srv/b",
    });
    await call("repo.clone", "https://x/c.git", { kind: "local", path: "/tmp/c" });
    expect((services.hosts.get("fedora") as ReturnType<typeof shellHost>).execs).toEqual([
      [
        "git",
        [...safe, "clone", "--no-recurse-submodules", "--", "git@github.com:a/b.git", "/srv/b"],
      ],
    ]);
    expect((services.hosts.get(LOCAL_HOST) as ReturnType<typeof shellHost>).execs).toEqual([
      ["git", [...safe, "clone", "--no-recurse-submodules", "--", "https://x/c.git", "/tmp/c"]],
    ]);
    for (const url of ["--upload-pack=evil", "ext::sh -c touch% /tmp/pwned", "FD::17", ""]) {
      const exit = await callExit("repo.clone", url, { kind: "local", path: "/tmp/d" });
      expect(exit).toEqual(Exit.fail(new InvalidInputError({ message: "Invalid URL" })));
    }
    expect(services.hosts.get(LOCAL_HOST)).toBeDefined();
    expect((services.hosts.get(LOCAL_HOST) as ReturnType<typeof shellHost>).execs).toHaveLength(1);
  });
});

describe("repository handlers", () => {
  const special = new Set([
    "repo.open",
    "repo.close",
    "repo.init",
    "repo.clone",
    "repo.hiddenRefs",
    "repo.setHiddenRefs",
    "repo.setVisible",
  ]);
  const delegating = Object.keys(handlers).filter((m) => m.startsWith("repo.") && !special.has(m));

  it.each(delegating)("%s calls the repository method with its arguments", async (method) => {
    const ids: string[] = [];
    services.getRepo = (id) => {
      ids.push(id);
      return Effect.succeed(services.repo);
    };
    const arity = (handlers as unknown as Record<string, AnyHandler>)[method]!.length;
    const args = ["a1", "a2", "a3", "a4"].slice(0, arity - 1);
    expect(await call(method, "local:/work/repo", ...args)).toEqual({
      method: method.slice("repo.".length),
      args,
    });
    expect(ids).toEqual(["local:/work/repo"]);
  });

  it("reads and stores hidden refs", async () => {
    services.hidden.set("local:/work/repo", ["refs/heads/x"]);
    expect(await call("repo.hiddenRefs", "local:/work/repo")).toEqual(["refs/heads/x"]);
    await call("repo.setHiddenRefs", "local:/work/repo", ["refs/heads/y", 42, null, "refs/tags/t"]);
    expect(services.hidden.get("local:/work/repo")).toEqual(["refs/heads/y", "refs/tags/t"]);
    expect(services.repo.setHiddenRefs).toHaveBeenCalledWith(["refs/heads/y", "refs/tags/t"]);
  });
});

describe("updater handlers", () => {
  it("delegates to the updater", async () => {
    expect(await call("updater.status")).toEqual({ kind: "idle" });
    await call("updater.check");
    await call("updater.install");
    expect(updater.check).toHaveBeenCalledTimes(1);
    expect(updater.install).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// IPC entry point
// ---------------------------------------------------------------------------

describe("registerIpc", () => {
  type Invoke = (event: unknown, method: unknown, args: unknown) => Promise<RpcResult<unknown>>;
  const sender = { id: 1, once: vi.fn() };
  const invoke = (method: unknown, args: unknown) => {
    registerIpc(runtime);
    expect(electron.ipcMain.handle).toHaveBeenCalledWith(IPC_INVOKE, expect.any(Function));
    const handler = electron.ipcMain.handle.mock.lastCall![1] as Invoke;
    return handler({ sender }, method, args);
  };

  it("rejects unknown methods", async () => {
    for (const method of ["no.such", "toString", "__proto__", 42]) {
      expect(await invoke(method, [])).toEqual({
        ok: false,
        error: { tag: "BadRequest", message: `Unknown method ${String(method)}` },
      });
    }
  });

  it("rejects malformed arguments before they reach a handler", async () => {
    const id = "local:/work/repo";
    const bad: [string, unknown][] = [
      ["app.version", "not-an-array"],
      ["app.version", [1]],
      ["repo.status", []],
      ["repo.status", [42]],
      ["repo.status", ["nope"]],
      ["repo.status", ["local:"]],
      ["repo.status", ["ssh://-oProxyCommand=x/srv"]],
      ["repo.stage", [id, "a"]],
      ["repo.stage", [id, ["a", 1]]],
      ["repo.stashPop", [id, -1]],
      ["repo.stashPop", [id, 1.5]],
      ["repo.reset", [id, "HEAD", "keep"]],
      ["repo.push", [id, { force: "yes", setUpstream: false }]],
      ["repo.open", [{ kind: "ssh", host: "-oProxyCommand=x", path: "/srv" }]],
      ["repo.open", [{ kind: "ssh", host: "box", path: "" }]],
      ["repo.open", [{ kind: "nfs", path: "/srv" }]],
      // The local host is not an SSH host, whatever its id.
      ["repo.open", [{ kind: "ssh", host: LOCAL_HOST, path: "/srv" }]],
      ["ssh.listDir", [LOCAL_HOST, null]],
      ["repo.status", [`ssh://${LOCAL_HOST}/srv`]],
      ["ssh.listDir", ["fedora --", null]],
      ["app.setState", [{ tabs: "x", activeTab: null, recent: [] }]],
      ["repo.graphRows", [id, 1, 0, 4097]],
    ];
    services.getRepo = () => Effect.die("must not be called");
    for (const [method, args] of bad) {
      const r = await invoke(method, args);
      expect(r, `${method} ${JSON.stringify(args)}`).toMatchObject({
        ok: false,
        error: { tag: "BadRequest" },
      });
      expect(!r.ok && r.error.message).toMatch(`Invalid arguments for ${method}: `);
    }
    expect(log.error).not.toHaveBeenCalled();
  });

  it("accepts well-formed arguments", async () => {
    expect(await invoke("repo.graphRows", ["local:/work/repo", 1, 4096, 8192])).toMatchObject({
      ok: true,
    });
    expect(
      await invoke("repo.merge", ["ssh://fedora/srv/a", "main", { ffOnly: true }]),
    ).toMatchObject({ ok: true });
    expect(await invoke("shell.revealInFinder", ["local:/work/repo"])).toMatchObject({ ok: true });
    // Unknown properties are dropped.
    await invoke("app.setState", [{ tabs: [], activeTab: null, recent: [], extra: 1 }]);
    expect(state.saveState).toHaveBeenLastCalledWith({ tabs: [], activeTab: null, recent: [] });
  });

  it("runs edit commands in the window that asked", async () => {
    registerIpc(runtime);
    const handler = electron.ipcMain.handle.mock.lastCall![1] as Invoke;
    const editor = { id: 2, once: vi.fn(), paste: vi.fn() };
    expect(await handler({ sender: editor }, "app.edit", ["paste"])).toEqual({ ok: true });
    expect(editor.paste).toHaveBeenCalledOnce();
    expect(await handler({ sender: editor }, "app.edit", ["destroy"])).toMatchObject({
      ok: false,
      error: { tag: "BadRequest" },
    });
  });

  it("returns values", async () => {
    expect(await invoke("app.version", [])).toEqual({
      ok: true,
      value: { version: "1.2.3", platform: process.platform },
    });
  });

  it("serializes typed failures with their stderr", async () => {
    services.getRepo = () =>
      Effect.fail(
        new CommandError({
          message: "bad revision",
          command: "git log",
          exitCode: 128,
          stderr: "fatal: bad revision",
        }),
      ) as never;
    expect(await invoke("repo.status", ["local:/x"])).toEqual({
      ok: false,
      error: { tag: "CommandError", message: "bad revision", detail: "fatal: bad revision" },
    });
    expect(log.warn).toHaveBeenCalledWith("repo.status failed: bad revision");
    services.getRepo = () =>
      Effect.fail(
        new NotARepositoryError({
          message: "/x cannot be opened",
          path: "/x",
          stderr: "fatal: detected dubious ownership",
        }),
      ) as never;
    expect(await invoke("repo.status", ["local:/x"])).toEqual({
      ok: false,
      error: {
        tag: "NotARepositoryError",
        message: "/x cannot be opened",
        detail: "fatal: detected dubious ownership",
      },
    });
    expect(await invoke("shell.openExternal", ["ftp://x"])).toEqual({
      ok: false,
      error: { tag: "InvalidInputError", message: "Refusing to open ftp://x" },
    });
  });

  it("caps error details and logs expected failures quietly", async () => {
    services.getRepo = () =>
      Effect.fail(
        new CommandError({ message: "x", command: "c", exitCode: 1, stderr: "e".repeat(100_000) }),
      ) as never;
    const r = await invoke("repo.status", ["local:/x"]);
    expect(!r.ok && r.error.detail!.length).toBeLessThan(17_000);
    services.getRepo = () => Effect.fail(new StaleGraphError({ message: "outdated" })) as never;
    log.warn.mockClear();
    await invoke("repo.status", ["local:/x"]);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("repo.status: outdated");
  });

  it("reports interruptions and defects", async () => {
    services.getRepo = () => Effect.interrupt as never;
    expect(await invoke("repo.status", ["local:/x"])).toEqual({
      ok: false,
      error: { tag: "Interrupted", message: "Operation was cancelled" },
    });
    services.getRepo = () => Effect.die(new Error("boom")) as never;
    const r = await invoke("repo.status", ["local:/x"]);
    expect(r).toMatchObject({ ok: false, error: { tag: "Defect" } });
    expect(!r.ok && r.error.message).toContain("boom");
    expect(log.error).toHaveBeenCalledWith("Unexpected error", expect.stringContaining("boom"));
  });

  it("releases the repositories of a renderer when it goes away", async () => {
    const renderer = { id: 5, once: vi.fn() };
    registerIpc(runtime);
    const handler = electron.ipcMain.handle.mock.lastCall![1] as Invoke;
    await handler({ sender: renderer }, "repo.status", ["local:/work/repo"]);
    await handler({ sender: renderer }, "repo.refs", ["local:/work/repo"]);
    expect(services.owners).toEqual([5, 5]);
    expect(renderer.once).toHaveBeenCalledTimes(1);
    expect(renderer.once).toHaveBeenCalledWith("destroyed", expect.any(Function));
    renderer.once.mock.calls[0]![1]();
    await vi.waitFor(() => expect(services.connected).toEqual(["release 5"]));
  });

  it("logs slow calls", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(1000).mockReturnValueOnce(1750);
    await invoke("app.version", []);
    expect(log.info).toHaveBeenCalledWith("app.version took 750ms");
    vi.restoreAllMocks();
  });
});
