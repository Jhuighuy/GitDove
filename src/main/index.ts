import { join } from "node:path";
import { type EventName, type Events, IPC_EVENT, type MenuCommand } from "@shared/ipc";
import { app, BrowserWindow, Menu, type MenuItemConstructorOptions, shell } from "electron";
import log from "electron-log/main";
import { Effect, Layer, ManagedRuntime } from "effect";
import { activity } from "./activity";
import { fixProcessPath } from "./exec/environment";
import { HostsLive } from "./exec/hosts";
import { registerIpc } from "./ipc";
import { Notifier, ReposLive } from "./services";
import { updater } from "./updater";

log.initialize();
log.transports.file.level = "info";

const isMac = process.platform === "darwin";

const broadcast = <E extends EventName>(event: E, payload: Events[E]) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC_EVENT, event, payload);
  }
};

const NotifierLive = Layer.succeed(Notifier, { emit: broadcast });
const MainLive = ReposLive.pipe(Layer.provideMerge(HostsLive), Layer.provide(NotifierLive));
const runtime = ManagedRuntime.make(MainLive);

const command = (c: MenuCommand) => () => broadcast("menu.command", { command: c });

const buildMenu = () => {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        { label: "Open Repository…", accelerator: "CmdOrCtrl+O", click: command("open-repo") },
        {
          label: "Open Remote Repository…",
          accelerator: "CmdOrCtrl+Shift+O",
          click: command("open-remote-repo"),
        },
        { type: "separator" },
        { label: "Close Tab", accelerator: "CmdOrCtrl+W", click: command("close-tab") },
        ...(isMac ? [] : [{ type: "separator" as const }, { role: "quit" as const }]),
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Refresh", accelerator: "CmdOrCtrl+R", click: command("refresh") },
        { label: "Toggle Sidebar", accelerator: "CmdOrCtrl+J", click: command("toggle-sidebar") },
        {
          label: "Toggle Details Panel",
          accelerator: "CmdOrCtrl+K",
          click: command("toggle-details"),
        },
        { type: "separator" },
        { label: "Next Tab", accelerator: "Ctrl+Tab", click: command("next-tab") },
        { label: "Previous Tab", accelerator: "Ctrl+Shift+Tab", click: command("prev-tab") },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
        { role: "forceReload" },
      ],
    },
    {
      label: "Repository",
      submenu: [
        { label: "Fetch", accelerator: "CmdOrCtrl+Shift+F", click: command("fetch") },
        { label: "Pull", accelerator: "CmdOrCtrl+Shift+L", click: command("pull") },
        { label: "Push", accelerator: "CmdOrCtrl+Shift+K", click: command("push") },
        { type: "separator" },
        { label: "New Branch…", accelerator: "CmdOrCtrl+B", click: command("new-branch") },
        { label: "Stash", accelerator: "CmdOrCtrl+Shift+S", click: command("stash") },
        { label: "Pop Stash", accelerator: "CmdOrCtrl+Shift+P", click: command("pop") },
        { type: "separator" },
        { label: "Commit…", accelerator: "CmdOrCtrl+Shift+C", click: command("commit-focus") },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "GitDove on GitHub",
          click: () => void shell.openExternal("https://github.com/Jhuighuy/GitDove"),
        },
        {
          label: "Show Logs",
          click: () => void shell.openPath(log.transports.file.getFile().path),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: "#18181b",
    title: "GitDove",
    ...(isMac
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 13 } }
      : {
          titleBarStyle: "hidden" as const,
          titleBarOverlay: { color: "#00000000", symbolColor: "#a1a1aa", height: 40 },
        }),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.once("ready-to-show", () => win.show());
  win.on("focus", () => activity.setFocused(true));
  win.on("blur", () => activity.setFocused(BrowserWindow.getFocusedWindow() !== null));

  // Never navigate away from the app; open links externally.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }
  return win;
};

const main = async () => {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  await app.whenReady();
  await Effect.runPromise(fixProcessPath);
  registerIpc(runtime);
  buildMenu();
  createWindow();
  updater.init((s) => broadcast("updater.status", s));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
};

app.on("window-all-closed", () => {
  if (!isMac) app.quit();
});

let disposing = false;
app.on("will-quit", (e) => {
  if (disposing) return;
  disposing = true;
  e.preventDefault();
  // Close SSH masters and file watchers before exiting.
  void runtime
    .dispose()
    .catch((err: unknown) => log.error("dispose failed", err))
    .finally(() => app.exit(0));
});

void main();
