import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ipcChannels as ipc } from "@shared/ipc";
import type { LogQuery } from "@main/control/logs";

const booleanOptions = ["json", "help", "headless", "ui", "overwrite", "key-stdin", "prompt-key", "token-stdin", "prompt-token"];
const stringOptions = ["data-path", "file", "base-url", "model", "endpoint-name", "name", "coworker",
  "provider", "role", "description", "system-prompt", "status", "cron", "run-at", "timezone", "title", "input",
  "output", "source", "level", "since", "until", "limit", "conversation", "timeout"];
type Values = Record<string, string | boolean | undefined>;
export interface CliCommand { name: string; args: string[]; values: Values }
const definitions: Record<string, { args: [number, number]; flags: string[]; usage: string }> = {
  chat: { args: [2, 2], flags: ["conversation", "timeout"], usage: 'chat COWORKER "MESSAGE" [--conversation ID] [--timeout SECONDS]' },
  "chat result": { args: [1, 1], flags: ["timeout"], usage: "chat result TASK_ID [--timeout SECONDS]" },
  run: { args: [0, 0], flags: ["headless"], usage: "run --headless" },
  start: { args: [0, 0], flags: ["headless", "ui"], usage: "start [--headless|--ui]" },
  stop: { args: [0, 0], flags: [], usage: "stop" },
  restart: { args: [0, 0], flags: [], usage: "restart" },
  status: { args: [0, 0], flags: [], usage: "status" },
  "telegram status": { args: [0, 0], flags: [], usage: "telegram status" },
  "telegram configure": { args: [1, 1], flags: ["token-stdin", "prompt-token"], usage: "telegram configure COWORKER_ID [--prompt-token | --token-stdin]" },
  "telegram unpair": { args: [0, 0], flags: [], usage: "telegram unpair" },
  "telegram disconnect": { args: [0, 0], flags: [], usage: "telegram disconnect" },
  "activity list": { args: [0, 0], flags: ["limit"], usage: "activity list [--limit N]" },
  "models providers": { args: [0, 0], flags: [], usage: "models providers" },
  "models list": { args: [1, 1], flags: [], usage: "models list PROVIDER" },
  "models configure": { args: [1, 1], flags: ["base-url", "model", "endpoint-name", "key-stdin", "prompt-key"], usage: "models configure PROVIDER [--base-url URL] [--model MODEL] [--prompt-key | --key-stdin]" },
  "models default": { args: [0, 2], flags: [], usage: "models default [PROVIDER MODEL]" },
  "models endpoints add": { args: [0, 0], flags: ["name", "base-url", "model", "key-stdin", "prompt-key"], usage: "models endpoints add --name NAME --base-url URL [--model MODEL] [--prompt-key | --key-stdin]" },
  "models endpoints remove": { args: [1, 1], flags: [], usage: "models endpoints remove PROVIDER" },
  "models credentials remove": { args: [1, 1], flags: [], usage: "models credentials remove PROVIDER" },
  "coworkers list": { args: [0, 0], flags: [], usage: "coworkers list" },
  "coworkers show": { args: [1, 1], flags: [], usage: "coworkers show ID" },
  "coworkers create": { args: [0, 0], flags: ["file", "name", "role", "description", "system-prompt", "provider", "model"], usage: "coworkers create --file coworker.json [field flags]" },
  "coworkers update": { args: [1, 1], flags: ["file", "name", "role", "description", "system-prompt", "provider", "model", "status"], usage: "coworkers update ID [--file patch.json] [--provider PROVIDER --model MODEL] [--status active|paused]" },
  "coworkers remove": { args: [1, 1], flags: [], usage: "coworkers remove ID" },
  "skills list": { args: [0, 0], flags: [], usage: "skills list" },
  "skills show": { args: [1, 1], flags: [], usage: "skills show ID" },
  "skills install": { args: [1, 1], flags: ["coworker"], usage: "skills install SOURCE [--coworker ID] (HTTPS, SKILL.md, .skill or .zip)" },
  "skills remove": { args: [1, 1], flags: [], usage: "skills remove ID" },
  "skills enable": { args: [1, 1], flags: ["coworker"], usage: "skills enable ID --coworker ID" },
  "skills disable": { args: [1, 1], flags: ["coworker"], usage: "skills disable ID --coworker ID" },
  "schedules list": { args: [0, 0], flags: [], usage: "schedules list" },
  "schedules show": { args: [1, 1], flags: [], usage: "schedules show ID" },
  "schedules create": { args: [0, 0], flags: ["file", "coworker", "name", "cron", "run-at", "timezone", "title", "input"], usage: "schedules create [--file schedule.json] [--coworker ID --name NAME --cron EXPR|--run-at ISO --timezone ZONE --title TITLE --input TEXT]" },
  "schedules update": { args: [1, 1], flags: ["file", "name", "cron", "run-at", "timezone", "title", "input"], usage: "schedules update ID [--file patch.json] [schedule flags]" },
  "schedules remove": { args: [1, 1], flags: [], usage: "schedules remove ID" },
  "schedules enable": { args: [1, 1], flags: [], usage: "schedules enable ID" },
  "schedules disable": { args: [1, 1], flags: [], usage: "schedules disable ID" },
  "schedules run": { args: [1, 1], flags: [], usage: "schedules run ID" },
  "approvals list": { args: [0, 0], flags: ["status"], usage: "approvals list [--status PENDING|APPROVED|REJECTED|EDITED]" },
  "approvals show": { args: [1, 1], flags: [], usage: "approvals show ID" },
  "approvals approve": { args: [1, 1], flags: [], usage: "approvals approve ID" },
  "approvals reject": { args: [1, 1], flags: [], usage: "approvals reject ID" },
  "logs show": { args: [0, 0], flags: ["source", "level", "since", "until", "limit"], usage: "logs show [--source all|app|provider] [--level LEVEL] [--since ISO] [--until ISO] [--limit N]" },
  "logs follow": { args: [0, 0], flags: ["source", "level", "since", "until", "limit"], usage: "logs follow [log filters]" },
  "logs export": { args: [0, 0], flags: ["output", "overwrite"], usage: "logs export --output PATH.zip [--overwrite]" },
};

