import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoworkerDatabase } from "@main/db/database";
import { DesktopAppService } from "@main/app/app-service";
import { ToolGateway } from "@main/tools/tool-gateway";
import { sendCoworkerDiscordMessage } from "@main/integrations/discord-send";
import { sendCoworkerTelegramMessage } from "@main/integrations/telegram-send";
import type { Integration } from "@shared/contracts";

const contexts: Array<{ root: string; database: CoworkerDatabase }> = [];
afterEach(async () => {
  for (const context of contexts.splice(0)) { context.database.close(); await rm(context.root, { recursive: true, force: true }); }
  vi.restoreAllMocks();
});
async function setup(provider: "telegram" | "discord") {
  const root = await mkdtemp(join(tmpdir(), "coworker-send-binding-"));
  const database = new CoworkerDatabase(join(root, "coworker.db"));
  contexts.push({ root, database });
  const coworker = database.createCoworker({ name: "Ava", role: "Assistant", systemPrompt: "Help", modelProvider: "demo", modelName: "faux-1", enabledTools: ["telegram.send", "discord.send"] }, join(root, "workspace"));
  const neighbor = database.createCoworker({ name: "Ben", role: "Assistant", systemPrompt: "Help", modelProvider: "demo", modelName: "faux-1", enabledTools: ["telegram.send", "discord.send"] }, join(root, "neighbor"));
  const tokens = new Map<string, string>();
  const credentials = { get: vi.fn(async (key: string) => tokens.get(key) ?? null), set: async (key: string, value: string) => { tokens.set(key, value); }, delete: async (key: string) => { tokens.delete(key); }, has: async (key: string) => tokens.has(key) };
  const rows = [1, 2].map(number => {
    const owner = number === 1 ? coworker : neighbor;
    const config = { coworkerId: owner.id, botUserId: provider === "telegram" ? number : String(number), botUsername: `bot${number}`, conversationId: `coworker:${owner.id}`, ...(provider === "telegram" ? { chatId: number * 100 } : { guildId: String(number), channelId: String(number * 100), channelType: 0, channelName: "general" }) };
    const row = provider === "telegram"
      ? database.upsertTelegramIntegration({ name: `bot${number}`, credentialKey: `key${number}`, status: "connected", config })
      : database.upsertDiscordIntegration({ name: `bot${number}`, credentialKey: `key${number}`, status: "connected", config });
    tokens.set(row.credentialKey!, `token${number}`);
    return database.resetIntegrationRouting(row.id);
  });
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const result = String(url).includes("api.telegram.org")
      ? { ok: true, result: { message_id: 1 } }
      : String(url).endsWith("/threads") ? { id: "999", type: 11 } : { id: "888" };
    return new Response(JSON.stringify(result), { status: 200 });
  });
  const gateway = new ToolGateway(database, credentials, join(root, "outbox"), {}, { telegramFetch: fetchImpl, discordFetch: fetchImpl });
  const task = database.createTask({ coworkerId: coworker.id, title: "Deliver", input: "Send a message", threadId: `coworker:${coworker.id}` });
  return { root, database, coworker, credentials, rows, gateway, task, fetchImpl };
}

