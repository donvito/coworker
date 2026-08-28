import type { Integration } from "@shared/contracts";

/** Hard limits documented by the Telegram Bot API. */
export const telegramMessageLimit = 4096;
export const telegramCaptionLimit = 1024;
export const telegramPhotoUploadLimit = 10 * 1024 * 1024;
export const telegramDocumentUploadLimit = 50 * 1024 * 1024;
export const telegramDownloadLimit = 20 * 1024 * 1024;

export const telegramCredentialKey = "integration:telegram:bot";

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
  /** True when the bot owner enabled Threaded Mode in the BotFather Mini App. */
  has_topics_enabled?: boolean;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  forum_topic_created?: { name: string };
  forum_topic_edited?: { name?: string };
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramInlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface TelegramForumTopic {
  message_thread_id: number;
  name: string;
}

/** Config JSON stored on the singleton `telegram` integration row. */
export interface TelegramIntegrationConfig {
  botUsername: string;
  /** The coworker this bot is linked to. */
  coworkerId: string;
  /** The coworker's main conversation, used for messages outside any topic. */
  conversationId: string;
  /** Paired private chat id, set after /start <pairingCode> succeeds. */
  chatId: number | null;
  pairingCode: string;
  /** message_thread_id → conversationId for Threaded Mode topics. */
  topics: Record<string, string>;
  /**
   * conversationId → the topic the user last wrote from. Replies and
   * telegram.send deliveries into that conversation target this thread, since
   * threaded bot chats swallow messages sent without a thread id.
   */
  lastThreads: Record<string, number>;
  /** Last processed getUpdates update_id, persisted so restarts skip old work. */
  lastUpdateId: number | null;
  /** Snapshot of getMe.has_topics_enabled from the latest poll session. */
  threadsEnabled: boolean;
}

export function parseTelegramConfig(integration: Integration): TelegramIntegrationConfig {
  const config = integration.config as Partial<TelegramIntegrationConfig>;
  return {
    botUsername: typeof config.botUsername === "string" ? config.botUsername : "",
    coworkerId: typeof config.coworkerId === "string" ? config.coworkerId : "",
    conversationId: typeof config.conversationId === "string" ? config.conversationId : "",
    chatId: typeof config.chatId === "number" ? config.chatId : null,
    pairingCode: typeof config.pairingCode === "string" ? config.pairingCode : "",
    topics:
      config.topics && typeof config.topics === "object" && !Array.isArray(config.topics)
        ? (config.topics as Record<string, string>)
        : {},
    lastThreads:
      config.lastThreads &&
      typeof config.lastThreads === "object" &&
      !Array.isArray(config.lastThreads)
        ? (config.lastThreads as Record<string, number>)
        : {},
    lastUpdateId: typeof config.lastUpdateId === "number" ? config.lastUpdateId : null,
    threadsEnabled: config.threadsEnabled === true,
  };
}

export function telegramPairingLink(botUsername: string, pairingCode: string): string | null {
  if (!botUsername || !pairingCode) return null;
  return `https://t.me/${botUsername}?start=${pairingCode}`;
}

