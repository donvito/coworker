// Opt-in real Electron smoke test. Uses only a fresh temporary data profile.
// Set COWORKER_SMOKE_EXECUTABLE to exercise an unpacked desktop distribution.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { _electron } from "playwright";

const require = createRequire(import.meta.url);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "coworker-cli-smoke-"));
const executable = process.env.COWORKER_SMOKE_EXECUTABLE ?? require("electron");
const packaged = Boolean(process.env.COWORKER_SMOKE_EXECUTABLE);
const env = { ...process.env, COWORKER_DATA_PATH: root };
delete env.ELECTRON_RUN_AS_NODE;
let app;
let configuration;
let foreground;
let requestsWithCredential = 0;
const key = "coworker-smoke-local-key";
const provider = createServer((request, response) => {
  if (request.headers.authorization === `Bearer ${key}`) requestsWithCredential++;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ data: [{ id: "smoke-model", object: "model", owned_by: "local" }] }));
});
await new Promise((done) => provider.listen(0, "127.0.0.1", done));

function execute(executablePath, args, childEnv = env, input = "") {
  return new Promise((done, reject) => {
    const child = spawn(executablePath, args, { env: childEnv, cwd: repo, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (value) => { stdout += value; });
    child.stderr.on("data", (value) => { stderr += value; });
    child.once("error", reject);
    child.once("exit", (code, signal) => done({ code, signal, stdout, stderr }));
    child.stdin.end(input);
  });
}
async function cli(args, input = "", expected = 0) {
  const result = await execute(executable, [configuration.entry, ...args, "--data-path", root, "--json"], {
    ...env, ELECTRON_RUN_AS_NODE: "1", COWORKER_LAUNCH_CONFIG: Buffer.from(JSON.stringify(configuration)).toString("base64"),
  }, input);
  assert.equal(result.code, expected, `${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}
async function ready() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { const value = await cli(["status"]); if (value.ready) return value; } catch { /* startup */ }
    await delay(100);
  }
  throw new Error("App did not become ready");
}
try {
  app = await _electron.launch({ executablePath: executable, args: [...(packaged ? [] : [repo]), "--headless", "--data-path", root], cwd: repo, env });
  const appPath = await app.evaluate(({ app }) => app.getAppPath());
  configuration = { executable, appPath, packaged, entry: join(appPath, "out/main/cli/index.js"), appDataPath: root, defaultUserDataPath: root };
  const initial = await ready();
  assert.equal(initial.mode, "headless");
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 0);
  const concurrent = await Promise.all([cli(["start"]), cli(["start"])]);
  assert.ok(concurrent.every((value) => value.pid === initial.pid));

  const coworkers = await cli(["coworkers", "list"]);
  await cli(["coworkers", "update", coworkers[0].id, "--name", "CLI Smoke"]);
  const chat = await cli(["chat", "CLI Smoke", "Say hello briefly."]);
  assert.equal(chat.status, "COMPLETED");
  assert.ok(chat.reply?.length > 0);
  assert.ok(chat.conversationId);
  const continued = await cli(["chat", "CLI Smoke", "Thank you.", "--conversation", chat.conversationId]);
  assert.equal(continued.status, "COMPLETED");
  assert.equal(continued.conversationId, chat.conversationId);
  assert.notEqual(continued.taskId, chat.taskId);
  assert.deepEqual(await cli(["chat", "result", chat.taskId]), chat);
  const skill = await cli(["skills", "show", "bundled:coworker-administration"]);
  assert.equal(skill.name, "coworker-administration");
  await cli(["skills", "disable", skill.id, "--coworker", coworkers[0].id]);
  await cli(["skills", "enable", skill.id, "--coworker", coworkers[0].id]);
  const schedule = await cli(["schedules", "create", "--coworker", coworkers[0].id, "--name", "Smoke schedule", "--cron", "0 9 * * *", "--timezone", "Asia/Singapore", "--title", "Smoke", "--input", "Produce a short report"]);
  await cli(["schedules", "disable", schedule.id]);
  assert.equal((await cli(["schedules", "show", schedule.id])).enabled, false);
  assert.deepEqual(await cli(["approvals", "list"]), []);

  const endpoint = await cli(["models", "endpoints", "add", "--name", "Local smoke", "--base-url", `http://127.0.0.1:${provider.address().port}/v1`, "--model", "smoke-model", "--key-stdin"], key);
  assert.equal(endpoint.configured, true);
  assert.ok(requestsWithCredential > 0);
  await cli(["models", "list", endpoint.provider]);

  // A normal desktop launch must attach to the headless owner, not start new services.
  const second = await cli(["start", "--ui"]);
  assert.equal(second.pid, initial.pid);
  assert.equal(second.mode, "desktop");
  for (let attempt = 0; attempt < 50 && !app.windows().length; attempt++) await delay(100);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  const attached = await cli(["status"]);
  assert.equal(attached.pid, initial.pid);
  assert.equal(attached.mode, "desktop");
  const window = app.windows()[0];
  await window.waitForLoadState("domcontentloaded");
  // The renderer's trusted IPC sees the exact same persisted state and credential status.
  const rendererState = await window.evaluate(async ({ providerId, coworkerId }) => ({
    credential: await window.coworker.integrations.credentialStatus(`model:${providerId}`),
    coworker: (await window.coworker.coworkers.list()).find((item) => item.id === coworkerId),
  }), { providerId: endpoint.provider, coworkerId: coworkers[0].id });
  assert.equal(rendererState.credential.configured, true);
  assert.equal(rendererState.coworker.name, "CLI Smoke");
  // Configure through desktop IPC, then use that saved credential from the terminal.
  await window.evaluate(async (providerId) => window.coworker.integrations.configureModel({ provider: providerId, defaultModelName: "smoke-model" }), endpoint.provider);
  await cli(["models", "configure", endpoint.provider, "--model", "smoke-model"]);
  assert.ok(requestsWithCredential >= 2);

  const archive = join(root, "support.zip");
  await cli(["logs", "export", "--output", archive]);
  assert.ok((await readFile(archive)).length > 0);
  await cli(["logs", "export", "--output", archive], "", 1);
  // Restart must use the owner's executable, even if the client launcher points elsewhere.
  const savedExecutable = configuration.executable;
  configuration.executable = join(root, "not-the-owner-executable");
  const restarted = await cli(["restart"]);
  configuration.executable = savedExecutable;
  assert.notEqual(restarted.pid, initial.pid);
  assert.equal(restarted.mode, "desktop");
  assert.equal((await cli(["coworkers", "show", coworkers[0].id])).name, "CLI Smoke");
  await cli(["models", "configure", endpoint.provider, "--model", "smoke-model"]);
  await cli(["stop"]);
  await cli(["status"], "", 3);
  const records = await cli(["logs", "show", "--limit", "10000"]);
  assert.ok(records.length > 0);
  assert.ok(!JSON.stringify(records).includes(key));
  await cli(["logs", "export", "--output", join(root, "offline.zip")]);
  await cli(["coworkers", "list"], "", 3);

  const installed = await execute(executable, [...(packaged ? [] : [repo]), "--install-cli", "--bin-dir", join(root, "bin")]);
  assert.equal(installed.code, 0, installed.stderr);
  if (process.platform !== "win32") {
    const wrapper = await execute(join(root, "bin", "coworker"), ["status", "--data-path", root, "--json"]);
    assert.equal(wrapper.code, 3, wrapper.stderr);
  }
  foreground = spawn(executable, [configuration.entry, "run", "--headless", "--data-path", root], {
    env: { ...env, ELECTRON_RUN_AS_NODE: "1", COWORKER_LAUNCH_CONFIG: Buffer.from(JSON.stringify(configuration)).toString("base64") },
    cwd: repo, stdio: "ignore",
  });
  const foregroundExit = new Promise((done) => foreground.once("exit", (code) => done(code)));
  assert.equal((await ready()).mode, "headless");
  foreground.kill("SIGINT");
  foreground.kill("SIGTERM");
  assert.equal(await foregroundExit, 0);
  await cli(["status"], "", 3);
  console.log(`CLI Electron smoke passed (${packaged ? "packaged" : "development"}, ${process.platform}).`);
} finally {
  if (configuration) await cli(["stop"]).catch(() => {});
  foreground?.kill("SIGTERM");
  await app?.close().catch(() => {});
  await new Promise((done) => provider.close(done));
  await rm(root, { recursive: true, force: true });
}