export function cliHelp(prefix = ""): string {
  return ["Coworker terminal administration", "", ...Object.entries(definitions)
    .filter(([name]) => name.startsWith(prefix)).map(([, value]) => `  coworker ${value.usage}`),
    "", "Global: --data-path /absolute/profile, --json, --help",
    "Configuration requires an explicitly started app. Existing logs are available offline.",
    "Secrets: --prompt-key (hidden input) or --key-stdin. Never pass an API key in argv.",
    "Coworker/schedule --file accepts existing application JSON fields; flags override file fields.",
    "Exit codes: 0 success, 1 operation failure, 2 usage, 3 stopped, 4 timeout, 5 authentication/version.",
  ].join("\n");
}

export function parseCommand(argv: string[]): CliCommand {
  const { positionals, values: parsedValues } = parseArgs({ args: argv, allowPositionals: true, strict: true,
    options: Object.fromEntries([
      ...booleanOptions.map((name) => [name, { type: "boolean" as const }]),
      ...stringOptions.map((name) => [name, { type: "string" as const }]),
    ]),
  });
  const values = parsedValues as Values;
  const commandName = Object.keys(definitions).sort((a, b) => b.length - a.length)
    .find((name) => name.split(" ").every((word, i) => positionals[i] === word));
  if (values.help || !positionals.length) return { name: "help", args: [positionals.join(" ")], values };
  if (!commandName) throw new Error(`Unknown command. Run coworker --help.`);
  const definition = definitions[commandName]!;
  const args = positionals.slice(commandName.split(" ").length);
  if (args.length < definition.args[0] || args.length > definition.args[1] ||
    (commandName === "models default" && args.length === 1)) throw new Error(`Usage: coworker ${definition.usage}`);
  const allowed = new Set(["json", "data-path", "help", ...definition.flags]);
  for (const flag of Object.keys(values)) if (!allowed.has(flag)) throw new Error(`--${flag} is not valid for ${commandName}`);
  if (values["key-stdin"] && values["prompt-key"]) throw new Error("Choose --key-stdin or --prompt-key");
  if (values["token-stdin"] && values["prompt-token"]) throw new Error("Choose --token-stdin or --prompt-token");
  if (values.cron && values["run-at"]) throw new Error("Choose --cron or --run-at");
  if (values.ui && values.headless) throw new Error("Choose --ui or --headless");
  if (commandName === "run" && !values.headless) throw new Error("Usage: coworker run --headless");
  return { name: commandName, args, values };
}

export function logQuery(command: CliCommand): LogQuery {
  const value = command.values;
  return Object.fromEntries(["source", "level", "since", "until", "limit"]
    .filter((key) => value[key] !== undefined).map((key) => [key, key === "limit" ? Number(value[key]) : value[key]]));
}

