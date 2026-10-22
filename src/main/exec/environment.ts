import { spawn as nodeSpawn } from "node:child_process";
import { delimiter } from "node:path";
import { Effect } from "effect";
import { shellQuote } from "./shell";

const MARKER = "__GITDOVE_ENV__";
/** Variables taken over from the login shell's environment (see `fixProcessPath`). */
const LOCALE_VARS = /^(LANG|LC_[A-Z]+)$/;
const MAX_OUTPUT = 1024 * 1024;

/** Extracts the `env -0` output between the markers; null without both markers. */
export const parseShellEnvironment = (output: Buffer): Record<string, string> | null => {
  const text = output.toString("utf8");
  const start = text.indexOf(MARKER);
  const end = text.lastIndexOf(MARKER);
  if (start < 0 || end <= start) return null;
  const env: Record<string, string> = {};
  for (const entry of text.slice(start + MARKER.length, end).split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
};

/**
 * Arguments that make `shell` an interactive login shell running `command`. csh and tcsh take
 * `-l` only as their sole argument: they run it interactive, which reads `.cshrc` (`.login`,
 * which sets little else, is left out).
 */
export const shellArgs = (shell: string, command: string): string[] =>
  /(^|\/)(t?csh|bsd-csh)$/.test(shell) ? ["-i", "-c", command] : ["-ilc", command];

/**
 * Asks the user's interactive login shell for its environment: GUI apps on macOS (and some
 * Linux desktops) are launched with a minimal one, without e.g. Homebrew's PATH or an
 * `SSH_AUTH_SOCK` set in `.zshrc`. Null on Windows or when the shell fails.
 *
 * The shell gets no stdin and its own session (no controlling terminal), so prompts in rc
 * files cannot block it, and SIGKILL after `timeoutMs`: interactive shells ignore SIGTERM.
 */
export const resolveShellEnvironment = (timeoutMs = 5000) =>
  Effect.callback<Record<string, string> | null>((resume) => {
    if (process.platform === "win32") {
      resume(Effect.succeed(null));
      return;
    }
    const shell = process.env.SHELL || "/bin/sh";
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    let drain: NodeJS.Timeout | undefined;
    const child = nodeSpawn(shell, shellArgs(shell, `printf ${MARKER}; env -0; printf ${MARKER}`), {
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
      env: { ...process.env, DISABLE_AUTO_UPDATE: "true", GITDOVE_RESOLVING_ENVIRONMENT: "1" },
    });
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(drain);
      child.stdout.destroy();
      resume(Effect.succeed(ok ? parseShellEnvironment(Buffer.concat(chunks)) : null));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(true);
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (size < MAX_OUTPUT) chunks.push(chunk);
      size += chunk.length;
    });
    child.on("error", () => finish(false));
    child.on("close", () => finish(true));
    // Something the shell started in the background may hold stdout open.
    child.on("exit", () => {
      drain = setTimeout(() => finish(true), 500);
    });
    return Effect.sync(() => {
      done = true;
      clearTimeout(timer);
      clearTimeout(drain);
      child.kill("SIGKILL");
    });
  });

/**
 * Takes PATH (merged), `SSH_AUTH_SOCK` and the locale from the login shell. Does nothing on
 * Windows, where apps get the full environment.
 */
export const fixProcessPath = Effect.gen(function* () {
  if (process.platform === "win32") return;
  const shellEnv = yield* resolveShellEnvironment();
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const parts = [
    ...(shellEnv?.PATH?.split(delimiter) ?? []),
    ...(process.env.PATH?.split(delimiter) ?? []),
    ...extra,
  ].filter(Boolean);
  process.env.PATH = [...new Set(parts)].join(delimiter);
  if (!shellEnv) return;
  // An agent configured in the shell (1Password, gpg-agent) is the one the user means.
  if (shellEnv.SSH_AUTH_SOCK) process.env.SSH_AUTH_SOCK = shellEnv.SSH_AUTH_SOCK;
  for (const [k, v] of Object.entries(shellEnv)) {
    if (LOCALE_VARS.test(k) && process.env[k] === undefined) process.env[k] = v;
  }
});

let loading: Promise<void> | undefined;

/**
 * Starts `fixProcessPath` once, without waiting for it: the login shell can take seconds, and
 * must not delay the window. Processes are spawned only after it is done (`environmentReady`).
 */
export const loadEnvironment: Effect.Effect<void> = Effect.sync(() => {
  loading ??= Effect.runPromise(fixProcessPath).catch(() => {});
});

/** Waits for `loadEnvironment` if it was started. */
export const environmentReady: Effect.Effect<void> = Effect.suspend(() =>
  loading ? Effect.promise(() => loading!) : Effect.void,
);

/**
 * Variables that point git at another repository or configuration, set e.g. when the app is
 * started from a git hook, or that would stamp every commit with a fixed date.
 */
const INHERITED_GIT_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_SHALLOW_FILE",
  "GIT_REFLOG_ACTION",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_DATE",
];
// Without GIT_CONFIG_COUNT, git ignores GIT_CONFIG_KEY_<n> (which a shell cannot enumerate).
const INHERITED_GIT_VAR = new RegExp(
  `^(${INHERITED_GIT_VARS.join("|")}|GIT_CONFIG_(KEY|VALUE)_\\d+)$`,
);

/**
 * Settings for every git invocation, local and remote: no prompts, pagers or editors, and
 * untranslated messages (errors are matched and summarized in English).
 */
export const remoteGitEnv: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  GIT_EDITOR: "true",
  GIT_SEQUENCE_EDITOR: "true",
  GCM_INTERACTIVE: "never",
  LC_MESSAGES: "C",
  LANGUAGE: "",
};

/** Environment used for every local git invocation. */
export const gitEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!INHERITED_GIT_VAR.test(k)) env[k] = v;
  // LC_ALL would override LC_MESSAGES; keep the character set it selects.
  if (env.LC_ALL) env.LC_CTYPE = env.LC_ALL;
  delete env.LC_ALL;
  return { ...env, ...remoteGitEnv, SSH_ASKPASS_REQUIRE: "never" };
};

/** POSIX `sh` that gives a remote shell the environment `gitEnv` gives local processes. */
export const REMOTE_ENV_SCRIPT = [
  `unset ${INHERITED_GIT_VARS.join(" ")}`,
  `if [ -n "\${LC_ALL-}" ]; then LC_CTYPE=$LC_ALL; export LC_CTYPE; fi; unset LC_ALL`,
  Object.entries(remoteGitEnv)
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join(" "),
  `export ${Object.keys(remoteGitEnv).join(" ")}`,
].join("\n");
