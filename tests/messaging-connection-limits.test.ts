import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoworkerDatabase } from "@main/db/database";
import { DesktopAppService } from "@main/app/app-service";

type Provider = "telegram" | "discord";
const fixtures: Array<{ root: string; db: CoworkerDatabase }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { root, db } of fixtures.splice(0)) { db.close(); await rm(root, { recursive: true, force: true }); }
});
function token(provider: Provider, number: number) {
  return provider === "telegram" ? `${100 + number}:synthetic-test-token-long` : `${String(number).repeat(20)}.TEST1.TESTTESTTESTTESTTESTTEST`;
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "coworker-messaging-limits-"));
  const db = new CoworkerDatabase(join(root, "coworker.db"));
  fixtures.push({ root, db });
  const coworkers = ["Ava", "Ben"].map(name => db.createCoworker({ name, role: "Assistant", systemPrompt: "Help", modelProvider: "demo", modelName: "faux-1", enabledTools: [], policies: { "telegram.send": "automatic", "discord.send": "approval" } }, join(root, name)));
  const values = new Map<string, string>();
  const credentials = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
    delete: vi.fn(async (key: string) => { values.delete(key); }),
    has: async (key: string) => values.has(key),
  };
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const telegramId = Number(url.match(/\/bot(\d+):/)?.[1]);
    const discordId = new Headers(init?.headers).get("Authorization")?.match(/Bot (\d)/)?.[1] ?? "0";
    const result = telegramId ? { ok: true, result: { id: telegramId, username: `bot${telegramId}`, is_bot: true } }
      : { id: discordId, username: `bot${discordId}`, bot: true, flags: 1 << 19 };
    return new Response(JSON.stringify(result));
  });
  const service = new DesktopAppService({ dataPath: root, database: db, credentials, telegram: { fetchImpl }, discord: { fetchImpl } });
  for (const manager of [service.telegram, service.discord]) {
    vi.spyOn(manager, "start").mockResolvedValue();
    vi.spyOn(manager, "stop").mockResolvedValue();
    vi.spyOn(manager, "restart").mockResolvedValue();
  }
  const configure = (provider: Provider, coworkerId: string, number?: number, integrationId?: string) => provider === "telegram"
    ? service.configureTelegram({ coworkerId, integrationId, botToken: number ? token(provider, number) : undefined })
    : service.configureDiscord({ coworkerId, integrationId, botToken: number ? token(provider, number) : undefined });
  return { root, db, service, coworkers, configure, credentials, fetchImpl, values };
}

