import { join } from "node:path";
import { type EventName, type Events, IPC_EVENT, type MenuCommand } from "@shared/ipc";
import {
  app,
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
  nativeTheme,
  powerMonitor,
  screen,
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
import { killUnlessGone } from "./exec/terminate";
import { isWebUrl, registerIpc } from "./ipc";
import { LoggerLive, Notifier, RepoSettings, ReposLive } from "./services";
import {
  flushState,
  loadWindowState,
  placeWindow,
  repoSettings,
  saveWindowState,
  updateRepoSettings,
} from "./state";
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

/**
 * Window colors before the renderer paints, and of the title bar buttons: the app's theme once
 * the renderer set it (`app.setTheme`), the system's until then.
 */
const chrome = () =>
  nativeTheme.shouldUseDarkColors
    ? { background: "#0c0a09", symbols: "#a6a09b" }
    : { background: "#ffffff", symbols: "#57534d" };

const titleBarOverlay = () => ({ color: "#00000000", symbolColor: chrome().symbols, height: 40 });

/** Releases what a crashed renderer used, see `registerIpc`. */
let releaseRenderer: ((sender: Electron.WebContents) => Promise<void>) | null = null;
/** A window whose renderer crashed more than this often in this long is not reloaded. */
const MAX_CRASHES = 3;
const CRASH_WINDOW_MS = 60_000;

const DEFAULT_SIZE = { width: 1440, height: 900 };
const MIN_SIZE = { width: 900, height: 560 };

/** Saves where the window is, to open the next one there (see `createWindow`). */
const trackWindowState = (win: BrowserWindow) => {
  const save = () => {
    // A minimized window keeps the state it had before.
    if (win.isDestroyed() || win.isMinimized()) return;
    saveWindowState({
      bounds: win.getNormalBounds(),
      maximized: win.isMaximized(),
      fullScreen: win.isFullScreen(),
    });
  };
  win.on("resize", save);
  win.on("move", save);
  win.on("maximize", save);
  win.on("unmaximize", save);
  win.on("enter-full-screen", save);
  win.on("leave-full-screen", save);
  win.on("close", save);
};

const createWindow = () => {
  const saved = loadWindowState();
  const workAreas = [screen.getPrimaryDisplay(), ...screen.getAllDisplays()].map((d) => d.workArea);
  const win = new BrowserWindow({
    ...(saved.bounds ? placeWindow(saved.bounds, workAreas, MIN_SIZE) : DEFAULT_SIZE),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
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

  win.once("ready-to-show", () => {
    if (saved.maximized) win.maximize();
    win.show();
    if (saved.fullScreen) win.setFullScreen(true);
    trackWindowState(win);
  });
  // A crashed renderer: its repositories are released (its tabs open them again), then the
  // window loads again, unless it keeps crashing.
  const crashes: number[] = [];
  win.webContents.on("render-process-gone", (_e, details) => {
    log.error(`Renderer process gone: ${details.reason} (exit code ${details.exitCode})`);
    if (details.reason === "clean-exit" || win.isDestroyed()) return;
    const now = Date.now();
    crashes.push(now);
    while (crashes[0]! < now - CRASH_WINDOW_MS) crashes.shift();
    void (releaseRenderer?.(win.webContents) ?? Promise.resolve()).then(() => {
      if (win.isDestroyed()) return;
      if (crashes.length > MAX_CRASHES) log.error("The renderer keeps crashing: not reloading it");
      else win.webContents.reload();
    });
  });
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
  ({ releaseRenderer } = registerIpc(runtime));
  restrictPermissions();
  handleAvatarProtocol();
  buildMenu();
  createWindow();
  started = true;
  updater.init((s) => broadcast("updater.status", s));
  // Back from sleep or a locked screen: remote repositories may have changed meanwhile.
  powerMonitor.on("resume", activity.wake);
  powerMonitor.on("unlock-screen", activity.wake);
  // Housekeeping, once startup work has settled.
  setTimeout(() => void pruneAvatarCache(), 60_000).unref();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  // The system's theme changed, or the app's (`app.setTheme`).
  nativeTheme.on("updated", () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.setBackgroundColor(chrome().background);
      if (!isMac) win.setTitleBarOverlay(titleBarOverlay());
    }
  });
};

app.on("window-all-closed", () => {
  if (!isMac) app.quit();
});

/** Longest wait for cleanup on quit, e.g. for an unresponsive SSH host. */
const QUIT_TIMEOUT = 5000;
/**
 * Longest wait for Chromium to shut down after cleanup. It can wait forever for a helper
 * process that hangs (seen with the network service), and then ignores SIGTERM too.
 */
const EXIT_TIMEOUT = 3000;

let exiting = false;
const exit = () => {
  if (exiting) return;
  exiting = true;
  const helpers = app.getAppMetrics().flatMap((m) => (m.pid === process.pid ? [] : [m.pid]));
  killUnlessGone([process.pid, ...helpers], EXIT_TIMEOUT);
  app.exit(0);
};

let disposing = false;
app.on("will-quit", (e) => {
  if (disposing) return;
  disposing = true;
  e.preventDefault();
  updater.dispose();
  flushState();
  // The renderer's own layout (panel sizes, sections) lives in its local storage; the forced
  // exit below must not lose a pending write.
  session.defaultSession.flushStorageData();
  setTimeout(() => {
    log.warn("Cleanup on quit timed out");
    exit();
  }, QUIT_TIMEOUT).unref();
  // Close SSH masters and file watchers before exiting.
  void runtime
    .dispose()
    .catch((err: unknown) => log.error("dispose failed", err))
    .finally(exit);
});

void main();
