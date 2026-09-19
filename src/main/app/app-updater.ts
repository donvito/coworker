import type { AppUpdateStatus } from "@shared/contracts";

export interface UpdaterReleaseInfo {
  version: string;
  releaseNotes?: string | Array<{ version: string; note: string | null }> | null;
}

export interface UpdaterEvents {
  "checking-for-update": () => void;
  "update-available": (info: UpdaterReleaseInfo) => void;
  "update-not-available": (info: UpdaterReleaseInfo) => void;
  "download-progress": (progress: { percent: number }) => void;
  "update-downloaded": (info: UpdaterReleaseInfo) => void;
  error: (error: Error) => void;
}

/** The subset of electron-updater's `AppUpdater` the desktop app drives. */
export interface UpdaterClient {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: "checking-for-update", listener: UpdaterEvents["checking-for-update"]): unknown;
  on(event: "update-available", listener: UpdaterEvents["update-available"]): unknown;
  on(event: "update-not-available", listener: UpdaterEvents["update-not-available"]): unknown;
  on(event: "download-progress", listener: UpdaterEvents["download-progress"]): unknown;
  on(event: "update-downloaded", listener: UpdaterEvents["update-downloaded"]): unknown;
  on(event: "error", listener: UpdaterEvents["error"]): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface AppUpdaterLogger {
  info(category: string, message: string, details?: Record<string, string | number | boolean | null>): Promise<void>;
  error(category: string, error: unknown, details?: Record<string, string | number | boolean | null>): Promise<void>;
}

export interface AppUpdaterOptions {
  /** Null when the running build cannot update itself (development, unpackaged). */
  client: UpdaterClient | null;
  currentVersion: string;
  /** GitHub repository page, e.g. https://github.com/donvito/coworker. */
  repositoryUrl: string;
  /** False when the platform build cannot install updates in place (unsigned macOS builds). */
  canInstall: boolean;
  autoUpdateEnabled: () => boolean;
  onStatus: (status: AppUpdateStatus) => void;
  /** Runs before quitAndInstall so the host can mark itself as quitting. */
  beforeInstall?: () => void;
  logger?: AppUpdaterLogger;
  startupDelayMs?: number;
  checkIntervalMs?: number;
}

const DEFAULT_STARTUP_DELAY_MS = 20_000;
const DEFAULT_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

function releaseNotesText(notes: UpdaterReleaseInfo["releaseNotes"]): string | undefined {
  if (typeof notes === "string") return notes.trim() || undefined;
  if (Array.isArray(notes)) {
    const text = notes
      .map((entry) => (entry.note ? `${entry.version}\n${entry.note}` : entry.version))
      .join("\n\n")
      .trim();
    return text || undefined;
  }
  return undefined;
}

export class AppUpdater {
  private status: AppUpdateStatus;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private pendingCheck: Promise<AppUpdateStatus> | null = null;
  private pendingDownload: Promise<AppUpdateStatus> | null = null;
  private manualCheck = false;

