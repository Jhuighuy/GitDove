import { execFile } from "node:child_process";
import { Effect } from "effect";

/**
 * GUI apps on macOS (and some Linux desktops) are launched with a minimal
 * PATH. Ask the user's login shell for the real one so that Homebrew git,
 * ssh, etc. are found.
 */
export const resolveShellPath = Effect.callback<string | null>((resume) => {
  if (process.platform === "win32") {
    resume(Effect.succeed(null));
    return;
  }
  const shell = process.env.SHELL || "/bin/sh";
  const marker = "__GITDOVE_PATH__";
  const child = execFile(
    shell,
    ["-ilc", `printf '${marker}%s${marker}' "$PATH"`],
    { timeout: 5000, env: { ...process.env, DISABLE_AUTO_UPDATE: "true" } },
    (error, stdout) => {
      if (error) return resume(Effect.succeed(null));
      const m = new RegExp(`${marker}(.*)${marker}`).exec(stdout);
      resume(Effect.succeed(m?.[1] ?? null));
    },
  );
  return Effect.sync(() => child.kill());
});

export const fixProcessPath = Effect.gen(function* () {
  const shellPath = yield* resolveShellPath;
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const parts = [
    ...(shellPath?.split(":") ?? []),
    ...(process.env.PATH?.split(":") ?? []),
    ...extra,
  ].filter(Boolean);
  process.env.PATH = [...new Set(parts)].join(":");
});

/** Environment used for every git invocation. */
export const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  GIT_EDITOR: "true",
  GIT_SEQUENCE_EDITOR: "true",
  GCM_INTERACTIVE: "never",
  SSH_ASKPASS_REQUIRE: "never",
});

/** Environment variables forwarded to remote git invocations. */
export const remoteGitEnv: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  GIT_EDITOR: "true",
  GIT_SEQUENCE_EDITOR: "true",
  GCM_INTERACTIVE: "never",
};
