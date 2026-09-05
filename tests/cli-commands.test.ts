import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { parseCommand, remoteCommand } from "../src/cli/commands";
import { installCli, shellQuote } from "@main/control/launcher";
import { ipcChannels } from "@shared/ipc";
import { configureModelSchema, createScheduleSchema, settingsPatchSchema } from "@shared/validation";

const roots: string[] = [];
async function temporary() { const root = await mkdtemp(join(tmpdir(), "cw-cli-")); roots.push(root); return root; }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("terminal command contracts", () => {
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