export class TelegramApiError extends Error {
  constructor(
    readonly errorCode: number,
    description: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Telegram API error ${errorCode}: ${description}`);
    this.name = "TelegramApiError";
  }
}

interface TelegramApiEnvelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

const jsonCallTimeoutMs = 30_000;
const uploadTimeoutMs = 120_000;

/**
 * Minimal fetch-based Telegram Bot API client. No SDK dependency; every call
 * hits https://api.telegram.org directly, mirroring how the Resend email
 * integration talks to its provider.
 */
export class TelegramBotApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = "https://api.telegram.org",
  ) {}

  private async call<T>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T> {
    const timeout = AbortSignal.timeout(options?.timeoutMs ?? jsonCallTimeoutMs);
    const signal = options?.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params ?? {}),
        signal,
      });
    } catch (error) {
      // Never propagate the raw error: fetch failures can embed the request
      // URL, which contains the bot token.
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error(`Telegram ${method} was aborted`);
      }
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new Error(`Telegram ${method} timed out`);
      }
      throw new Error(`Telegram ${method} failed: could not reach api.telegram.org`);
    }
    return this.unwrap<T>(method, response);
  }

  private async callMultipart<T>(
    method: string,
    fields: Record<string, string | undefined>,
    file: { field: string; data: Uint8Array; fileName: string; mimeType: string },
  ): Promise<T> {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) form.set(key, value);
    }
    form.set(
      file.field,
      new Blob([file.data as BlobPart], { type: file.mimeType || "application/octet-stream" }),
      file.fileName,
    );
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(uploadTimeoutMs),
      });
    } catch {
      throw new Error(`Telegram ${method} failed: could not reach api.telegram.org`);
    }
    return this.unwrap<T>(method, response);
  }

  private async unwrap<T>(method: string, response: Response): Promise<T> {
    let envelope: TelegramApiEnvelope<T>;
    try {
      envelope = (await response.json()) as TelegramApiEnvelope<T>;
    } catch {
      throw new Error(`Telegram ${method} returned an unreadable response (${response.status})`);
    }
    if (!envelope.ok || envelope.result === undefined) {
      throw new TelegramApiError(
        envelope.error_code ?? response.status,
        envelope.description ?? "unknown error",
        envelope.parameters?.retry_after,
      );
    }
    return envelope.result;
  }

  getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>("getMe");
  }

  async getUpdates(input: {
    offset?: number;
    timeoutSeconds?: number;
    signal?: AbortSignal;
  }): Promise<TelegramUpdate[]> {
    const timeoutSeconds = input.timeoutSeconds ?? 50;
    return this.call<TelegramUpdate[]>(
      "getUpdates",
      {
        offset: input.offset,
        timeout: timeoutSeconds,
        allowed_updates: ["message", "callback_query"],
      },
      // The HTTP timeout must outlast the long-poll window.
      { timeoutMs: (timeoutSeconds + 15) * 1000, signal: input.signal },
    );
  }

  sendMessage(input: {
    chatId: number;
    text: string;
    parseMode?: "HTML";
    messageThreadId?: number;
    replyMarkup?: TelegramInlineKeyboard;
  }): Promise<TelegramMessage> {
    return this.call<TelegramMessage>("sendMessage", {
      chat_id: input.chatId,
      text: input.text,
      parse_mode: input.parseMode,
      message_thread_id: input.messageThreadId,
      reply_markup: input.replyMarkup,
      link_preview_options: { is_disabled: true },
    });
  }

  /** Replaces a message's text; omitting reply_markup also clears its buttons. */
  editMessageText(input: {
    chatId: number;
    messageId: number;
    text: string;
  }): Promise<TelegramMessage | boolean> {
    return this.call<TelegramMessage | boolean>("editMessageText", {
      chat_id: input.chatId,
      message_id: input.messageId,
      text: input.text,
    });
  }

  async answerCallbackQuery(input: {
    callbackQueryId: string;
    text?: string;
  }): Promise<void> {
    await this.call<boolean>("answerCallbackQuery", {
      callback_query_id: input.callbackQueryId,
      text: input.text,
    });
  }

  async sendChatAction(input: {
    chatId: number;
    action: "typing" | "upload_photo" | "upload_document";
    messageThreadId?: number;
  }): Promise<void> {
    await this.call<boolean>("sendChatAction", {
      chat_id: input.chatId,
      action: input.action,
      message_thread_id: input.messageThreadId,
    });
  }

  sendPhoto(input: {
    chatId: number;
    data: Uint8Array;
    fileName: string;
    mimeType: string;
    caption?: string;
    messageThreadId?: number;
  }): Promise<TelegramMessage> {
    return this.callMultipart<TelegramMessage>(
      "sendPhoto",
      {
        chat_id: String(input.chatId),
        caption: input.caption,
        message_thread_id:
          input.messageThreadId === undefined ? undefined : String(input.messageThreadId),
      },
      { field: "photo", data: input.data, fileName: input.fileName, mimeType: input.mimeType },
    );
  }

  sendDocument(input: {
    chatId: number;
    data: Uint8Array;
    fileName: string;
    mimeType: string;
    caption?: string;
    messageThreadId?: number;
  }): Promise<TelegramMessage> {
    return this.callMultipart<TelegramMessage>(
      "sendDocument",
      {
        chat_id: String(input.chatId),
        caption: input.caption,
        message_thread_id:
          input.messageThreadId === undefined ? undefined : String(input.messageThreadId),
      },
      { field: "document", data: input.data, fileName: input.fileName, mimeType: input.mimeType },
    );
  }

  getFile(fileId: string): Promise<TelegramFile> {
    return this.call<TelegramFile>("getFile", { file_id: fileId });
  }

  async downloadFile(filePath: string, maxBytes = telegramDownloadLimit): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/file/bot${this.token}/${filePath}`, {
        signal: AbortSignal.timeout(uploadTimeoutMs),
      });
    } catch {
      throw new Error("Telegram file download failed: could not reach api.telegram.org");
    }
    if (!response.ok) {
      throw new Error(`Telegram file download failed (${response.status})`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error("The Telegram file is larger than the supported download size");
    }
    return bytes;
  }

  createForumTopic(input: { chatId: number; name: string }): Promise<TelegramForumTopic> {
    return this.call<TelegramForumTopic>("createForumTopic", {
      chat_id: input.chatId,
      // Telegram caps topic names at 128 characters.
      name: input.name.slice(0, 128) || "Conversation",
    });
  }
}
