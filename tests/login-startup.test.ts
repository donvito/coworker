import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginStartup, readStartupConfiguration, type LoginItems, type LoginStartupOptions } from "@main/app/login-startup";
import { applyLoginStartup, loginRelaunchArguments, parseLaunchOptions, shouldShowSecondInstance } from "@shared/launch-options";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(overrides: Partial<LoginStartupOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "coworker-startup-"));
  roots.push(root);
  const state: { registered: boolean; approved: boolean } = { registered: false, approved: true };
  let nativeArguments: string[] = [];
  let nativePath = process.execPath;
  const loginItems: LoginItems = {
    get: vi.fn((): ReturnType<LoginItems["get"]> => overrides.platform === "win32" ? {
      openAtLogin: state.registered,
      launchItems: [{ path: nativePath, args: nativeArguments, scope: "user", enabled: state.approved }],
    } : {
      openAtLogin: state.registered && state.approved,
      status: state.registered ? state.approved ? "enabled" : "requires-approval" : "not-registered",
    }),
    set: vi.fn((value) => {
      state.registered = value.openAtLogin;
      if (value.path) nativePath = value.path;
      if (value.args) nativeArguments = value.args;
    }),
  };
  const options: LoginStartupOptions = {
    platform: "darwin", packaged: true, executable: process.execPath,
    dataPath: join(root, "Selected Profile"), defaultDataPath: root,
    configurationPath: join(root, "startup.json"), loginItems, ...overrides,
  };
  return { root, state, options, loginItems, startup: new LoginStartup(options) };
}