async function inputObject(command: CliCommand): Promise<Record<string, unknown>> {
  let result: Record<string, unknown> = {};
  if (typeof command.values.file === "string") {
    const path = command.values.file;
    if ((await stat(path)).size > 1_000_000) throw new Error("Configuration JSON must be at most 1 MB");
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuration must be a JSON object");
    result = value as Record<string, unknown>;
  }
  const fields: Record<string, string> = command.name.startsWith("coworkers")
    ? { name: "name", role: "role", description: "description", "system-prompt": "systemPrompt", provider: "modelProvider", model: "modelName", status: "status" }
    : { name: "name", coworker: "coworkerId", timezone: "timezone", cron: "cronExpression", "run-at": "runAt" };
  for (const [flag, field] of Object.entries(fields)) if (command.values[flag] !== undefined) result[field] = command.values[flag];
  if (command.values.cron) { result.scheduleType = "cron"; delete result.runAt; }
  if (command.values["run-at"]) { result.scheduleType = "once"; delete result.cronExpression; }
  if (command.values.title || command.values.input) {
    result.taskTemplate = { ...(result.taskTemplate as object ?? {}),
      ...(command.values.title ? { title: command.values.title } : {}),
      ...(command.values.input ? { input: command.values.input } : {}),
    };
  }
  return result;
}

export async function remoteCommand(command: CliCommand, apiKey?: string): Promise<{ method: string; args: unknown[] }> {
  const { name, args, values } = command;
  const request = (method: string, ...parameters: unknown[]) => ({ method, args: parameters });
  const simple: Record<string, string> = {
    "models providers": "models.providers", "models list": ipc.integrationsListModels,
    "telegram status": "telegram.status", "telegram unpair": "telegram.unpair", "telegram disconnect": "telegram.disconnect", "activity list": "activity.list",
    "models endpoints remove": ipc.integrationsRemoveModelEndpoint,
    "coworkers list": ipc.coworkersList, "coworkers show": "coworkers.show", "coworkers remove": ipc.coworkersRemove,
    "skills list": ipc.skillsList, "skills show": "skills.show", "skills remove": ipc.skillsRemove,
    "schedules list": ipc.schedulesList, "schedules show": "schedules.show", "schedules remove": ipc.schedulesRemove,
    "schedules run": ipc.schedulesRunNow, "approvals show": "approvals.show",
  };
  if (simple[name]) return request(simple[name], ...args);
  if (name === "activity list") return request("activity.list", values.limit === undefined ? undefined : Number(values.limit));
  if (name === "models configure" || name === "models endpoints add") return request(
    name === "models configure" ? ipc.integrationsConfigureModel : ipc.integrationsAddModelEndpoint,
    { provider: args[0], name: values.name, baseUrl: values["base-url"], defaultModelName: values.model, endpointName: values["endpoint-name"], apiKey });
  if (name === "telegram configure") return request("telegram.configure", { coworkerId: args[0], botToken: apiKey });
  if (name === "models default") return args.length ? request(ipc.integrationsConfigureModel,
    { provider: args[0], defaultModelName: args[1] }) : request(ipc.getSettings);
  if (name === "models credentials remove") return request(ipc.integrationsRemoveCredential, `model:${args[0]}`);
  if (name === "coworkers create") return request(ipc.coworkersCreate, await inputObject(command));
  if (name === "coworkers update") return request(ipc.coworkersUpdate, args[0], await inputObject(command));
  if (name === "schedules create") return request(ipc.schedulesCreate, await inputObject(command));
  if (name === "schedules update") return request(ipc.schedulesUpdate, args[0], await inputObject(command));
  if (name === "schedules enable" || name === "schedules disable") return request(ipc.schedulesUpdate, args[0], { enabled: name.endsWith("enable") });
  if (name === "approvals list") return request(ipc.approvalsList, values.status ?? "PENDING");
  if (name === "approvals approve" || name === "approvals reject") return request(ipc.approvalsDecide,
    { approvalId: args[0], decision: name.endsWith("approve") ? "approve" : "reject" });
  if (name === "skills enable" || name === "skills disable") {
    if (!values.coworker) throw new Error("--coworker ID is required");
    return request("skills.assign", args[0], values.coworker, name.endsWith("enable"));
  }
  if (name === "skills install") {
    const source = args[0]!;
    if (/^https?:\/\//i.test(source)) {
      if (!source.startsWith("https://")) throw new Error("Skill URLs must use HTTPS");
      return request(ipc.skillsInstallFromUrl, { url: source, coworkerId: values.coworker });
    }
    const path = resolve(source);
    if ((await stat(path)).size > 10_000_000) throw new Error("Skill packages must be at most 10 MB");
    const content = await readFile(path);
    if ([".skill", ".zip"].includes(extname(path).toLowerCase())) return request(ipc.skillsInstallFromPackage,
      { fileName: basename(path), dataBase64: content.toString("base64"), coworkerId: values.coworker });
    if (basename(path).toLowerCase() !== "skill.md") throw new Error("Expected SKILL.md, .skill or .zip");
    return request(ipc.skillsInstallFromContent, { content: content.toString("utf8"), coworkerId: values.coworker });
  }
  throw new Error("Unknown remote command");
}
