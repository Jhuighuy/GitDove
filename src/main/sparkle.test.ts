import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdaterStatus } from "@shared/domain";
import { describe, expect, it } from "vitest";
import { parseSparkleStatus, Sparkle } from "./sparkle";

describe("parseSparkleStatus", () => {
  it("parses statuses", () => {
    expect(parseSparkleStatus('{"kind":"idle"}')).toEqual({ kind: "idle" });
    expect(parseSparkleStatus('{"kind":"ready","version":"0.1.7"}')).toEqual({
      kind: "ready",
      version: "0.1.7",
    });
    expect(parseSparkleStatus('{"kind":"downloading","percent":42}')).toEqual({
      kind: "downloading",
      percent: 42,
    });
    expect(parseSparkleStatus('{"kind":"error","message":"no"}')).toEqual({
      kind: "error",
      message: "no",
    });
  });

  it("rejects malformed lines", () => {
    for (const line of ["", "null", "[]", "{", '{"kind":"ready"}', '{"kind":"installed"}'])
      expect(parseSparkleStatus(line)).toBeNull();
  });
});

/** A stand-in for the helper: answers commands the way `native/macos/Updater.swift` does. */
function fakeHelper(script: string) {
  const file = join(mkdtempSync(join(tmpdir(), "gitdove-sparkle-")), "helper");
  writeFileSync(file, `#!/bin/sh\n${script}`);
  chmodSync(file, 0o755);
  return file;
}

function start(script: string, bundle = "/Applications/GitDove.app", automatic = true) {
  const statuses: UpdaterStatus[] = [];
  const logs: string[] = [];
  const sparkle = new Sparkle(
    bundle,
    { automatic, onStatus: (s) => statuses.push(s), onLog: (m) => logs.push(m) },
    script ? fakeHelper(script) : undefined,
  );
  return { sparkle, statuses, logs };
}

describe.skipIf(process.platform === "win32")("Sparkle", () => {
  it("relays statuses and commands", async () => {
    const { sparkle, statuses, logs } = start(`
echo '{"kind":"checking"}'
while read -r command; do
  case "$command" in
    check) echo '{"kind":"ready","version":"0.1.7"}' ;;
    *) echo "$command $1" >&2 ;;
  esac
done
echo bye >&2`);
    await expect.poll(() => statuses).toEqual([{ kind: "checking" }]);
    sparkle.check();
    await expect.poll(() => statuses.at(-1)).toEqual({ kind: "ready", version: "0.1.7" });
    sparkle.install();
    await expect.poll(() => logs).toEqual(["install /Applications/GitDove.app"]);
    sparkle.close();
    await expect.poll(() => logs.at(-1)).toBe("bye");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(statuses).toHaveLength(2);
  });

  it("starts the helper without automatic checks, and turns them on and off", async () => {
    const { sparkle, logs } = start(
      `echo "args $*" >&2; while read -r command; do echo "$command" >&2; done`,
      "/Applications/GitDove.app",
      false,
    );
    await expect.poll(() => logs).toEqual(["args /Applications/GitDove.app --manual"]);
    sparkle.setAutomatic(true);
    sparkle.setAutomatic(false);
    await expect.poll(() => logs.slice(1)).toEqual(["automatic", "manual"]);
    sparkle.close();
  });

  it("logs unexpected output", async () => {
    const { logs } = start("echo nonsense; sleep 1");
    await expect.poll(() => logs).toEqual(["Unexpected output from the updater: nonsense"]);
  });

  it("reports a helper that stops unexpectedly", async () => {
    const { statuses } = start("exit 3");
    await expect
      .poll(() => statuses)
      .toEqual([{ kind: "error", message: "Updater stopped unexpectedly (3)" }]);
  });

  it("reports a helper that cannot start", async () => {
    const { statuses } = start("", "/nonexistent/GitDove.app");
    await expect.poll(() => statuses.length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(statuses).toEqual([{ kind: "error", message: expect.stringMatching(/ENOENT/) }]);
  });
});
