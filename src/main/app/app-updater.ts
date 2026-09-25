import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, chmod, constants, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type {
  AppUpdateCompletion,
  AppUpdateRelease,
  AppUpdateState,
} from "@shared/contracts";

export const latestReleaseUrl = "https://api.github.com/repos/donvito/coworker/releases/latest";
export const releasesPageUrl = "https://github.com/donvito/coworker/releases/latest";

export interface ReleaseAsset {
  name: string;
  size: number;
  url: string;
  digest: string | null;
}

export interface LatestRelease extends AppUpdateRelease {
  asset: ReleaseAsset | null;
}

export type InstallTarget =
  | { kind: "mac-bundle"; bundlePath: string }
  | { kind: "windows-nsis"; executablePath: string }
  | { kind: "linux-appimage"; appImagePath: string }
  | { kind: "unsupported"; reason: string };

export interface InstallerPlan {
  target: Exclude<InstallTarget, { kind: "unsupported" }>;
  /** Verified installer, AppImage, or extracted app bundle. */
  payloadPath: string;
  parentPid: number;
  relaunchArguments: string[];
  workPath: string;
}

interface PendingUpdate {
  fromVersion: string;
  toVersion: string;
  backupPath: string;
  startedAt: string;
}

export interface AppUpdaterOptions {
  currentVersion: string;
  updatesPath: string;
  target: InstallTarget;
  platform: NodeJS.Platform;
  arch: string;
  releaseUrl?: string;
  fetchImpl?: typeof fetch;
  extractZip?: (archivePath: string, destinationPath: string) => Promise<void>;
  /** Stops background work and writes a verified database backup. */
  prepareForInstall: (input: { fromVersion: string; toVersion: string }) => Promise<{ backupPath: string }>;
  cancelInstallPreparation: () => Promise<void>;
  launchInstaller?: (plan: InstallerPlan) => Promise<void>;
  quit: () => void;
  relaunchArguments?: () => string[];
  onStateChanged?: (state: AppUpdateState) => void;
  onError?: (scope: string, error: unknown) => void;
}

type ParsedVersion = { core: [number, number, number]; prerelease: string[] };

