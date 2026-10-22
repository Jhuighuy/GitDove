import { join } from "node:path";
import { type EventName, type Events, IPC_EVENT, type MenuCommand } from "@shared/ipc";
import {
  app,
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
  nativeTheme,
  session,
  shell,
} from "electron";
import log from "electron-log/main";
import { Effect, Layer, ManagedRuntime } from "effect";
import dockIcon from "../../build/icon.png?asset";
import windowIcon from "../../resources/icon.png?asset";
import { activity } from "./activity";
import { handleAvatarProtocol, pruneAvatarCache, registerAvatarScheme } from "./avatars";
import { loadEnvironment } from "./exec/environment";
import { HostsLive } from "./exec/hosts";
import { isWebUrl, registerIpc } from "./ipc";
import { LoggerLive, Notifier, RepoSettings, ReposLive } from "./services";
import { flushState, repoSettings, updateRepoSettings } from "./state";
import { checkForUpdatesMenuItem, updater } from "./updater";

// Isolated profiles (e.g. for automated UI tests). Development runs get their own profile, so
// they never share the single-instance lock or state with an installed GitDove.
if (process.env.GITDOVE_USER_DATA) app.setPath("userData", process.env.GITDOVE_USER_DATA);
else if (!app.isPackaged) app.setPath("userData", `${app.getPath("userData")}-dev`);

// The renderer does not log through electron-log, so it needs no preload or IPC channel.
log.initialize({ preload: false });
log.transports.file.level = "info";
if (!app.isPackaged) log.transports.file.fileName = "dev.log";
// Record uncaught errors (e.g. from a child process without an error listener) in the log.
log.errorHandler.startCatching({ showDialog: false });
registerAvatarScheme();

const isMac = process.platform === "darwin";

const broadcast = <E extends EventName>(event: E, payload: Events[E]) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC_EVENT, event, payload);
  }
};

const NotifierLive = Layer.succeed(Notifier, { emit: broadcast });
const RepoSettingsLive = Layer.succeed(RepoSettings, {
  hidden: (id) => repoSettings(id).hidden,
  setHidden: (id, hidden) => updateRepoSettings(id, { hidden }),
});
const MainLive = ReposLive.pipe(
  Layer.provideMerge(HostsLive),
  Layer.provideMerge(RepoSettingsLive),
  Layer.provide(NotifierLive),
  // Every service and the fibers they start log to the app log.
  Layer.provideMerge(LoggerLive),
);
const runtime = ManagedRuntime.make(MainLive);

// ---------------------------------------------------------------------------
// Hardening: applies to every web contents, including ones created later.
// ---------------------------------------------------------------------------

/** Opens a web link in the browser; anything else is ignored. */
const openExternal = (url: string) => {
  if (!isWebUrl(url)) return;
  shell.openExternal(url).catch((e: unknown) => log.warn(`Cannot open ${url}`, e));
};

app.on("web-contents-created", (_e, contents) => {
  // Never navigate away from the app or open windows; open links externally.
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  const stay = (e: Electron.Event, url: string) => {
    if (url !== contents.getURL()) e.preventDefault();
  };
  contents.on("will-navigate", stay);
  contents.on("will-redirect", stay);
  contents.on("will-attach-webview", (e) => e.preventDefault());
});

/** Permissions the renderer may use (copying to the clipboard); Electron grants all by default. */
const PERMISSIONS = new Set(["clipboard-sanitized-write"]);

const restrictPermissions = () => {
  const s = session.defaultSession;
  s.setPermissionRequestHandler((_wc, permission, grant) => grant(PERMISSIONS.has(permission)));
  s.setPermissionCheckHandler((_wc, permission) => PERMISSIONS.has(permission));
  s.setDevicePermissionHandler(() => false);
};

// ---------------------------------------------------------------------------
// Menu and windows
// ---------------------------------------------------------------------------

const command = (c: MenuCommand) => () => broadcast("menu.command", { command: c });

