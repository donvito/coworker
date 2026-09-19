import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppUpdater, type UpdaterClient, type UpdaterEvents } from "@main/app/app-updater";
import type { AppUpdateStatus } from "@shared/contracts";

class FakeClient implements UpdaterClient {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  listeners: { [E in keyof UpdaterEvents]?: UpdaterEvents[E] } = {};
  checkForUpdates = vi.fn(async () => {
    this.emit("checking-for-update");
    if (this.latest) this.emit("update-available", { version: this.latest, releaseNotes: "Fixes" });
    else this.emit("update-not-available", { version: "0.6.1" });
  });
  downloadUpdate = vi.fn(async () => {
    this.emit("download-progress", { percent: 42.4 });
    this.emit("update-downloaded", { version: this.latest ?? "0.0.0" });
  });
  quitAndInstall = vi.fn();
  latest: string | null = null;

  on<E extends keyof UpdaterEvents>(event: E, listener: UpdaterEvents[E]): unknown {
    this.listeners[event] = listener;
    return this;
  }

  emit<E extends keyof UpdaterEvents>(event: E, ...args: Parameters<UpdaterEvents[E]>): void {
    const listener = this.listeners[event] as ((...a: Parameters<UpdaterEvents[E]>) => void) | undefined;
    listener?.(...args);
  }
}

function setup(overrides: Partial<ConstructorParameters<typeof AppUpdater>[0]> = {}) {
  const client = new FakeClient();
  const statuses: AppUpdateStatus[] = [];
  let enabled = true;
  const beforeInstall = vi.fn();
  const updater = new AppUpdater({
    client,
    currentVersion: "0.6.1",
    repositoryUrl: "https://github.com/donvito/coworker",
    canInstall: true,
    autoUpdateEnabled: () => enabled,
    onStatus: (status) => statuses.push(status),
    beforeInstall,
    startupDelayMs: 100,
    checkIntervalMs: 1_000,
    ...overrides,
  });
  return { client, statuses, updater, beforeInstall, setEnabled: (value: boolean) => (enabled = value) };
}

describe("AppUpdater", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports unsupported builds and never schedules checks without a client", () => {
    const { updater, statuses } = setup({ client: null });
    updater.start();
    vi.advanceTimersByTime(10_000);
    expect(updater.current()).toMatchObject({
      state: "unsupported",
      canInstall: false,
      currentVersion: "0.6.1",
      releaseUrl: "https://github.com/donvito/coworker/releases/latest",
    });
    expect(statuses).toHaveLength(0);
  });

  it("disables the client's automatic download and reports up-to-date after a check", async () => {
    const { client, updater } = setup();
    expect(client.autoDownload).toBe(false);
    expect(client.autoInstallOnAppQuit).toBe(true);
    const status = await updater.check();
    expect(client.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(status).toMatchObject({ state: "up-to-date", latestVersion: "0.6.1" });
    expect(status.checkedAt).toBeTruthy();
  });

  it("downloads automatically on scheduled checks and installs on request", async () => {
    const { client, updater, statuses, beforeInstall } = setup();
    client.latest = "0.7.0";
    updater.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(client.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(client.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(statuses.map((s) => s.state)).toEqual([
      "checking",
      "checking",
      "available",
      "downloading",
      "downloading",
      "downloaded",
    ]);
    expect(updater.current()).toMatchObject({
      state: "downloaded",
      latestVersion: "0.7.0",
      releaseNotes: "Fixes",
      percent: 100,
      releaseUrl: "https://github.com/donvito/coworker/releases/tag/v0.7.0",
    });
    updater.install();
    expect(beforeInstall).toHaveBeenCalledTimes(1);
    expect(client.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("does not download automatically after a manual check", async () => {
    const { client, updater } = setup();
    client.latest = "0.7.0";
    const status = await updater.check();
    expect(status.state).toBe("available");
    expect(client.downloadUpdate).not.toHaveBeenCalled();
    const downloaded = await updater.download();
    expect(downloaded.state).toBe("downloaded");
  });

  it("never downloads when the build cannot install in place", async () => {
    const { client, updater } = setup({ canInstall: false });
    client.latest = "0.7.0";
    updater.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(client.autoInstallOnAppQuit).toBe(false);
    expect(client.downloadUpdate).not.toHaveBeenCalled();
    expect(updater.current()).toMatchObject({ state: "available", canInstall: false, latestVersion: "0.7.0" });
    expect((await updater.download()).state).toBe("available");
    expect(() => updater.install()).toThrow(/No downloaded update/);
  });

  it("re-checks periodically only while automatic updates are enabled", async () => {
    const { client, updater, setEnabled } = setup();
    updater.start();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(client.checkForUpdates).toHaveBeenCalledTimes(3);
    setEnabled(false);
    updater.refreshSchedule();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.checkForUpdates).toHaveBeenCalledTimes(3);
    setEnabled(true);
    updater.refreshSchedule();
    await vi.advanceTimersByTimeAsync(100);
    expect(client.checkForUpdates).toHaveBeenCalledTimes(4);
    updater.stop();
  });

  it("surfaces check failures as an error state and recovers on the next check", async () => {
    const { client, updater } = setup();
    client.checkForUpdates.mockRejectedValueOnce(new Error("network down"));
    const failed = await updater.check();
    expect(failed).toMatchObject({ state: "error", error: "network down" });
    const ok = await updater.check();
    expect(ok.state).toBe("up-to-date");
    expect(ok.error).toBeUndefined();
  });

  it("collapses concurrent checks into one request", async () => {
    const { client, updater } = setup();
    const [a, b] = await Promise.all([updater.check(), updater.check()]);
    expect(client.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });
});
