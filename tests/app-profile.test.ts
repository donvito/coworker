import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAppProfile } from "@main/app/app-profile";

describe("application data profiles", () => {
  it("prefers an explicit isolated data path", () => {
    const custom = join(realpathSync(tmpdir()), "coworker-channel-test");
    expect(
      resolveAppProfile({
        override: custom,
        isPackaged: true,
        appDataPath: "/app-data",
        defaultUserDataPath: "/production/Coworker",
      }),
    ).toEqual({
      dataPath: custom,
      sessionPath: resolve(custom, "session"),
      label: "Custom",
    });
  });

  it("uses development isolation without changing the packaged default", () => {
    expect(
      resolveAppProfile({
        isPackaged: false,
        appDataPath: "/profiles",
        defaultUserDataPath: "/production/Coworker",
      }).dataPath,
    ).toBe(resolve("/profiles/Coworker Development"));
    expect(
      resolveAppProfile({
        isPackaged: true,
        appDataPath: "/profiles",
        defaultUserDataPath: "/production/Coworker",
      }).dataPath,
    ).toBe(resolve("/production/Coworker"));
  });

  it("canonicalizes symlinked profile ancestors before choosing a lock", () => {
    const root = mkdtempSync(join(tmpdir(), "cw-profile-"));
    try {
      mkdirSync(join(root, "real"));
      symlinkSync(join(root, "real"), join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
      const profile = resolveAppProfile({ override: join(root, "alias", "new-profile"), isPackaged: true,
        appDataPath: root, defaultUserDataPath: root });
      expect(profile.dataPath).toBe(join(realpathSync(join(root, "real")), "new-profile"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects relative and filesystem-root overrides", () => {
    expect(() =>
      resolveAppProfile({
        override: "relative/profile",
        isPackaged: false,
        appDataPath: "/profiles",
        defaultUserDataPath: "/production/Coworker",
      }),
    ).toThrow("absolute directory");
    expect(() =>
      resolveAppProfile({
        override: resolve("/"),
        isPackaged: false,
        appDataPath: "/profiles",
        defaultUserDataPath: "/production/Coworker",
      }),
    ).toThrow("filesystem root");
  });
});
