import { withConnectionOperation } from "./connection-operations";
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
import { resolveMessagingIntegration, resolvedMessagingThread } from "./integration-selection";
import type { RequestContext } from "@shared/request-context";

const photoMimeTypes: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export interface TelegramSendResult {
  delivered: true;
  integrationId: string;
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
async function sendCoworkerTelegramMessageUnchecked(input: {
  database: CoworkerDatabase;
  credentials: CredentialStore;
  workspacePath: string;
  /** The task's conversation (threadId); routes into its mapped topic. */
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
}): Promise<TelegramSendResult> {
  const selected = resolveMessagingIntegration({ database: input.database, provider: "telegram", coworkerId: input.coworkerId, conversationId: input.conversationId, requestedIntegrationId: input.integrationId, originatingIntegrationId: input.requestContext?.channel === "telegram" ? input.requestContext.originatingIntegrationId : undefined });
  const integration = selected.integration;
  const currentBinding = { ...selected.binding, resolvedThreadId: resolvedMessagingThread("telegram", integration, input.conversationId) };
  if ((input.integrationName && input.integrationName !== selected.name) || (input.integrationDestination && input.integrationDestination !== selected.destination) || (input.integrationBinding && JSON.stringify(input.integrationBinding) !== JSON.stringify(currentBinding))) throw new Error("The selected Telegram connection changed while approval was pending. Ask for approval again.");
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
  const token = await input.credentials.get(integration.credentialKey ?? telegramCredentialKey);
  if (!token) {
    throw new Error(
      "The Telegram bot token is missing. Ask the user to reconnect Telegram in Settings → Integrations.",
    );
  }

  const selectedThread = resolvedMessagingThread("telegram", integration, input.conversationId);
  const threadId = selectedThread === null ? undefined : Number(selectedThread);

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
    integrationId: selected.id,
    chatId: config.chatId,
    messageThreadId: threadId ?? null,
    messageChunks,
    attachments,
  };
}

export async function sendCoworkerTelegramMessage(input: Parameters<typeof sendCoworkerTelegramMessageUnchecked>[0]): Promise<TelegramSendResult> {
  const selected = resolveMessagingIntegration({
    database: input.database, provider: "telegram", coworkerId: input.coworkerId,
    conversationId: input.conversationId, requestedIntegrationId: input.integrationId,
    originatingIntegrationId: input.requestContext?.channel === "telegram" ? input.requestContext.originatingIntegrationId : undefined,
  });
  return withConnectionOperation(input.database, selected.id, () => sendCoworkerTelegramMessageUnchecked({
    ...input, integrationId: selected.id,
    integrationBinding: input.integrationBinding ?? { ...selected.binding, resolvedThreadId: resolvedMessagingThread("telegram", selected.integration, input.conversationId) },
  }));
}
