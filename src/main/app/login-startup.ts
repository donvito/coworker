import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import type { StartupMode, StartupStatus } from "@shared/startup";

const absolutePath = z.string().min(1).max(4096).refine((path) => isAbsolute(path) && !path.includes("\0"), "Expected an absolute path");
const startupConfigurationSchema = z.object({
  version: z.literal(1),
  dataPath: absolutePath,
  executable: absolutePath,
  mode: z.enum(["headless", "desktop"]),
}).strict();
type StartupConfiguration = z.infer<typeof startupConfigurationSchema>;

// Read during login redirection on macOS: main-app login items have no argv.
// The file contains only launch preferences; it never supplies executable code.
export function readStartupConfiguration(path: string): StartupConfiguration | null {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > 16_384 || (process.getuid && info.uid !== process.getuid())) {
      throw new Error("Startup configuration must be a regular file owned by the current user");
    }
    return startupConfigurationSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Cannot read startup configuration at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface LoginItems {
  get(options?: { path?: string; args?: string[] }): {
    openAtLogin: boolean;
    status?: "not-registered" | "enabled" | "requires-approval" | "not-found";
    launchItems?: Array<{ path: string; args: string[]; scope: string; enabled: boolean }>;
  };
  set(settings: { openAtLogin: boolean; path?: string; args?: string[]; enabled?: boolean }): void;
}

export interface LoginStartupOptions {
  platform: NodeJS.Platform;
  packaged: boolean;
  executable: string;
  dataPath: string;
  defaultDataPath: string;
  configurationPath: string;
  loginItems: LoginItems;
}

function windowsArgument(value: string): string {
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

export class LoginStartup {
  readonly supported: boolean;
  constructor(private readonly options: LoginStartupOptions) {
    this.supported = options.packaged && ["darwin", "win32"].includes(options.platform);
  }

  private nativeOptions(configuration: StartupConfiguration | null) {
    if (this.options.platform !== "win32") return {};
    return {
      path: configuration?.executable ?? this.options.executable,
      args: configuration ? this.arguments(configuration).map(windowsArgument) : [],
    };
  }

  private arguments(configuration: StartupConfiguration): string[] {
    return ["--data-path", configuration.dataPath, ...(configuration.mode === "headless" ? ["--headless"] : [])];
  }

  status(): StartupStatus {
    if (!this.supported) return {
      supported: false, scope: "user-login", registered: false, enabled: false, state: "unsupported",
      mode: "headless", dataPath: this.options.dataPath, selectedProfile: true, executable: this.options.executable,
      message: "Automatic startup requires an installed Coworker app on macOS or Windows. Development checkouts and Linux are not supported yet.",
    };
    const configuration = readStartupConfiguration(this.options.configurationPath);
    const nativeOptions = this.nativeOptions(configuration);
    const native = this.options.loginItems.get(nativeOptions);
    const registered = native.openAtLogin || native.status === "requires-approval";
    const dataPath = configuration?.dataPath ?? (registered ? this.options.defaultDataPath : this.options.dataPath);
    let enabled = native.openAtLogin;
    if (this.options.platform === "win32" && native.launchItems) {
      const rawArgs = configuration ? this.arguments(configuration) : [];
      enabled = native.openAtLogin && native.launchItems.some((item) => item.scope === "user" && item.enabled &&
        item.path.toLowerCase() === nativeOptions.path?.toLowerCase() &&
        [rawArgs.join("\0"), nativeOptions.args?.join("\0")].includes(item.args.join("\0")));
    }
    const state = native.status === "requires-approval" || native.status === "not-found"
      ? native.status : enabled ? "enabled" : "disabled";
    return {
      supported: true, scope: "user-login", registered, enabled: state === "enabled", state,
      mode: configuration?.mode ?? "desktop", dataPath, selectedProfile: dataPath === this.options.dataPath,
      executable: configuration?.executable ?? this.options.executable,
      ...(state === "not-found" ? { message: "The OS cannot find Coworker's login item. Reinstall the app and enable startup again." }
        : state === "requires-approval" ? { message: "Allow Coworker in macOS System Settings → General → Login Items & Extensions." }
        : registered && !enabled ? { message: "Coworker's startup entry is disabled in your OS settings. Enable it in Startup Apps/Login Items." } : {}),
    };
  }

  async enable(mode?: StartupMode): Promise<StartupStatus> {
    return this.change(async () => {
      const current = this.status();
      this.assertSelected(current);
      const previous = readStartupConfiguration(this.options.configurationPath);
      const configuration = startupConfigurationSchema.parse({
        version: 1, dataPath: this.options.dataPath, executable: this.options.executable,
        mode: mode ?? (previous?.dataPath === this.options.dataPath ? previous.mode : "desktop"),
      });
      await this.write(configuration);
      try {
        this.options.loginItems.set({ openAtLogin: true, enabled: true, ...this.nativeOptions(configuration) });
        const result = this.status();
        if (!result.registered) throw new Error("The OS did not register Coworker for startup. Check Login Items/Startup Apps settings.");
        return result;
      } catch (error) {
        // Restore launch preferences if OS registration fails; never leave a new
        // profile selected behind an old registration.
        try {
          if (previous) await this.write(previous);
          else await rm(this.options.configurationPath, { force: true });
          this.options.loginItems.set({ openAtLogin: current.registered, enabled: current.enabled, ...this.nativeOptions(previous) });
        } catch (rollbackError) {
          throw new Error(`${error instanceof Error ? error.message : String(error)}. Restoring previous startup settings also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}. Check startup status before retrying.`);
        }
        throw error;
      }
    });
  }

  async disable(): Promise<StartupStatus> {
    return this.change(async () => {
      const current = this.status();
      this.assertSelected(current);
      const configuration = readStartupConfiguration(this.options.configurationPath);
      this.options.loginItems.set({ openAtLogin: false, ...this.nativeOptions(configuration) });
      const result = this.status();
      if (result.registered) throw new Error("The OS did not remove Coworker's startup entry. Check Login Items/Startup Apps settings.");
      return result;
    });
  }

  private assertSelected(status: StartupStatus): void {
    if (status.registered && !status.selectedProfile) {
      throw new Error(`Startup is registered for ${status.dataPath}. Disable startup for that profile before selecting another one.`);
    }
  }

  private async write(configuration: StartupConfiguration): Promise<void> {
    const path = this.options.configurationPath;
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(configuration), { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }

  private async change<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.supported) throw new Error(this.status().message);
    await mkdir(dirname(this.options.configurationPath), { recursive: true, mode: 0o700 });
    // Profiles own different app processes, but share one OS login registration.
    const lock = `${this.options.configurationPath}.lock`;
    try { await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new Error(`Another startup change holds ${lock}. Retry after it finishes; if Coworker crashed, remove this lock after closing all Coworker instances.`);
    }
    try { return await operation(); }
    finally { await rm(lock, { force: true }); }
  }
}