describe("user-login startup", () => {
  it("persists a headless profile, reports actual OS state, and disables without deleting the mode", async () => {
    const { startup, options, loginItems } = await fixture();
    expect(startup.status()).toMatchObject({ registered: false, enabled: false, selectedProfile: true });
    await expect(startup.enable("headless")).resolves.toMatchObject({
      supported: true, scope: "user-login", registered: true, enabled: true, state: "enabled",
      mode: "headless", dataPath: options.dataPath, executable: options.executable,
    });
    expect(loginItems.set).toHaveBeenCalledWith({ openAtLogin: true, enabled: true });
    expect(readStartupConfiguration(options.configurationPath)).toEqual({
      version: 1, dataPath: options.dataPath, executable: options.executable, mode: "headless",
    });
    if (process.platform !== "win32") expect((await stat(options.configurationPath)).mode & 0o777).toBe(0o600);
    await expect(startup.disable()).resolves.toMatchObject({ registered: false, enabled: false, mode: "headless" });
    await expect(startup.enable()).resolves.toMatchObject({ enabled: true, mode: "headless" });
    await expect(startup.enable("desktop")).resolves.toMatchObject({ enabled: true, mode: "desktop" });
  });

  it("does not mutate OS settings during status checks", async () => {
    const { startup, state, loginItems } = await fixture();
    state.registered = true;
    state.approved = false;
    expect(startup.status()).toMatchObject({ registered: true, enabled: false, state: "requires-approval" });
    expect(loginItems.set).not.toHaveBeenCalled();
  });

  it("reports pending macOS approval without treating it as registration failure", async () => {
    const { startup, state } = await fixture();
    state.approved = false;
    await expect(startup.enable("headless")).resolves.toMatchObject({
      registered: true, enabled: false, state: "requires-approval", message: expect.stringContaining("System Settings"),
    });
  });

  it("quotes Windows profile arguments and detects an OS-disabled entry", async () => {
    const { startup, options, state, loginItems } = await fixture({ platform: "win32" });
    await expect(startup.enable("headless")).resolves.toMatchObject({ enabled: true });
    expect(loginItems.set).toHaveBeenLastCalledWith({
      openAtLogin: true, enabled: true, path: options.executable,
      args: ["--data-path", `"${options.dataPath}"`, "--headless"],
    });
    expect(loginItems.get).toHaveBeenLastCalledWith({
      path: options.executable, args: ["--data-path", `"${options.dataPath}"`, "--headless"],
    });
    state.approved = false;
    expect(startup.status()).toMatchObject({ registered: true, enabled: false, state: "disabled" });
  });

  it("does not count another Windows launch entry as enabling the selected arguments", async () => {
    const { startup, loginItems } = await fixture({ platform: "win32" });
    await startup.enable("headless");
    vi.mocked(loginItems.get).mockReturnValue({ openAtLogin: true, launchItems: [
      { path: process.execPath, args: ["--other-profile"], scope: "user", enabled: true },
    ] });
    expect(startup.status().enabled).toBe(false);
  });

  it("recognizes a legacy desktop login item and upgrades it for the default profile", async () => {
    const { options, state, loginItems } = await fixture();
    const startup = new LoginStartup({ ...options, dataPath: options.defaultDataPath });
    state.registered = true;
    expect(startup.status()).toMatchObject({ registered: true, mode: "desktop", selectedProfile: true });
    expect(loginItems.set).not.toHaveBeenCalled();
    await expect(startup.enable("headless")).resolves.toMatchObject({ mode: "headless", dataPath: options.defaultDataPath });
  });

  it("prevents another profile from replacing or disabling an active registration", async () => {
    const { startup, options, loginItems } = await fixture();
    await startup.enable("headless");
    const other = new LoginStartup({ ...options, dataPath: join(options.defaultDataPath, "Other Profile") });
    expect(other.status()).toMatchObject({ selectedProfile: false, dataPath: options.dataPath });
    vi.mocked(loginItems.set).mockClear();
    await expect(other.enable("desktop")).rejects.toThrow("Disable startup for that profile");
    await expect(other.disable()).rejects.toThrow("Disable startup for that profile");
    expect(loginItems.set).not.toHaveBeenCalled();
    await startup.disable();
    await expect(other.enable("headless")).resolves.toMatchObject({ selectedProfile: true, dataPath: join(options.defaultDataPath, "Other Profile") });
  });

  it("restores the saved mode when registration fails and releases the mutation lock", async () => {
    const { startup, options, loginItems } = await fixture();
    await startup.enable("desktop");
    vi.mocked(loginItems.set).mockImplementationOnce(() => { throw new Error("OS registration failed"); });
    await expect(startup.enable("headless")).rejects.toThrow("OS registration failed");
    expect(readStartupConfiguration(options.configurationPath)?.mode).toBe("desktop");
    await expect(startup.enable("headless")).resolves.toMatchObject({ enabled: true });
    await expect(stat(`${options.configurationPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a silent OS registration failure without leaving new launch preferences", async () => {
    const { startup, options, loginItems } = await fixture();
    vi.mocked(loginItems.set).mockImplementation(() => {});
    await expect(startup.enable("headless")).rejects.toThrow("did not register");
    expect(readStartupConfiguration(options.configurationPath)).toBeNull();
  });

  it("reports the original failure and rollback failure together", async () => {
    const { startup, options, loginItems } = await fixture();
    vi.mocked(loginItems.set)
      .mockImplementationOnce(() => { throw new Error("Registration denied"); })
      .mockImplementationOnce(() => { throw new Error("Restore denied"); });
    await expect(startup.enable("headless")).rejects.toThrow(/Registration denied.*Restore denied/);
    expect(readStartupConfiguration(options.configurationPath)).toBeNull();
  });

  it("does not report successful disable when the OS retains the entry", async () => {
    const { startup, loginItems } = await fixture();
    await startup.enable("headless");
    vi.mocked(loginItems.set).mockImplementation(() => {});
    await expect(startup.disable()).rejects.toThrow("did not remove");
    expect(startup.status().registered).toBe(true);
  });

  it("refuses concurrent changes across profiles without touching the registration", async () => {
    const { startup, options, loginItems } = await fixture();
    await writeFile(`${options.configurationPath}.lock`, "another process");
    await expect(startup.enable("headless")).rejects.toThrow("Another startup change");
    expect(loginItems.set).not.toHaveBeenCalled();
  });

  it("rejects symlinked, malformed, and oversized startup configuration files", async () => {
    const { startup, options, root, loginItems } = await fixture();
    await writeFile(join(root, "foreign.json"), "do not overwrite");
    await symlink(join(root, "foreign.json"), options.configurationPath);
    await expect(startup.enable("headless")).rejects.toThrow("regular file");
    expect(await readFile(join(root, "foreign.json"), "utf8")).toBe("do not overwrite");
    await rm(options.configurationPath);
    for (const content of ["not json", JSON.stringify({ version: 99 }), " ".repeat(20_000)]) {
      await writeFile(options.configurationPath, content);
      await expect(startup.enable("headless")).rejects.toThrow("Cannot read startup configuration");
    }
    expect(loginItems.set).not.toHaveBeenCalled();
  });

  it.each([{ platform: "linux", packaged: true }, { platform: "darwin", packaged: false }] as const)("reports unsupported $platform/packaged=$packaged without OS writes", async (overrides) => {
    const { startup, loginItems } = await fixture(overrides);
    expect(startup.status()).toMatchObject({ supported: false, state: "unsupported" });
    await expect(startup.enable("headless")).rejects.toThrow("installed Coworker app");
    await expect(startup.disable()).rejects.toThrow("installed Coworker app");
    expect(loginItems.get).not.toHaveBeenCalled();
    expect(loginItems.set).not.toHaveBeenCalled();
  });
});

describe("login launch selection", () => {
  it("redirects an argv-less macOS login launch once using explicit profile arguments", () => {
    const saved = { dataPath: "/Profile With Spaces", mode: "headless" as const };
    const args = loginRelaunchArguments(parseLaunchOptions([]), saved)!;
    expect(args).toEqual(["--data-path", saved.dataPath, "--headless"]);
    expect(loginRelaunchArguments(parseLaunchOptions(args), saved)).toBeNull();
    expect(loginRelaunchArguments(parseLaunchOptions([]), null)).toBeNull();
    expect(loginRelaunchArguments(parseLaunchOptions(["--install-cli"]), saved)).toBeNull();
    expect(loginRelaunchArguments(parseLaunchOptions([]), { ...saved, mode: "desktop" }))
      .toEqual(["--data-path", saved.dataPath]);
  });

  it("selects the recorded profile and headless mode before taking the instance lock", () => {
    const options = applyLoginStartup(parseLaunchOptions([]), { dataPath: "/saved-profile", mode: "headless" });
    expect(options).toMatchObject({ dataPath: "/saved-profile", headless: true });
    expect(applyLoginStartup(parseLaunchOptions([]), { dataPath: "/saved-profile", mode: "desktop" }).headless).toBe(false);
  });

  it("keeps explicit launch choices and CLI installation independent of login preferences", () => {
    const saved = { dataPath: "/saved-profile", mode: "headless" as const };
    expect(applyLoginStartup(parseLaunchOptions(["--data-path", "/explicit"]), saved)).toMatchObject({ dataPath: "/explicit", headless: false });
    expect(applyLoginStartup(parseLaunchOptions(["--install-cli"]), saved)).toMatchObject({ dataPath: undefined, headless: false });
    expect(applyLoginStartup(parseLaunchOptions([]), null)).toMatchObject({ dataPath: undefined, headless: false });
  });

  it("keeps a headless login attachment hidden while normal desktop launches reveal the owner", () => {
    expect(shouldShowSecondInstance([], { headless: true })).toBe(false);
    expect(shouldShowSecondInstance(["--headless"], undefined)).toBe(false);
    expect(shouldShowSecondInstance([], { headless: false })).toBe(true);
    expect(shouldShowSecondInstance([], undefined)).toBe(true);
  });
});
