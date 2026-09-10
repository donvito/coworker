import { describe, expect, it } from "vitest";
import type { Approval, Integration, TelegramIntegrationStatus } from "@shared/contracts";
import type { LogRecord } from "@main/control/logs";
import { formatOutput, humanOutput } from "../src/cli/output";

const approval: Approval = {
  id: "approval-1", taskId: "task-1", coworkerId: "ava", toolCallId: "tool-1",
  actionType: "email.send", summary: "Send the invoice to the client", riskLevel: "high",
  proposedPayload: { to: "client@example.com", subject: "Invoice", body: "Invoice details\n".repeat(500) },
  decidedPayload: null, status: "PENDING", createdAt: "2026-09-10T00:00:00Z", decidedAt: null,
};
const record: LogRecord = {
  timestamp: "2026-09-10T00:00:00Z", source: "app", level: "error",
  category: "app.startup", message: "Could not open the database",
};
const integration: Integration = {
  id: "telegram-1", type: "telegram", name: "@example_bot", mode: "bot", status: "connected",
  credentialKey: "telegram:bot", config: { botUsername: "example_bot", chatId: null },
  createdAt: "2026-09-10T00:00:00Z", updatedAt: "2026-09-10T00:00:00Z",
};
const telegram: TelegramIntegrationStatus = {
  integration, pairingLink: "https://t.me/example_bot?start=pair-code",
};
const providers = {
  providers: [
    { id: "openai", label: "OpenAI", credentialStatus: "configured" },
    { id: "anthropic", label: "Anthropic", credentialStatus: "unreadable" },
    { id: "google", label: "Google", credentialStatus: "missing" },
  ],
  endpoints: [{ id: "openai-compatible:local", name: "Local model", baseUrl: "http://127.0.0.1:1234/v1" }],
};

