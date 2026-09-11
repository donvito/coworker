import type { AppSettings, Approval, ConfigureModelResult, ModelEndpoint, TelegramIntegrationStatus } from "@shared/contracts";
import type { ModelProviderDefinition } from "@shared/model-providers";
import type { CredentialReadStatus } from "@main/security/credential-store";
import type { LogRecord } from "@main/control/logs";
import type { StartupStatus } from "@shared/startup";
import type { WorkspaceTextDocument } from "@shared/workspace-context";

function cell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value).replaceAll("\n", " ");
}

function table(rows: Array<Record<string, unknown>>, columns: string[]): string {
  if (!rows.length) return "No results.";
  const widths = columns.map((column) => Math.max(column.length, ...rows.map((row) => cell(row[column]).length)));
  const line = (row: Record<string, unknown>) => columns.map((column, index) => cell(row[column]).padEnd(widths[index]!)).join("  ").trimEnd();
  return [line(Object.fromEntries(columns.map((column) => [column, column]))),
    columns.map((column, index) => "─".repeat(widths[index]!)).join("  "), ...rows.map(line)].join("\n");
}

function formatApproval(approval: Approval): string {
  const lines = [
    `Approval: ${approval.id}`, `Status: ${approval.status}`,
    `Summary: ${approval.summary}`, `Action: ${approval.actionType}`, `Risk: ${approval.riskLevel}`,
    `Coworker: ${approval.coworkerId}`, `Task: ${approval.taskId}`,
    `Created: ${approval.createdAt}`, `Decided: ${cell(approval.decidedAt)}`,
    `Proposed payload:\n${JSON.stringify(approval.proposedPayload ?? null, null, 2)}`,
  ];
  if (approval.decidedPayload !== null && approval.decidedPayload !== undefined) {
    lines.push(`Decided payload:\n${JSON.stringify(approval.decidedPayload, null, 2)}`);
  }
  return lines.join("\n");
}

function telegramState(result: TelegramIntegrationStatus | undefined): string {
  return result?.integration?.status ?? "not configured";
}

function formatTelegram(result: TelegramIntegrationStatus): string {
  const { integration, pairingLink } = result;
  if (!integration) return "Telegram is not configured.";
  const { config } = integration;
  const lines = [`Telegram: ${telegramState(result)}`, `Bot: ${cell(config.botUsername)}`];
  if (integration.status === "connected") {
    const paired = config.chatId !== null && config.chatId !== undefined;
    lines.push(`Pairing: ${paired ? "paired" : "waiting for pairing"}`);
    if (paired) lines.push(`Chat ID: ${cell(config.chatId)}`);
    else if (pairingLink) lines.push(`Pairing link: ${pairingLink}`);
  }
  return lines.join("\n");
}

interface ModelProvidersResult {
  providers: Array<Pick<ModelProviderDefinition, "id" | "label"> & { credentialStatus: CredentialReadStatus }>;
  endpoints: ModelEndpoint[];
}

function formatModelProviders(result: ModelProvidersResult): string {
  const providers = table(result.providers.map((provider) => ({
    ID: provider.id, Name: provider.label, Credentials: provider.credentialStatus,
  })), ["ID", "Name", "Credentials"]);
  const endpoints = table(result.endpoints.map((endpoint) => ({
    ID: endpoint.id, Name: endpoint.name, "Base URL": endpoint.baseUrl,
  })), ["ID", "Name", "Base URL"]);
  return `Providers\n${providers}\n\nCustom endpoints\n${endpoints}`;
}

function formatModelDefault(result: AppSettings | ConfigureModelResult): string {
  if ("defaultApplied" in result) return result.defaultApplied ? "Default model updated." : "Default model was not changed.";
  return `Default provider: ${result.defaultModelProvider ?? "not set"}\nDefault model: ${result.defaultModelName ?? "not set"}`;
}

function formatLogRecord(record: LogRecord): string {
  return `${cell(record.timestamp)}  ${cell(record.level).toUpperCase().padEnd(7)}  ${cell(record.source)}  ${cell(record.category)}  ${cell(record.message)}`;
}

