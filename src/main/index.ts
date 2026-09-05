import { createAdministration } from "@main/control/administration";
import { startControlServer, ControlError } from "@main/control/transport";
import { exportLogs, readLogs, logQuerySchema } from "@main/control/logs";
import { installCli } from "@main/control/launcher";
import { parseLaunchOptions } from "@shared/launch-options";
import { z } from "zod";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
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
import { prepareAppProfile, resolveAppProfile } from "@main/app/app-profile";
import { registerIpc } from "@main/ipc/register-ipc";
import { ApplicationLogger } from "@main/runtime/application-logger";
import { SecureCredentialStore } from "@main/security/credential-store";
import { ipcChannels } from "@shared/ipc";

function ignoreBrokenPipe(stream: NodeJS.WriteStream): void {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });
}

ignoreBrokenPipe(process.stdout);
ignoreBrokenPipe(process.stderr);

const launchOptions = parseLaunchOptions(process.argv);
let headless = launchOptions.headless;
const defaultUserDataPath = app.getPath("userData");
const appProfile = resolveAppProfile({
  override: launchOptions.dataPath ?? process.env.COWORKER_DATA_PATH,
  isPackaged: app.isPackaged,
  appDataPath: app.getPath("appData"),
  defaultUserDataPath: app.getPath("userData"),
});
prepareAppProfile(appProfile);
app.setPath("userData", appProfile.dataPath);
app.setPath("sessionData", appProfile.sessionPath);

const gotLock = !launchOptions.installCli && app.requestSingleInstanceLock();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let service: DesktopAppService | null = null;
let unregisterIpc: (() => void) | null = null;
let isQuitting = false;
let shutdownStarted = false;
let shutdownCompleted = false;
let runInBackground = true;
let applicationLogger: ApplicationLogger | null = null;
let control: Awaited<ReturnType<typeof startControlServer>> | null = null;
let ready = false;
let showWhenReady = false;
let shutdownFailed = false;
let startupPromise: Promise<void> | null = null;
const startedAt = new Date().toISOString();

function showDesktop(): void {
  if (isQuitting || shutdownStarted) return;
  if (!ready) { showWhenReady = true; return; }
  headless = false;
  if (process.platform === "darwin") void app.dock?.show();
  if (!mainWindow) mainWindow = createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (!tray) {
    tray = new Tray(trayImage());
    tray.setToolTip(appProfile.label === "Production" ? "Coworker" : `Coworker — ${appProfile.label}`);
    tray.on("click", () => {
      if (isQuitting || shutdownStarted) return;
      if (mainWindow?.isVisible()) mainWindow.hide(); else showDesktop();
    });
    rebuildTrayMenu();
  }
}


process.on("uncaughtExceptionMonitor", (error, origin) => {
  applicationLogger?.emergency("main.uncaught_exception", error, { origin });
});
process.on("unhandledRejection", (reason) => {
  applicationLogger?.emergency("main.unhandled_rejection", reason);
  throw reason instanceof Error ? reason : new Error(String(reason));
});