describe("messaging approvals and connection lifecycle", () => {
  it.each(["telegram", "discord"] as const)("selects the coworker's sole %s bot and audits attempts to use another coworker's bot", async provider => {
    const context = await setup(provider);
    const { task, coworker, rows, gateway, database, fetchImpl } = context;
    const denied = await gateway.request({ task, coworker, toolName: `${provider}.send`, toolCallId: "foreign", arguments: { message: "hello", integrationId: rows[1]!.id } });
    expect(denied.kind).toBe("denied");
    expect(database.getToolCall(denied.toolCall.id).status).toBe("DENIED");
    expect(database.listApprovals()).toHaveLength(0);
    const selected = rows[0]!;
    const pending = await gateway.request({ task, coworker, toolName: `${provider}.send`, toolCallId: "sole", arguments: { message: "hello" } });
    if (pending.kind !== "approval") throw new Error("Expected approval");
    expect(pending.approval.summary).toContain("bot1");
    expect(pending.approval.proposedPayload).toMatchObject({ integrationId: selected.id });
    const approved = database.decideApproval({ approvalId: pending.approval.id, decision: "approve" });
    const result = await gateway.executeApproval(approved, coworker);
    expect(result.result).toMatchObject({ delivered: true, integrationId: selected.id });
    expect(context.credentials.get).toHaveBeenCalledWith(selected.credentialKey);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(provider === "telegram" ? String(fetchImpl.mock.calls[0]![0]) : new Headers(fetchImpl.mock.calls[0]![1]?.headers).get("Authorization")).toContain("token1");
  });

  it.each(["telegram", "discord"] as const)("rejects a changed %s recipient even when its label is unchanged", async provider => {
    const { task, coworker, rows, gateway, database, fetchImpl } = await setup(provider);
    const selected = rows[0]!;
    const pending = await gateway.request({ task, coworker, toolName: `${provider}.send`, toolCallId: "pending", arguments: { message: "hello", integrationId: selected.id } });
    if (pending.kind !== "approval") throw new Error("Expected approval");
    if (provider === "telegram") database.updateTelegramIntegration({ config: { chatId: 900 } }, selected.id);
    else database.updateDiscordIntegration({ config: { guildId: "900", channelId: "900", channelName: "general" } }, selected.id);
    const approved = database.decideApproval({ approvalId: pending.approval.id, decision: "approve" });
    await expect(gateway.executeApproval(approved, coworker)).rejects.toThrow(/changed while approval/);
    expect(database.getToolCall(pending.toolCall.id).status).toBe("FAILED");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a changed thread or routing generation while approval is pending", async () => {
    const { task, coworker, rows, gateway, database, fetchImpl } = await setup("discord");
    const selected = rows[0]!;
    const pending = await gateway.request({ task, coworker, toolName: "discord.send", toolCallId: "pending-thread", arguments: { message: "hello", integrationId: selected.id } });
    if (pending.kind !== "approval") throw new Error("Expected approval");
    database.updateDiscordIntegration({ config: { lastThreads: { [String(selected.config.conversationId)]: "new-thread" } } }, selected.id);
    const approved = database.decideApproval({ approvalId: pending.approval.id, decision: "approve" });
    await expect(gateway.executeApproval(approved, coworker)).rejects.toThrow(/changed while approval/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps forum delivery mappings under each bot's root rather than the calling local conversation", async () => {
    const { database, credentials, coworker, rows, task, fetchImpl } = await setup("discord");
    for (const row of rows) {
      database.updateDiscordIntegration({ config: { channelType: 15 } }, row.id);
      const owner = database.getCoworker(String(row.config.coworkerId));
      await sendCoworkerDiscordMessage({ database, credentials, coworkerId: owner.id, workspacePath: owner.workspacePath, conversationId: task.threadId, integrationId: row.id, message: "forum delivery", fetchImpl });
      const saved = database.getIntegration(row.id);
      expect(Object.values(saved.config.threads as Record<string, string>)).toEqual([row.config.conversationId]);
      expect(Object.values(saved.config.threads as Record<string, string>)).not.toContain(task.threadId);
    }
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/threads"))).toHaveLength(2);
  });

  it("holds the selected connection stable until an in-flight send finishes", async () => {
    const { root, database, credentials, coworker, rows, task, fetchImpl } = await setup("telegram");
    const selected = rows[0]!;
    let release!: (value: string) => void;
    credentials.get.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    const send = sendCoworkerTelegramMessage({ database, credentials, coworkerId: coworker.id, workspacePath: coworker.workspacePath, conversationId: task.threadId, integrationId: selected.id, message: "in flight", fetchImpl });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const service = new DesktopAppService({ dataPath: root, database, credentials });
    vi.spyOn(service.telegram, "start").mockResolvedValue();
    const unpair = service.unpairTelegram(selected.id);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(database.getIntegration(selected.id).config.chatId).toBe(selected.config.chatId);
    release("token1");
    await send;
    await unpair;
    expect(database.getIntegration(selected.id).config.chatId).toBeNull();
    expect(database.getIntegration(selected.id).config.routingGeneration).not.toBe(selected.config.routingGeneration);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
