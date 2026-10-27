import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoLocation } from "@shared/domain";
import { programName } from "@shared/settings";
import { Effect, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Files that "exist", besides real ones under the temporary directory. */
const fs = vi.hoisted(() => ({ present: new Set<string>(), tmp: "" }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    existsSync: (p: string) =>
      fs.present.has(p) || (fs.tmp !== "" && p.startsWith(fs.tmp) && real.existsSync(p)),
  };
});
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => "/Users/me",
}));

const { checkTerminalPath, knownTerminalList, launch, terminalLaunches, terminalSetting } =
  await import("./terminals");

const platform = process.platform;
const setPlatform = (value: string) => Object.defineProperty(process, "platform", { value });

beforeEach(() => fs.present.clear());
afterEach(() => {
  setPlatform(platform);
  vi.unstubAllEnvs();
});

const local: RepoLocation = { kind: "local", path: "/work/it's" };
const remote: RepoLocation = { kind: "ssh", host: "fedora", path: "/srv/my repo" };
const ssh = ["ssh", "-t", "--", "fedora", "cd '/srv/my repo' && exec $SHELL -l"];

describe("on macOS", () => {
  beforeEach(() => setPlatform("darwin"));

  it("scripts Terminal, iTerm and Ghostty", () => {
    fs.present.add("/Applications/iTerm.app").add("/Applications/Ghostty.app");
    const iterm = terminalLaunches(remote, "iterm");
    expect(iterm.name).toBe("iTerm");
    expect(iterm.launches).toEqual([
      {
        file: "osascript",
        args: [
          "-e",
          expect.stringContaining(
            `tell current session of w to write text "ssh -t -- fedora 'cd '\\\\''/srv/my repo'\\\\'' && exec $SHELL -l'"`,
          ),
        ],
        waits: true,
      },
    ]);

    // A window of the running Ghostty, or a new instance of one that cannot be scripted.
    const local_ = terminalLaunches(local, "ghostty").launches;
    expect(local_[0]!.args[1]).toContain(`set initial working directory of cfg to "/work/it's"`);
    expect(local_[1]).toEqual({
      file: "open",
      args: ["-na", "/Applications/Ghostty.app", "--args", "--working-directory=/work/it's"],
      waits: true,
    });
    const remote_ = terminalLaunches(remote, "ghostty").launches;
    expect(remote_[0]!.args[1]).toContain(
      `set command of cfg to "ssh -t -- fedora 'cd '\\\\''/srv/my repo'\\\\'' && exec $SHELL -l'"`,
    );
    expect(remote_[1]!.args).toEqual(["-na", "/Applications/Ghostty.app", "--args", "-e", ...ssh]);
  });

  it("passes the directory or ssh to terminals that take arguments", () => {
    for (const app of ["WezTerm", "kitty", "Alacritty", "Warp"]) {
      fs.present.add(`/Users/me/Applications/${app}.app`);
    }
    const args = (loc: RepoLocation, id: string) => terminalLaunches(loc, id).launches[0]!.args;
    const app = (name: string) => ["-na", `/Users/me/Applications/${name}.app`, "--args"];
    expect(args(local, "wezterm")).toEqual([...app("WezTerm"), "start", "--cwd", "/work/it's"]);
    expect(args(remote, "wezterm")).toEqual([...app("WezTerm"), "start", "--", ...ssh]);
    expect(args(local, "kitty")).toEqual([...app("kitty"), "--directory", "/work/it's"]);
    expect(args(remote, "kitty")).toEqual([...app("kitty"), ...ssh]);
    expect(args(remote, "alacritty")).toEqual([...app("Alacritty"), "-e", ...ssh]);
    // Warp opens folders only: Terminal opens remote repositories.
    expect(args(local, "warp")).toEqual(["-a", "/Users/me/Applications/Warp.app", "/work/it's"]);
    expect(args(remote, "warp")[1]).toContain(`tell application id "com.apple.Terminal"`);
  });

  it("opens local repositories in any application, and remote ones in Terminal", () => {
    expect(terminalLaunches(local, "/Applications/Some Term.app")).toEqual({
      name: "Some Term",
      launches: [
        { file: "open", args: ["-a", "/Applications/Some Term.app", "/work/it's"], waits: true },
      ],
    });
    expect(terminalLaunches(remote, "/Applications/Some Term.app").launches[0]!.args[1]).toContain(
      "com.apple.Terminal",
    );
    // A known terminal elsewhere is still known.
    expect(terminalLaunches(remote, "/Volumes/Apps/kitty.app").launches[0]!.args).toEqual([
      "-na",
      "/Volumes/Apps/kitty.app",
      "--args",
      ...ssh,
    ]);
  });

  it("refuses a known terminal that is not installed", () => {
    expect(() => terminalLaunches(local, "iterm")).toThrow("iTerm is not installed");
  });

  it("lists the known terminals and which are installed", () => {
    fs.present.add("/System/Applications/Utilities/Terminal.app").add("/Applications/Ghostty.app");
    const list = knownTerminalList();
    expect(list.filter((t) => t.installed).map((t) => t.id)).toEqual(["terminal", "ghostty"]);
    expect(list.map((t) => t.id)).toContain("warp");
  });

  it("takes applications, by id where they are a known terminal", () => {
    fs.tmp = mkdtempSync(join(tmpdir(), "gitdove-terms-"));
    try {
      const app = join(fs.tmp, "Ghostty.app");
      mkdirSync(app);
      expect(checkTerminalPath(app)).toBeNull();
      expect(checkTerminalPath(fs.tmp)).toMatch(/is not an application$/);
      expect(checkTerminalPath("/nope/X.app")).toBe("/nope/X.app does not exist");
      // Ghostty, but not where GitDove looks for it: kept by path.
      expect(terminalSetting(app)).toBe(app);
      fs.present.add("/Applications/Ghostty.app");
      expect(terminalSetting("/Applications/Ghostty.app")).toBe("ghostty");
    } finally {
      rmSync(fs.tmp, { recursive: true, force: true });
      fs.tmp = "";
    }
  });
});

