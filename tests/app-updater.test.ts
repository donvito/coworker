import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppUpdater,
  compareVersions,
  resolveInstallTarget,
  selectReleaseAsset,
  type AppUpdaterOptions,
  type InstallTarget,
  type ReleaseAsset,
} from "@main/app/app-updater";
import { DesktopAppService } from "@main/app/app-service";
import { MemoryCredentialStore } from "@main/security/credential-store";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "coworker-updater-"));
  temporaryPaths.push(path);
  return path;
}

const assetNames = [
  "Coworker-0.7.0-mac-arm64.zip",
  "Coworker-0.7.0-mac-x64.zip",
  "Coworker-0.7.0-win-x64-setup.exe",
  "Coworker-0.7.0-win-arm64-setup.exe",
  "Coworker-0.7.0-win-setup.exe",
  "Coworker-0.7.0-linux-x86_64.AppImage",
  "Coworker-0.7.0-linux-amd64.deb",
];
const assets: ReleaseAsset[] = assetNames.map((name) => ({
  name,
  size: 1,
  url: `https://example.test/${name}`,
  digest: null,
}));

describe("version comparison", () => {
  it("orders semantic versions including prereleases", () => {
    expect(compareVersions("0.7.0", "0.6.1")).toBe(1);
    expect(compareVersions("v0.6.1", "0.6.1")).toBe(0);
    expect(compareVersions("0.6.10", "0.6.9")).toBe(1);
    expect(compareVersions("1.0.0-beta.2", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0-beta.10", "1.0.0-beta.2")).toBe(1);
    expect(compareVersions("garbage", "0.0.1")).toBe(-1);
  });
});

describe("release asset selection", () => {
  it("picks the published asset for each platform and architecture", () => {
    const mac: InstallTarget = { kind: "mac-bundle", bundlePath: "/Applications/Coworker.app" };
    const win: InstallTarget = { kind: "windows-nsis", executablePath: "C:\\Coworker\\Coworker.exe" };
    const linux: InstallTarget = { kind: "linux-appimage", appImagePath: "/opt/Coworker.AppImage" };
    expect(selectReleaseAsset(assets, mac, "arm64")?.name).toBe("Coworker-0.7.0-mac-arm64.zip");
    expect(selectReleaseAsset(assets, mac, "x64")?.name).toBe("Coworker-0.7.0-mac-x64.zip");
    expect(selectReleaseAsset(assets, win, "arm64")?.name).toBe("Coworker-0.7.0-win-arm64-setup.exe");
    expect(selectReleaseAsset(assets, win, "ia32")?.name).toBe("Coworker-0.7.0-win-setup.exe");
    expect(selectReleaseAsset(assets, linux, "x64")?.name).toBe("Coworker-0.7.0-linux-x86_64.AppImage");
    expect(selectReleaseAsset(assets, { kind: "unsupported", reason: "no" }, "x64")).toBeNull();
  });

  it("refuses to self-install from dev builds, disk images, and package managers", () => {
    expect(resolveInstallTarget({ packaged: false, platform: "darwin", executablePath: "/x" }).kind).toBe("unsupported");
    expect(
      resolveInstallTarget({
        packaged: true,
        platform: "darwin",
        executablePath: "/Volumes/Coworker/Coworker.app/Contents/MacOS/Coworker",
      }).kind,
    ).toBe("unsupported");
    expect(
      resolveInstallTarget({
        packaged: true,
        platform: "darwin",
        executablePath: "/Applications/Coworker.app/Contents/MacOS/Coworker",
      }),
    ).toEqual({ kind: "mac-bundle", bundlePath: "/Applications/Coworker.app" });
    expect(resolveInstallTarget({ packaged: true, platform: "linux", executablePath: "/usr/bin/coworker" }).kind).toBe(
      "unsupported",
    );
  });
});

function releaseResponse(version: string, payload: Buffer, digest: string | null) {
  const name = `Coworker-${version}-linux-x86_64.AppImage`;
  return {
    tag_name: `v${version}`,
    name: `Coworker v${version}`,
    body: "Release notes",
    html_url: `https://github.com/donvito/coworker/releases/tag/v${version}`,
    published_at: "2026-09-01T00:00:00Z",
    draft: false,
    prerelease: false,
    assets: [{ name, size: payload.length, browser_download_url: `https://example.test/${name}`, digest }],
  };
}

async function setup(overrides: Partial<AppUpdaterOptions> & { payload?: Buffer; digest?: string | null } = {}) {
  const root = await temporaryDirectory();
  const payload = overrides.payload ?? Buffer.from("new app image");
  const digest =
    overrides.digest === undefined ? `sha256:${createHash("sha256").update(payload).digest("hex")}` : overrides.digest;
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes("releases/latest")) return Response.json(releaseResponse("0.7.0", payload, digest));
    return new Response(new Uint8Array(payload));
  }) as unknown as typeof fetch;
  const updater = new AppUpdater({
    currentVersion: "0.6.1",
    updatesPath: join(root, "updates"),
    target: { kind: "linux-appimage", appImagePath: join(root, "Coworker.AppImage") },
    platform: "linux",
    arch: "x64",
    releaseUrl: "https://api.github.com/repos/donvito/coworker/releases/latest",
    fetchImpl,
    prepareForInstall: vi.fn(async () => {
      calls.push("backup");
      return { backupPath: join(root, "backups", "before-update.db") };
    }),
    cancelInstallPreparation: vi.fn(async () => {
      calls.push("cancel");
    }),
    launchInstaller: vi.fn(async () => {
      calls.push("launch");
    }),
    quit: vi.fn(() => {
      calls.push("quit");
    }),
    ...overrides,
  });
  return { root, updater, calls, fetchImpl, payload };
}