export function humanOutput(command: string, value: unknown): string {
  if (value === null || value === undefined) return "Done.";
  if (command === "memory show") return (value as WorkspaceTextDocument).content;
  if (["memory set", "memory clear"].includes(command)) return "Memory saved. It will be loaded on the next turn.";
  if (command.startsWith("startup ")) {
    const result = value as StartupStatus;
    return [`Login startup: ${result.state}`, `Mode: ${result.mode}`, `Data: ${result.dataPath}`,
      `App: ${result.executable}`, ...(result.selectedProfile ? [] : ["This registration belongs to another profile."]),
      ...(result.message ? [result.message] : [])].join("\n");
  }
  if (command === "status") {
    const status = value as Record<string, unknown>;
    if (status.running !== true) return `Coworker is stopped.\nProfile: ${cell(status.profile)}\nData: ${cell(status.dataPath)}`;
    const services = status.services as Record<string, unknown> | undefined;
    return ["Coworker is running.", `Mode: ${cell(status.mode)}  PID: ${cell(status.pid)}  Uptime: ${cell(status.uptimeSeconds)}s`,
      `Profile: ${cell(status.profile)}\nData: ${cell(status.dataPath)}`,
      `Scheduler: ${cell(services?.scheduler)}  Telegram: ${telegramState(services?.telegram as TelegramIntegrationStatus | undefined)}`].join("\n");
  }
  if (["start", "restart"].includes(command)) return `Coworker started (${cell((value as Record<string, unknown>).mode)} mode, PID ${cell((value as Record<string, unknown>).pid)}).`;
  if (command === "stop") return "Coworker stopped.";
  if (command === "models providers") return formatModelProviders(value as ModelProvidersResult);
  if (command === "models default") return formatModelDefault(value as AppSettings | ConfigureModelResult);
  if (command === "models endpoints add") return `Endpoint added.\nProvider ID: ${cell((value as { provider: string }).provider)}`;
  if (command === "models list") return table((value as Array<Record<string, unknown>>).map((model) => ({ Model: model.id, Name: model.name ?? "" })), ["Model", "Name"]);
  if (["telegram status", "telegram configure", "telegram unpair"].includes(command)) return formatTelegram(value as TelegramIntegrationStatus);
  if (command === "approvals show") return formatApproval(value as Approval);
  if (command === "activity list") {
    const rows = value as Array<Record<string, unknown>>;
    return table(rows.map((row) => ({ Time: row.createdAt, Event: row.type, Summary: row.summary })), ["Time", "Event", "Summary"]);
  }
  if (["coworkers list", "skills list", "schedules list", "approvals list"].includes(command)) {
    const rows = value as Array<Record<string, unknown>>;
    if (command === "coworkers list") return table(rows.map((row) => ({ Name: row.name, Role: row.role, Status: row.status, ID: row.id })), ["Name", "Role", "Status", "ID"]);
    if (command === "skills list") return table(rows.map((row) => ({ Name: row.name, Bundled: row.bundled, Description: row.description, ID: row.id })), ["Name", "Bundled", "Description", "ID"]);
    if (command === "schedules list") return table(rows.map((row) => ({ Name: row.name, Type: row.scheduleType, Enabled: row.enabled, Next: row.nextRunAt, ID: row.id })), ["Name", "Type", "Enabled", "Next", "ID"]);
    return table(rows.map((row) => ({ Status: row.status, Action: row.actionType, Summary: row.summary, ID: row.id })), ["Status", "Action", "Summary", "ID"]);
  }
  if (command === "logs export") return `Support bundle exported to ${cell((value as { path: string }).path)}.`;
  if (command === "logs follow") return formatLogRecord(value as LogRecord);
  if (command === "logs show") {
    const rows = value as LogRecord[];
    return rows.length ? rows.map(formatLogRecord).join("\n") : "No matching log entries.";
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    const preferred = ["id", "name", "description", "status", "modelProvider", "modelName", "enabled", "nextRunAt", "createdAt"];
    return preferred.filter((key) => key in object).map((key) => `${key}: ${cell(object[key])}`).join("\n") || "Done.";
  }
  if (Array.isArray(value)) return value.length ? value.map((item) => typeof item === "object" ? Object.values(item as object).map(cell).join("  ") : cell(item)).join("\n") : "No results.";
  return String(value);
}

export function formatOutput(command: string, value: unknown, json: boolean): string {
  return json ? JSON.stringify(value) : humanOutput(command, value);
}
