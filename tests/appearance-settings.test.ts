import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAppService } from "@main/app/app-service";
import { createAdministration } from "@main/control/administration";
import { CoworkerDatabase } from "@main/db/database";
import { MemoryCredentialStore } from "@main/security/credential-store";
import { appColorModes } from "@shared/contracts";
import { ipcChannels } from "@shared/ipc";
import { settingsPatchSchema } from "@shared/validation";

const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "coworker-appearance-"));
  temporaryPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("appearance settings", () => {
  it.each(appColorModes)("validates and persists %s mode independently of the theme", async (colorMode) => {
    expect(settingsPatchSchema.parse({ colorMode })).toEqual({ colorMode });
    const path = join(await temporaryDirectory(), "coworker.db");
    const database = new CoworkerDatabase(path);
    try {
      expect(database.getSettings()).toMatchObject({ theme: "graphite", colorMode: "light" });
      database.updateSettings({ theme: "ocean" });
      expect(database.updateSettings({ colorMode })).toMatchObject({ theme: "ocean", colorMode });
      expect(database.updateSettings({ theme: "plum" })).toMatchObject({ theme: "plum", colorMode });
    } finally {
      database.close();
    }

    const reopened = new CoworkerDatabase(path);
    try {
      expect(reopened.getSettings()).toMatchObject({ theme: "plum", colorMode });
    } finally {
      reopened.close();
    }
  });

  it("preserves the theme and uses light mode for existing settings without a color mode", async () => {
    const path = join(await temporaryDirectory(), "coworker.db");
    const database = new CoworkerDatabase(path);
    database.updateSettings({ theme: "forest" });
    database.close();
    const sqlite = new DatabaseSync(path);
    sqlite.prepare("DELETE FROM settings WHERE key = ?").run("colorMode");
    sqlite.close();

    const reopened = new CoworkerDatabase(path);
    try {
      expect(reopened.getSettings()).toMatchObject({ theme: "forest", colorMode: "light" });
    } finally {
      reopened.close();
    }
  });

  it("rejects unsupported color modes at the settings boundary", () => {
    for (const colorMode of ["auto", "ocean", "DARK", "", null, true, 1, {}]) {
      expect(settingsPatchSchema.safeParse({ colorMode }).success).toBe(false);
    }
    expect(settingsPatchSchema.parse({ theme: "clay", colorMode: "dark" })).toEqual({
      theme: "clay", colorMode: "dark",
    });
  });

  it("falls back to light for corrupt or unsupported stored color modes", async () => {
    const path = join(await temporaryDirectory(), "coworker.db");
    const database = new CoworkerDatabase(path);
    const sqlite = new DatabaseSync(path);
    try {
      database.updateSettings({ theme: "ocean" });
      for (const value of ['"invalid"', '"DARK"', "null", "true", "123", "{}", "{malformed"]) {
        sqlite.prepare("UPDATE settings SET value_json = ? WHERE key = ?").run(value, "colorMode");
        expect(database.getSettings()).toMatchObject({ theme: "ocean", colorMode: "light" });
      }
    } finally {
      sqlite.close();
      database.close();
    }
  });

  it("delivers saved appearance on startup and validated changes through the settings callback", async () => {
    const dataPath = await temporaryDirectory();
    const credentials = new MemoryCredentialStore();
    const onSettingsChanged = vi.fn();
    const service = new DesktopAppService({ dataPath, credentials, onSettingsChanged });
    service.database.updateSettings({ theme: "ocean", colorMode: "dark" });
    try {
      await service.initialize();
      expect(onSettingsChanged).toHaveBeenLastCalledWith(expect.objectContaining({
        theme: "ocean", colorMode: "dark",
      }));
      const administration = createAdministration({ service, credentials });
      await expect(administration.invoke(ipcChannels.updateSettings, [{ colorMode: "system" }]))
        .resolves.toMatchObject({ theme: "ocean", colorMode: "system" });
      expect(onSettingsChanged).toHaveBeenLastCalledWith(expect.objectContaining({
        theme: "ocean", colorMode: "system",
      }));
      await expect(administration.invoke(ipcChannels.updateSettings, [{ colorMode: "invalid" }]))
        .rejects.toThrow();
      expect(service.snapshot().settings).toMatchObject({ theme: "ocean", colorMode: "system" });
    } finally {
      await service.shutdown();
    }
  });
});
