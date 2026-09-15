import { withConnectionOperation } from "./connection-operations";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { CoworkerDatabase } from "@main/db/database";
import type { CredentialStore } from "@main/security/credential-store";
import { resolveWorkspacePath } from "@main/tools/workspace-path";
import { markdownToDiscordChunks } from "./discord-format";
import {
  DiscordRestApi,
  parseDiscordConfig,
  discordCredentialKey,
  discordDocumentUploadLimit,
  discordPhotoUploadLimit,
  isDiscordForumType,
} from "./discord";
import { messagingConversationId, resolveMessagingIntegration, resolvedMessagingThread } from "./integration-selection";
import type { RequestContext } from "@shared/request-context";

const photoMimeTypes: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export interface DiscordSendResult {
  delivered: true;
  integrationId: string;
  channelId: string;
  threadId: string | null;
  messageChunks: number;
  attachments: Array<{ name: string; bytes: number; sentAs: "photo" | "document" }>;
}

/**
 * Executes the coworker's `discord.send` tool: delivers a markdown message
 * and optional workspace files to the paired Discord channel, targeting the
 * thread mapped to the task's conversation when one exists.
 */
async function sendCoworkerDiscordMessageUnchecked(input: {
  database: CoworkerDatabase;
  credentials: CredentialStore;
  workspacePath: string;
  conversationId: string | null;
  coworkerId: string;
  integrationId?: string;
  integrationName?: string;
  integrationDestination?: string;
  integrationBinding?: Record<string, unknown>;
  requestContext?: RequestContext;
  message: string;
  attachments?: string[];
  fetchImpl?: typeof fetch;
}): Promise<DiscordSendResult> {
  const selected = resolveMessagingIntegration({ database: input.database, provider: "discord", coworkerId: input.coworkerId, conversationId: input.conversationId, requestedIntegrationId: input.integrationId, originatingIntegrationId: input.requestContext?.channel === "discord" ? input.requestContext.originatingIntegrationId : undefined });
  const integration = selected.integration;
  const currentBinding = { ...selected.binding, resolvedThreadId: resolvedMessagingThread("discord", integration, input.conversationId) };
  if ((input.integrationName && input.integrationName !== selected.name) || (input.integrationDestination && input.integrationDestination !== selected.destination) || (input.integrationBinding && JSON.stringify(input.integrationBinding) !== JSON.stringify(currentBinding))) throw new Error("The selected Discord connection changed while approval was pending. Ask for approval again.");
  if (!integration || integration.status !== "connected") {
    throw new Error(
      "Discord is not connected. Ask the user to connect it in Settings → Integrations.",
    );
  }
  const config = parseDiscordConfig(integration);
  if (!config.channelId) {
    throw new Error(
      "Discord is connected but no channel is paired yet. Ask the user to post the pairing code from Settings → Integrations.",
    );
  }
  const token = await input.credentials.get(integration.credentialKey ?? discordCredentialKey);
  if (!token) {
    throw new Error(
      "The Discord bot token is missing. Ask the user to reconnect Discord in Settings → Integrations.",
    );
  }

  const api = new DiscordRestApi(token, input.fetchImpl ?? fetch);
  const conversationId = messagingConversationId("discord", integration, input.conversationId);
  const mappedThread = Object.entries(config.threads).find(([, mapped]) => mapped === conversationId)?.[0];
  let threadId = mappedThread ?? config.lastThreads[conversationId];
  let channelId = threadId ?? config.channelId;
  let messageAlreadyPosted = false;

  const files: Array<{
    name: string;
    data: Buffer;
    mimeType: string;
    sentAs: "photo" | "document";
  }> = [];
  for (const path of input.attachments ?? []) {
    const absolute = await resolveWorkspacePath(input.workspacePath, path);
    const data = await readFile(absolute);
    const name = basename(absolute);
    const photoMime = photoMimeTypes[extname(name).toLowerCase()];
    const sentAs =
      photoMime && data.byteLength <= discordPhotoUploadLimit ? "photo" : "document";
    if (data.byteLength > discordDocumentUploadLimit) {
      throw new Error(`${name} is larger than Discord's 25 MB upload limit`);
    }
    files.push({ name, data, mimeType: photoMime ?? "application/octet-stream", sentAs });
  }

  const chunks = markdownToDiscordChunks(input.message);
  // Prepare all local inputs before creating a forum post, which is itself
  // a visible delivery. Its starter message obeys the same size limit.
  if (!threadId && config.channelType !== null && isDiscordForumType(config.channelType)) {
    const post = await api.createThread({
      channelId: config.channelId,
      name: conversationId === config.conversationId ? "Coworker" : conversationId.slice(0, 100),
      forum: true,
      message: chunks[0],
    });
    threadId = post.id;
    channelId = post.id;
    messageAlreadyPosted = true;
    // Inbound Gateway events may add mappings while the REST call is pending.
    const latest = parseDiscordConfig(input.database.getIntegration(selected.id));
    input.database.updateDiscordIntegration({
      config: {
        threads: { ...latest.threads, [post.id]: conversationId },
        lastThreads: { ...latest.lastThreads, [conversationId]: post.id },
      },
    }, selected.id);
  }

  let messageChunks = messageAlreadyPosted ? 1 : 0;
  for (const chunk of messageAlreadyPosted ? chunks.slice(1) : chunks) {
    await api.sendMessage({ channelId, content: chunk });
    messageChunks += 1;
  }

  const attachments: DiscordSendResult["attachments"] = [];
  for (const file of files) {
    await api.sendAttachment({
      channelId,
      data: new Uint8Array(file.data),
      fileName: file.name,
      mimeType: file.mimeType,
    });
    attachments.push({ name: file.name, bytes: file.data.byteLength, sentAs: file.sentAs });
  }

  return {
    delivered: true,
    integrationId: selected.id,
    channelId,
    threadId: threadId ?? null,
    messageChunks,
    attachments,
  };
}

export async function sendCoworkerDiscordMessage(input: Parameters<typeof sendCoworkerDiscordMessageUnchecked>[0]): Promise<DiscordSendResult> {
  const selected = resolveMessagingIntegration({
    database: input.database, provider: "discord", coworkerId: input.coworkerId,
    conversationId: input.conversationId, requestedIntegrationId: input.integrationId,
    originatingIntegrationId: input.requestContext?.channel === "discord" ? input.requestContext.originatingIntegrationId : undefined,
  });
  return withConnectionOperation(input.database, selected.id, () => sendCoworkerDiscordMessageUnchecked({
    ...input, integrationId: selected.id,
    integrationBinding: input.integrationBinding ?? { ...selected.binding, resolvedThreadId: resolvedMessagingThread("discord", selected.integration, input.conversationId) },
  }));
}
