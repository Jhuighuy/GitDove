// @vitest-environment happy-dom
/// <reference lib="dom" />
import type { Bridge } from "@shared/ipc";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  bridge: null as Bridge | null,
  onEvent: null as null | ((e: unknown, event: string, payload: unknown) => void),
  invoke: vi.fn(async (..._args: unknown[]) => ({ ok: true, value: 1 })),
}));
vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, api: Bridge) => {
      electron.bridge = api;
    },
  },
  ipcRenderer: {
    invoke: electron.invoke,
    on: (_channel: string, f: (e: unknown, event: string, payload: unknown) => void) => {
      electron.onEvent = f;
    },
  },
}));

const load = async () => {
  vi.resetModules();
  await import("./index");
  return electron.bridge!;
};
const emit = (event: string, payload: unknown) => electron.onEvent!({}, event, payload);

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = "dark";
});

describe("preload bridge", () => {
  it("invokes methods through the single channel", async () => {
    const bridge = await load();
    await bridge.invoke("repo.status", "local:/a");
    expect(electron.invoke).toHaveBeenCalledWith("gitdove:invoke", "repo.status", ["local:/a"]);
  });

  it("delivers events to every listener even when one throws", async () => {
    const bridge = await load();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: unknown[] = [];
    bridge.on("menu.command", () => {
      throw new Error("boom");
    });
    const off = bridge.on("menu.command", (p) => seen.push(p));
    emit("menu.command", { command: "fetch" });
    expect(seen).toEqual([{ command: "fetch" }]);
    expect(error).toHaveBeenCalledOnce();
    off();
    emit("menu.command", { command: "pull" });
    expect(seen).toHaveLength(1);
    error.mockRestore();
  });

  it("applies the saved theme once the document is parsed", async () => {
    localStorage.setItem("theme", "light");
    await load();
    document.dispatchEvent(new Event("readystatechange"));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");

    localStorage.setItem("theme", "dark");
    document.documentElement.className = "";
    await load();
    document.dispatchEvent(new Event("readystatechange"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
