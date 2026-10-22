// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const b = {
    invoke: vi.fn(),
    invokeCancellable: vi.fn(),
    on: vi.fn((event: string, listener: (p: unknown) => void) => {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(listener);
      return () => void set.delete(listener);
    }),
    platform: "linux",
    emit: (event: string, payload: unknown) => listeners.get(event)?.forEach((l) => l(payload)),
    count: (event: string) => listeners.get(event)?.size ?? 0,
  };
  (globalThis as unknown as { window: { gitdove: unknown } }).window.gitdove = b;
  return b;
});

const { api, ApiError, apiWithSignal, isMac, modKey, platform, useEvent } = await import("./api");

beforeEach(() => {
  bridge.invoke.mockReset();
  bridge.invokeCancellable.mockReset();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

it("unwraps successful results", async () => {
  bridge.invoke.mockResolvedValue({ ok: true, value: { tabs: [] } });
  await expect(api("app.getState")).resolves.toEqual({ tabs: [] });
  expect(bridge.invoke).toHaveBeenCalledWith("app.getState");
  bridge.invoke.mockResolvedValue({ ok: true, value: undefined });
  await api("repo.stage", "local:/r", ["a", "b"]);
  expect(bridge.invoke).toHaveBeenLastCalledWith("repo.stage", "local:/r", ["a", "b"]);
});

it("throws an ApiError carrying the tag and detail of failures", async () => {
  bridge.invoke.mockResolvedValue({
    ok: false,
    error: { tag: "GitError", message: "push rejected", detail: "! [rejected] main" },
  });
  const error = await api("repo.fetch", "local:/r", null).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({
    name: "ApiError",
    message: "push rejected",
    tag: "GitError",
    detail: "! [rejected] main",
  });
});

it("reads the platform from the bridge", () => {
  expect(platform).toBe("linux");
  expect(isMac).toBe(false);
  expect(modKey).toBe("Ctrl+");
});

it("subscribes to events while mounted, always calling the latest listener", async () => {
  const seen: string[] = [];
  const Probe = ({ tag }: { tag: string }) => {
    useEvent("menu.command", ({ command }) => seen.push(`${tag}:${command}`));
    return null;
  };
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Probe, { tag: "a" })));
  expect(bridge.count("menu.command")).toBe(1);
  bridge.emit("menu.command", { command: "fetch" });
  // Re-rendering with a new listener does not resubscribe.
  await act(async () => root.render(createElement(Probe, { tag: "b" })));
  expect(bridge.on).toHaveBeenCalledTimes(1);
  bridge.emit("menu.command", { command: "pull" });
  expect(seen).toEqual(["a:fetch", "b:pull"]);
  await act(async () => root.unmount());
  expect(bridge.count("menu.command")).toBe(0);
});

describe("apiWithSignal", () => {
  /** A cancellable request that the test settles; `cancelled` counts the cancels sent. */
  const pending = () => {
    const state = { cancelled: 0, settle: (_r: unknown) => {} };
    bridge.invokeCancellable.mockImplementation(
      (_method: string, _args: unknown[], onStart: (cancel: () => void) => void) =>
        new Promise((resolve) => {
          state.settle = resolve;
          onStart(() => state.cancelled++);
        }),
    );
    return state;
  };

  it("unwraps results of cancellable requests", async () => {
    const request = pending();
    const result = apiWithSignal(new AbortController().signal, "repo.status", "local:/r");
    expect(bridge.invokeCancellable).toHaveBeenCalledWith(
      "repo.status",
      ["local:/r"],
      expect.any(Function),
    );
    request.settle({ ok: true, value: "status" });
    await expect(result).resolves.toBe("status");
    expect(request.cancelled).toBe(0);
  });

  it("cancels the request when the signal aborts", async () => {
    const request = pending();
    const controller = new AbortController();
    const result = apiWithSignal(controller.signal, "repo.diff", "local:/r", {
      kind: "unstaged",
      path: "a",
    });
    controller.abort();
    expect(request.cancelled).toBe(1);
    request.settle({
      ok: false,
      error: { tag: "Interrupted", message: "Operation was cancelled" },
    });
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    expect(request.cancelled).toBe(1);
  });

  it("sends nothing for an aborted signal, and plain requests without one", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(apiWithSignal(controller.signal, "repo.refs", "local:/r")).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(bridge.invokeCancellable).not.toHaveBeenCalled();
    bridge.invoke.mockResolvedValue({ ok: true, value: 1 });
    await expect(apiWithSignal(undefined, "repo.refs", "local:/r")).resolves.toBe(1);
  });

  it("reports failures that are not cancellations", async () => {
    const request = pending();
    const result = apiWithSignal(new AbortController().signal, "repo.status", "local:/r");
    request.settle({ ok: false, error: { tag: "CommandError", message: "boom" } });
    await expect(result).rejects.toMatchObject({ name: "ApiError", tag: "CommandError" });
  });
});
