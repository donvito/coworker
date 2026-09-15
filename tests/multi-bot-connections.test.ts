import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { DesktopAppService } from "@main/app/app-service";
import { CoworkerDatabase } from "@main/db/database";

const roots: string[] = [];
const services: DesktopAppService[] = [];

async function database(): Promise<CoworkerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "coworker-multi-bot-"));
  roots.push(root);
  const db = new CoworkerDatabase(join(root, "coworker.db"));
  db.createCoworker({
    name: "Ava",
    role: "Assistant",
    systemPrompt: "You are Ava.",
    modelProvider: "demo",
    modelName: "demo",
    enabledTools: [],
  }, join(root, "workspace"), "00000000-0000-4000-8000-000000000001");
  db.createCoworker({
    name: "Ben",
    role: "Assistant",
    systemPrompt: "You are Ben.",
    modelProvider: "demo",
    modelName: "demo",
    enabledTools: [],
  }, join(root, "workspace-ben"), "00000000-0000-4000-8000-000000000002");
  return db;
}

afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown().catch(() => undefined);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function credentials() {
  const values = new Map<string, string>();
  return {
    async set(key: string, value: string) { values.set(key, value); },
    async get(key: string) { return values.get(key) ?? null; },
    async has(key: string) { return values.has(key); },
    async delete(key: string) { values.delete(key); },
    values,
  };
}

function botFetch(botId: number, username: string): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/getMe")) {
      return new Response(JSON.stringify({ ok: true, result: { id: botId, is_bot: true, first_name: username, username } }));
    }
    return new Response(JSON.stringify({ ok: true, result: [] }));
  }) as typeof fetch;
}

async function serviceFixture() {
  const db = await database();
  const store = credentials();
  const root = roots.at(-1)!;
  const service = new DesktopAppService({
    dataPath: root,
    database: db,
    credentials: store,
    telegram: { fetchImpl: botFetch(900, "servicebot"), pollTimeoutSeconds: 1 },
    discord: { fetchImpl: botFetch(901, "servicebot") },
  });
  services.push(service);
  vi.spyOn(service.telegram, "start").mockResolvedValue();
  vi.spyOn(service.telegram, "restart").mockResolvedValue();
  vi.spyOn(service.telegram, "stop").mockResolvedValue();
  vi.spyOn(service.discord, "start").mockResolvedValue();
  vi.spyOn(service.discord, "restart").mockResolvedValue();
  vi.spyOn(service.discord, "stop").mockResolvedValue();
  return { db, service, store };
}

function telegramConfig(botUserId: number, coworkerId = "00000000-0000-4000-8000-000000000001", conversationId = "coworker:00000000-0000-4000-8000-000000000001") {
  return {
    botUserId,
    botUsername: `bot${botUserId}`,
    coworkerId,
    conversationId,
    chatId: 123,
    pairingCode: "paired",
    topics: { "7": "legacy-topic" },
    lastThreads: { [conversationId]: 7 },
    approvalEdits: {},
  };
}

