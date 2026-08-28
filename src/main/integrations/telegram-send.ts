import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { CoworkerDatabase } from "@main/db/database";
import type { CredentialStore } from "@main/security/credential-store";
import { resolveWorkspacePath } from "@main/tools/workspace-path";
import { markdownToTelegramChunks, telegramHtmlToPlainText } from "./telegram-format";
import {
  TelegramApiError,
  TelegramBotApi,
  parseTelegramConfig,
  telegramCredentialKey,
  telegramDocumentUploadLimit,
  telegramPhotoUploadLimit,
} from "./telegram";

const photoMimeTypes: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export interface TelegramSendResult {
  delivered: true;
  chatId: number;
  messageThreadId: number | null;
  messageChunks: number;
  attachments: Array<{ name: string; bytes: number; sentAs: "photo" | "document" }>;
}

/**
 * Executes the coworker's `telegram.send` tool: delivers a markdown message
 * and optional workspace files to the paired Telegram chat, targeting the
 * topic mapped to the task's conversation when one exists.
 */
export async function sendCoworkerTelegramMessage(input: {
  database: CoworkerDatabase;
  credentials: CredentialStore;
  workspacePath: string;
  /** The task's conversation (threadId); routes into its mapped topic. */
  conversationId: string | null;
  message: string;
  attachments?: string[];
  fetchImpl?: typeof fetch;
}): Promise<TelegramSendResult> {
  const integration = input.database.getTelegramIntegration();
  if (!integration || integration.status !== "connected") {
    throw new Error(
      "Telegram is not connected. Ask the user to connect it in Settings → Integrations.",
    );
  }
  const config = parseTelegramConfig(integration);
  if (config.chatId === null) {
    throw new Error(
      "Telegram is connected but no chat is paired yet. Ask the user to open the pairing link in Settings → Integrations.",
    );
  }
  const token = await input.credentials.get(telegramCredentialKey);
  if (!token) {
    throw new Error(
      "The Telegram bot token is missing. Ask the user to reconnect Telegram in Settings → Integrations.",
    );
  }

  // Bridge-created topics map strictly; otherwise deliver into the thread the
  // user last wrote from in this conversation. Threaded bot chats swallow
  // messages sent without a thread id, so a bare send is the last resort.
  const mappedThread =
    input.conversationId && input.conversationId !== config.conversationId
      ? Object.entries(config.topics).find(([, mapped]) => mapped === input.conversationId)?.[0]
      : undefined;
  const threadId =
    mappedThread !== undefined
      ? Number(mappedThread)
      : input.conversationId
        ? config.lastThreads[input.conversationId]
        : undefined;

  // Read and validate every attachment before sending anything, so a bad
  // path cannot leave a half-delivered message.
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
      photoMime && data.byteLength <= telegramPhotoUploadLimit ? "photo" : "document";
    if (sentAs === "document" && data.byteLength > telegramDocumentUploadLimit) {
      throw new Error(`${name} is larger than Telegram's 50 MB upload limit`);
    }
    files.push({ name, data, mimeType: photoMime ?? "application/octet-stream", sentAs });
  }

  const api = new TelegramBotApi(token, input.fetchImpl ?? fetch);
  let messageChunks = 0;
  for (const chunk of markdownToTelegramChunks(input.message)) {
    try {
      await api.sendMessage({
        chatId: config.chatId,
        text: chunk,
        parseMode: "HTML",
        messageThreadId: threadId,
      });
    } catch (error) {
      if (error instanceof TelegramApiError && error.errorCode === 400) {
        await api.sendMessage({
          chatId: config.chatId,
          text: telegramHtmlToPlainText(chunk),
          messageThreadId: threadId,
        });
      } else {
        throw error;
      }
    }
    messageChunks += 1;
  }

  const attachments: TelegramSendResult["attachments"] = [];
  for (const file of files) {
    const payload = {
      chatId: config.chatId,
      data: new Uint8Array(file.data),
      fileName: file.name,
      mimeType: file.mimeType,
      messageThreadId: threadId,
    };
    if (file.sentAs === "photo") await api.sendPhoto(payload);
    else await api.sendDocument(payload);
    attachments.push({ name: file.name, bytes: file.data.byteLength, sentAs: file.sentAs });
  }

  return {
    delivered: true,
    chatId: config.chatId,
    messageThreadId: threadId ?? null,
    messageChunks,
    attachments,
  };
}