const buildMenu = () => {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            role: "appMenu" as const,
            submenu: [
              { role: "about" as const },
              checkForUpdatesMenuItem(),
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
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
        ...(app.isPackaged
          ? []
          : [{ role: "toggleDevTools" as const }, { role: "forceReload" as const }]),
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
    {
      // Cmd/Ctrl+W closes a tab, so closing the window gets its own shortcut.
      role: "windowMenu",
      submenu: [
        { role: "minimize" },
        ...(isMac ? [{ role: "zoom" as const }] : []),
        { type: "separator" },
        {
          label: "Close Window",
          accelerator: "CmdOrCtrl+Shift+W",
          click: (_item, win) => win?.close(),
        },
        ...(isMac ? [{ type: "separator" as const }, { role: "front" as const }] : []),
      ],
    },
    {
      role: "help",
      submenu: [
        ...(isMac ? [] : [checkForUpdatesMenuItem(), { type: "separator" as const }]),
        {
          label: "GitDove on GitHub",
          click: () => openExternal("https://github.com/Jhuighuy/GitDove"),
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

/** Window colors before the renderer paints, matching the system theme (the default theme). */
const chrome = () =>
  nativeTheme.shouldUseDarkColors
    ? { background: "#18181b", symbols: "#a1a1aa" }
    : { background: "#ffffff", symbols: "#52525b" };

const titleBarOverlay = () => ({ color: "#00000000", symbolColor: chrome().symbols, height: 40 });

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: chrome().background,
    title: "GitDove",
    // macOS takes the icon from the app bundle; elsewhere set it explicitly.
    ...(isMac ? {} : { icon: windowIcon }),
    ...(isMac
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 13 } }
      : { titleBarStyle: "hidden" as const, titleBarOverlay: titleBarOverlay() }),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  });

  win.once("ready-to-show", () => win.show());
  win.on("focus", () => activity.setFocused(true));
  win.on("blur", () =>
    activity.setFocused(
      BrowserWindow.getFocusedWindow() !== null || win.webContents.isDevToolsFocused(),
    ),
  );

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }
  return win;
};

/** Shows the last used window, or opens one if there is none (e.g. macOS after closing it). */
const showWindow = () => {
  const win =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!win) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
};

const main = async () => {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  let started = false;
  app.on("second-instance", () => {
    if (started) showWindow();
  });

  await app.whenReady();
  // Packaged builds use the bundle icon; in development show ours instead of Electron's.
  if (isMac && !app.isPackaged) app.dock?.setIcon(dockIcon);
  // The login shell may take a while: spawns wait for it, the window does not.
  Effect.runSync(loadEnvironment);
  registerIpc(runtime);
  restrictPermissions();
  handleAvatarProtocol();
  buildMenu();
  createWindow();
  started = true;
  updater.init((s) => broadcast("updater.status", s));
  // Housekeeping, once startup work has settled.
  setTimeout(() => void pruneAvatarCache(), 60_000).unref();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  nativeTheme.on("updated", () => {
    if (isMac) return;
    for (const win of BrowserWindow.getAllWindows()) win.setTitleBarOverlay(titleBarOverlay());
  });
};

app.on("window-all-closed", () => {
  if (!isMac) app.quit();
});

/** Longest wait for cleanup on quit, e.g. for an unresponsive SSH host. */
const QUIT_TIMEOUT = 5000;

let disposing = false;
app.on("will-quit", (e) => {
  if (disposing) return;
  disposing = true;
  e.preventDefault();
  updater.dispose();
  flushState();
  setTimeout(() => {
    log.warn("Cleanup on quit timed out");
    app.exit(0);
  }, QUIT_TIMEOUT).unref();
  // Close SSH masters and file watchers before exiting.
  void runtime
    .dispose()
    .catch((err: unknown) => log.error("dispose failed", err))
    .finally(() => app.exit(0));
});

void main();
