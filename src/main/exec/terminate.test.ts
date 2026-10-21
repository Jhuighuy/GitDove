import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { groupHasLiveMember } from "./terminate";

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
