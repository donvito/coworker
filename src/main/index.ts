import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  powerMonitor,
  shell,
  Tray,
} from "electron";
import { DesktopAppService } from "@main/app/app-service";
import { registerIpc } from "@main/ipc/register-ipc";
import { SecureCredentialStore } from "@main/security/credential-store";
import { ipcChannels } from "@shared/ipc";

function ignoreBrokenPipe(stream: NodeJS.WriteStream): void {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });
}

ignoreBrokenPipe(process.stdout);
ignoreBrokenPipe(process.stderr);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let service: DesktopAppService | null = null;
let unregisterIpc: (() => void) | null = null;
let isQuitting = false;
let shutdownStarted = false;
let runInBackground = true;

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    title: "AI Coworker",
    backgroundColor: "#f2efe8",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "mailto:") {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    const current = new URL(window.webContents.getURL());
    const requested = new URL(url);
    if (requested.origin !== current.origin) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  window.on("close", (event) => {
    if (!isQuitting && runInBackground) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(fileURLToPath(new URL("../renderer/index.html", import.meta.url)));
  }
  return window;
}

function trayImage() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
      <rect x="2" y="2" width="18" height="18" rx="6" fill="#1d4739"/>
      <path d="M7 14.5V8.8c0-1 .8-1.8 1.8-1.8h4.4c1 0 1.8.8 1.8 1.8v5.7" fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round"/>
      <circle cx="9" cy="10.5" r="1" fill="white"/><circle cx="13" cy="10.5" r="1" fill="white"/>
    </svg>`;
  const image = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
  );
  if (process.platform === "darwin") image.setTemplateImage(true);
  return image;
}

function rebuildTrayMenu(): void {
  if (isQuitting || shutdownStarted || !tray || !service) return;
  const pending = service.database.listApprovals("PENDING").length;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open AI Coworker",
        click: () => {
          if (!mainWindow) mainWindow = createMainWindow();
          mainWindow.show();
          mainWindow.focus();
        },
      },
      {
        label: pending > 0 ? `Approvals (${pending})` : "Approvals",
        enabled: pending > 0,
        click: () => {
          if (!mainWindow) mainWindow = createMainWindow();
          mainWindow.show();
          mainWindow.webContents.send(ipcChannels.event, {
            type: "navigation.requested",
            page: "approvals",
          });
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
}

async function start(): Promise<void> {
  const dataPath = process.env.AI_COWORKER_DATA_PATH || app.getPath("userData");
  const credentials = new SecureCredentialStore(join(dataPath, "credentials"));
  service = new DesktopAppService({
    dataPath,
    credentials,
    onSettingsChanged: async (settings) => {
      runInBackground = settings.runInBackground;
      if (
        app.isPackaged &&
        (process.platform === "darwin" || process.platform === "win32") &&
        app.getLoginItemSettings().openAtLogin !== settings.launchAtLogin
      ) {
        app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
      }
    },
  });
  await service.initialize();
  unregisterIpc = registerIpc({
    service,
    credentials,
    getMainWindow: () => mainWindow,
  });
  mainWindow = createMainWindow();
  tray = new Tray(trayImage());
  tray.setToolTip("AI Coworker");
  tray.on("click", () => {
    if (isQuitting || shutdownStarted) return;
    if (!mainWindow) mainWindow = createMainWindow();
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });
  service.subscribe((event) => {
    if (event.type === "entity.changed" && event.entity === "approvals") rebuildTrayMenu();
  });
  rebuildTrayMenu();
  powerMonitor.on("resume", () => {
    void service?.scheduler.wake();
  });
}

app.whenReady().then(start).catch((error) => {
  console.error("Failed to start AI Coworker", error);
  app.exit(1);
});

app.on("second-instance", () => {
  if (isQuitting || shutdownStarted) return;
  if (!mainWindow) mainWindow = createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.on("activate", () => {
  if (isQuitting || shutdownStarted) return;
  if (!mainWindow) mainWindow = createMainWindow();
  mainWindow.show();
});

app.on("window-all-closed", () => {
  if (!isQuitting && !runInBackground) {
    isQuitting = true;
    app.quit();
  }
});

app.on("before-quit", (event) => {
  isQuitting = true;
  if (shutdownStarted || !service) return;
  event.preventDefault();
  shutdownStarted = true;
  const window = mainWindow;
  mainWindow = null;
  if (window && !window.isDestroyed()) window.destroy();
  unregisterIpc?.();
  unregisterIpc = null;
  tray?.destroy();
  tray = null;
  void service
    .shutdown()
    .catch((error) => console.error("Failed to shut down AI Coworker cleanly", error))
    .finally(() => app.quit());
});