describe("AppUpdater", () => {
  it("only notifies on check and never downloads or installs without user action", async () => {
    const { updater, fetchImpl, calls } = await setup();
    const state = await updater.check();
    expect(state.status).toBe("available");
    expect(state.release?.version).toBe("0.7.0");
    expect(state.release?.assetName).toBe("Coworker-0.7.0-linux-x86_64.AppImage");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
    await expect(updater.install()).rejects.toThrow(/download the update/i);
  });

  it("reports up to date when the latest release is not newer", async () => {
    const { updater } = await setup({ currentVersion: "0.7.0" });
    expect((await updater.check()).status).toBe("up-to-date");
    await expect(updater.download()).rejects.toThrow(/check for updates/i);
  });

  it("backs up the database before handing off to the installer, then quits", async () => {
    const { updater, calls, root, payload } = await setup();
    await updater.check();
    const ready = await updater.download();
    expect(ready.status).toBe("ready");
    const downloaded = join(root, "updates", "0.7.0", "Coworker-0.7.0-linux-x86_64.AppImage");
    expect(await readFile(downloaded)).toEqual(payload);
    expect((await stat(downloaded)).mode & 0o111).not.toBe(0);

    await updater.install();
    expect(calls).toEqual(["backup", "launch", "quit"]);
    const pending = JSON.parse(await readFile(join(root, "updates", "pending.json"), "utf8"));
    expect(pending).toMatchObject({ fromVersion: "0.6.1", toVersion: "0.7.0" });
    expect(pending.backupPath).toContain("before-update.db");
  });

  it("rejects downloads that fail integrity verification", async () => {
    const { updater, root } = await setup({ digest: "sha256:" + "0".repeat(64) });
    await updater.check();
    const state = await updater.download();
    expect(state.status).toBe("available");
    expect(state.error).toMatch(/integrity check/i);
    await expect(stat(join(root, "updates", "0.7.0"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not quit and resumes work when the backup or installer handoff fails", async () => {
    const backupFailure = await setup({
      prepareForInstall: vi.fn(async () => {
        throw new Error("Wait for active coworker tasks to finish before updating");
      }),
    });
    await backupFailure.updater.check();
    await backupFailure.updater.download();
    const afterBackupFailure = await backupFailure.updater.install();
    expect(afterBackupFailure.status).toBe("ready");
    expect(afterBackupFailure.error).toMatch(/active coworker tasks/);
    expect(backupFailure.calls).toEqual([]);

    const launchFailure = await setup({
      launchInstaller: vi.fn(async () => {
        throw new Error("spawn failed");
      }),
    });
    await launchFailure.updater.check();
    await launchFailure.updater.download();
    const afterLaunchFailure = await launchFailure.updater.install();
    expect(afterLaunchFailure.status).toBe("ready");
    expect(launchFailure.calls).toEqual(["backup", "cancel"]);
    await expect(stat(join(launchFailure.root, "updates", "pending.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("confirms a finished update on the next launch and reports an unfinished one", async () => {
    const root = await temporaryDirectory();
    const updatesPath = join(root, "updates");
    const pending = { fromVersion: "0.6.1", toVersion: "0.7.0", backupPath: "/backup.db", startedAt: "now" };
    const base = {
      updatesPath,
      target: { kind: "unsupported", reason: "test" } as InstallTarget,
      platform: "linux" as const,
      arch: "x64",
      prepareForInstall: async () => ({ backupPath: "" }),
      cancelInstallPreparation: async () => undefined,
      quit: () => undefined,
    };
    await mkdir(join(updatesPath, "0.7.0"), { recursive: true });
    await writeFile(join(updatesPath, "pending.json"), JSON.stringify(pending));
    const removed: string[] = [];
    const updated = new AppUpdater({
      ...base,
      currentVersion: "0.7.0",
      removeDirectory: async (path) => {
        removed.push(path);
        await rm(path, { recursive: true, force: true });
      },
    });
    const completion = await updated.finalizePendingUpdate();
    expect(completion).toMatchObject({ fromVersion: "0.6.1", toVersion: "0.7.0", backupPath: "/backup.db" });
    expect(updated.getState().lastUpdate?.toVersion).toBe("0.7.0");
    await vi.waitFor(() => expect(removed).toEqual([join(updatesPath, "0.7.0")]));
    await expect(stat(join(updatesPath, "0.7.0"))).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(join(updatesPath, "pending.json"), JSON.stringify(pending));
    const stale = new AppUpdater({ ...base, currentVersion: "0.6.1" });
    expect(await stale.finalizePendingUpdate()).toBeNull();
    expect(stale.getState()).toMatchObject({ status: "error" });
    expect(stale.getState().error).toMatch(/did not finish installing/);
  });
});

describe("DesktopAppService update preparation", () => {
  it("refuses while tasks run, then writes a verified backup and blocks writes", async () => {
    const root = await temporaryDirectory();
    const service = new DesktopAppService({
      dataPath: root,
      appVersion: "0.6.1",
      credentials: new MemoryCredentialStore(),
    });
    await service.initialize();
    try {
      const coworker = service.database.listCoworkers()[0]!;
      const task = service.database.createTask({ coworkerId: coworker.id, title: "Active", input: "work" });
      service.database.claimNextTask(coworker.id);
      await expect(service.prepareForUpdate({ fromVersion: "0.6.1", toVersion: "0.7.0" })).rejects.toThrow(
        /active coworker tasks/i,
      );
      expect(() => service.assertDataMutationAllowed()).not.toThrow();

      service.database.setTaskStatus(task.id, "COMPLETED");
      const { backupPath } = await service.prepareForUpdate({ fromVersion: "0.6.1", toVersion: "0.7.0" });
      expect(backupPath).toContain(join(root, "backups", "coworker-before-update-0.6.1-to-0.7.0-"));
      expect(() => service.database.verifyBackup(backupPath)).not.toThrow();
      expect(() => service.assertDataMutationAllowed()).toThrow(/installing an update/i);

      await service.cancelUpdatePreparation();
      expect(() => service.assertDataMutationAllowed()).not.toThrow();
    } finally {
      await service.shutdown();
    }
  });

  it("rejects a corrupt backup", async () => {
    const root = await temporaryDirectory();
    const service = new DesktopAppService({
      dataPath: root,
      appVersion: "0.6.1",
      credentials: new MemoryCredentialStore(),
    });
    await service.initialize();
    try {
      const backupPath = join(root, "broken.db");
      await writeFile(backupPath, "not a database");
      expect(() => service.database.verifyBackup(backupPath)).toThrow();
    } finally {
      await service.shutdown();
    }
  });
});