describe("on Windows", () => {
  beforeEach(() => {
    setPlatform("win32");
    vi.stubEnv("LOCALAPPDATA", "C:\\Users\\me\\AppData\\Local");
    vi.stubEnv("ProgramFiles", "C:\\Program Files");
  });

  it("opens local repositories in the chosen terminal, and remote ones with start", () => {
    const wt = join("C:\\Users\\me\\AppData\\Local", "Microsoft", "WindowsApps", "wt.exe");
    const pwsh = join("C:\\Program Files", "PowerShell", "7", "pwsh.exe");
    fs.present.add(wt).add(pwsh);
    expect(terminalLaunches(local, "wt").launches).toEqual([
      { file: wt, args: ["-d", "/work/it's"], options: { detached: true } },
    ]);
    expect(terminalLaunches(local, "pwsh").launches).toEqual([
      {
        file: "cmd.exe",
        args: [`/d /s /c "start "" "${pwsh}""`],
        options: { cwd: "/work/it's", windowsVerbatimArguments: true },
      },
    ]);
    for (const id of ["wt", "pwsh"]) {
      expect(terminalLaunches(remote, id).launches[0]!.args[0]).toContain(`start "" "ssh"`);
    }
    expect(programName("C:\\Tools\\My Term.exe")).toBe("My Term");
  });
});

describe("on Linux", () => {
  beforeEach(() => setPlatform("linux"));

  it("runs known terminals with their own way of taking a command", () => {
    const run = (id: string) => terminalLaunches(remote, id).launches[0];
    expect(run("ptyxis")).toEqual({ file: "ptyxis", args: ["--new-window", "--", ...ssh] });
    expect(run("kitty")).toEqual({ file: "kitty", args: ssh });
    expect(run("wezterm")).toEqual({ file: "wezterm", args: ["start", "--", ...ssh] });
    expect(run("/usr/local/bin/konsole")).toEqual({
      file: "/usr/local/bin/konsole",
      args: ["-e", ...ssh],
    });
    // Others take `-e`, like most.
    expect(run("/opt/term/bin/myterm")!.args).toEqual(["-e", ...ssh]);
    expect(terminalLaunches(local, "ptyxis").launches).toEqual([
      { file: "ptyxis", args: ["--new-window"], options: { cwd: "/work/it's" } },
    ]);
  });

  it("tries $TERMINAL and the usual terminals without a choice", () => {
    vi.stubEnv("TERMINAL", "kitty");
    const { launches } = terminalLaunches(remote);
    expect(launches.map((l) => l.file)).toEqual([
      "kitty",
      "x-terminal-emulator",
      "gnome-terminal",
      "ptyxis",
      "konsole",
      "xfce4-terminal",
      "xterm",
    ]);
    expect(launches[0]!.args).toEqual(ssh);
  });

  it("finds terminals on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "gitdove-path-"));
    fs.tmp = dir;
    try {
      writeFileSync(join(dir, "foot"), "", { mode: 0o755 });
      writeFileSync(join(dir, "xterm"), "", { mode: 0o644 });
      vi.stubEnv("PATH", dir);
      const installed = knownTerminalList().filter((t) => t.installed);
      expect(installed).toEqual([{ id: "foot", name: "foot", installed: true }]);
      expect(checkTerminalPath(join(dir, "foot"))).toBeNull();
      expect(checkTerminalPath(join(dir, "xterm"))).toBe("xterm is not a program");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      fs.tmp = "";
    }
  });
});

describe.skipIf(platform === "win32")("launch", () => {
  it("waits for a handing-over program, and fails with its last error line", async () => {
    const ok = await Effect.runPromiseExit(launch({ file: "true", args: [], waits: true }));
    expect(ok).toEqual(Exit.void);
    const failed = await Effect.runPromiseExit(
      launch({
        file: "sh",
        args: ["-c", "echo first >&2; echo 'no such app' >&2; exit 3"],
        waits: true,
      }),
    );
    expect(failed).toEqual(Exit.fail(new Error("no such app")));
    const silent = await Effect.runPromiseExit(
      launch({ file: "sh", args: ["-c", "exit 4"], waits: true }),
    );
    expect(silent).toEqual(Exit.fail(new Error("sh exited with code 4")));
  });

  it("fails for a program that is not installed", async () => {
    const exit = await Effect.runPromiseExit(launch({ file: "gitdove-no-such-term", args: [] }));
    expect(JSON.stringify(exit)).toContain("ENOENT");
  });
});