describe("multi-bot connection storage", () => {
  it("migrates each provider to a fresh root and is idempotent", async () => {
    const db = await database();
    const telegram = db.upsertTelegramIntegration({
      name: "@bot10", credentialKey: "telegram:10", status: "connected",
      config: { ...telegramConfig(10), lastUpdateId: 12345, approvalEdits: { "old-edit": { approvalId: "old-approval" } } },
    });
    const discord = db.upsertDiscordIntegration({
      name: "bot20", credentialKey: "discord:20", status: "connected",
      config: { ...telegramConfig(20), botUserId: "20", guildId: "30", channelId: "40", pairedUserId: "50",
        sessionId: "legacy-session", lastSequence: 600, resumeUrl: "wss://gateway.example.test",
        threads: { "old-thread": "legacy-topic" }, inboundMessages: { "old-message": { channelId: "40" } } },
    });
    const legacyRoot = "coworker:00000000-0000-4000-8000-000000000001";
    const legacyMessage = db.addMessage({ conversationId: legacyRoot, role: "user", content: "Keep my desktop history", taskId: null });
    db.migrateIntegrationRouting();
    const first = db.getIntegration(telegram.id);
    const firstRoot = (first.config as { conversationId: string }).conversationId;
    expect(firstRoot).not.toBe("coworker:00000000-0000-4000-8000-000000000001");
    expect(db.getConversation(firstRoot).coworkerId).toBe("00000000-0000-4000-8000-000000000001");
    expect(first).toMatchObject({ id: telegram.id, credentialKey: "telegram:10", config: { chatId: 123, lastUpdateId: 12345, topics: {}, lastThreads: {}, approvalEdits: {} } });
    expect(db.getIntegration(discord.id)).toMatchObject({ id: discord.id, credentialKey: "discord:20", config: {
      guildId: "30", channelId: "40", pairedUserId: "50", sessionId: "legacy-session", lastSequence: 600,
      resumeUrl: "wss://gateway.example.test", threads: {}, lastThreads: {}, inboundMessages: {},
    } });
    expect(db.listConversationMessages(firstRoot)).toEqual([]);
    expect(db.listConversationMessages(legacyRoot)).toEqual([legacyMessage]);
    expect((db.getIntegration(discord.id).config as { conversationId: string }).conversationId).not.toBe(firstRoot);
    db.migrateIntegrationRouting();
    expect((db.getIntegration(telegram.id).config as { conversationId: string }).conversationId).toBe(firstRoot);
    expect(db.getConversation("coworker:00000000-0000-4000-8000-000000000001")).toBeTruthy();
  });

  it("stores two independent connections and rejects duplicate stable bot identities", async () => {
    const db = await database();
    const one = db.upsertTelegramIntegration({ name: "one", credentialKey: "t:1", status: "connected", config: telegramConfig(1) });
    const two = db.upsertTelegramIntegration({ name: "two", credentialKey: "t:2", status: "connected", config: telegramConfig(2, "00000000-0000-4000-8000-000000000002") });
    expect(db.listTelegramIntegrations().map((item) => item.id)).toEqual([one.id, two.id]);
    expect(() => db.upsertTelegramIntegration({ name: "duplicate", credentialKey: "t:3", status: "disconnected", config: telegramConfig(1) })).toThrow(/already configured/);
    expect(() => db.updateTelegramIntegration({ status: "disconnected" }, "missing")).toThrow();
  });

  it("updates by selected ID without changing the other connection", async () => {
    const db = await database();
    const one = db.upsertDiscordIntegration({ name: "one", credentialKey: "d:1", status: "connected", config: { ...telegramConfig(11), botUserId: "11" } });
    const two = db.upsertDiscordIntegration({ name: "two", credentialKey: "d:2", status: "connected", config: { ...telegramConfig(12, "00000000-0000-4000-8000-000000000002"), botUserId: "12" } });
    db.migrateIntegrationRouting();
    const rootTwo = (db.getIntegration(two.id).config as { conversationId: string }).conversationId;
    db.updateDiscordIntegration({ config: { pairingCode: "new-code" } }, two.id);
    expect((db.getIntegration(one.id).config as { pairingCode: string }).pairingCode).toBe("paired");
    expect((db.getIntegration(two.id).config as { pairingCode: string }).pairingCode).toBe("new-code");
    expect((db.getIntegration(two.id).config as { conversationId: string }).conversationId).toBe(rootTwo);
  });

  it("creates a new root when a connection is relinked to another coworker", async () => {
    const db = await database();
    const integration = db.upsertTelegramIntegration({ name: "one", credentialKey: "t:1", status: "connected", config: telegramConfig(30) });
    db.migrateIntegrationRouting();
    const oldRoot = (db.getIntegration(integration.id).config as { conversationId: string }).conversationId;
    db.updateTelegramIntegration({ config: { coworkerId: "00000000-0000-4000-8000-000000000002" } }, integration.id);
    db.migrateIntegrationRouting();
    const newRoot = (db.getIntegration(integration.id).config as { conversationId: string }).conversationId;
    expect(newRoot).not.toBe(oldRoot);
    expect(db.getConversation(oldRoot).coworkerId).toBe("00000000-0000-4000-8000-000000000001");
    expect(db.getConversation(newRoot).coworkerId).toBe("00000000-0000-4000-8000-000000000002");
  });

  it("configures, rotates, unpairs, and rejects invalid service connections", async () => {
    const { db, service, store } = await serviceFixture();
    const first = await service.configureTelegram({ botToken: "900:aaaaaaaaaaaaaaaaaaaa", coworkerId: "00000000-0000-4000-8000-000000000001" });
    const firstId = first.integration.id;
    const firstRoot = (db.getIntegration(firstId).config as { conversationId: string }).conversationId;
    db.updateTelegramIntegration({ config: { topics: { "4": "topic" }, lastThreads: { [firstRoot]: 4 } } }, firstId);
    await service.configureTelegram({ integrationId: firstId, botToken: "900:bbbbbbbbbbbbbbbbbbbb", coworkerId: "00000000-0000-4000-8000-000000000001" });
    const rotated = db.getIntegration(firstId);
    expect((rotated.config as { conversationId: string }).conversationId).toBe(firstRoot);
    expect((rotated.config as { topics: Record<string, string> }).topics["4"]).toBe("topic");
    expect(store.values.get(rotated.credentialKey!)).toBe("900:bbbbbbbbbbbbbbbbbbbb");
    await service.unpairTelegram(firstId);
    const unpaired = db.getIntegration(firstId);
    expect((unpaired.config as { chatId: number | null }).chatId).toBeNull();
    expect((unpaired.config as { topics: Record<string, string> }).topics).toEqual({});
    await expect(service.unpairTelegram("missing")).rejects.toThrow();
    await expect(service.configureTelegram({ coworkerId: "00000000-0000-4000-8000-000000000001" })).rejects.toThrow();
  });

  it("keeps existing credentials and connections on duplicate or invalid token", async () => {
    const { db, service, store } = await serviceFixture();
    const first = await service.configureTelegram({ botToken: "900:aaaaaaaaaaaaaaaaaaaa", coworkerId: "00000000-0000-4000-8000-000000000001" });
    const firstKey = db.getIntegration(first.integration.id).credentialKey!;
    await expect(service.configureTelegram({ integrationId: "missing", botToken: "900:bbbbbbbbbbbbbbbbbbbb", coworkerId: "00000000-0000-4000-8000-000000000001" })).rejects.toThrow();
    expect(store.values.get(firstKey)).toBe("900:aaaaaaaaaaaaaaaaaaaa");
    await expect(service.configureTelegram({ integrationId: first.integration.id, botToken: "900:aaaaaaaaaaaaaaaaaaaa", coworkerId: "00000000-0000-4000-8000-000000000001" })).resolves.toBeTruthy();
    expect(db.listTelegramIntegrations()).toHaveLength(1);
  });
});
