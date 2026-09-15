import type { Integration } from "@shared/contracts";
import type { CoworkerDatabase } from "@main/db/database";
import { parseTelegramConfig } from "./telegram";
import { parseDiscordConfig } from "./discord";

export type MessagingProvider = "telegram" | "discord";

export interface MessagingCandidate {
  id: string;
  name: string;
  destination: string;
  integration: Integration;
  binding: { botUserId?: string | number; botUsername?: string; chatId?: number | null; channelId?: string | null; guildId?: string | null; routingGeneration?: number };
}

export function originatingMessagingIntegrationId(database: CoworkerDatabase, provider: MessagingProvider, coworkerId: string, conversationId: string | null): string | null {
  if (!conversationId) return null;
  for (const integration of database.listIntegrations().filter((i) => i.type === provider)) {
    const d = details(provider, integration);
    if (d.coworkerId !== coworkerId) continue;
    const config = provider === "telegram" ? parseTelegramConfig(integration) : parseDiscordConfig(integration);
    const mappings = provider === "telegram" ? parseTelegramConfig(integration).topics : parseDiscordConfig(integration).threads;
    if (config.conversationId === conversationId || Object.values(mappings).includes(conversationId)) return integration.id;
  }
  return null;
}

function details(provider: MessagingProvider, integration: Integration): { coworkerId: string; paired: boolean; destination: string } {
  if (provider === "telegram") {
    const c = parseTelegramConfig(integration);
    return { coworkerId: c.coworkerId, paired: c.chatId !== null, destination: c.chatId === null ? "unpaired Telegram chat" : `Telegram chat ${c.chatId}` };
  }
  const c = parseDiscordConfig(integration);
  return { coworkerId: c.coworkerId, paired: Boolean(c.channelId), destination: c.channelName ? `Discord #${c.channelName}` : c.channelId ? `Discord channel ${c.channelId}` : "unpaired Discord channel" };
}
function binding(provider: MessagingProvider, integration: Integration) {
  const c = integration.config as Record<string, unknown>;
  return provider === "telegram"
    ? { botUsername: typeof c.botUsername === "string" ? c.botUsername : "", botUserId: typeof c.botUserId === "number" ? c.botUserId : undefined, chatId: typeof c.chatId === "number" ? c.chatId : null, routingGeneration: typeof c.routingGeneration === "number" ? c.routingGeneration : 0 }
    : { botUserId: typeof c.botUserId === "string" ? c.botUserId : "", channelId: typeof c.channelId === "string" ? c.channelId : null, guildId: typeof c.guildId === "string" ? c.guildId : null, routingGeneration: typeof c.routingGeneration === "number" ? c.routingGeneration : 0 };
}

/** Explicit delivery from a local/foreign conversation must not claim that conversation for this bot. */
export function messagingConversationId(provider: MessagingProvider, integration: Integration, conversationId: string | null): string {
  const config = provider === "telegram" ? parseTelegramConfig(integration) : parseDiscordConfig(integration);
  const mappings = provider === "telegram" ? parseTelegramConfig(integration).topics : parseDiscordConfig(integration).threads;
  return conversationId && (conversationId === config.conversationId || Object.values(mappings).includes(conversationId))
    ? conversationId : config.conversationId;
}

export function resolvedMessagingThread(provider: MessagingProvider, integration: Integration, conversationId: string | null): string | number | null {
  const target = messagingConversationId(provider, integration, conversationId);
  if (provider === "telegram") {
    const config = parseTelegramConfig(integration);
    const mapped = Object.entries(config.topics).find(([, id]) => id === target)?.[0];
    return mapped !== undefined ? Number(mapped) : config.lastThreads[target] ?? null;
  }
  const config = parseDiscordConfig(integration);
  return Object.entries(config.threads).find(([, id]) => id === target)?.[0] ?? config.lastThreads[target] ?? null;
}

export function messagingCandidates(database: CoworkerDatabase, provider: MessagingProvider, coworkerId: string): MessagingCandidate[] {
  return database.listIntegrations().filter((i) => i.type === provider && i.status === "connected").flatMap((integration) => {
    const d = details(provider, integration);
    if (d.coworkerId !== coworkerId || !d.paired) return [];
    return [{ id: integration.id, name: integration.name || integration.id.slice(0, 8), destination: d.destination, integration, binding: binding(provider, integration) }];
  });
}

export function resolveMessagingIntegration(input: {
  database: CoworkerDatabase;
  provider: MessagingProvider;
  coworkerId: string;
  requestedIntegrationId?: string;
  originatingIntegrationId?: string | null;
  conversationId?: string | null;
}): MessagingCandidate {
  const all = input.database.listIntegrations().filter((i) => i.type === input.provider);
  if (input.requestedIntegrationId) {
    const selected = all.find((i) => i.id === input.requestedIntegrationId);
    if (!selected) throw new Error(`The selected ${input.provider} connection was not found.`);
    const d = details(input.provider, selected);
    if (d.coworkerId !== input.coworkerId) throw new Error(`The selected ${input.provider} connection belongs to another coworker.`);
    if (selected.status !== "connected" || !d.paired) throw new Error(`The selected ${input.provider} connection is not connected and paired.`);
    return { id: selected.id, name: selected.name || selected.id.slice(0, 8), destination: d.destination, integration: selected, binding: binding(input.provider, selected) };
  }
  const inferredOrigin = input.originatingIntegrationId ?? originatingMessagingIntegrationId(input.database, input.provider, input.coworkerId, input.conversationId ?? null);
  const candidates = messagingCandidates(input.database, input.provider, input.coworkerId);
  if (inferredOrigin) {
    const origin = candidates.find((c) => c.id === inferredOrigin);
    if (origin) return origin;
    throw new Error(`The originating ${input.provider} connection is not connected and paired.`);
  }
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) {
    const owned = all.some((i) => details(input.provider, i).coworkerId === input.coworkerId);
    throw new Error(owned
      ? `${input.provider === "telegram" ? "Telegram" : "Discord"} is not connected or paired for this coworker.`
      : `No connected and paired ${input.provider} connection is available for this coworker.`);
  }
  throw new Error(`Multiple ${input.provider} connections are available. Ask the user which connection to use, then provide its connection id.`);
}
