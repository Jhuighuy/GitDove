import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { groupHasLiveMember, killUnlessGone } from "./terminate";

describe("groupHasLiveMember", () => {
  const ps = ["  100 Ss", "  100 Z", "  200 S+", "  300 Z+", "", "garbage"].join("\n");

  it("finds running members of the group", () => {
    expect(groupHasLiveMember(ps, 100)).toBe(true);
    expect(groupHasLiveMember(ps, 200)).toBe(true);
  });

  it("ignores zombies, which no signal removes, and other groups", () => {
    expect(groupHasLiveMember(ps, 300)).toBe(false);
    expect(groupHasLiveMember(ps, 400)).toBe(false);
    expect(groupHasLiveMember("", 100)).toBe(false);
  });
});

describe("terminateTree on Windows", () => {
  it("kills the process itself and settles when taskkill cannot start", async () => {
    vi.resetModules();
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.doMock("node:child_process", () => ({
      execFile: vi.fn(),
      spawn: vi.fn(() => {
        const killer = new EventEmitter();
        setTimeout(() => killer.emit("error", new Error("spawn taskkill ENOENT")), 0);
        return killer;
      }),
    }));
    try {
      const { terminateTree } = await import("./terminate");
      const child = {
        pid: 123,
        exitCode: null as number | null,
        signalCode: null,
        kill: vi.fn(() => {
          child.exitCode = 1;
          return true;
        }),
      };
      await Effect.runPromise(
        terminateTree(child as unknown as ChildProcess).pipe(Effect.timeout("2 seconds")),
      );
      expect(child.kill).toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", platform);
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });
});

describe.skipIf(process.platform === "win32")("killUnlessGone", () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  /** A process that runs until killed; reaped once it exits, so `alive` sees it gone. */
  const sleeper = () => spawn("sleep", ["30"], { stdio: "ignore" }).pid!;

  it("kills the processes once the time is up, if the first still runs", async () => {
    const [main, helper] = [sleeper(), sleeper()];
    killUnlessGone([main, helper], 500);
    await new Promise((r) => setTimeout(r, 300));
    expect([alive(main), alive(helper)]).toEqual([true, true]);
    await vi.waitFor(() => expect([alive(main), alive(helper)]).toEqual([false, false]), {
      timeout: 5000,
    });
  });

  it("leaves them alone when the first one exited meanwhile", async () => {
    const [main, helper] = [sleeper(), sleeper()];
    killUnlessGone([main, helper], 500);
    process.kill(main);
    await new Promise((r) => setTimeout(r, 2000));
    expect(alive(helper)).toBe(true);
    process.kill(helper);
  });
});
