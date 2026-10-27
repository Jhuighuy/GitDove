/**
 * Opening a repository in a terminal: the terminals GitDove knows on each platform, how to find
 * them, and how to start each at a local directory or with an SSH session to a remote one.
 */
import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { RepoLocation } from "@shared/domain";
import { programName, type TerminalInfo } from "@shared/settings";
import { Effect } from "effect";
import { shellJoin, shellQuote } from "./exec/shell";

/** A program to start to open a terminal. */
export interface Launch {
  readonly file: string;
  readonly args: readonly string[];
  readonly options?: SpawnOptions;
  /**
   * Whether the program only hands over to the terminal and exits (`open`, `osascript`): it is
   * waited for, and fails when it exits with an error, e.g. without such an application.
   */
  readonly waits?: boolean;
}

/** Most of a handing-over program's error output kept for its error message. */
const MAX_STDERR = 4096;

/** Starts a program; fails when it cannot be started (e.g. it is not installed). */
export const launch = ({ file, args, options, waits }: Launch) =>
  Effect.callback<void, Error>((resume) => {
    let child: ChildProcess;
    try {
      child = waits
        ? nodeSpawn(file, args, { ...options, stdio: ["ignore", "ignore", "pipe"] })
        : nodeSpawn(file, args, { ...options, detached: true, stdio: "ignore" });
    } catch (e) {
      resume(Effect.fail(e instanceof Error ? e : new Error(String(e))));
      return;
    }
    // Without an `error` listener, a missing program would crash the main process.
    child.on("error", (e) => resume(Effect.fail(e)));
    if (!waits) {
      child.once("spawn", () => {
        child.unref();
        resume(Effect.void);
      });
      return;
    }
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < MAX_STDERR) stderr += d.toString("utf8");
    });
    child.once("close", (code) => {
      if (code === 0) return resume(Effect.void);
      const message = stderr.trim().split("\n").at(-1);
      resume(Effect.fail(new Error(message || `${file} exited with code ${code}`)));
    });
  });

/** An AppleScript string literal. */
const appleScriptString = (s: string) => `"${s.replaceAll(/[\\"]/g, "\\$&")}"`;