function createMainWindow(): BrowserWindow {
  const appTitle =
    appProfile.label === "Production" ? "Coworker" : `Coworker — ${appProfile.label}`;
  const window = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    title: appTitle,
    backgroundColor: "#f2efe8",
    icon: appIcon(),
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
  window.webContents.on("console-message", (details) => {
    if (details.level !== "error" && details.level !== "warning") return;
    const logDetails = {
      lineNumber: details.lineNumber,
      sourceId: details.sourceId,
    };
    if (details.level === "error") {
      void applicationLogger?.error(
        "renderer.console.error",
        new Error(details.message),
        logDetails,
      );
    } else {
      void applicationLogger?.warning(
        "renderer.console.warning",
        details.message,
        logDetails,
      );
    }
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    void applicationLogger?.error(
      "renderer.process_gone",
      new Error(`Renderer process exited: ${details.reason}`),
      { exitCode: details.exitCode, reason: details.reason },
    );
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    void applicationLogger?.error("renderer.load", new Error(errorDescription), {
      errorCode,
      url: validatedURL,
    });
  });
  window.on("unresponsive", () => {
    void applicationLogger?.warning("renderer.unresponsive", "The main window became unresponsive");
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

let cachedAppIcon: Electron.NativeImage | null | undefined;

function appIcon(): Electron.NativeImage | undefined {
  if (cachedAppIcon === undefined) {
    const image = nativeImage.createFromPath(
      fileURLToPath(new URL("../../build/icon.png", import.meta.url)),
    );
    cachedAppIcon = image.isEmpty() ? null : image;
  }
  return cachedAppIcon ?? undefined;
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
        label: "Open Coworker",
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
  if (isQuitting) return;
  if (headless && process.platform === "darwin") app.dock?.hide();
  const dataPath = appProfile.dataPath;
  applicationLogger = new ApplicationLogger(join(dataPath, "logs", "app.jsonl"));
  await applicationLogger.info("app.lifecycle", "Starting Coworker", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: `${process.platform} ${process.arch}`,
  });
  const credentials = new SecureCredentialStore(join(dataPath, "credentials"));
  service = new DesktopAppService({
    dataPath,
    appVersion: app.getVersion(),
    applicationLogger,
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
  if (isQuitting) return;
  unregisterIpc = registerIpc({
    service,
    credentials,
    getMainWindow: () => mainWindow,
    logger: applicationLogger,
  });
  if (process.platform === "darwin" && !app.isPackaged) {
    const icon = appIcon();
    if (icon) app.dock?.setIcon(icon);
  }
  const administration = createAdministration({ service, credentials });
  const activeService = service;
  const logger = applicationLogger;
  control = await startControlServer({
    dataPath,
    audit: (method, success) => logger.info("control.request", success ? "Command completed" : "Command failed", { method, success }),
    invoke: async (method, args) => {
      if (!ready || isQuitting) throw new ControlError("STOPPING", "Coworker is starting or shutting down");
      if (method === "status") return {
        running: true, ready, pid: process.pid, dataPath, profile: appProfile.label,
        launch: { executable: app.isPackaged && process.platform === "linux" && process.env.APPIMAGE ? process.env.APPIMAGE : process.execPath,
          appPath: app.getAppPath(), packaged: app.isPackaged },
        mode: headless ? "headless" : "desktop", version: app.getVersion(), startedAt,
        uptimeSeconds: Math.floor((Date.now() - Date.parse(startedAt)) / 1000),
        services: { scheduler: "running", workers: activeService.database.listCoworkers().map(({ id, runtimeStatus }) => ({ id, status: runtimeStatus })), telegram: activeService.telegramStatus() },
      };
      if (method === "stop") {
        // Reply before shutdown closes the transport. Close drains outstanding commands.
        setTimeout(() => { isQuitting = true; app.quit(); }, 100);
        return { stopping: true };
      }
      if (method === "show") {
        showDesktop();
        return { shown: true };
      }
      if (method === "logs.show") {
        await Promise.all([logger.flush(), activeService.providerErrors.flush()]);
        return readLogs(dataPath, logQuerySchema.parse(args[0] ?? {}));
      }
      if (method === "logs.export") {
        const value = z.object({ destination: z.string().min(1), overwrite: z.boolean().default(false) }).strict().parse(args[0]);
        return exportLogs(dataPath, value.destination, value.overwrite,
          { application: logger, provider: activeService.providerErrors }, { "App version": app.getVersion() });
      }
      return administration.invoke(method, args);
    },
  });
  if (isQuitting) return;
  ready = true;
  if (!headless || showWhenReady) showDesktop();
  else if (process.platform === "darwin") app.dock?.hide();
  service.subscribe((event) => {
    if (event.type === "entity.changed" && event.entity === "approvals") rebuildTrayMenu();
  });
  rebuildTrayMenu();
  powerMonitor.on("resume", () => {
    void service?.scheduler.wake();
    void service?.telegram.wake();
  });
}

if (launchOptions.installCli) {
  app.whenReady().then(async () => {
    const result = await installCli({
      executable: app.isPackaged && process.platform === "linux" && process.env.APPIMAGE
        ? process.env.APPIMAGE : process.execPath,
      entry: fileURLToPath(new URL("./cli/index.js", import.meta.url)),
      appPath: app.getAppPath(), packaged: app.isPackaged,
      directory: launchOptions.binDirectory,
      defaultUserDataPath, appDataPath: app.getPath("appData"),
    });
    console.log(`${result.path}\n${result.message}`);
    app.exit(0);
  }).catch((error) => { console.error(error.message); app.exit(1); });
} else if (!gotLock) {
  app.exit(2);
} else {
  app.whenReady().then(() => { startupPromise = start(); return startupPromise; }).catch(async (error) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    isQuitting = true;
    console.error("Failed to start Coworker", error);
    await applicationLogger?.error("app.startup", error);
    await control?.close().catch(() => {});
    await service?.shutdown().catch(() => {});
    await applicationLogger?.flush();
    app.exit(1);
  });
}

app.on("second-instance", (_event, argv) => {
  if (!argv.includes("--headless")) showDesktop();
});

app.on("activate", () => {
  if (!headless || ready) showDesktop();
});

process.on("SIGINT", () => { isQuitting = true; app.quit(); });
process.on("SIGTERM", () => { isQuitting = true; app.quit(); });

app.on("window-all-closed", () => {
  if (!headless && !isQuitting && !runInBackground) {
    isQuitting = true;
    app.quit();
  }
});

app.on("before-quit", (event) => {
  isQuitting = true;
  if (shutdownCompleted || !service) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  const window = mainWindow;
  mainWindow = null;
  if (window && !window.isDestroyed()) window.destroy();
  unregisterIpc?.();
  unregisterIpc = null;
  tray?.destroy();
  tray = null;
  void (async () => {
    await startupPromise?.catch(() => {});
    await control?.close();
    control = null;
    await service!.shutdown();
  })()
    .then(() => applicationLogger?.info("app.lifecycle", "Coworker shut down cleanly"))
    .catch(async (error) => {
      shutdownFailed = true;
      console.error("Failed to shut down Coworker cleanly", error);
      await applicationLogger?.error("app.shutdown", error);
    })
    .finally(async () => {
      await applicationLogger?.flush();
      try {
        await mkdir(join(appProfile.dataPath, ".control"), { recursive: true, mode: 0o700 });
        await writeFile(join(appProfile.dataPath, ".control", "last-exit.json"),
          JSON.stringify({ pid: process.pid, startedAt, success: !shutdownFailed }), { mode: 0o600 });
      } catch { shutdownFailed = true; }
      shutdownCompleted = true;
      if (shutdownFailed) app.exit(1); else app.quit();
    });
});