describe("terminal output", () => {
  it("shows login-startup state, profile, mode, and OS approval instructions", () => {
    const status = { supported: true, registered: true, enabled: false, state: "requires-approval",
      scope: "user-login", mode: "headless", dataPath: "/other-profile", selectedProfile: false,
      executable: "/Applications/Coworker", message: "Allow Coworker in Login Items." };
    for (const command of ["startup status", "startup enable", "startup disable"]) {
      const output = humanOutput(command, status);
      for (const value of ["requires-approval", "headless", "/other-profile", "/Applications/Coworker", "another profile", status.message]) {
        expect(output).toContain(value);
      }
      expect(JSON.parse(formatOutput(command, status, true))).toEqual(status);
    }
  });

  it("shows the complete action and payload needed to inspect an approval", () => {
    const output = humanOutput("approvals show", approval);
    for (const text of [approval.id, approval.status, approval.summary, approval.actionType,
      approval.riskLevel, approval.coworkerId, approval.taskId, approval.createdAt]) {
      expect(output).toContain(text);
    }
    expect(output).toContain(`Proposed payload:\n${JSON.stringify(approval.proposedPayload, null, 2)}`);
    expect(output).not.toContain("Decided payload:");
  });

  it("includes the decided payload and timestamp for a resolved approval", () => {
    const decidedPayload = { to: "corrected@example.com", body: "Updated invoice" };
    const output = humanOutput("approvals show", {
      ...approval, status: "EDITED", decidedPayload, decidedAt: "2026-09-10T01:00:00Z",
    });
    expect(output).toContain("Status: EDITED");
    expect(output).toContain("Decided: 2026-09-10T01:00:00Z");
    expect(output).toContain(`Decided payload:\n${JSON.stringify(decidedPayload, null, 2)}`);
    expect(humanOutput("approvals show", { ...approval, decidedPayload: false })).toContain("Decided payload:\nfalse");
  });

  it("prints each followed log record with the same contents as logs show", () => {
    const output = humanOutput("logs follow", record);
    expect(output).toContain(record.timestamp);
    expect(output).toContain("ERROR");
    expect(output).toContain("app.startup");
    expect(output).toContain("Could not open the database");
    expect(output).not.toContain("No matching log entries.");
    expect(humanOutput("logs show", [record])).toBe(output);
    expect(humanOutput("logs show", [])).toBe("No matching log entries.");
  });

  it.each(["telegram status", "telegram configure", "telegram unpair"])("shows pairing instructions for %s", (command) => {
    const output = humanOutput(command, telegram);
    expect(output).toContain("Telegram: connected");
    expect(output).toContain("Bot: example_bot");
    expect(output).toContain("Pairing: waiting for pairing");
    expect(output).toContain(`Pairing link: ${telegram.pairingLink}`);
    expect(output).not.toContain("Chat ID:");
  });

  it("shows a paired chat without offering to pair again", () => {
    const output = humanOutput("telegram status", {
      integration: { ...integration, config: { ...integration.config, chatId: 123 } }, pairingLink: null,
    });
    expect(output).toContain("Pairing: paired");
    expect(output).toContain("Chat ID: 123");
    expect(output).not.toContain("Pairing link:");
  });

  it.each(["disconnected", "error"] as const)("reports Telegram's %s state without pairing instructions", (status) => {
    const result = { ...telegram, integration: { ...integration, status } };
    const output = humanOutput("telegram status", result);
    expect(output).toContain(`Telegram: ${status}`);
    expect(output).toContain("Bot: example_bot");
    expect(output).not.toContain("Pairing");
  });

  it.each([null, "disconnected", "error", "connected"] as const)("uses the nested integration for overview status (%s)", (status) => {
    const result = { integration: status ? { ...integration, status } : null, pairingLink: null };
    const output = humanOutput("status", { running: true, services: { scheduler: "running", telegram: result } });
    expect(output).toContain(`Telegram: ${status ?? "not configured"}`);
    if (status === null) expect(humanOutput("telegram status", result)).toBe("Telegram is not configured.");
  });

  it("lists provider IDs, distinct credential states, and custom endpoints", () => {
    const output = humanOutput("models providers", providers);
    for (const text of ["openai", "OpenAI", "configured", "unreadable", "missing", "Custom endpoints",
      "openai-compatible:local", "Local model", "http://127.0.0.1:1234/v1"]) expect(output).toContain(text);
    expect(humanOutput("models providers", { ...providers, endpoints: [] })).toContain("Custom endpoints\nNo results.");
  });

  it("prints the generated endpoint ID and the selected or unset model default", () => {
    expect(humanOutput("models endpoints add", { configured: true, provider: "openai-compatible:new" }))
      .toContain("Provider ID: openai-compatible:new");
    expect(humanOutput("models default", { defaultModelProvider: "openai", defaultModelName: "example-model" }))
      .toBe("Default provider: openai\nDefault model: example-model");
    expect(humanOutput("models default", { defaultModelProvider: null, defaultModelName: null }))
      .toBe("Default provider: not set\nDefault model: not set");
    expect(humanOutput("models default", { configured: true, defaultApplied: true, models: [] }))
      .toBe("Default model updated.");
  });

  it("preserves full JSON responses independently of human formatting", () => {
    const cases: Array<[string, unknown]> = [
      ["approvals show", approval], ["telegram configure", telegram], ["models providers", providers],
      ["models default", { defaultModelProvider: null, defaultModelName: null, theme: "forest" }],
      ["models endpoints add", { provider: "openai-compatible:new", configured: true, models: [], defaultApplied: false }],
      ["logs show", [record]], ["stop", null],
    ];
    for (const [command, value] of cases) expect(JSON.parse(formatOutput(command, value, true))).toEqual(value);
    const records = [record, { ...record, message: "Second record\nwith details" }];
    const ndjson = records.map((value) => formatOutput("logs follow", value, true)).join("\n");
    expect(ndjson.split("\n").map((line) => JSON.parse(line))).toEqual(records);
  });
});
