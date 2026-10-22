import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  fixProcessPath,
  gitEnv,
  parseShellEnvironment,
  REMOTE_ENV_SCRIPT,
  remoteGitEnv,
  resolveShellEnvironment,
} from "./environment";

const platform = process.platform;
const setPlatform = (value: string) => Object.defineProperty(process, "platform", { value });
const saved = { ...process.env };

let dir = "";
/** Writes an executable fake login shell. */
const fakeShell = (name: string, body: string) => {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "gitdove-env-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  setPlatform(platform);
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("parseShellEnvironment", () => {
  it("reads NUL-separated variables between the markers", () => {
    const out = Buffer.from(
      "motd __GITDOVE_ENV__A=1\0B=x=y\nz\0junk\0__GITDOVE_ENV__ bye __GITDOVE_ENV__",
    );
    // The last marker ends the list; text after the first one is ignored.
    expect(parseShellEnvironment(Buffer.from("__GITDOVE_ENV__A=1\0__GITDOVE_ENV__"))).toEqual({
      A: "1",
    });
    expect(parseShellEnvironment(out)).toMatchObject({ A: "1", B: "x=y\nz" });
    expect(parseShellEnvironment(Buffer.from("no markers"))).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("resolveShellEnvironment", () => {
  it("extracts the environment from the login shell's noisy output", async () => {
    // The fake shell also checks that it is asked for an interactive login shell.
    process.env.SHELL = fakeShell(
      "noisy",
      `[ "$1" = -ilc ] || exit 3
[ "$DISABLE_AUTO_UPDATE" = true ] || exit 4
[ "$GITDOVE_RESOLVING_ENVIRONMENT" = 1 ] || exit 5
echo "Welcome!"
PATH=/fake/bin:/usr/bin; MULTI="a
b"; export MULTI; eval "$2"; echo; echo bye`,
    );
    const env = await Effect.runPromise(resolveShellEnvironment());
    expect(env).toMatchObject({ PATH: "/fake/bin:/usr/bin", MULTI: "a\nb" });
  });

  it.each(["/bin/csh", "/bin/tcsh"].filter((s) => existsSync(s)))(
    "reads the environment from %s, which takes -l only alone",
    async (shell) => {
      process.env.SHELL = shell;
      process.env.GITDOVE_TEST_VAR = "from csh";
      const env = await Effect.runPromise(resolveShellEnvironment());
      expect(env).toMatchObject({ GITDOVE_TEST_VAR: "from csh" });
    },
  );

  it("is null when the shell fails, cannot start or prints no marker", async () => {
    process.env.SHELL = fakeShell("failing", "exit 1");
    expect(await Effect.runPromise(resolveShellEnvironment())).toBeNull();
    process.env.SHELL = join(dir, "missing");
    expect(await Effect.runPromise(resolveShellEnvironment())).toBeNull();
    process.env.SHELL = fakeShell("silent", "echo nothing here");
    expect(await Effect.runPromise(resolveShellEnvironment())).toBeNull();
  });

  it("cannot be blocked by prompts in rc files", async () => {
    // stdin is closed, and there is no terminal to open.
    process.env.SHELL = fakeShell(
      "prompting",
      `read -r answer; (: </dev/tty) 2>/dev/null && exec sleep 30; PATH=/p:/usr/bin; eval "$2"`,
    );
    expect(await Effect.runPromise(resolveShellEnvironment())).toMatchObject({
      PATH: "/p:/usr/bin",
    });
  });

  it("gives up on a shell that ignores SIGTERM, killing it", async () => {
    const pidFile = join(dir, "stuck.pid");
    process.env.SHELL = fakeShell(
      "stuck",
      `trap '' TERM; echo $$ > '${pidFile}'; while :; do sleep 0.1; done`,
    );
    const t0 = Date.now();
    expect(await Effect.runPromise(resolveShellEnvironment(1000))).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5000);
    // (Under heavy load, it may not even have got this far.)
    if (existsSync(pidFile)) {
      await expect.poll(() => alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
    }
  });

  it("does not wait for what the shell left running in the background", async () => {
    process.env.SHELL = fakeShell("daemon", `(sleep 3) & PATH=/d:/usr/bin; eval "$2"`);
    const t0 = Date.now();
    expect(await Effect.runPromise(resolveShellEnvironment())).toMatchObject({
      PATH: "/d:/usr/bin",
    });
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it("kills the shell when interrupted", async () => {
    const pidFile = join(dir, "pid");
    process.env.SHELL = fakeShell("slow", `echo $$ > '${pidFile}'; exec sleep 30`);
    const fiber = Effect.runFork(resolveShellEnvironment());
    await expect
      .poll(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim())
      .toBeTruthy();
    const pid = Number(readFileSync(pidFile, "utf8"));
    await Effect.runPromise(Fiber.interrupt(fiber));
    await expect.poll(() => alive(pid)).toBe(false);
  });

  it("is null on Windows without running a shell", async () => {
    setPlatform("win32");
    process.env.SHELL = fakeShell("never", "exit 1");
    expect(await Effect.runPromise(resolveShellEnvironment())).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("fixProcessPath", () => {
  it("puts the login shell's PATH first and appends the usual locations, deduplicated", async () => {
    process.env.SHELL = fakeShell("login", `PATH=/shell/bin:/usr/bin; eval "$2"`);
    process.env.PATH = "/usr/bin:/app/bin::/shell/bin";
    await Effect.runPromise(fixProcessPath);
    expect(process.env.PATH).toBe(
      "/shell/bin:/usr/bin:/app/bin:/opt/homebrew/bin:/usr/local/bin:/bin",
    );
  });

  it("keeps the current PATH when the shell gives nothing", async () => {
    process.env.SHELL = fakeShell("broken", "exit 1");
    process.env.PATH = "/app/bin";
    await Effect.runPromise(fixProcessPath);
    expect(process.env.PATH).toBe("/app/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
  });

  it("takes the SSH agent and missing locale settings from the shell", async () => {
    process.env.SHELL = fakeShell(
      "agent",
      `SSH_AUTH_SOCK=/shell/agent LANG=de_DE.UTF-8 LC_TIME=C; export SSH_AUTH_SOCK LANG LC_TIME
PATH=/usr/bin:/bin; eval "$2"`,
    );
    process.env.SSH_AUTH_SOCK = "/launchd/agent";
    delete process.env.LANG;
    process.env.LC_TIME = "en_GB.UTF-8";
    await Effect.runPromise(fixProcessPath);
    expect(process.env.SSH_AUTH_SOCK).toBe("/shell/agent");
    expect(process.env.LANG).toBe("de_DE.UTF-8");
    expect(process.env.LC_TIME).toBe("en_GB.UTF-8");
  });

  it("leaves PATH alone on Windows", async () => {
    setPlatform("win32");
    process.env.PATH = "C:\\Windows;C:\\Program Files\\Git\\cmd";
    await Effect.runPromise(fixProcessPath);
    expect(process.env.PATH).toBe("C:\\Windows;C:\\Program Files\\Git\\cmd");
  });
});

describe.skipIf(process.platform === "win32")("loadEnvironment", () => {
  it("does not block, but processes are spawned only once it is done", async () => {
    vi.resetModules();
    try {
      const environment = await import("./environment");
      const { spawn } = await import("./spawn");
      process.env.SHELL = fakeShell("slow-login", `sleep 0.5; PATH=/late/bin:$PATH; eval "$2"`);
      const t0 = Date.now();
      Effect.runSync(environment.loadEnvironment);
      expect(Date.now() - t0).toBeLessThan(400);
      const r = await Effect.runPromise(spawn("/bin/sh", ["-c", 'printf %s "$PATH"']));
      expect(r.stdout.toString()).toMatch(/^\/late\/bin:/);
    } finally {
      vi.resetModules();
    }
  });
});

describe("git environments", () => {
  it("disables prompts, pagers and editors locally on top of the process environment", () => {
    process.env.GITDOVE_TEST_VAR = "kept";
    expect(gitEnv()).toMatchObject({
      GITDOVE_TEST_VAR: "kept",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      GIT_EDITOR: "true",
      GIT_SEQUENCE_EDITOR: "true",
      GCM_INTERACTIVE: "never",
      SSH_ASKPASS_REQUIRE: "never",
    });
  });

  it("gets untranslated messages but keeps the character set", () => {
    process.env.LC_ALL = "de_DE.UTF-8";
    process.env.LANGUAGE = "de";
    const env = gitEnv();
    expect(env).toMatchObject({ LC_CTYPE: "de_DE.UTF-8", LC_MESSAGES: "C", LANGUAGE: "" });
    expect(env.LC_ALL).toBeUndefined();
  });

  it("drops variables that would point git elsewhere", () => {
    Object.assign(process.env, {
      GIT_DIR: "/elsewhere/.git",
      GIT_WORK_TREE: "/elsewhere",
      GIT_INDEX_FILE: "/elsewhere/index",
      GIT_CONFIG_PARAMETERS: "'core.bare'='true'",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.bare",
      GIT_CONFIG_VALUE_0: "true",
      GIT_AUTHOR_NAME: "Kept",
    });
    const env = gitEnv();
    for (const k of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_CONFIG_PARAMETERS",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
    ]) {
      expect(env[k], k).toBeUndefined();
    }
    expect(env.GIT_AUTHOR_NAME).toBe("Kept");
  });

  it("forwards only git and message settings to remote hosts", () => {
    expect(remoteGitEnv).toEqual({
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      GIT_EDITOR: "true",
      GIT_SEQUENCE_EDITOR: "true",
      GCM_INTERACTIVE: "never",
      LC_MESSAGES: "C",
      LANGUAGE: "",
    });
  });

  it.skipIf(process.platform === "win32")("sets up the same environment in a remote shell", () => {
    const out = execFileSync("/bin/sh", ["-c", `${REMOTE_ENV_SCRIPT}\nenv`], {
      env: {
        PATH: process.env.PATH,
        GIT_DIR: "/elsewhere",
        GIT_CONFIG_COUNT: "1",
        LC_ALL: "de_DE.UTF-8",
      },
    }).toString();
    const env = Object.fromEntries(
      out.split("\n").map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1)]),
    );
    expect(env).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      LC_CTYPE: "de_DE.UTF-8",
      LC_MESSAGES: "C",
      LANGUAGE: "",
    });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(env.LC_ALL).toBeUndefined();
  });
});