/** Quotes an argument for a `cmd.exe` command line, which has no way to escape `"` or `%`. */
const cmdQuote = (s: string) => {
  if (/["%\r\n]/.test(s)) throw new Error(`Cannot pass ${JSON.stringify(s)} to cmd.exe`);
  return `"${s}"`;
};

/** `ssh` with a login shell in the repository, for a remote repository. */
const sshArgs = (loc: RepoLocation & { kind: "ssh" }) => [
  "ssh",
  "-t",
  "--",
  loc.host,
  `cd ${shellQuote(loc.path)} && exec $SHELL -l`,
];

/** A shell command that opens the repository: `cd` to it, or `ssh` to it. */
const shellCommand = (loc: RepoLocation) =>
  loc.kind === "local" ? `cd ${shellQuote(loc.path)}` : shellJoin(sshArgs(loc));

const osascript = (script: string): Launch => ({
  file: "osascript",
  args: ["-e", script],
  waits: true,
});

/** `open -na <app> --args …`: a new instance of a macOS application, with arguments. */
const openApp = (app: string, args: readonly string[]): Launch => ({
  file: "open",
  args: ["-na", app, "--args", ...args],
  waits: true,
});

/** `start` opens a new console window; the empty argument is its title. */
const cmdStart = (argv: readonly string[], options?: SpawnOptions): Launch => ({
  file: "cmd.exe",
  args: [`/d /s /c "start "" ${argv.map(cmdQuote).join(" ")}"`],
  options: { ...options, windowsVerbatimArguments: true },
});

interface Terminal {
  readonly id: string;
  readonly name: string;
  /** Where it is installed: an app bundle, an `.exe`, or a command on `PATH`; null if nowhere. */
  readonly locate: () => string | null;
  /**
   * How to open a repository with the terminal installed at `path`; null for a remote repository
   * it cannot run `ssh` for (the default terminal opens it then).
   */
  readonly open: (path: string, loc: RepoLocation) => Launch[] | null;
}

/** A macOS application in one of the usual places. */
const macApp =
  (bundle: string, places = ["/Applications", join(homedir(), "Applications")]) =>
  () =>
    places.map((dir) => join(dir, bundle)).find((p) => existsSync(p)) ?? null;

/** A macOS terminal that takes a working directory, or a command to run, as arguments. */
const macCli = (
  id: string,
  name: string,
  local: (dir: string) => string[],
  remote: (argv: string[]) => string[],
): Terminal => ({
  id,
  name,
  locate: macApp(`${name}.app`),
  open: (path, loc) => [
    openApp(path, loc.kind === "local" ? local(loc.path) : remote(sshArgs(loc))),
  ],
});

const MAC_TERMINALS: readonly Terminal[] = [
  {
    id: "terminal",
    name: "Terminal",
    locate: macApp("Terminal.app", ["/System/Applications/Utilities", "/Applications/Utilities"]),
    open: (_path, loc) => [
      osascript(`tell application id "com.apple.Terminal"
  activate
  do script ${appleScriptString(shellCommand(loc))}
end tell`),
    ],
  },
  {
    id: "iterm",
    name: "iTerm",
    locate: macApp("iTerm.app"),
    open: (_path, loc) => [
      osascript(`tell application id "com.googlecode.iterm2"
  activate
  set w to (create window with default profile)
  tell current session of w to write text ${appleScriptString(shellCommand(loc))}
end tell`),
    ],
  },
  {
    id: "ghostty",
    name: "Ghostty",
    locate: macApp("Ghostty.app"),
    // A window of the running Ghostty (1.3 and later can be scripted), else a new instance.
    open: (path, loc) => [
      osascript(`tell application id "com.mitchellh.ghostty"
  activate
  set cfg to new surface configuration
  ${
    loc.kind === "local"
      ? `set initial working directory of cfg to ${appleScriptString(loc.path)}`
      : `set command of cfg to ${appleScriptString(shellJoin(sshArgs(loc)))}`
  }
  new window with configuration cfg
end tell`),
      openApp(
        path,
        loc.kind === "local" ? [`--working-directory=${loc.path}`] : ["-e", ...sshArgs(loc)],
      ),
    ],
  },
  macCli(
    "wezterm",
    "WezTerm",
    (dir) => ["start", "--cwd", dir],
    (argv) => ["start", "--", ...argv],
  ),
  macCli(
    "kitty",
    "kitty",
    (dir) => ["--directory", dir],
    (argv) => argv,
  ),
  macCli(
    "alacritty",
    "Alacritty",
    (dir) => ["--working-directory", dir],
    (argv) => ["-e", ...argv],
  ),
  {
    id: "warp",
    name: "Warp",
    locate: macApp("Warp.app"),
    open: (path, loc) =>
      loc.kind === "local" ? [{ file: "open", args: ["-a", path, loc.path], waits: true }] : null,
  },
];

/** A Windows program at `dir\…\file`, where `dir` is an environment variable's value. */
const winExe =
  (variable: string, ...parts: string[]) =>
  () => {
    const dir = process.env[variable];
    const path = dir ? join(dir, ...parts) : null;
    return path && existsSync(path) ? path : null;
  };

/** A Windows shell: opened at a local repository with `start`. */
const winShell = (id: string, name: string, locate: () => string | null): Terminal => ({
  id,
  name,
  locate,
  open: (path, loc) => (loc.kind === "local" ? [cmdStart([path], { cwd: loc.path })] : null),
});

// Remote repositories open with `start ssh …` whatever the choice: it opens in the default
// terminal (Windows Terminal on Windows 11), and terminals differ in how they would take it.
const WINDOWS_TERMINALS: readonly Terminal[] = [
  {
    id: "wt",
    name: "Windows Terminal",
    locate: winExe("LOCALAPPDATA", "Microsoft", "WindowsApps", "wt.exe"),
    open: (path, loc) =>
      loc.kind === "local"
        ? [{ file: path, args: ["-d", loc.path], options: { detached: true } }]
        : null,
  },
  winShell("pwsh", "PowerShell", winExe("ProgramFiles", "PowerShell", "7", "pwsh.exe")),
  winShell(
    "powershell",
    "Windows PowerShell",
    winExe("SystemRoot", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ),
  winShell("cmd", "Command Prompt", winExe("SystemRoot", "System32", "cmd.exe")),
  winShell("gitbash", "Git Bash", winExe("ProgramFiles", "Git", "git-bash.exe")),
];

/** Whether `path` is a file that can be run. */
const isExecutable = (path: string) => {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** A command's location on `PATH`. */
const onPath = (command: string) => () => {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && isExecutable(join(dir, command))) return join(dir, command);
  }
  return null;
};

/**
 * A terminal emulator command: started in the local repository's directory, or given `ssh`
 * after `exec`, the options that take the command to run.
 */
const linuxCommand = (
  id: string,
  name: string,
  exec: readonly string[],
  local: readonly string[] = [],
): Terminal => ({
  id,
  name,
  locate: onPath(id),
  open: (path, loc) => [
    loc.kind === "local"
      ? { file: path, args: local, options: { cwd: loc.path } }
      : { file: path, args: [...exec, ...sshArgs(loc)] },
  ],
});

const LINUX_TERMINALS: readonly Terminal[] = [
  linuxCommand("x-terminal-emulator", "Default (x-terminal-emulator)", ["-e"]),
  linuxCommand("gnome-terminal", "GNOME Terminal", ["--"]),
  linuxCommand("ptyxis", "Ptyxis", ["--new-window", "--"], ["--new-window"]),
  linuxCommand("konsole", "Konsole", ["-e"]),
  linuxCommand("xfce4-terminal", "Xfce Terminal", ["-x"]),
  linuxCommand("ghostty", "Ghostty", ["-e"]),
  linuxCommand("kitty", "kitty", []),
  linuxCommand("alacritty", "Alacritty", ["-e"]),
  linuxCommand("wezterm", "WezTerm", ["start", "--"]),
  linuxCommand("foot", "foot", []),
  linuxCommand("xterm", "XTerm", ["-e"]),
];

const knownTerminals = (): readonly Terminal[] =>
  process.platform === "darwin"
    ? MAC_TERMINALS
    : process.platform === "win32"
      ? WINDOWS_TERMINALS
      : LINUX_TERMINALS;

/** Terminals tried in turn when none is chosen on Linux. */
const LINUX_DEFAULTS = [
  "x-terminal-emulator",
  "gnome-terminal",
  "ptyxis",
  "konsole",
  "xfce4-terminal",
  "xterm",
];

/** The terminal used when none is chosen. */
export const defaultTerminalName = (): string =>
  process.platform === "darwin"
    ? "Terminal"
    : process.platform === "win32"
      ? "Command Prompt"
      : "$TERMINAL or the system's";

/** The terminals known here, for the user to choose from. */
export const knownTerminalList = (): TerminalInfo[] =>
  knownTerminals().map((t) => ({ id: t.id, name: t.name, installed: t.locate() !== null }));

/** A known terminal that `path` (a chosen application or program) is an install of, if any. */
const knownByPath = (path: string) => {
  const name = programName(path).toLowerCase();
  return knownTerminals().find((t) => t.id === name || t.name.toLowerCase() === name);
};

/** What the user may choose as a terminal (see `pickTerminal`): an error message, or null. */
export const checkTerminalPath = (path: string): string | null => {
  if (!isAbsolute(path) || !existsSync(path)) return `${path} does not exist`;
  if (process.platform === "darwin")
    return path.endsWith(".app") ? null : `${programName(path)} is not an application`;
  if (process.platform === "win32")
    return /\.exe$/i.test(path) ? null : `${programName(path)} is not a program`;
  return isExecutable(path) ? null : `${programName(path)} is not a program`;
};

/** The `terminal` setting for a chosen path: a known terminal's id where it is installed. */
export const terminalSetting = (path: string): string => {
  const known = knownByPath(path);
  return known && known.locate() === path ? known.id : path;
};

/** Opening a repository with the default terminal. */
const defaults = (loc: RepoLocation): Launch[] => {
  if (process.platform === "darwin") return MAC_TERMINALS[0]!.open("", loc)!;
  if (process.platform === "win32") {
    return loc.kind === "local"
      ? [cmdStart(["cmd.exe"], { cwd: loc.path })]
      : [cmdStart(sshArgs(loc))];
  }
  const fromEnv = process.env.TERMINAL ? [process.env.TERMINAL] : [];
  return [...fromEnv, ...LINUX_DEFAULTS].flatMap(
    (command) => linuxTerminal(command).open(command, loc) ?? [],
  );
};

/** A Linux terminal by its command or path: a known one, or one that takes `-e` like most do. */
const linuxTerminal = (command: string): Terminal =>
  knownByPath(command) ?? {
    ...linuxCommand("", programName(command), ["-e"]),
    locate: () => command,
  };

/** A terminal the user chose by its path (or, from older settings, by name). */
const custom = (path: string): Terminal => {
  const known = knownByPath(path);
  if (known) return { ...known, locate: () => path };
  if (process.platform === "darwin") {
    return {
      id: "",
      name: programName(path),
      locate: () => path,
      open: (p, loc) =>
        loc.kind === "local" ? [{ file: "open", args: ["-a", p, loc.path], waits: true }] : null,
    };
  }
  return winShell("", programName(path), () => path);
};

/**
 * What the terminal the user chose is called, and whether it opens remote repositories itself
 * (or they open in the default terminal).
 */
export const describeTerminal = (setting: string): { name: string; remote: boolean } => {
  if (!setting) return { name: defaultTerminalName(), remote: true };
  if (process.platform === "linux") return { name: linuxTerminal(setting).name, remote: true };
  const terminal = knownTerminals().find((t) => t.id === setting) ?? custom(setting);
  const probe: RepoLocation = { kind: "ssh", host: "host", path: "/" };
  return {
    name: terminal.name,
    remote: terminal.open(terminal.locate() ?? setting, probe) !== null,
  };
};

/**
 * How to open a repository in the terminal the user chose (the `terminal` setting: empty for the
 * default, a known terminal's id, or a path): launches tried in turn, and what to call it.
 */
export const terminalLaunches = (
  loc: RepoLocation,
  setting = "",
): { readonly name: string; readonly launches: Launch[] } => {
  if (!setting) return { name: defaultTerminalName(), launches: defaults(loc) };
  if (process.platform === "linux") {
    // Run as given, from `PATH` or by path.
    const terminal = linuxTerminal(setting);
    return { name: terminal.name, launches: terminal.open(setting, loc) ?? [] };
  }
  const terminal = knownTerminals().find((t) => t.id === setting) ?? custom(setting);
  const path = terminal.locate();
  if (path === null) throw new Error(`${terminal.name} is not installed`);
  return { name: terminal.name, launches: terminal.open(path, loc) ?? defaults(loc) };
};
