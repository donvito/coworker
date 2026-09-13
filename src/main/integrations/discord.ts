import type { Integration } from "@shared/contracts";

/** Discord message content limit. */
export const discordMessageLimit = 2000;
export const discordPhotoUploadLimit = 10 * 1024 * 1024;
export const discordDocumentUploadLimit = 25 * 1024 * 1024;
export const discordDownloadLimit = 25 * 1024 * 1024;

export const discordCredentialKey = "integration:discord:bot";

export const discordDefaultReceiptEmoji = "👀";

/**
 * Minimum invite permissions: View Channel, Send Messages, Send Messages in
 * Threads, Create Public Threads, Embed Links, Attach Files, Read Message
 * History, Add Reactions. Not Administrator.
 */
export const discordInvitePermissions =
  (1n << 6n) | // Add Reactions
  (1n << 10n) | // View Channel
  (1n << 11n) | // Send Messages
  (1n << 14n) | // Embed Links
  (1n << 15n) | // Attach Files
  (1n << 16n) | // Read Message History
  (1n << 35n) | // Create Public Threads
  (1n << 38n); // Send Messages in Threads

export const discordGatewayIntents =
  (1 << 0) | // GUILDS
  (1 << 9) | // GUILD_MESSAGES
  (1 << 15); // MESSAGE_CONTENT

const applicationFlagMessageContent = 1 << 18;
const applicationFlagMessageContentLimited = 1 << 19;

export const discordChannelType = {
  guildText: 0,
  dm: 1,
  guildAnnouncement: 5,
  announcementThread: 10,
  publicThread: 11,
  privateThread: 12,
  guildForum: 15,
  guildMedia: 16,
} as const;

export function isDiscordThreadType(type: number): boolean {
  return (
    type === discordChannelType.announcementThread ||
    type === discordChannelType.publicThread ||
    type === discordChannelType.privateThread
  );
}

export function isDiscordForumType(type: number): boolean {
  return type === discordChannelType.guildForum || type === discordChannelType.guildMedia;
}

export interface DiscordUser {
  id: string;
  username: string;
  bot?: boolean;
  discriminator?: string;
}

export interface DiscordApplication {
  id: string;
  flags?: number;
  name?: string;
}

export interface DiscordChannel {
  id: string;
  type: number;
  guild_id?: string;
  name?: string;
  parent_id?: string | null;
}

export interface DiscordGuild {
  id: string;
  name: string;
}

export interface DiscordAttachment {
  id: string;
  filename: string;
  size: number;
  url: string;
  proxy_url?: string;
  content_type?: string;
}

export interface DiscordMessageReference {
  message_id?: string;
  channel_id?: string;
  guild_id?: string;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author?: DiscordUser;
  content?: string;
  type?: number;
  attachments?: DiscordAttachment[];
  referenced_message?: DiscordMessage | null;
  message_reference?: DiscordMessageReference;
  thread?: DiscordChannel;
  components?: DiscordMessageComponent[];
}

/** DEFAULT (0) and REPLY (19). System messages (pins, thread-created, joins) are ignored. */
export function isDiscordHumanMessage(message: DiscordMessage): boolean {
  return message.type === 0 || message.type === 19;
}

export interface DiscordButton {
  type: 2;
  style: 1 | 2 | 3 | 4 | 5;
  label: string;
  custom_id: string;
}

export interface DiscordActionRow {
  type: 1;
  components: DiscordButton[];
}

export type DiscordMessageComponent = DiscordActionRow;

export interface DiscordInteraction {
  id: string;
  token: string;
  type: number;
  guild_id?: string;
  channel_id?: string;
  data?: { custom_id?: string };
  member?: { user?: DiscordUser };
  user?: DiscordUser;
  message?: DiscordMessage;
}

export interface DiscordInboundMessageRef {
  channelId: string;
  messageId: string;
  taskId?: string;
  reactedAt?: string;
}

export interface DiscordApprovalEditRequest {
  approvalId: string;
  noticeMessageId: string;
  noticeChannelId: string;
  threadId?: string;
  cancelled?: boolean;
}

