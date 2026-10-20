import { type Bridge, IPC_EVENT, IPC_INVOKE } from "@shared/ipc";
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

ipcRenderer.on(IPC_EVENT, (_e: IpcRendererEvent, event: string, payload: unknown) => {
  const set = listeners.get(event);
  if (set) for (const l of set) l(payload);
});

const bridge: Bridge = {
  invoke: (method, ...args) => ipcRenderer.invoke(IPC_INVOKE, method, args),
  on: (event, listener) => {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(listener as Listener);
    return () => set.delete(listener as Listener);
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld("gitdove", bridge);
