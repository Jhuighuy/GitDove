import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fixProcessPath, gitEnv, remoteGitEnv, resolveShellPath } from "./environment";

const platform = process.platform;
const setPlatform = (value: string) => Object.defineProperty(process, "platform", { value });
const saved = { SHELL: process.env.SHELL, PATH: process.env.PATH };

let dir = "";
/** Writes an executable fake login shell. */
const fakeShell = (name: string, body: string) => {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "gitdove-env-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  setPlatform(platform);
  process.env.SHELL = saved.SHELL;
  process.env.PATH = saved.PATH;
});

describe.skipIf(process.platform === "win32")("resolveShellPath", () => {
  it("extracts PATH from the login shell's noisy output", async () => {
    // The fake shell also checks that it is asked for an interactive login shell.
    process.env.SHELL = fakeShell(
      "noisy",
      `[ "$1" = -ilc ] || exit 3
[ "$DISABLE_AUTO_UPDATE" = true ] || exit 4
echo "Welcome!"
PATH=/fake/bin:/usr/bin; eval "$2"; echo; echo bye`,
    );
    expect(await Effect.runPromise(resolveShellPath)).toBe("/fake/bin:/usr/bin");
  });

  it("is null when the shell fails, cannot start or prints no marker", async () => {
    process.env.SHELL = fakeShell("failing", "exit 1");
    expect(await Effect.runPromise(resolveShellPath)).toBeNull();
    process.env.SHELL = join(dir, "missing");
    expect(await Effect.runPromise(resolveShellPath)).toBeNull();
    process.env.SHELL = fakeShell("silent", "echo nothing here");
    expect(await Effect.runPromise(resolveShellPath)).toBeNull();
  });

  it("kills the shell when interrupted", async () => {
    const pidFile = join(dir, "pid");
    process.env.SHELL = fakeShell("slow", `echo $$ > '${pidFile}'; exec sleep 30`);
    const fiber = Effect.runFork(resolveShellPath);
    await expect
      .poll(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim())
      .toBeTruthy();
    const pid = Number(readFileSync(pidFile, "utf8"));
    await Effect.runPromise(Fiber.interrupt(fiber));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await expect.poll(alive).toBe(false);
  });

  it("is null on Windows without running a shell", async () => {
    setPlatform("win32");
    process.env.SHELL = fakeShell("never", "exit 1");
    expect(await Effect.runPromise(resolveShellPath)).toBeNull();
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
});

describe("git environments", () => {
  it("disables prompts, pagers and editors locally on top of the process environment", () => {
    process.env.GITDOVE_TEST_VAR = "kept";
    try {
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
    } finally {
      delete process.env.GITDOVE_TEST_VAR;
    }
  });

  it("forwards only git settings to remote hosts", () => {
    expect(remoteGitEnv).toEqual({
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      GIT_EDITOR: "true",
      GIT_SEQUENCE_EDITOR: "true",
      GCM_INTERACTIVE: "never",
    });
  });
});