describe("one Telegram and one Discord connection per coworker", () => {
  it("allows both platforms for one coworker and separate bots for another", async () => {
    const { coworkers, configure, db } = await setup();
    for (const [index, coworker] of coworkers.entries()) {
      await configure("telegram", coworker.id, index + 1);
      await configure("discord", coworker.id, index + 1);
    }
    expect(db.listTelegramIntegrations()).toHaveLength(2);
    expect(db.listDiscordIntegrations()).toHaveLength(2);
    expect(new Set(db.listIntegrations().map(row => row.config.conversationId)).size).toBe(4);
  });

  it.each(["telegram", "discord"] as const)("rejects duplicate %s creates, moves, and reconnects before touching credentials", async provider => {
    const { coworkers: [ava, ben], configure, db, service, credentials, fetchImpl } = await setup();
    const first = (await configure(provider, ava!.id, 1)).integration;
    const second = (await configure(provider, ben!.id, 2)).integration;
    const savedToken = await credentials.get(second.credentialKey!);
    const beforeFetches = fetchImpl.mock.calls.length;
    const beforeWrites = credentials.set.mock.calls.length;
    await expect(configure(provider, ava!.id, 3)).rejects.toThrow(/already has/);
    await expect(configure(provider, ava!.id, undefined, second.id)).rejects.toThrow(/already has/);
    expect(fetchImpl).toHaveBeenCalledTimes(beforeFetches);
    expect(credentials.set).toHaveBeenCalledTimes(beforeWrites);
    expect(await credentials.get(second.credentialKey!)).toBe(savedToken);
    expect(db.getIntegration(second.id).config.coworkerId).toBe(ben!.id);
    // Transient transport errors still occupy the slot.
    if (provider === "telegram") db.updateTelegramIntegration({ status: "error" }, first.id);
    else db.updateDiscordIntegration({ status: "error" }, first.id);
    await expect(configure(provider, ava!.id, 3)).rejects.toThrow(/already has/);
    if (provider === "telegram") await service.disconnectTelegram(second.id);
    else await service.disconnectDiscord(second.id);
    await expect(configure(provider, ava!.id, 2, second.id)).rejects.toThrow(/already has/);
    await configure(provider, ben!.id, 2, second.id);
    expect(db.getIntegration(first.id).status).toBe("error");
  });

  it.each(["telegram", "discord"] as const)("serializes competing %s creates, keeps unpair occupied, and releases disconnect", async provider => {
    const { coworkers: [ava], configure, db, service } = await setup();
    const results = await Promise.allSettled([configure(provider, ava!.id, 1), configure(provider, ava!.id, 2)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const first = db.listIntegrations().find(row => row.type === provider)!;
    if (provider === "telegram") await service.unpairTelegram(first.id);
    else await service.unpairDiscord(first.id);
    await expect(configure(provider, ava!.id, 3)).rejects.toThrow(/already has/);
    const policy = db.getCoworker(ava!.id).policies[`${provider}.send`];
    if (provider === "telegram") await service.disconnectTelegram(first.id);
    else await service.disconnectDiscord(first.id);
    const replacement = (await configure(provider, ava!.id, 3)).integration;
    expect(replacement.id).not.toBe(first.id);
    expect(db.getCoworker(ava!.id).policies[`${provider}.send`]).toBe(policy);
    expect(db.getIntegration(first.id).status).toBe("disconnected");
  });

  it.each(["telegram", "discord"] as const)("enforces %s slots for direct storage writes and preserves conflicting legacy rows", async provider => {
    const { root, db, coworkers: [ava, ben], configure, values, service } = await setup();
    const first = (await configure(provider, ava!.id, 1)).integration;
    const second = (await configure(provider, ben!.id, 2)).integration;
    const patch = { config: { coworkerId: ava!.id } };
    expect(() => provider === "telegram" ? db.updateTelegramIntegration(patch, second.id) : db.updateDiscordIntegration(patch, second.id)).toThrow(/already has/);
    // Synthetic old-version fixture bypasses current write validation.
    const legacy = { ...second.config, coworkerId: ava!.id, chatId: 700, channelId: "800", lastUpdateId: 55, lastSequence: 66 };
    const sqlite = new DatabaseSync(join(root, "coworker.db"));
    sqlite.prepare("UPDATE integrations SET config_json = ? WHERE id = ?").run(JSON.stringify(legacy), second.id);
    sqlite.close();
    const credentialsBefore = new Map(values);
    db.migrateMessagingConnectionLimits();
    for (const row of [first, second]) expect(db.getIntegration(row.id)).toMatchObject({ id: row.id, status: "disconnected", credentialKey: row.credentialKey, config: { connectionLimitConflict: true, conversationId: row.config.conversationId } });
    expect(db.getIntegration(second.id).config).toMatchObject({ chatId: 700, channelId: "800", lastUpdateId: 55, lastSequence: 66 });
    expect(values).toEqual(credentialsBefore);
    const migrated = db.listIntegrations();
    db.migrateMessagingConnectionLimits();
    expect(db.listIntegrations()).toEqual(migrated);
    await configure(provider, ava!.id, undefined, first.id);
    expect(db.getIntegration(first.id).status).toBe("connected");
    expect(db.getIntegration(first.id).config.connectionLimitConflict).toBe(false);
    await expect(configure(provider, ava!.id, undefined, second.id)).rejects.toThrow(/already has/);
    if (provider === "telegram") {
      await service.disconnectTelegram(first.id);
      await service.disconnectTelegram(second.id);
    } else {
      await service.disconnectDiscord(first.id);
      await service.disconnectDiscord(second.id);
    }
    expect(db.getIntegration(second.id).config.connectionLimitConflict).toBe(false);
    expect(values.has(second.credentialKey!)).toBe(false);
    await expect(configure(provider, ava!.id, undefined, second.id)).rejects.toThrow(/token.*required/i);
  });
});