/** Config JSON stored on the singleton `discord` integration row. */
export interface DiscordIntegrationConfig {
  botUsername: string;
  botUserId: string;
  applicationId: string;
  coworkerId: string;
  conversationId: string;
  guildId: string | null;
  channelId: string | null;
  channelType: number | null;
  guildName: string | null;
  channelName: string | null;
  pairedThreadId: string | null;
  pairedThreadName: string | null;
  pairedUserId: string | null;
  pairingCode: string;
  threads: Record<string, string>;
  lastThreads: Record<string, string>;
  inboundMessages: Record<string, DiscordInboundMessageRef>;
  receiptEmoji: string;
  receiptReactionDenied: boolean;
  sessionId: string | null;
  lastSequence: number | null;
  resumeUrl: string | null;
  messageContentIntentEnabled: boolean | null;
  approvalEdits: Record<string, DiscordApprovalEditRequest>;
  refusedChannels: string[];
  gatewayError: string | null;
}

function parseInboundMessages(
  value: unknown,
): Record<string, DiscordInboundMessageRef> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, DiscordInboundMessageRef> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const ref = item as Partial<DiscordInboundMessageRef>;
    if (typeof ref.channelId !== "string" || typeof ref.messageId !== "string") continue;
    result[key] = {
      channelId: ref.channelId,
      messageId: ref.messageId,
      taskId: typeof ref.taskId === "string" ? ref.taskId : undefined,
      reactedAt: typeof ref.reactedAt === "string" ? ref.reactedAt : undefined,
    };
  }
  return result;
}

function parseApprovalEdits(value: unknown): Record<string, DiscordApprovalEditRequest> {
  return Object.fromEntries(
    Object.entries((value ?? {}) as Record<string, DiscordApprovalEditRequest>).filter(
      ([id, item]) =>
        /^\d+$/.test(id) &&
        item &&
        typeof item === "object" &&
        typeof item.approvalId === "string" &&
        typeof item.noticeMessageId === "string" &&
        typeof item.noticeChannelId === "string" &&
        (item.threadId === undefined || typeof item.threadId === "string"),
    ),
  );
}

export function parseDiscordConfig(integration: Integration): DiscordIntegrationConfig {
  const config = integration.config as Partial<DiscordIntegrationConfig>;
  return {
    botUsername: typeof config.botUsername === "string" ? config.botUsername : "",
    botUserId: typeof config.botUserId === "string" ? config.botUserId : "",
    applicationId: typeof config.applicationId === "string" ? config.applicationId : "",
    coworkerId: typeof config.coworkerId === "string" ? config.coworkerId : "",
    conversationId: typeof config.conversationId === "string" ? config.conversationId : "",
    guildId: typeof config.guildId === "string" ? config.guildId : null,
    channelId: typeof config.channelId === "string" ? config.channelId : null,
    channelType: typeof config.channelType === "number" ? config.channelType : null,
    guildName: typeof config.guildName === "string" ? config.guildName : null,
    channelName: typeof config.channelName === "string" ? config.channelName : null,
    pairedThreadId: typeof config.pairedThreadId === "string" ? config.pairedThreadId : null,
    pairedThreadName: typeof config.pairedThreadName === "string" ? config.pairedThreadName : null,
    pairedUserId: typeof config.pairedUserId === "string" ? config.pairedUserId : null,
    pairingCode: typeof config.pairingCode === "string" ? config.pairingCode : "",
    threads:
      config.threads && typeof config.threads === "object" && !Array.isArray(config.threads)
        ? (config.threads as Record<string, string>)
        : {},
    lastThreads:
      config.lastThreads &&
      typeof config.lastThreads === "object" &&
      !Array.isArray(config.lastThreads)
        ? (config.lastThreads as Record<string, string>)
        : {},
    inboundMessages: parseInboundMessages(config.inboundMessages),
    receiptEmoji:
      typeof config.receiptEmoji === "string" ? config.receiptEmoji : discordDefaultReceiptEmoji,
    receiptReactionDenied: config.receiptReactionDenied === true,
    sessionId: typeof config.sessionId === "string" ? config.sessionId : null,
    lastSequence: typeof config.lastSequence === "number" ? config.lastSequence : null,
    resumeUrl: typeof config.resumeUrl === "string" ? config.resumeUrl : null,
    messageContentIntentEnabled:
      typeof config.messageContentIntentEnabled === "boolean"
        ? config.messageContentIntentEnabled
        : null,
    approvalEdits: parseApprovalEdits(config.approvalEdits),
    refusedChannels: Array.isArray(config.refusedChannels)
      ? config.refusedChannels.filter((item): item is string => typeof item === "string")
      : [],
    gatewayError: typeof config.gatewayError === "string" ? config.gatewayError : null,
  };
}

