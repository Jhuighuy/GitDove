import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoLocation } from "@shared/domain";
import { IPC_INVOKE, type RpcResult } from "@shared/ipc";
import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandError, InvalidInputError } from "./exec/errors";
import { type Host, Hosts } from "./exec/hosts";
import { spawn } from "./exec/spawn";
import type { Repository } from "./git/repository";
import { RepoSettings, Repos } from "./services";

const electron = vi.hoisted(() => ({
  app: { getVersion: () => "1.2.3" },
  BrowserWindow: { getFocusedWindow: vi.fn((): object | null => null) },
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
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
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
  spawn: vi.fn((..._args: unknown[]) => ({ unref: terminals.unref })),
  unref: vi.fn(),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const launchers = ["osascript", "cmd.exe", "x-terminal-emulator"];
  return {
    ...real,
    spawn: (file: string, ...rest: unknown[]) =>
      launchers.includes(file)
        ? terminals.spawn(file, ...rest)
        : (real.spawn as (...a: unknown[]) => unknown)(file, ...rest),
  };
});

const { handlers, registerIpc } = await import("./ipc");

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
};

/** A host that runs scripts with the local `/bin/sh` and records programs. */
const shellHost = (id: string) => {
  const execs: [string, readonly string[]][] = [];
  const shOptions: unknown[] = [];
  const host: Host = {
    id,
    kind: id === "local" ? "local" : "ssh",
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
    open: (location) => Effect.succeed(fakeRepo(location)),
    get: (id) => (services.getRepo ? services.getRepo(id) : Effect.succeed(services.repo)),
    close: (id) => Effect.sync(() => void services.connected.push(`close ${id}`)),
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

type AnyHandler = (...args: unknown[]) => Effect.Effect<unknown, unknown, never>;
const call = (method: string, ...args: unknown[]) =>
  runtime.runPromise((handlers as unknown as Record<string, AnyHandler>)[method]!(...args));
const callExit = (method: string, ...args: unknown[]) =>
  runtime.runPromiseExit((handlers as unknown as Record<string, AnyHandler>)[method]!(...args));

const platform = process.platform;
const setPlatform = (value: string) => Object.defineProperty(process, "platform", { value });

beforeEach(() => {
  vi.clearAllMocks();
  services.repo = fakeRepo({ kind: "local", path: "/work/repo" });
  services.getRepo = null;
  services.hosts.clear();
  services.connected.length = 0;
  services.hidden.clear();
});
afterEach(() => setPlatform(platform));
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

  it("picks a directory, attached to the focused window if any", async () => {
    expect(await call("dialog.pickDirectory")).toBe("/picked");
    expect(electron.dialog.showOpenDialog).toHaveBeenLastCalledWith({
      properties: ["openDirectory", "createDirectory"],
    });
    const win = { id: 1 };
    electron.BrowserWindow.getFocusedWindow.mockReturnValueOnce(win);
    await call("dialog.pickDirectory");
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
    expect(electron.shell.openExternal).toHaveBeenCalledWith("https://example.org/x");
    const exit = await callExit("shell.openExternal", "file:///etc/passwd");
    expect(exit).toEqual(
      Exit.fail(new InvalidInputError({ message: "Refusing to open file:///etc/passwd" })),
    );
    expect(electron.shell.openExternal).toHaveBeenCalledTimes(1);
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
      `do script ${JSON.stringify(`ssh -t fedora 'cd '\\''/srv/my repo'\\'' && exec $SHELL -l'`)}`,
    );
    expect(terminals.unref).toHaveBeenCalledTimes(2);
  });

  it("opens cmd on Windows", async () => {
    setPlatform("win32");
    services.repo = local();
    await call("shell.openTerminal", services.repo.id);
    expect(terminals.spawn).toHaveBeenLastCalledWith(
      "cmd.exe",
      ["/c", "start", "cmd", "/k", `cd /d "/work/it's"`],
      detached,
    );
    services.repo = remote();
    await call("shell.openTerminal", services.repo.id);
    expect(terminals.spawn).toHaveBeenLastCalledWith(
      "cmd.exe",
      ["/c", "start", "ssh", "-t", "fedora", "cd '/srv/my repo' && exec $SHELL -l"],
      detached,
    );
  });

  it("opens the default terminal emulator elsewhere", async () => {
    setPlatform("linux");
    services.repo = local();
    await call("shell.openTerminal", services.repo.id);
    expect(terminals.spawn).toHaveBeenLastCalledWith("x-terminal-emulator", [], {
      cwd: "/work/it's",
      ...detached,
    });
    services.repo = remote();
    await call("shell.openTerminal", services.repo.id);
    expect(terminals.spawn).toHaveBeenLastCalledWith(
      "x-terminal-emulator",
      ["-e", "ssh", "-t", "fedora", "cd '/srv/my repo' && exec $SHELL -l"],
      { cwd: undefined, ...detached },
    );
  });
});

