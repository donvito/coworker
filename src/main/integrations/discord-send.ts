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
} from "./discord";

const photoMimeTypes: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export interface DiscordSendResult {
  delivered: true;
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
export async function sendCoworkerDiscordMessage(input: {
  database: CoworkerDatabase;
  credentials: CredentialStore;
  workspacePath: string;
  conversationId: string | null;
  message: string;
  attachments?: string[];
  fetchImpl?: typeof fetch;
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

  const mappedThread =
    input.conversationId && input.conversationId !== config.conversationId
      ? Object.entries(config.threads).find(([, mapped]) => mapped === input.conversationId)?.[0]
      : undefined;
  const threadId =
    mappedThread ?? (input.conversationId ? config.lastThreads[input.conversationId] : undefined);
  const channelId = threadId ?? config.channelId;

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

  const api = new DiscordRestApi(token, input.fetchImpl ?? fetch);
  let messageChunks = 0;
  for (const chunk of markdownToDiscordChunks(input.message)) {
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
