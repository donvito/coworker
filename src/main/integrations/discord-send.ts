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

const photoMimeTypes: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** Merge one thread↔conversation mapping into the stored config, re-reading it first. */
export function recordDiscordThreadMapping(
  database: CoworkerDatabase,
  mapping: DiscordThreadMapping,
): void {
  const integration = database.getDiscordIntegration();
  if (!integration) return;
  const current = parseDiscordConfig(integration);
  database.updateDiscordIntegration({
    config: {
      threads: { ...current.threads, [mapping.threadId]: mapping.conversationId },
      lastThreads: { ...current.lastThreads, [mapping.conversationId]: mapping.threadId },
    },
  });
}

export interface DiscordSendResult {
  delivered: true;
  channelId: string;
  threadId: string | null;
  messageChunks: number;
  attachments: Array<{ name: string; bytes: number; sentAs: "photo" | "document" }>;
}

export interface DiscordThreadMapping {
  threadId: string;
  conversationId: string;
}

/**
 * Executes the coworker's `discord.send` tool: delivers a markdown message
 * and optional workspace files to the paired Discord channel, targeting the
 * thread mapped to the task's conversation when one exists.
 *
 * When a forum post has to be created, the new thread↔conversation mapping is
 * handed to `registerThread` so the running bridge (the owner of the thread
 * map) records it in memory and on disk. Without a bridge the mapping is
 * merged into the stored config directly.
 */
export async function sendCoworkerDiscordMessage(input: {
  database: CoworkerDatabase;
  credentials: CredentialStore;
  workspacePath: string;
  conversationId: string | null;
  message: string;
  attachments?: string[];
  fetchImpl?: typeof fetch;
  registerThread?: (mapping: DiscordThreadMapping) => void;
}): Promise<DiscordSendResult> {
  const integration = input.database.getDiscordIntegration();
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
  const token = await input.credentials.get(discordCredentialKey);
  if (!token) {
    throw new Error(
      "The Discord bot token is missing. Ask the user to reconnect Discord in Settings → Integrations.",
    );
  }

  const api = new DiscordRestApi(token, input.fetchImpl ?? fetch);
  const conversationId = input.conversationId ?? config.conversationId;
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
    const mapping = { threadId: post.id, conversationId };
    if (input.registerThread) {
      input.registerThread(mapping);
    } else {
      recordDiscordThreadMapping(input.database, mapping);
    }
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
    channelId,
    threadId: threadId ?? null,
    messageChunks,
    attachments,
  };
}