export function parseVersion(value: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

/** Semantic version ordering; unparseable versions sort before everything. */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  for (let index = 0; index < 3; index += 1) {
    const difference = a.core[index]! - b.core[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric && Number(x) !== Number(y)) return Math.sign(Number(x) - Number(y));
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const archAliases: Record<string, string[]> = {
  x64: ["x64", "x86_64", "amd64"],
  arm64: ["arm64", "aarch64"],
};

export function selectReleaseAsset(
  assets: ReleaseAsset[],
  target: InstallTarget,
  arch: string,
): ReleaseAsset | null {
  const aliases = archAliases[arch] ?? [arch];
  const matching = (pattern: (alias: string) => RegExp) =>
    assets.find((asset) => aliases.some((alias) => pattern(alias).test(asset.name))) ?? null;
  switch (target.kind) {
    case "mac-bundle":
      return matching((alias) => new RegExp(`-mac-${alias}\\.zip$`, "i"));
    case "windows-nsis":
      return (
        matching((alias) => new RegExp(`-win-${alias}-setup\\.exe$`, "i")) ??
        assets.find((asset) => /-win-setup\.exe$/i.test(asset.name)) ??
        null
      );
    case "linux-appimage":
      return matching((alias) => new RegExp(`-linux-${alias}\\.AppImage$`, "i"));
    case "unsupported":
      return null;
  }
}

/** Where the running app is installed and whether it can replace itself. */
export function resolveInstallTarget(input: {
  packaged: boolean;
  platform: NodeJS.Platform;
  executablePath: string;
  appImagePath?: string;
}): InstallTarget {
  if (!input.packaged) {
    return { kind: "unsupported", reason: "Updates can only be installed from a packaged Coworker build." };
  }
  if (input.platform === "darwin") {
    const marker = input.executablePath.indexOf(".app/");
    if (marker < 0) return { kind: "unsupported", reason: "Coworker could not locate its application bundle." };
    const bundlePath = input.executablePath.slice(0, marker + 4);
    if (bundlePath.includes("/AppTranslocation/") || bundlePath.startsWith("/Volumes/")) {
      return {
        kind: "unsupported",
        reason: "Move Coworker to your Applications folder and reopen it to install updates.",
      };
    }
    return { kind: "mac-bundle", bundlePath };
  }
  if (input.platform === "win32") return { kind: "windows-nsis", executablePath: input.executablePath };
  if (input.platform === "linux" && input.appImagePath) {
    return { kind: "linux-appimage", appImagePath: input.appImagePath };
  }
  return {
    kind: "unsupported",
    reason: "This installation is managed by your package manager. Download the new package to update.",
  };
}

function releaseFromJson(value: unknown, target: InstallTarget, arch: string): LatestRelease | null {
  if (!value || typeof value !== "object") throw new Error("The release feed returned an invalid response");
  const record = value as Record<string, unknown>;
  if (record.draft === true || record.prerelease === true) return null;
  const tag = typeof record.tag_name === "string" ? record.tag_name : "";
  const parsed = parseVersion(tag);
  if (!parsed) throw new Error(`The latest release has an invalid version: ${tag || "missing"}`);
  const version = tag.replace(/^v/, "");
  const assets: ReleaseAsset[] = Array.isArray(record.assets)
    ? record.assets.flatMap((entry): ReleaseAsset[] => {
        if (!entry || typeof entry !== "object") return [];
        const asset = entry as Record<string, unknown>;
        if (typeof asset.name !== "string" || typeof asset.browser_download_url !== "string") return [];
        return [{
          name: asset.name,
          size: typeof asset.size === "number" ? asset.size : 0,
          url: asset.browser_download_url,
          digest: typeof asset.digest === "string" ? asset.digest : null,
        }];
      })
    : [];
  const asset = selectReleaseAsset(assets, target, arch);
  return {
    version,
    name: typeof record.name === "string" && record.name.trim() ? record.name : `Coworker ${tag}`,
    notes: typeof record.body === "string" ? record.body.slice(0, 20_000) : "",
    publishedAt: typeof record.published_at === "string" ? record.published_at : null,
    url: typeof record.html_url === "string" && record.html_url.startsWith("https://")
      ? record.html_url
      : releasesPageUrl,
    assetName: asset?.name ?? null,
    assetSize: asset?.size ?? null,
    asset,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function defaultExtractZip(archivePath: string, destinationPath: string): Promise<void> {
  // ditto preserves the bundle's symlinks, permissions, and code signature.
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/ditto", ["-x", "-k", archivePath, destinationPath], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Could not extract the update (ditto exited with ${code})`)),
    );
  });
}

const posixWaitScript = `#!/bin/sh
set -u
exec >>"$COWORKER_UPDATE_LOG" 2>&1
echo "$(date) waiting for Coworker ($COWORKER_PARENT_PID) to exit"
attempts=0
while kill -0 "$COWORKER_PARENT_PID" 2>/dev/null; do
  attempts=$((attempts + 1))
  if [ "$attempts" -gt 1200 ]; then
    echo "Coworker did not exit; the update was not installed"
    exit 1
  fi
  sleep 0.25
done
`;

const macInstallScript = `${posixWaitScript}
target="$COWORKER_UPDATE_TARGET"
previous="$target.previous-update"
rm -rf "$previous"
if mv "$target" "$previous"; then
  if /usr/bin/ditto "$COWORKER_UPDATE_SOURCE" "$target"; then
    rm -rf "$previous"
    echo "installed update"
  else
    echo "copy failed; restoring the previous version"
    rm -rf "$target"
    mv "$previous" "$target"
  fi
else
  echo "could not move the current version aside; the update was not installed"
fi
/usr/bin/xattr -dr com.apple.quarantine "$target" 2>/dev/null || true
/usr/bin/open -n "$target" --args "$@"
`;

const appImageInstallScript = `${posixWaitScript}
target="$COWORKER_UPDATE_TARGET"
if cp "$COWORKER_UPDATE_SOURCE" "$target.update" && chmod 755 "$target.update" && mv -f "$target.update" "$target"; then
  echo "installed update"
else
  echo "replace failed; the previous version was kept"
  rm -f "$target.update"
fi
nohup "$target" "$@" >/dev/null 2>&1 &
`;

const windowsInstallScript = `$ErrorActionPreference = 'Continue'
Start-Transcript -Path $env:COWORKER_UPDATE_LOG -Append | Out-Null
$parent = [int]$env:COWORKER_PARENT_PID
Wait-Process -Id $parent -Timeout 300 -ErrorAction SilentlyContinue
if (Get-Process -Id $parent -ErrorAction SilentlyContinue) {
  Write-Output 'Coworker did not exit; the update was not installed'
  exit 1
}
$installDirectory = Split-Path -Parent $env:COWORKER_UPDATE_TARGET
$installer = Start-Process -FilePath $env:COWORKER_UPDATE_SOURCE -ArgumentList @('/S', '--updated', "/D=$installDirectory") -Wait -PassThru
Write-Output "installer exited with $($installer.ExitCode)"
$relaunch = @(ConvertFrom-Json $env:COWORKER_RELAUNCH_ARGS) | ForEach-Object { '"' + ($_ -replace '"', '\\"') + '"' }
if ($relaunch.Count -gt 0) {
  Start-Process -FilePath $env:COWORKER_UPDATE_TARGET -ArgumentList $relaunch
} else {
  Start-Process -FilePath $env:COWORKER_UPDATE_TARGET
}
`;

/** Runs a detached helper that swaps in the update after this process exits, then relaunches. */
export async function launchDetachedInstaller(plan: InstallerPlan): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    COWORKER_PARENT_PID: String(plan.parentPid),
    COWORKER_UPDATE_SOURCE: plan.payloadPath,
    COWORKER_UPDATE_LOG: join(plan.workPath, "install.log"),
    COWORKER_RELAUNCH_ARGS: JSON.stringify(plan.relaunchArguments),
  };
  let command: string;
  let args: string[];
  if (plan.target.kind === "windows-nsis") {
    env.COWORKER_UPDATE_TARGET = plan.target.executablePath;
    const script = join(plan.workPath, "install-update.ps1");
    await writeFile(script, windowsInstallScript, "utf8");
    command = "powershell.exe";
    args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script];
  } else {
    const mac = plan.target.kind === "mac-bundle";
    env.COWORKER_UPDATE_TARGET = mac
      ? (plan.target as { bundlePath: string }).bundlePath
      : (plan.target as { appImagePath: string }).appImagePath;
    const script = join(plan.workPath, "install-update.sh");
    await writeFile(script, mac ? macInstallScript : appImageInstallScript, { encoding: "utf8", mode: 0o700 });
    command = "/bin/sh";
    args = [script, ...plan.relaunchArguments];
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", env, windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export class AppUpdater {
  private state: AppUpdateState;
  private release: LatestRelease | null = null;
  private payload: { version: string; path: string; workPath: string } | null = null;
  private checking: Promise<AppUpdateState> | null = null;
  private downloading: Promise<AppUpdateState> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private lastProgressEmit = 0;

  constructor(private readonly options: AppUpdaterOptions) {
    const unsupported = options.target.kind === "unsupported" ? options.target.reason : null;
    this.state = {
      status: "idle",
      currentVersion: options.currentVersion,
      release: null,
      checkedAt: null,
      progress: null,
      error: null,
      canInstall: unsupported === null,
      installUnsupportedReason: unsupported,
      lastUpdate: null,
    };
  }

  getState(): AppUpdateState {
    return structuredClone(this.state);
  }

  private get pendingPath(): string {
    return join(this.options.updatesPath, "pending.json");
  }

  private setState(patch: Partial<AppUpdateState>): AppUpdateState {
    this.state = { ...this.state, ...patch };
    const snapshot = this.getState();
    this.options.onStateChanged?.(snapshot);
    return snapshot;
  }

  /**
   * Reconciles an update started by a previous run. Returns the completed
   * update so the caller can record it once.
   */
  async finalizePendingUpdate(): Promise<AppUpdateCompletion | null> {
    let pending: PendingUpdate | null = null;
    try {
      pending = JSON.parse(await readFile(this.pendingPath, "utf8")) as PendingUpdate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.options.onError?.("updates.finalize", error);
    }
    await this.removeStaleDownloads();
    if (!pending) return null;
    await rm(this.pendingPath, { force: true });
    if (compareVersions(this.options.currentVersion, pending.toVersion) >= 0) {
      const completion: AppUpdateCompletion = {
        fromVersion: pending.fromVersion,
        toVersion: pending.toVersion,
        backupPath: pending.backupPath,
        completedAt: new Date().toISOString(),
      };
      this.setState({ lastUpdate: completion });
      return completion;
    }
    this.setState({
      status: "error",
      error:
        `The update to ${pending.toVersion} did not finish installing, so Coworker is still on ` +
        `${this.options.currentVersion}. Your data was not changed. A backup was saved to ${pending.backupPath}.`,
    });
    return null;
  }

  private async removeStaleDownloads(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.options.updatesPath);
    } catch {
      return;
    }
    await Promise.all(
      entries
        .filter((entry) => parseVersion(entry) && compareVersions(entry, this.options.currentVersion) <= 0)
        .map((entry) => rm(join(this.options.updatesPath, entry), { recursive: true, force: true })),
    );
  }

  /** Periodically looks for new releases. Never downloads or installs on its own. */
  startAutomaticChecks(intervalMs = 6 * 60 * 60 * 1000, initialDelayMs = 15_000): void {
    this.stopAutomaticChecks();
    const run = () => {
      if (["idle", "up-to-date", "error"].includes(this.state.status)) void this.check();
    };
    this.startupTimer = setTimeout(run, initialDelayMs);
    this.timer = setInterval(run, intervalMs);
    this.startupTimer.unref?.();
    this.timer.unref?.();
  }

  ensureAutomaticChecks(): void {
    if (!this.timer && this.state.status !== "installing") this.startAutomaticChecks();
  }

  stopAutomaticChecks(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.timer) clearInterval(this.timer);
    this.startupTimer = null;
    this.timer = null;
  }

  check(): Promise<AppUpdateState> {
    if (this.checking) return this.checking;
    if (["downloading", "installing"].includes(this.state.status)) return Promise.resolve(this.getState());
    this.checking = this.runCheck().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async runCheck(): Promise<AppUpdateState> {
    const previousStatus = this.state.status;
    this.setState({ status: "checking", error: null });
    try {
      const response = await (this.options.fetchImpl ?? fetch)(this.options.releaseUrl ?? latestReleaseUrl, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "Coworker-Desktop" },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 404) {
        this.release = null;
        return this.setState({ status: "up-to-date", release: null, checkedAt: new Date().toISOString() });
      }
      if (!response.ok) throw new Error(`The release feed returned HTTP ${response.status}`);
      const release = releaseFromJson(await response.json(), this.options.target, this.options.arch);
      const checkedAt = new Date().toISOString();
      if (!release || compareVersions(release.version, this.options.currentVersion) <= 0) {
        this.release = null;
        return this.setState({ status: "up-to-date", release: null, checkedAt });
      }
      const { asset: _asset, ...publicRelease } = release;
      const alreadyDownloaded = previousStatus === "ready" && this.payload?.version === release.version;
      this.release = release;
      return this.setState({
        status: alreadyDownloaded ? "ready" : "available",
        release: publicRelease,
        checkedAt,
        progress: null,
      });
    } catch (error) {
      this.options.onError?.("updates.check", error);
      const readyPayload = previousStatus === "ready" && this.payload;
      return this.setState({
        status: readyPayload ? "ready" : "error",
        error: `Could not check for updates: ${errorMessage(error)}`,
      });
    }
  }

  download(): Promise<AppUpdateState> {
    if (this.downloading) return this.downloading;
    this.downloading = this.runDownload().finally(() => {
      this.downloading = null;
    });
    return this.downloading;
  }

  private async runDownload(): Promise<AppUpdateState> {
    const release = this.release;
    if (this.state.status === "ready" && this.payload) return this.getState();
    if (!release || this.state.status !== "available") {
      throw new Error("Check for updates before downloading");
    }
    if (this.options.target.kind === "unsupported") throw new Error(this.options.target.reason);
    const asset = release.asset;
    if (!asset) throw new Error(`Release ${release.version} does not include a download for this computer`);
    if (!asset.url.startsWith("https://")) throw new Error("Updates must be downloaded over HTTPS");
    const workPath = join(this.options.updatesPath, release.version);
    this.setState({ status: "downloading", error: null, progress: { receivedBytes: 0, totalBytes: asset.size || null } });
    try {
      await rm(workPath, { recursive: true, force: true });
      await mkdir(workPath, { recursive: true });
      const finalPath = join(workPath, basename(asset.name));
      const partialPath = `${finalPath}.partial`;
      const response = await (this.options.fetchImpl ?? fetch)(asset.url, {
        headers: { Accept: "application/octet-stream", "User-Agent": "Coworker-Desktop" },
      });
      if (!response.ok || !response.body) throw new Error(`The download failed with HTTP ${response.status}`);
      const hash = createHash("sha256");
      let receivedBytes = 0;
      const totalBytes = asset.size || Number(response.headers.get("content-length")) || null;
      const meter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          hash.update(chunk);
          receivedBytes += chunk.length;
          const nowMs = Date.now();
          if (nowMs - this.lastProgressEmit > 250) {
            this.lastProgressEmit = nowMs;
            this.setState({ progress: { receivedBytes, totalBytes } });
          }
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
        meter,
        createWriteStream(partialPath, { mode: 0o600 }),
      );
      if (asset.size && receivedBytes !== asset.size) {
        throw new Error(`The download was incomplete (${receivedBytes} of ${asset.size} bytes)`);
      }
      const expected = asset.digest?.startsWith("sha256:") ? asset.digest.slice(7).toLowerCase() : null;
      if (expected && hash.digest("hex") !== expected) {
        throw new Error("The downloaded update failed its integrity check");
      }
      await rename(partialPath, finalPath);
      let payloadPath = finalPath;
      if (this.options.target.kind === "mac-bundle") {
        const extractedPath = join(workPath, "extracted");
        await (this.options.extractZip ?? defaultExtractZip)(finalPath, extractedPath);
        const bundle = (await readdir(extractedPath)).find((entry) => entry.endsWith(".app"));
        if (!bundle) throw new Error("The downloaded update does not contain an application");
        payloadPath = join(extractedPath, bundle);
        await rm(finalPath, { force: true });
      } else if (this.options.target.kind === "linux-appimage") {
        await chmod(finalPath, 0o755);
      }
      if (!(await stat(payloadPath).catch(() => null))) throw new Error("The downloaded update is missing");
      this.payload = { version: release.version, path: payloadPath, workPath };
      return this.setState({ status: "ready", progress: { receivedBytes, totalBytes } });
    } catch (error) {
      this.options.onError?.("updates.download", error);
      this.payload = null;
      await rm(workPath, { recursive: true, force: true }).catch(() => undefined);
      return this.setState({ status: "available", progress: null, error: `Could not download the update: ${errorMessage(error)}` });
    }
  }

  /**
   * Backs up and verifies the database, then hands off to the installer and
   * quits. Migrations run on the next launch, after another pre-migration backup.
   */
  async install(): Promise<AppUpdateState> {
    const release = this.release;
    const payload = this.payload;
    if (this.state.status !== "ready" || !release || !payload || payload.version !== release.version) {
      throw new Error("Download the update before installing it");
    }
    const target = this.options.target;
    if (target.kind === "unsupported") throw new Error(target.reason);
    this.stopAutomaticChecks();
    this.setState({ status: "installing", error: null });
    let prepared = false;
    try {
      if (target.kind !== "windows-nsis") {
        const installed = target.kind === "mac-bundle" ? target.bundlePath : target.appImagePath;
        await access(dirname(installed), constants.W_OK).catch(() => {
          throw new Error(`Coworker cannot write to ${dirname(installed)}. Download the update and install it manually.`);
        });
      }
      const { backupPath } = await this.options.prepareForInstall({
        fromVersion: this.options.currentVersion,
        toVersion: release.version,
      });
      prepared = true;
      const pending: PendingUpdate = {
        fromVersion: this.options.currentVersion,
        toVersion: release.version,
        backupPath,
        startedAt: new Date().toISOString(),
      };
      await mkdir(dirname(this.pendingPath), { recursive: true });
      await writeFile(this.pendingPath, JSON.stringify(pending, null, 2), { mode: 0o600 });
      await (this.options.launchInstaller ?? launchDetachedInstaller)({
        target,
        payloadPath: payload.path,
        parentPid: process.pid,
        relaunchArguments: this.options.relaunchArguments?.() ?? [],
        workPath: payload.workPath,
      });
    } catch (error) {
      this.options.onError?.("updates.install", error);
      await rm(this.pendingPath, { force: true }).catch(() => undefined);
      if (prepared) await this.options.cancelInstallPreparation().catch((cancelError) =>
        this.options.onError?.("updates.install.cancel", cancelError));
      return this.setState({ status: "ready", error: `Could not install the update: ${errorMessage(error)}` });
    }
    const state = this.getState();
    this.options.quit();
    return state;
  }
}