describe.skipIf(process.platform === "win32")("ssh handlers", () => {
  let dir = "";
  const home = process.env.HOME;
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "gitdove-ipc-")));
    const browse = join(dir, "browse");
    for (const d of ["zeta", "Alpha", "repo/.git", "bare.git/objects", ".hidden", "linked"]) {
      mkdirSync(join(browse, d), { recursive: true });
    }
    writeFileSync(join(browse, "bare.git", "HEAD"), "ref: refs/heads/main\n");
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
        { name: ".hidden", isDir: true, isRepo: false },
        { name: "Alpha", isDir: true, isRepo: false },
        { name: "bare.git", isDir: true, isRepo: true },
        { name: "linked", isDir: true, isRepo: true },
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
    expect(services.connected).toEqual(["close local:/a"]);
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
    expect((services.hosts.get("local") as ReturnType<typeof shellHost>).execs).toEqual([
      ["git", ["init", "--", "/tmp/new"]],
    ]);
  });

  it("clones on the target host and refuses option-like URLs", async () => {
    await call("repo.clone", "git@github.com:a/b.git", {
      kind: "ssh",
      host: "fedora",
      path: "/srv/b",
    });
    await call("repo.clone", "https://x/c.git", { kind: "local", path: "/tmp/c" });
    expect((services.hosts.get("fedora") as ReturnType<typeof shellHost>).execs).toEqual([
      ["git", ["clone", "--", "git@github.com:a/b.git", "/srv/b"]],
    ]);
    expect((services.hosts.get("local") as ReturnType<typeof shellHost>).execs).toEqual([
      ["git", ["clone", "--", "https://x/c.git", "/tmp/c"]],
    ]);
    const exit = await callExit("repo.clone", "--upload-pack=evil", {
      kind: "local",
      path: "/tmp/d",
    });
    expect(exit).toEqual(Exit.fail(new InvalidInputError({ message: "Invalid URL" })));
    expect(services.hosts.get("local")).toBeDefined();
    expect((services.hosts.get("local") as ReturnType<typeof shellHost>).execs).toHaveLength(1);
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
  const invoke = (method: unknown, args: unknown) => {
    registerIpc(runtime);
    expect(electron.ipcMain.handle).toHaveBeenCalledWith(IPC_INVOKE, expect.any(Function));
    const handler = electron.ipcMain.handle.mock.lastCall![1] as Invoke;
    return handler({}, method, args);
  };

  it("rejects unknown methods and malformed arguments", async () => {
    for (const [method, args] of [
      ["no.such", []],
      ["toString", []],
      ["__proto__", []],
      [42, []],
      ["app.version", "not-an-array"],
    ] as const) {
      expect(await invoke(method, args)).toEqual({
        ok: false,
        error: { tag: "BadRequest", message: `Unknown method ${String(method)}` },
      });
    }
  });

  it("runs edit commands in the window that asked", async () => {
    registerIpc(runtime);
    const handler = electron.ipcMain.handle.mock.lastCall![1] as Invoke;
    const sender = { paste: vi.fn() };
    expect(await handler({ sender }, "app.edit", ["paste"])).toEqual({ ok: true });
    expect(sender.paste).toHaveBeenCalledOnce();
    expect(await handler({ sender }, "app.edit", ["destroy"])).toMatchObject({
      ok: false,
      error: { tag: "InvalidInputError", message: "Unknown edit command: destroy" },
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
    expect(await invoke("shell.openExternal", ["ftp://x"])).toEqual({
      ok: false,
      error: { tag: "InvalidInputError", message: "Refusing to open ftp://x" },
    });
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

  it("logs slow calls", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(1000).mockReturnValueOnce(1750);
    await invoke("app.version", []);
    expect(log.info).toHaveBeenCalledWith("app.version took 750ms");
    vi.restoreAllMocks();
  });
});
