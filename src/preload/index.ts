/// <reference lib="dom" />
import { type Bridge, IPC_EVENT, IPC_INVOKE } from "@shared/ipc";
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

ipcRenderer.on(IPC_EVENT, (_e: IpcRendererEvent, event: string, payload: unknown) => {
  const set = listeners.get(event);
  if (!set) return;
  // One failing listener must not keep the event from the others.
  for (const l of set) {
    try {
      l(payload);
    } catch (e) {
      console.error(`${event} listener failed`, e);
    }
  }
});

const bridge: Bridge = {
  invoke: (method, ...args) => ipcRenderer.invoke(IPC_INVOKE, method, args),
  on: (event, listener) => {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    const added = set;
    added.add(listener as Listener);
    return () => {
      added.delete(listener as Listener);
      if (added.size === 0 && listeners.get(event) === added) listeners.delete(event);
    };
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld("gitdove", bridge);

/**
 * Applies the saved theme (next-themes' `theme` key, as the renderer uses it) once the document
 * is parsed, before the renderer's scripts run: the page then never paints in the wrong theme.
 */
const applyTheme = () => {
  const root = document.documentElement;
  let saved: string | null = null;
  try {
    saved = localStorage.getItem("theme");
  } catch {
    // Storage is unavailable; follow the system.
  }
  const dark =
    saved === "dark" || (saved !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
};
document.addEventListener("readystatechange", applyTheme, { once: true });