  constructor(private readonly options: AppUpdaterOptions) {
    this.status = {
      state: options.client ? "idle" : "unsupported",
      currentVersion: options.currentVersion,
      canInstall: Boolean(options.client) && options.canInstall,
      releaseUrl: `${options.repositoryUrl}/releases/latest`,
    };
    const client = options.client;
    if (!client) return;
    client.autoDownload = false;
    client.autoInstallOnAppQuit = this.status.canInstall;
    client.on("checking-for-update", () => this.update({ state: "checking", error: undefined }));
    client.on("update-available", (info) => {
      this.update({
        state: "available",
        latestVersion: info.version,
        releaseUrl: this.releaseUrl(info.version),
        releaseNotes: releaseNotesText(info.releaseNotes),
        percent: undefined,
        checkedAt: new Date().toISOString(),
        error: undefined,
      });
      void this.options.logger?.info("app.updates", "Update available", { version: info.version });
      if (this.status.canInstall && !this.manualCheck && this.options.autoUpdateEnabled()) {
        void this.download().catch(() => undefined);
      }
    });
    client.on("update-not-available", (info) => {
      this.update({
        state: "up-to-date",
        latestVersion: info.version,
        releaseUrl: this.releaseUrl(info.version),
        checkedAt: new Date().toISOString(),
        error: undefined,
      });
    });
    client.on("download-progress", (progress) => {
      this.update({ state: "downloading", percent: Math.max(0, Math.min(100, Math.round(progress.percent))) });
    });
    client.on("update-downloaded", (info) => {
      this.update({
        state: "downloaded",
        latestVersion: info.version,
        releaseUrl: this.releaseUrl(info.version),
        releaseNotes: releaseNotesText(info.releaseNotes) ?? this.status.releaseNotes,
        percent: 100,
        error: undefined,
      });
      void this.options.logger?.info("app.updates", "Update downloaded", { version: info.version });
    });
    client.on("error", (error) => this.fail(error));
  }

  get supported(): boolean {
    return this.options.client !== null;
  }

  current(): AppUpdateStatus {
    return { ...this.status };
  }

  /** Schedules the startup check and periodic re-checks when automatic updates are enabled. */
  start(): void {
    this.stop();
    if (!this.supported || !this.options.autoUpdateEnabled()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.check({ manual: false }).catch(() => undefined);
      this.interval = setInterval(() => {
        void this.check({ manual: false }).catch(() => undefined);
      }, this.options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS);
    }, this.options.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
    this.timer = null;
    this.interval = null;
  }

  /** Re-reads the setting and starts or stops the schedule accordingly. */
  refreshSchedule(): void {
    if (this.options.autoUpdateEnabled()) {
      if (!this.timer && !this.interval) this.start();
    } else {
      this.stop();
    }
  }

  async check(input: { manual: boolean } = { manual: true }): Promise<AppUpdateStatus> {
    const client = this.options.client;
    if (!client) return this.current();
    if (this.pendingCheck) return this.pendingCheck;
    if (this.status.state === "downloading" || this.status.state === "downloaded") return this.current();
    this.manualCheck = input.manual;
    this.pendingCheck = (async () => {
      try {
        this.update({ state: "checking", error: undefined });
        await client.checkForUpdates();
        if (this.status.state === "checking") {
          this.update({ state: "up-to-date", checkedAt: new Date().toISOString() });
        }
      } catch (error) {
        this.fail(error);
      } finally {
        this.pendingCheck = null;
      }
      return this.current();
    })();
    return this.pendingCheck;
  }

  async download(): Promise<AppUpdateStatus> {
    const client = this.options.client;
    if (!client || !this.status.canInstall) return this.current();
    if (this.pendingDownload) return this.pendingDownload;
    if (this.status.state !== "available" && this.status.state !== "error") return this.current();
    this.pendingDownload = (async () => {
      try {
        this.update({ state: "downloading", percent: 0, error: undefined });
        await client.downloadUpdate();
        if (this.status.state === "downloading") this.update({ state: "downloaded", percent: 100 });
      } catch (error) {
        this.fail(error);
      } finally {
        this.pendingDownload = null;
      }
      return this.current();
    })();
    return this.pendingDownload;
  }

  install(): void {
    const client = this.options.client;
    if (!client || this.status.state !== "downloaded") {
      throw new Error("No downloaded update is ready to install");
    }
    this.stop();
    this.options.beforeInstall?.();
    client.quitAndInstall();
  }

  private releaseUrl(version: string): string {
    return `${this.options.repositoryUrl}/releases/tag/v${version.replace(/^v/, "")}`;
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    void this.options.logger?.error("app.updates", error);
    this.update({ state: "error", error: message, percent: undefined, checkedAt: new Date().toISOString() });
  }

  private update(patch: Partial<AppUpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    this.options.onStatus(this.current());
  }
}
