import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { z } from "zod";
import { resolveAppProfile } from "@main/app/app-profile";
import { ControlError, requestControl } from "@main/control/transport";
import { exportLogs, followLogs, readLogs, logQuerySchema } from "@main/control/logs";
import { redactProviderDiagnostic } from "@main/runtime/provider-error-logger";
import { cliHelp, logQuery, parseCommand, remoteCommand } from "./commands";
import { launch, restart, status, stop, type LaunchConfiguration } from "./lifecycle";
import { runChat, formatChatResult, formatToolProgress } from "./chat";
import { formatOutput } from "./output";

function configuration(): LaunchConfiguration {
  if (process.env.COWORKER_LAUNCH_CONFIG) return z.object({
    executable: z.string(), appPath: z.string(), packaged: z.boolean(),
    defaultUserDataPath: z.string(), appDataPath: z.string(),
  }).parse(JSON.parse(Buffer.from(process.env.COWORKER_LAUNCH_CONFIG, "base64").toString("utf8")));
  const appDataPath = process.platform === "darwin" ? join(homedir(), "Library", "Application Support")
    : process.platform === "win32" ? process.env.APPDATA ?? join(homedir(), "AppData", "Roaming")
      : process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return {
    executable: process.execPath,
    appPath: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
    packaged: false,
    appDataPath, defaultUserDataPath: join(appDataPath, "Coworker"),
  };
}

async function secretFromStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error("Pipe a key to --key-stdin, or use --prompt-key");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const data = Buffer.from(chunk);
    size += data.length;
    if (size > 2_000) throw new Error("API key must be at most 2000 bytes");
    chunks.push(data);
  }
  const value = Buffer.concat(chunks).toString("utf8").trim();
  if (!value) throw new Error("No API key received on stdin");
  return value;
}
async function promptSecret(label = "API key"): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error("--prompt-key requires a terminal; use --key-stdin for scripts");
  process.stderr.write(`${label} (hidden): `);
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const readline = createInterface({ input: process.stdin, output: muted, terminal: true });
  try {
    return await new Promise<string>((done, reject) => {
      let answered = false;
      readline.once("SIGINT", () => { reject(new Error("Key entry cancelled")); readline.close(); });
      readline.once("close", () => { if (!answered) reject(new Error("Key entry cancelled")); });
      readline.question("", (answer) => {
        answered = true;
        const value = answer.trim();
        if (!value || value.length > 2_000) reject(new Error(`${label} must contain 1 to 2000 characters`)); else done(value);
      });
    });
  } finally { readline.close(); process.stderr.write("\n"); }
}

function print(command: string, value: unknown, json: boolean) {
  process.stdout.write(`${formatOutput(command, value, json)}\n`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const json = argv.includes("--json");
  let phase: "usage" | "operation" = "usage";
  try {
    const command = parseCommand(argv);
    if (command.name === "help") { print(command.name, cliHelp(command.args[0]), json); return; }
    const config = configuration();
    const profile = resolveAppProfile({ ...config, isPackaged: config.packaged,
      override: command.values["data-path"] as string | undefined ?? process.env.COWORKER_DATA_PATH });
    const dataPath = profile.dataPath;
    phase = "operation";
    switch (command.name) {
      case "chat":
      case "chat result": {
        const abort = new AbortController();
        const cancel = () => abort.abort();
        process.on("SIGINT", cancel);
        process.on("SIGTERM", cancel);
        try {
          const result = await runChat(command, dataPath, {
            signal: abort.signal,
            onToolCall: json ? undefined : (tool) => { process.stderr.write(`${formatToolProgress(tool)}\n`); },
            onQueued: (taskId, conversationId) => {
              if (!json) process.stderr.write(`Waiting for reply…\nConversation: ${conversationId}\nTask: ${taskId}\n`);
            },
          });
          process.stdout.write(`${json ? JSON.stringify(result) : formatChatResult(result)}\n`);
          process.exitCode = result.timedOut ? 4 : ["FAILED", "CANCELLED"].includes(result.status) ? 1 : 0;
        } catch (error) {
          if (!abort.signal.aborted) throw error;
          process.stderr.write(json ? `${JSON.stringify({ error: { code: "INTERRUPTED", message: "Stopped waiting; accepted work continues in Coworker." } })}\n`
            : "Stopped waiting; accepted work continues in Coworker.\n");
          process.exitCode = 130;
        } finally {
          process.removeListener("SIGINT", cancel);
          process.removeListener("SIGTERM", cancel);
        }
        return;
      }
      case "status": {
        const result = await status(dataPath);
        print(command.name, result ?? { running: false, dataPath, profile: profile.label }, json);
        if (!result) process.exitCode = 3;
        return;
      }
      case "run": {
        const result = await launch(config, dataPath, { foreground: true });
        process.exitCode = Number(result.exitCode ?? 0);
        return;
      }
      case "start": print(command.name, await launch(config, dataPath, { mode: command.values.ui ? "desktop" : "headless", showExisting: Boolean(command.values.ui) }), json); return;
      case "stop": print(command.name, await stop(dataPath), json); return;
      case "restart": print(command.name, await restart(config, dataPath), json); return;
      case "logs show": {
        const query = logQuerySchema.parse(logQuery(command));
        const current = await status(dataPath);
        print(command.name, current ? await requestControl(dataPath, "logs.show", [query]) : await readLogs(dataPath, query), json);
        return;
      }
      case "logs follow": {
        const abort = new AbortController();
        const cancel = () => abort.abort();
        process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
        try { for await (const record of followLogs(dataPath, logQuerySchema.parse(logQuery(command)), abort.signal)) print(command.name, record, json); }
        finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
        return;
      }
      case "logs export": {
        if (typeof command.values.output !== "string") throw new Error("--output PATH.zip is required");
        const destination = resolve(command.values.output);
        const overwrite = command.values.overwrite === true;
        const current = await status(dataPath);
        print(command.name, current ? await requestControl(dataPath, "logs.export", [{ destination, overwrite }]) : await exportLogs(dataPath, destination, overwrite), json);
        return;
      }
      default: {
        // Check readiness before asking for a key or reading a package.
        if (!await status(dataPath)) throw new ControlError("NOT_RUNNING", "Coworker is stopped. Run coworker start first.");
        const key = command.values["key-stdin"] || command.values["token-stdin"]
          ? await secretFromStdin()
          : command.values["prompt-key"] ? await promptSecret()
            : command.values["prompt-token"] ? await promptSecret("Telegram bot token") : undefined;
        const request = await remoteCommand(command, key);
        print(command.name, await requestControl(dataPath, request.method, request.args), json);
      }
    }
  } catch (error) {
    const code = error instanceof ControlError ? error.code : phase === "usage" ? "USAGE" : "FAILED";
    const message = redactProviderDiagnostic(error instanceof Error ? error.message : String(error));
    process.stderr.write(json ? `${JSON.stringify({ error: { code, message } })}\n` : `${message}\n`);
    process.exitCode = code === "USAGE" || code === "ALREADY_RUNNING" ? 2 : code === "NOT_RUNNING" ? 3
      : code === "TIMEOUT" ? 4 : ["UNAUTHORIZED", "UNTRUSTED_OWNER", "VERSION"].includes(code) ? 5 : 1;
  }
}

for (const stream of [process.stdout, process.stderr]) stream.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0); else throw error;
});
void main();
