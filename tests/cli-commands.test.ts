import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { parseCommand, remoteCommand } from "../src/cli/commands";
import { installCli, shellQuote } from "@main/control/launcher";
import { ipcChannels } from "@shared/ipc";
import { configureModelSchema, createScheduleSchema, settingsPatchSchema } from "@shared/validation";
import { humanOutput } from "../src/cli/output";

const roots: string[] = [];
async function temporary() { const root = await mkdtemp(join(tmpdir(), "cw-cli-")); roots.push(root); return root; }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("terminal command contracts", () => {
  it("reads, replaces, and clears Markdown memory with revision preconditions", async () => {
    const root = await temporary();
    const file = join(root, "notes.md");
    const content = "# Memory\n- SGD, 中文, 🐈\n";
    await writeFile(file, content);
    const revision = "a".repeat(64);
    await expect(remoteCommand(parseCommand(["memory", "show", "ava"])))
      .resolves.toEqual({ method: ipcChannels.memoryRead, args: ["ava"] });
    const update = { method: ipcChannels.memoryUpdate, args: ["ava", { content, expectedRevision: revision }] };
    await expect(remoteCommand(parseCommand(["memory", "set", "ava", "--file", file]), undefined, revision)).resolves.toEqual(update);
    await expect(remoteCommand(parseCommand(["memory", "set", "ava", "--file", file, "--revision", revision]), undefined, "b".repeat(64))).resolves.toEqual(update);
    await expect(remoteCommand(parseCommand(["memory", "clear", "ava"]), undefined, revision))
      .resolves.toEqual({ method: ipcChannels.memoryUpdate, args: ["ava", { content: "", expectedRevision: revision }] });
    expect(humanOutput("memory show", { content, revision, path: "MEMORY.md" })).toBe(content);
    expect(humanOutput("memory set", { content, revision })).toContain("next turn");
  });

  it("rejects invalid memory commands and files before updating the app", async () => {
    const root = await temporary();
    const file = join(root, "invalid.md");
    for (const args of [["memory", "set", "ava"], ["memory", "clear"], ["memory", "show", "ava", "--file", file], ["memory", "set", "ava", "--file", file, "--revision", "bad"]]) {
      expect(() => parseCommand(args)).toThrow();
    }
    const command = parseCommand(["memory", "set", "ava", "--file", file]);
    for (const content of [Buffer.from("x".repeat(8001)), Buffer.alloc(32001, 120), Buffer.from([0xff])]) {
      await writeFile(file, content);
      await expect(remoteCommand(command, undefined, "a".repeat(64))).rejects.toThrow();
    }
    await writeFile(file, "Valid");
    await expect(remoteCommand(command)).rejects.toThrow();
  });
  it("maps login-startup controls with headless as the default", async () => {
    for (const flags of [[], ["--headless"]]) {
      await expect(remoteCommand(parseCommand(["startup", "enable", ...flags])))
        .resolves.toEqual({ method: "startup.enable", args: [{ mode: "headless" }] });
    }
    await expect(remoteCommand(parseCommand(["startup", "enable", "--ui"])))
      .resolves.toEqual({ method: "startup.enable", args: [{ mode: "desktop" }] });
    for (const operation of ["status", "disable"]) {
      await expect(remoteCommand(parseCommand(["startup", operation])))
        .resolves.toEqual({ method: `startup.${operation}`, args: [] });
    }
    expect(() => parseCommand(["startup", "enable", "--ui", "--headless"])).toThrow("Choose");
    expect(() => parseCommand(["startup", "disable", "--headless"])).toThrow("not valid");
  });

  it("passes activity limits and leaves the default to the service", async () => {
    await expect(remoteCommand(parseCommand(["activity", "list"]))).resolves.toEqual({ method: "activity.list", args: [] });
    for (const limit of [1, 50, 1000]) {
      await expect(remoteCommand(parseCommand(["activity", "list", "--limit", String(limit)])))
        .resolves.toEqual({ method: "activity.list", args: [limit] });
    }
  });

  it("rejects invalid activity limits during parsing, before contacting the app", () => {
    for (const limit of ["0", "-1", "1.5", "many", "1001", "Infinity", ""]) {
      expect(() => parseCommand(["activity", "list", `--limit=${limit}`])).toThrow("--limit must be an integer from 1 to 1000");
    }
  });

  it("rejects unknown and irrelevant flags, incomplete arguments, and secrets in argv", () => {
    for (const args of [
      ["start", "--file", "x"], ["models", "default", "openai"], ["run"],
      ["models", "configure", "openai", "--api-key", "secret"],
      ["models", "configure", "openai", "--prompt-key", "--key-stdin"],
      ["schedules", "create", "--cron", "* * * * *", "--run-at", "2030-01-01T00:00:00Z"],
    ]) expect(() => parseCommand(args)).toThrow();
  });

  it("accepts global flags in either position and configures custom model defaults", async () => {
    const command = parseCommand(["--json", "models", "configure", "openai-compatible:local", "--model", "test", "--data-path", "/tmp/profile"]);
    const request = await remoteCommand(command, "ephemeral-key");
    expect(request.method).toBe(ipcChannels.integrationsConfigureModel);
    expect(configureModelSchema.parse(request.args[0])).toMatchObject({ provider: "openai-compatible:local", defaultModelName: "test", apiKey: "ephemeral-key" });
    expect(settingsPatchSchema.parse({ defaultModelProvider: "openai-compatible:local", defaultModelName: "test" })).toBeDefined();
  });

  it("configures Telegram with a token supplied out of band", async () => {
    const command = parseCommand(["telegram", "configure", "coworker-1", "--token-stdin"]);
    await expect(remoteCommand(command, "123456:telegram-token-value")).resolves.toEqual({
      method: "telegram.configure",
      args: [{ coworkerId: "coworker-1", botToken: "123456:telegram-token-value" }],
    });
  });

  it("configures Discord with a token supplied out of band", async () => {
    const command = parseCommand(["discord", "configure", "coworker-1", "--token-stdin"]);
    await expect(remoteCommand(command, "TESTTESTTESTTESTTEST.TEST1.TESTTESTTESTTESTTESTTEST")).resolves.toEqual({
      method: "discord.configure",
      args: [{ coworkerId: "coworker-1", botToken: "TESTTESTTESTTESTTEST.TEST1.TESTTESTTESTTESTTESTTEST" }],
    });
  });

  it("maps schedule flags and JSON patches to existing schemas without inventing defaults", async () => {
    const root = await temporary();
    const file = join(root, "schedule.json");
    await writeFile(file, JSON.stringify({ coworkerId: "ava", name: "Old name", scheduleType: "cron",
      cronExpression: "0 9 * * *", timezone: "Asia/Singapore", taskTemplate: { title: "Report", input: "Prepare it" } }));
    const result = await remoteCommand(parseCommand(["schedules", "create", "--file", file, "--name", "New name"]));
    expect(createScheduleSchema.parse(result.args[0])).toMatchObject({ name: "New name", timezone: "Asia/Singapore" });
    expect(await remoteCommand(parseCommand(["schedules", "disable", "schedule-1"]))).toEqual({ method: ipcChannels.schedulesUpdate, args: ["schedule-1", { enabled: false }] });
  });

  it("preserves standard skill packages including script resources", async () => {
    const root = await temporary();
    const zip = new JSZip();
    zip.file("example/SKILL.md", "---\nname: example\ndescription: Example\n---\nExample");
    zip.file("example/scripts/main.mjs", "export const example = true;");
    const path = join(root, "example.skill");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    await writeFile(path, bytes);
    const request = await remoteCommand(parseCommand(["skills", "install", path, "--coworker", "ava"]));
    expect(request).toEqual({ method: ipcChannels.skillsInstallFromPackage, args: [{ fileName: "example.skill", dataBase64: bytes.toString("base64"), coworkerId: "ava" }] });
    await expect(remoteCommand(parseCommand(["skills", "enable", "example"]))).rejects.toThrow("--coworker");
  });

  it("installs a launcher with safely quoted paths and refuses overwriting an existing command", async () => {
    const root = await temporary();
    const input = { executable: "/Apps/Coworker's App/Electron", entry: "/Apps/Coworker's App/cli.js", appPath: "/Apps/Coworker's App", packaged: true,
      defaultUserDataPath: "/profile", appDataPath: "/data", directory: root };
    const installed = await installCli(input);
    const content = await readFile(installed.path, "utf8");
    expect(content).toContain("ELECTRON_RUN_AS_NODE");
    if (process.platform !== "win32") expect(content).toContain(shellQuote(input.executable));
    await expect(installCli(input)).rejects.toMatchObject({ code: "EEXIST" });
  });
});

describe("multi-bot CLI selection", () => {
  it.each(["telegram", "discord"])("targets %s edits and lifecycle operations by ID", async provider => {
    await expect(remoteCommand(parseCommand([provider, "configure", "ava", "--integration-id", "second"])))
      .resolves.toMatchObject({ method: `${provider}.configure`, args: [{ coworkerId: "ava", integrationId: "second" }] });
    for (const action of ["unpair", "disconnect"]) {
      expect(() => parseCommand([provider, action])).toThrow(/integration-id/);
      await expect(remoteCommand(parseCommand([provider, action, "--integration-id", "second"])))
        .resolves.toEqual({ method: `${provider}.${action}`, args: ["second"] });
    }
    expect(humanOutput(`${provider} disconnect`, undefined)).toMatch(/disconnected/i);
  });
});