export function messageContentIntentEnabled(flags: number | undefined): boolean {
  if (typeof flags !== "number") return false;
  return (
    (flags & applicationFlagMessageContent) !== 0 ||
    (flags & applicationFlagMessageContentLimited) !== 0
  );
}

export function discordInviteUrl(applicationId: string): string | null {
  if (!applicationId) return null;
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(applicationId)}&scope=bot&permissions=${discordInvitePermissions.toString()}`;
}

export function discordIntentSettingsUrl(applicationId: string): string | null {
  if (!applicationId) return null;
  return `https://discord.com/developers/applications/${encodeURIComponent(applicationId)}/bot`;
}

/** A single unicode emoji, otherwise the default 👀. */
export function resolveDiscordReceiptEmoji(value: string | undefined): string {
  const candidate = (value ?? "").trim();
  if (!candidate) return discordDefaultReceiptEmoji;
  try {
    const graphemes = [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(candidate)];
    if (graphemes.length !== 1) return discordDefaultReceiptEmoji;
    if (!/\p{Extended_Pictographic}/u.test(candidate)) return discordDefaultReceiptEmoji;
    return candidate;
  } catch {
    return discordDefaultReceiptEmoji;
  }
}

export function redactDiscordPath(path: string): string {
  return path.replace(/\/interactions\/[^/]+\/[^/]+/g, "/interactions/<id>/<token>");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function discordRetryAfterSeconds(response: Response): Promise<number> {
  const header = Number(response.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return header;
  try {
    const body = (await response.clone().json()) as { retry_after?: number };
    if (typeof body.retry_after === "number" && body.retry_after > 0) return body.retry_after;
  } catch {
    // Use the default below.
  }
  return 1;
}

const discordCdnHosts = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

export function mintDiscordPairingCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

export class DiscordApiError extends Error {
  constructor(
    readonly status: number,
    description: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Discord API error ${status}: ${description}`);
    this.name = "DiscordApiError";
  }
}

const jsonCallTimeoutMs = 30_000;
const uploadTimeoutMs = 120_000;

export type DiscordWebSocketConstructor = new (url: string) => WebSocket;

/**
 * Minimal fetch-based Discord REST client. No SDK; every call hits
 * https://discord.com/api/v10 directly, mirroring the Telegram client.
 */
export class DiscordRestApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = "https://discord.com/api/v10",
  ) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bot ${this.token}`,
      "User-Agent": "Coworker (https://github.com/donvito/coworker, 1.0)",
      ...extra,
    };
  }

  private async unwrap<T>(method: string, response: Response): Promise<T> {
    if (response.status === 204) return undefined as T;
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error(`Discord ${method} returned an unreadable response (${response.status})`);
    }
    if (!response.ok) {
      const error = (body ?? {}) as { message?: string; retry_after?: number };
      throw new DiscordApiError(
        response.status,
        error.message ?? "unknown error",
        typeof error.retry_after === "number" ? error.retry_after : undefined,
      );
    }
    return body as T;
  }

  private async request<T>(
    method: string,
    path: string,
    options?: { body?: unknown; timeoutMs?: number; contentType?: string },
  ): Promise<T> {
    const label = `${method} ${redactDiscordPath(path)}`;
    let attempt = 0;
    while (true) {
      const timeout = AbortSignal.timeout(options?.timeoutMs ?? jsonCallTimeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: this.headers(
            options?.body !== undefined && !(options.body instanceof FormData)
              ? { "Content-Type": options.contentType ?? "application/json" }
              : undefined,
          ),
          body:
            options?.body === undefined
              ? undefined
              : options.body instanceof FormData
                ? options.body
                : JSON.stringify(options.body),
          signal: timeout,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new Error(`Discord ${label} was aborted`);
        }
        if (error instanceof DOMException && error.name === "TimeoutError") {
          throw new Error(`Discord ${label} timed out`);
        }
        throw new Error(`Discord ${label} failed: could not reach discord.com`);
      }
      if (response.status === 429 && attempt < 3) {
        const retryAfter = await discordRetryAfterSeconds(response);
        await delay(Math.min(Math.max(retryAfter, 0.2) * 1000, 10_000));
        attempt += 1;
        continue;
      }
      return this.unwrap<T>(label, response);
    }
  }

  getMe(): Promise<DiscordUser> {
    return this.request<DiscordUser>("GET", "/users/@me");
  }

  getApplication(): Promise<DiscordApplication> {
    return this.request<DiscordApplication>("GET", "/applications/@me");
  }

  getGateway(): Promise<{ url: string }> {
    return this.request<{ url: string }>("GET", "/gateway");
  }

  getChannel(channelId: string): Promise<DiscordChannel> {
    return this.request<DiscordChannel>("GET", `/channels/${channelId}`);
  }

  getGuild(guildId: string): Promise<DiscordGuild> {
    return this.request<DiscordGuild>("GET", `/guilds/${guildId}`);
  }

  sendMessage(input: {
    channelId: string;
    content: string;
    components?: DiscordMessageComponent[];
    messageReference?: { message_id: string };
  }): Promise<DiscordMessage> {
    return this.request<DiscordMessage>("POST", `/channels/${input.channelId}/messages`, {
      body: {
        content: input.content,
        components: input.components,
        message_reference: input.messageReference,
      },
    });
  }

  editMessage(input: {
    channelId: string;
    messageId: string;
    content: string;
    components?: DiscordMessageComponent[];
  }): Promise<DiscordMessage> {
    return this.request<DiscordMessage>(
      "PATCH",
      `/channels/${input.channelId}/messages/${input.messageId}`,
      {
        body: {
          content: input.content,
          components: input.components ?? [],
        },
      },
    );
  }

  async triggerTyping(channelId: string): Promise<void> {
    await this.request<void>("POST", `/channels/${channelId}/typing`);
  }

  async addReaction(input: { channelId: string; messageId: string; emoji: string }): Promise<void> {
    const encoded = encodeURIComponent(input.emoji);
    await this.request<void>(
      "PUT",
      `/channels/${input.channelId}/messages/${input.messageId}/reactions/${encoded}/@me`,
    );
  }

  createThread(input: {
    channelId: string;
    name: string;
    forum?: boolean;
    message?: string;
  }): Promise<DiscordChannel> {
    const name = input.name.slice(0, 100) || "Conversation";
    if (input.forum) {
      return this.request<DiscordChannel>("POST", `/channels/${input.channelId}/threads`, {
        body: {
          name,
          auto_archive_duration: 10080,
          message: { content: input.message || "Started from Coworker." },
        },
      });
    }
    return this.request<DiscordChannel>("POST", `/channels/${input.channelId}/threads`, {
      body: { name, type: discordChannelType.publicThread, auto_archive_duration: 10080 },
    });
  }

  async sendAttachment(input: {
    channelId: string;
    data: Uint8Array;
    fileName: string;
    mimeType: string;
    content?: string;
  }): Promise<DiscordMessage> {
    const form = new FormData();
    form.set(
      "payload_json",
      JSON.stringify({
        content: input.content ?? "",
        attachments: [{ id: 0, filename: input.fileName }],
      }),
    );
    form.set(
      "files[0]",
      new Blob([input.data as BlobPart], { type: input.mimeType || "application/octet-stream" }),
      input.fileName,
    );
    return this.request<DiscordMessage>("POST", `/channels/${input.channelId}/messages`, {
      body: form,
      timeoutMs: uploadTimeoutMs,
    });
  }

  async answerInteraction(input: {
    interactionId: string;
    token: string;
    type: number;
    content?: string;
    ephemeral?: boolean;
  }): Promise<void> {
    await this.request<void>("POST", `/interactions/${input.interactionId}/${input.token}/callback`, {
      body: {
        type: input.type,
        data:
          input.content === undefined
            ? undefined
            : {
                content: input.content,
                ...(input.ephemeral ? { flags: 64 } : {}),
              },
      },
    });
  }

  async downloadAttachment(url: string, maxBytes = discordDownloadLimit): Promise<Uint8Array> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("Discord file download rejected: invalid URL");
    }
    if (!discordCdnHosts.has(parsed.hostname.toLowerCase())) {
      throw new Error("Discord file download rejected: unexpected host");
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(uploadTimeoutMs),
      });
    } catch {
      throw new Error("Discord file download failed: could not reach discord.com");
    }
    if (!response.ok) {
      throw new Error(`Discord file download failed (${response.status})`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error("The Discord file is larger than the supported download size");
    }
    return bytes;
  }
}
