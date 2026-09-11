// Opt-in real Electron smoke test. Uses only a fresh temporary data profile.
// Set COWORKER_SMOKE_EXECUTABLE to exercise an unpacked desktop distribution.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
    child.once("close", (code, signal) => done({ code, signal, stdout, stderr }));
    child.stdin.end(input);
  });
}
function cliEnvironment() {
  return {
    ...env, ELECTRON_RUN_AS_NODE: "1", COWORKER_LAUNCH_CONFIG: Buffer.from(JSON.stringify(configuration)).toString("base64"),
  };
}
function cliRaw(args, input = "") {
  return execute(executable, [configuration.entry, ...args, "--data-path", root], cliEnvironment(), input);
}
async function cli(args, input = "", expected = 0) {
  const result = await cliRaw([...args, "--json"], input);
  assert.equal(result.code, expected, `${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}
async function human(args, input = "") {
  const result = await cliRaw(args, input);
  assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}
async function checkHumanLogFollow() {
  return new Promise((done, reject) => {
    const child = spawn(executable, [configuration.entry, "logs", "follow", "--source", "app", "--limit", "1", "--data-path", root], {
      env: cliEnvironment(), cwd: repo, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = ""; let interrupted = false; let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 10_000);
    child.stdout.on("data", (value) => {
      stdout += value;
      if (!interrupted && stdout.includes("\n")) { interrupted = true; child.kill("SIGINT"); }
    });
    child.stderr.on("data", (value) => { stderr += value; });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      try {
        assert.equal(timedOut, false, `Log follow timed out: ${stderr}`);
        assert.equal(code, 0, stderr);
        assert.match(stdout, /\d{4}-\d{2}-\d{2}T.*INFO\s+app\s+/);
        assert.ok(!stdout.includes("No matching log entries."));
        done();
      } catch (error) { reject(error); }
    });
  });
}
async function ready() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { const value = await cli(["status"]); if (value.ready) return value; } catch { /* startup */ }
    await delay(100);
  }
  throw new Error("App did not become ready");
}
try {
  if (!packaged && process.platform === "darwin") {
    // Exercise the real main entry with a simulated OS login signal. All OS
    // registration and relaunch calls are intercepted; paths stay in this fixture.
    const loginRoot = join(root, "login-bootstrap");
    const selected = join(root, "Login Profile");
    await mkdir(loginRoot);
    await writeFile(join(loginRoot, "startup.json"), JSON.stringify({
      version: 1, dataPath: selected, executable, mode: "headless",
    }));
    const bootstrap = join(root, "login-bootstrap.cjs");
    const redirected = join(root, "login-redirect.json");
    await writeFile(bootstrap, `
      const { app } = require('electron');
      const { writeFileSync } = require('node:fs');
      Object.defineProperty(app, 'isPackaged', { value: true });
      const getPath = app.getPath.bind(app);
      app.getPath = name => ['userData', 'appData'].includes(name) ? ${JSON.stringify(loginRoot)} : getPath(name);
      app.getLoginItemSettings = () => {
        if (!app.isReady()) throw new Error('Login state queried before ready');
        return { openAtLogin: true, wasOpenedAtLogin: true };
      };
      app.setLoginItemSettings = () => { throw new Error('Unexpected OS mutation'); };
      app.requestSingleInstanceLock = () => { throw new Error('Lock acquired before login redirect'); };
      app.relaunch = options => writeFileSync(${JSON.stringify(redirected)}, JSON.stringify(options));
      import(${JSON.stringify(pathToFileURL(join(repo, "out/main/index.js")).href)}).catch(error => { console.error(error); app.exit(1); });
    `);
    const result = await execute(executable, [bootstrap]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(redirected, "utf8")), { args: ["--data-path", selected, "--coworker-headless"] });
  }
  app = await _electron.launch({ executablePath: executable, args: [...(packaged ? [] : [repo]), "--coworker-headless", "--data-path", root], cwd: repo, env });
  const appPath = await app.evaluate(({ app }) => app.getAppPath());
  configuration = { executable, appPath, packaged, entry: join(appPath, "out/main/cli/index.js"), appDataPath: root, defaultUserDataPath: root };
  const initial = await ready();
  assert.equal(initial.mode, "headless");
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 0);
  const startup = await cli(["startup", "status"]);
  assert.equal(startup.scope, "user-login");
  assert.match(await human(["startup", "status"]), /Login startup:/);
  // Registration is global to the installed app, so never mutate real login items.
  if (!packaged) {
    assert.equal(startup.state, "unsupported");
    const rejected = await cliRaw(["startup", "enable", "--headless", "--json"]);
    assert.equal(rejected.code, 1);
    assert.match(rejected.stderr, /installed Coworker app/);
  }
  const concurrent = await Promise.all([cli(["start"]), cli(["start"])]);
  assert.ok(concurrent.every((value) => value.pid === initial.pid));
  assert.match(await human(["status"]), /Telegram: not configured/);
  assert.match(await human(["telegram", "status"]), /Telegram is not configured/);
  assert.match(await human(["models", "default"]), /Default provider: not set\nDefault model: not set/);
  await checkHumanLogFollow();

  const coworkers = await cli(["coworkers", "list"]);
  const emptyMemory = await cli(["memory", "show", coworkers[0].id]);
  assert.equal(emptyMemory.content, "");
  const memoryPath = join(root, "memory-input.md");
  await writeFile(memoryPath, "- Prefer concise replies.\n- Reporting currency: SGD.\n");
  const cliMemory = await cli(["memory", "set", coworkers[0].id, "--file", memoryPath]);
  assert.match(await human(["memory", "show", coworkers[0].id]), /Reporting currency: SGD/);
  assert.equal((await cli(["memory", "show", coworkers[1].id])).content, "");
  await cli(["memory", "set", coworkers[0].id, "--file", memoryPath, "--revision", emptyMemory.revision], "", 1);
  for (const content of ["", "x".repeat(8_000), cliMemory.content]) {
    await writeFile(memoryPath, content);
    await cli(["memory", "set", coworkers[0].id, "--file", memoryPath]);
    const exported = await human(["memory", "show", coworkers[0].id]);
    assert.equal(exported.length, content.length, "Memory stdout must preserve the file's exact length");
    assert.equal(exported, content);
    await writeFile(memoryPath, exported);
    assert.equal((await cli(["memory", "set", coworkers[0].id, "--file", memoryPath])).content, content);
  }
  const invalidLimit = await cliRaw(["activity", "list", "--limit", "0", "--json"]);
  assert.equal(invalidLimit.code, 2);
  assert.equal(JSON.parse(invalidLimit.stderr).error.code, "USAGE");
  assert.equal((await cli(["activity", "list", "--limit", "1"])).length, 1);
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
  const providerList = await human(["models", "providers"]);
  assert.ok(providerList.includes(endpoint.provider));
  assert.ok(providerList.includes("Local smoke"));
  assert.ok(providerList.includes(`http://127.0.0.1:${provider.address().port}/v1`));
  const modelDefault = await human(["models", "default"]);
  assert.ok(modelDefault.includes(`Default provider: ${endpoint.provider}`));
  assert.ok(modelDefault.includes("Default model: smoke-model"));
  assert.match(await human(["models", "default", endpoint.provider, "smoke-model"]), /Default model updated/);
  const addedEndpoint = await human(["models", "endpoints", "add", "--name", "Human output smoke", "--base-url", `http://127.0.0.1:${provider.address().port}/v1`]);
  const addedProviderId = addedEndpoint.match(/Provider ID: (openai-compatible:[a-z0-9]+)/)?.[1];
  assert.ok(addedProviderId, addedEndpoint);
  await cli(["models", "endpoints", "remove", addedProviderId]);

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
  // The attached desktop renderer must match its display's pixel density.
  // The Retina launch probe separately checks native versus Chromium headless displays.
  const rendererScale = await window.evaluate(() => window.devicePixelRatio);
  const desktopScale = await app.evaluate(({ BrowserWindow, screen }) => {
    const active = BrowserWindow.getAllWindows()[0];
    return screen.getDisplayMatching(active.getBounds()).scaleFactor * active.webContents.getZoomFactor();
  });
  assert.ok(Math.abs(rendererScale - desktopScale) < 0.01, `Renderer DPR ${rendererScale} does not match desktop ${desktopScale}`);
  // The renderer's trusted IPC sees the exact same persisted state and credential status.
  const rendererState = await window.evaluate(async ({ providerId, coworkerId }) => ({
    credential: await window.coworker.integrations.credentialStatus(`model:${providerId}`),
    coworker: (await window.coworker.coworkers.list()).find((item) => item.id === coworkerId),
  }), { providerId: endpoint.provider, coworkerId: coworkers[0].id });
  assert.equal(rendererState.credential.configured, true);
  assert.equal(rendererState.coworker.name, "CLI Smoke");
  const desktopMemory = await window.evaluate(async (id) => window.coworker.memory.read(id), coworkers[0].id);
  assert.equal(desktopMemory.content, cliMemory.content);
  await window.evaluate(async ({ id, revision }) => window.coworker.memory.update(id, { content: "- Memory edited from desktop.\n", expectedRevision: revision }), { id: coworkers[0].id, revision: desktopMemory.revision });
  assert.equal((await cli(["memory", "show", coworkers[0].id])).content, "- Memory edited from desktop.\n");
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
  assert.equal((await cli(["memory", "show", coworkers[0].id])).content, "- Memory edited from desktop.\n");
  await cli(["memory", "clear", coworkers[0].id]);
  assert.equal((await cli(["memory", "show", coworkers[0].id])).content, "");
  await cli(["models", "configure", endpoint.provider, "--model", "smoke-model"]);
  await cli(["stop"]);
  await cli(["status"], "", 3);
  const records = await cli(["logs", "show", "--limit", "10000"]);
  assert.ok(records.length > 0);
  assert.ok(!JSON.stringify(records).includes(key));
  await cli(["logs", "export", "--output", join(root, "offline.zip")]);
  await cli(["coworkers", "list"], "", 3);
  await cli(["startup", "status"], "", 3);
  const offlineInvalidLimit = await cliRaw(["activity", "list", "--limit", "1001", "--json"]);
  assert.equal(offlineInvalidLimit.code, 2);
  assert.equal(JSON.parse(offlineInvalidLimit.stderr).error.code, "USAGE");

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
