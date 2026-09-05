import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { ControlError, requestControl } from "@main/control/transport";

export interface LaunchConfiguration {
  executable: string;
  appPath: string;
  packaged: boolean;
  defaultUserDataPath: string;
  appDataPath: string;
}
export interface AppStatus {
  running: true; ready: boolean; pid: number; startedAt: string;
  mode: "headless" | "desktop"; dataPath: string;
  launch: Pick<LaunchConfiguration, "executable" | "appPath" | "packaged">;
  [key: string]: unknown;
}
export async function status(dataPath: string): Promise<AppStatus | null> {
  try { return await requestControl<AppStatus>(dataPath, "status", [], { timeoutMs: 2_000 }); }
  catch (error) { if (error instanceof ControlError && error.code === "NOT_RUNNING") return null; throw error; }
}

export async function stop(dataPath: string): Promise<{ stopped: true }> {
  const current = await status(dataPath);
  if (!current) return { stopped: true };
  await requestControl(dataPath, "stop");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    let alive = true;
    try { process.kill(current.pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; else throw error; }
    if (!alive) {
      const receipt = JSON.parse(await readFile(join(dataPath, ".control", "last-exit.json"), "utf8").catch(() => "null"));
      if (receipt?.pid !== current.pid || receipt?.startedAt !== current.startedAt || receipt?.success !== true) {
        throw new ControlError("SHUTDOWN_FAILED", "Coworker exited without a clean shutdown. Check logs before starting it again.");
      }
      return { stopped: true };
    }
    await setTimeout(100);
  }
  throw new ControlError("TIMEOUT", "Coworker did not stop within 30 seconds. It has not been force-killed; inspect logs and status.");
}

export async function launch(config: LaunchConfiguration, dataPath: string, options: {
  foreground?: boolean; mode?: "headless" | "desktop"; showExisting?: boolean;
} = {}): Promise<AppStatus | { exitCode: number }> {
  const existing = await status(dataPath);
  if (existing) {
    if (options.foreground) throw new ControlError("ALREADY_RUNNING", "This profile is already running. Use coworker status or stop first.");
    if (!options.showExisting) return existing;
    // A normal second launch reveals the owner, including versions predating the show RPC.
    if (!existing.launch?.executable || !existing.launch.appPath || typeof existing.launch.packaged !== "boolean") {
      throw new ControlError("VERSION", "The running app cannot report its launch identity. Open the desktop app normally.");
    }
    config = { ...config, ...existing.launch };
    options = { ...options, mode: "desktop" };
  }
  const env: NodeJS.ProcessEnv = { ...process.env, COWORKER_DATA_PATH: dataPath };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  delete env.COWORKER_LAUNCH_CONFIG;
  const args = [
    ...(config.packaged ? [] : [config.appPath]),
    "--data-path", dataPath,
    ...(options.mode === "desktop" ? [] : ["--headless"]),
  ];
  const child = spawn(config.executable, args, {
    env, cwd: config.packaged ? undefined : config.appPath,
    detached: !options.foreground,
    stdio: options.foreground ? ["ignore", process.stderr, process.stderr] : "ignore",
  });
  let exitCode: number | null | undefined;
  let failure: Error | undefined;
  const exited = new Promise<number>((done) => {
    child.once("error", (error) => { failure = error; done(1); });
    child.once("exit", (code) => { exitCode = code; done(code ?? 1); });
  });
  let interrupted = false;
  const onInterrupt = () => { interrupted = true; child.kill("SIGINT"); };
  const onTerminate = () => { interrupted = true; child.kill("SIGTERM"); };
  if (options.foreground) {
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
  } else child.unref();
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      if (interrupted) return { exitCode: await exited };
      if (exitCode !== undefined && exitCode !== 2) throw new Error(`Coworker exited during startup (${exitCode}). Inspect coworker logs show.`);
      const current = await status(dataPath);
      if (current?.ready && (!options.showExisting || (current.mode === "desktop" && (!existing || exitCode === 2)))) {
        if (options.foreground) {
          if (current.pid !== child.pid) throw new ControlError("ALREADY_RUNNING", "Another process started this profile first");
          return { exitCode: await exited };
        }
        return current;
      }
      await setTimeout(100);
    }
    throw new ControlError("TIMEOUT", "Coworker did not become ready within 30 seconds. Check status and logs; the process was not killed.");
  } finally {
    const removeSignals = () => {
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onTerminate);
    };
    if (options.foreground && exitCode === undefined && !failure) {
      // Even after a readiness timeout, keep Ctrl-C connected to the foreground child.
      void exited.finally(removeSignals);
    } else removeSignals();
  }
}

export async function restart(config: LaunchConfiguration, dataPath: string) {
  const current = await status(dataPath);
  if (!current) throw new ControlError("NOT_RUNNING", "Coworker is stopped. Run coworker start first.");
  if (!current.launch?.executable || !current.launch.appPath || typeof current.launch.packaged !== "boolean") {
    throw new ControlError("VERSION", "The running app cannot preserve its launch identity. Update it before using restart.");
  }
  await stop(dataPath);
  return launch({ ...config, ...current.launch }, dataPath, { mode: current.mode });
}
