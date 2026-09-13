import { readFile, writeFile } from "node:fs/promises";
import { basename, posix } from "node:path";
import { EventType } from "@ag-ui/core";
import type {
  Approval,
  ApprovalDecisionInput,
  Conversation,
  ConversationDispatchReceipt,
  ConversationImageInput,
  CreateConversationInput,
  DesktopEvent,
  Message,
  SendConversationMessageInput,
  Task,
} from "@shared/contracts";
import type { CoworkerDatabase } from "@main/db/database";
import type { CredentialStore } from "@main/security/credential-store";
import { maxAttachedImageBytes, supportedImageMimeTypes } from "@main/integrations/image-attachments";
import { getModelCapabilities } from "@main/integrations/model-catalog";
import { editedWorkspaceTextPayload, workspaceTextApproval } from "@shared/workspace-text-approval";
import { resolveWorkspacePath } from "@main/tools/workspace-path";
import { resolveWorkspaceOutputPath } from "@main/tools/workspace-text";
import { markdownToDiscordChunks, plainTextChunks } from "./discord-format";
import { DiscordGateway, isDiscordChannel, isDiscordInteraction, isDiscordMessage } from "./discord-gateway";
import {
  DiscordApiError,
  DiscordRestApi,
  discordCredentialKey,
  discordDownloadLimit,
  isDiscordForumType,
  isDiscordHumanMessage,
  isDiscordThreadType,
  parseDiscordConfig,
  resolveDiscordReceiptEmoji,
  type DiscordApprovalEditRequest,
  type DiscordChannel,
  type DiscordInboundMessageRef,
  type DiscordIntegrationConfig,
  type DiscordInteraction,
  type DiscordMessage,
  type DiscordMessageComponent,
  type DiscordWebSocketConstructor,
} from "./discord";

export interface DiscordBridgeHost {
  sendConversationMessage(
    input: SendConversationMessageInput,
  ): Promise<ConversationDispatchReceipt>;
  createConversation(input: CreateConversationInput): Conversation;
  updateConversation(id: string, input: { title?: string }): Conversation;
  decideApproval(input: ApprovalDecisionInput): Promise<Approval>;
  cancelTask(id: string): Promise<Task>;
  subscribe(listener: (event: DesktopEvent) => void): () => void;
  beginDataMutation(): () => void;
}

export interface DiscordBridgeOptions {
  database: CoworkerDatabase;
  credentials: CredentialStore;
  host: DiscordBridgeHost;
  emit: (event: DesktopEvent) => void;
  onError?: (scope: string, error: unknown) => void;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: DiscordWebSocketConstructor;
  typingKeepAliveMs?: number;
}

const maxBackoffIdleMs = 10 * 60_000;
const typingKeepAliveMs = 8_000;
const stoppedFallbackMs = 5_000;

interface DiscordRunBuffer {
  taskId: string;
  conversationId: string;
  text: string;
  lastActivityAt: number;
  targetChannelId: string;
  typingTimer: NodeJS.Timeout | null;
  stopTimer: NodeJS.Timeout | null;
  stopRequested: boolean;
  pendingSeparator: boolean;
  finalized: boolean;
}

function titleFromText(text: string): string {
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  if (!firstLine) return "";
  return firstLine.length > 48 ? `${firstLine.slice(0, 45)}…` : firstLine;
}

function safeInboxFileName(name: string | undefined, fallback: string): string {
  const base = basename((name ?? "").replaceAll("\\", "/"))
    .replace(/[\0<>:"|?*]/g, "")
    .replace(/^\.+/, "")
    .trim();
  return base || fallback;
}

function isImageMime(mime: string | undefined, fileName: string): boolean {
  return discordImageMime(mime, fileName) !== null;
}

function discordImageMime(
  mime: string | undefined,
  fileName: string,
): ConversationImageInput["mimeType"] | null {
  const normalized = (mime ?? "").split(";")[0]?.trim().toLowerCase();
  if (normalized && (supportedImageMimeTypes as readonly string[]).includes(normalized)) {
    return normalized as ConversationImageInput["mimeType"];
  }
  if (/\.jpe?g$/i.test(fileName)) return "image/jpeg";
  if (/\.png$/i.test(fileName)) return "image/png";
  if (/\.webp$/i.test(fileName)) return "image/webp";
  if (/\.gif$/i.test(fileName)) return "image/gif";
  return null;
}

/**
 * Two-way bridge between one Discord bot's paired guild channel and the
 * linked coworker's conversations. Inbound events arrive over the Gateway;
 * outbound mirroring listens to the desktop event bus. Lifecycle mirrors
 * TelegramBridgeService.
 */
export class DiscordBridgeService {
  private running = false;
  private api: DiscordRestApi | null = null;
  private gateway: DiscordGateway | null = null;
  private config: DiscordIntegrationConfig | null = null;
  private unsubscribe: (() => void) | null = null;
  private outbound: Promise<void> = Promise.resolve();
  private readonly injectedMessageIds = new Set<string>();
  private readonly cursors = new Map<string, string>();
  private readonly mirroredMessageIds = new Set<string>();
  private readonly runBuffers = new Map<string, DiscordRunBuffer>();
  private readonly stoppedRuns = new Set<string>();
  private readonly refusedChannels = new Set<string>();
  private readonly threadFailureLogged = new Set<string>();
  private readonly inboundThreadOrigins = new Map<string, string>();
  private readonly lastInboundThread = new Map<string, string>();
  private readonly notifiedApprovals = new Set<string>();
  private readonly approvalNotices = new Map<string, { messageId: string; channelId: string }>();
  private readonly pendingThreadNames = new Map<string, string>();
  private readonly channelCache = new Map<string, DiscordChannel>();
  private sequenceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSequence: { lastSequence: number | null; sessionId: string | null } | null = null;

  constructor(private readonly options: DiscordBridgeOptions) {}

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    const integration = this.options.database.getDiscordIntegration();
    if (!integration || (integration.status !== "connected" && integration.status !== "error")) {
      return;
    }
    const token = await this.readToken();
    if (!token) return;

    this.config = parseDiscordConfig(integration);
    this.api = new DiscordRestApi(token, this.options.fetchImpl ?? fetch);
    this.running = true;
    for (const channelId of this.config.refusedChannels) this.refusedChannels.add(channelId);
    this.initializeCursors();
    this.unsubscribe = this.options.host.subscribe((event) => this.handleEvent(event));
    this.gateway = new DiscordGateway({
      token,
      api: this.api,
      WebSocketImpl: this.options.WebSocketImpl,
      sessionId: this.config.sessionId,
      lastSequence: this.config.lastSequence,
      resumeUrl: this.config.resumeUrl,
      handlers: {
        onReady: (sessionId, resumeUrl) => {
          this.saveConfig(
            { sessionId, resumeUrl: resumeUrl ?? this.config?.resumeUrl ?? null, gatewayError: null },
            { notify: false },
          );
          const current = this.options.database.getDiscordIntegration();
          if (current?.status === "error") {
            this.options.database.updateDiscordIntegration({ status: "connected" });
            this.options.emit({ type: "entity.changed", entity: "integrations", id: current.id });
          }
        },
        onSequence: (lastSequence, sessionId) => {
          this.queueSequenceWrite(lastSequence, sessionId);
        },
        onDispatch: (event) => this.handleDispatch(event.t, event.d),
        onClose: (code, reason) => {
          if (code === 1000 || code === 1001 || code === 4000) return;
          this.saveConfig(
            { gatewayError: reason ? `Discord Gateway closed (${code}): ${reason}` : `Discord Gateway closed (${code}).` },
            { notify: true },
          );
        },
        onFatal: (code, hint) => {
          this.saveConfig(
            {
              gatewayError: hint,
              messageContentIntentEnabled: code === 4014 ? false : this.config?.messageContentIntentEnabled ?? null,
            },
            { notify: false },
          );
          this.options.database.updateDiscordIntegration({ status: "error" });
          this.options.emit({ type: "entity.changed", entity: "integrations" });
          this.options.database.addActivity({ type: "discord.gateway_error", summary: hint });
          this.options.emit({ type: "entity.changed", entity: "activity" });
        },
        onError: (scope, error) => this.options.onError?.(scope, error),
      },
    });
    await this.gateway.start();
    this.enqueueOutbound(() => this.syncApprovals());
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.flushSequenceWrite();
    await this.gateway?.stop();
    this.flushSequenceWrite();
    this.gateway = null;
    await this.outbound.catch(() => undefined);
    this.api = null;
    this.config = null;
    for (const buffer of this.runBuffers.values()) {
      if (buffer.typingTimer) clearTimeout(buffer.typingTimer);
      if (buffer.stopTimer) clearTimeout(buffer.stopTimer);
    }
    this.runBuffers.clear();
    this.stoppedRuns.clear();
    this.cursors.clear();
    this.mirroredMessageIds.clear();
    this.injectedMessageIds.clear();
    this.refusedChannels.clear();
    this.threadFailureLogged.clear();
    this.inboundThreadOrigins.clear();
    this.lastInboundThread.clear();
    this.notifiedApprovals.clear();
    this.approvalNotices.clear();
    this.pendingThreadNames.clear();
    this.channelCache.clear();
  }

  async wake(): Promise<void> {
    if (this.running) {
      await this.gateway?.wake();
      return;
    }
    await this.start();
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  private async readToken(): Promise<string | null> {
    try {
      return await this.options.credentials.get(discordCredentialKey);
    } catch (error) {
      this.options.onError?.("discord.credentials", error);
      return null;
    }
  }

  private initializeCursors(): void {
    const config = this.config;
    if (!config?.coworkerId) return;
    for (const conversation of this.options.database.listConversations(config.coworkerId)) {
      if (conversation.kind !== "direct") continue;
      const messages = this.options.database.listConversationMessages(conversation.id);
      this.seedCursor(conversation.id, messages);
    }
  }

  private seedCursor(conversationId: string, messages: Message[]): void {
    const latest = messages.at(-1)?.createdAt ?? "";
    this.cursors.set(conversationId, latest);
    for (const message of messages) {
      if (message.createdAt >= latest) this.mirroredMessageIds.add(message.id);
    }
  }

  private async handleDispatch(event: string, data: unknown): Promise<void> {
    try {
      if (event === "MESSAGE_CREATE" && isDiscordMessage(data)) {
        await this.handleMessage(data);
        return;
      }
      if ((event === "THREAD_CREATE" || event === "THREAD_UPDATE") && isDiscordChannel(data)) {
        this.cacheChannel(data);
        if (data.name) this.pendingThreadNames.set(data.id, data.name);
        if (event === "THREAD_UPDATE" && data.name) this.renameMappedConversation(data.id, data.name);
        return;
      }
      if (event === "INTERACTION_CREATE" && isDiscordInteraction(data)) {
        await this.handleInteraction(data);
      }
    } catch (error) {
      this.options.onError?.("discord.dispatch", error);
    }
  }

  private cacheChannel(channel: DiscordChannel): void {
    this.channelCache.set(channel.id, channel);
  }

  private async resolveChannel(channelId: string): Promise<DiscordChannel | null> {
    const cached = this.channelCache.get(channelId);
    if (cached) return cached;
    if (!this.api) return null;
    try {
      const channel = await this.api.getChannel(channelId);
      this.cacheChannel(channel);
      return channel;
    } catch (error) {
      this.options.onError?.("discord.channel", error);
      return null;
    }
  }

  private async handleMessage(message: DiscordMessage): Promise<void> {
    const config = this.config;
    if (!config || !this.api) return;
    if (!message.guild_id) return; // DMs are out of v1.
    if (message.author?.bot) return;
    if (message.author?.id && message.author.id === config.botUserId) return;
    if (!isDiscordHumanMessage(message)) return;

    const text = (message.content ?? "").trim();
    const channel = await this.resolveChannel(message.channel_id);
    const knownThread = Boolean(config.threads[message.channel_id] || message.thread);
    const inThread = Boolean((channel && isDiscordThreadType(channel.type)) || knownThread);
    const parentId = inThread
      ? (channel?.parent_id ?? message.thread?.parent_id ?? config.channelId)
      : message.channel_id;

    if (config.pairingCode && text.toUpperCase() === config.pairingCode.toUpperCase()) {
      if (config.channelId === null) {
        await this.completePairing(message, channel);
        return;
      }
      if (parentId === config.channelId && message.guild_id === config.guildId) {
        await this.sendPlain(
          message.channel_id,
          `You're already connected — messages here go to ${this.linkedCoworkerName()}. Just send a message.`,
        );
        return;
      }
    }

    if (config.channelId === null || config.guildId === null) {
      await this.refuseUnpairedChannel(message.channel_id, text);
      return;
    }
    if (message.guild_id !== config.guildId || parentId !== config.channelId) {
      await this.refuseUnpairedChannel(message.channel_id, text);
      return;
    }

    if (await this.handleApprovalEditReply(message, inThread ? message.channel_id : undefined)) {
      return;
    }

    if (text === "/stop" || text.startsWith("/stop ")) {
      await this.handleStopCommand(message, inThread ? message.channel_id : undefined);
      return;
    }

    const conversationId = await this.resolveInboundConversation(message, channel);
    const images = await this.collectInboundImages(message);
    const documentNote = await this.collectInboundDocuments(message);
    const combined = [message.content ?? "", documentNote].filter(Boolean).join("\n\n");
    if (!combined.trim() && images.length === 0) {
      await this.sendPlain(
        message.channel_id,
        "I can only receive text, photos, and files here for now.",
      );
      return;
    }

    const clientMessageId = `discord:${message.id}`;
    this.injectedMessageIds.add(clientMessageId);
    if (inThread) {
      this.inboundThreadOrigins.set(clientMessageId, message.channel_id);
      this.lastInboundThread.set(conversationId, message.channel_id);
      if (config.lastThreads[conversationId] !== message.channel_id) {
        this.saveConfig(
          {
            lastThreads: { ...config.lastThreads, [conversationId]: message.channel_id },
          },
          { notify: false },
        );
      }
    }

    const release = this.tryBeginMutation();
    if (!release) {
      await this.sendPlain(
        message.channel_id,
        "The app is briefly busy creating a backup. Please resend this in a moment.",
      );
      return;
    }
    try {
      const receipt = await this.options.host.sendConversationMessage({
        conversationId,
        clientMessageId,
        content: combined,
        mentionedCoworkerIds: [],
        images: images.length > 0 ? images : undefined,
      });
      const taskId = receipt.runs[0]?.taskId;
      this.persistInboundRef(clientMessageId, {
        channelId: message.channel_id,
        messageId: message.id,
        taskId,
      });
      this.options.emit({
        type: "conversation.inbound",
        coworkerId: config.coworkerId,
        conversationId,
        source: "discord",
      });
    } catch (error) {
      this.options.onError?.("discord.inbound", error);
      await this.sendPlain(
        message.channel_id,
        `I couldn't pass that on: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    } finally {
      release();
    }
  }

  private persistInboundRef(clientMessageId: string, ref: DiscordInboundMessageRef): void {
    const config = this.config;
    if (!config) return;
    this.saveConfig(
      {
        inboundMessages: { ...config.inboundMessages, [clientMessageId]: ref },
      },
      { notify: false },
    );
  }

  private async completePairing(
    message: DiscordMessage,
    channel: DiscordChannel | null,
  ): Promise<void> {
    if (!this.api || !message.guild_id) return;
    const inThread = Boolean(channel && isDiscordThreadType(channel.type));
    const parentId = inThread ? channel?.parent_id : message.channel_id;
    if (!parentId) {
      await this.sendPlain(
        message.channel_id,
        "I couldn't see the parent channel for that thread. Try posting the code in the channel itself.",
      );
      return;
    }
    const parent = inThread ? await this.resolveChannel(parentId) : channel;
    let guildName: string | null = null;
    try {
      guildName = (await this.api.getGuild(message.guild_id)).name;
    } catch (error) {
      this.options.onError?.("discord.guild", error);
    }
    const threadName = inThread ? (channel?.name ?? this.pendingThreadNames.get(message.channel_id) ?? null) : null;
    const patch: Partial<DiscordIntegrationConfig> = {
      guildId: message.guild_id,
      channelId: parentId,
      channelType: parent?.type ?? null,
      guildName,
      channelName: parent?.name ?? channel?.name ?? null,
      pairedUserId: message.author?.id ?? null,
      pairedThreadId: inThread ? message.channel_id : null,
      pairedThreadName: threadName,
    };
    this.saveConfig(patch);
    if (inThread) {
      const conversation = this.createThreadConversation(
        threadName || titleFromText(message.content ?? "") || `Discord thread ${message.channel_id}`,
      );
      if (conversation) {
        this.saveConfig({
          threads: { ...this.config!.threads, [message.channel_id]: conversation.id },
          lastThreads: { ...this.config!.lastThreads, [conversation.id]: message.channel_id },
        });
      }
    }
    const coworkerName = this.linkedCoworkerName();
    this.options.database.addActivity({
      type: "discord.paired",
      summary: `Discord channel paired with ${coworkerName}`,
    });
    this.options.emit({ type: "entity.changed", entity: "activity" });
    await this.sendPlain(
      message.channel_id,
      `Connected. Messages here go to ${coworkerName}.`,
    );
  }

  private createThreadConversation(title: string): Conversation | null {
    const config = this.config;
    if (!config) return null;
    const release = this.tryBeginMutation();
    if (!release) return null;
    try {
      const conversation = this.options.host.createConversation({
        coworkerId: config.coworkerId,
        title,
      });
      this.cursors.set(conversation.id, "");
      return conversation;
    } catch (error) {
      this.options.onError?.("discord.thread", error);
      return null;
    } finally {
      release();
    }
  }

  private looksLikePairingAttempt(text: string): boolean {
    const config = this.config;
    if (!config) return false;
    const compact = text.replace(/\s/g, "");
    if (config.pairingCode && compact.toUpperCase() === config.pairingCode.toUpperCase()) return true;
    if (/^[0-9A-Fa-f]{16}$/.test(compact)) return true;
    if (/^[A-Za-z0-9_-]{8,32}$/.test(compact)) return true;
    if (config.botUserId && text.includes(`<@${config.botUserId}>`)) return true;
    if (config.botUsername && new RegExp(`@${config.botUsername}\\b`, "i").test(text)) return true;
    return false;
  }

  private persistRefusedChannel(channelId: string): void {
    if (this.refusedChannels.has(channelId)) return;
    this.refusedChannels.add(channelId);
    const refused = [...new Set([...(this.config?.refusedChannels ?? []), channelId])].slice(-256);
    this.saveConfig({ refusedChannels: refused }, { notify: false });
  }

  private async refuseUnpairedChannel(channelId: string, text: string): Promise<void> {
    if (this.refusedChannels.has(channelId)) return;
    this.persistRefusedChannel(channelId);
    this.options.database.addActivity({
      type: "discord.refused",
      summary:
        "Refused a Discord message from an unpaired channel — post the pairing code from Settings → Integrations in the channel or thread you want",
    });
    this.options.emit({ type: "entity.changed", entity: "activity" });
    if (!this.looksLikePairingAttempt(text)) return;
    await this.sendPlain(
      channelId,
      "This bot is private. To connect, invite it from Coworker's Settings → Integrations, then post the pairing code shown there in this channel or thread.",
    );
  }

  private async resolveInboundConversation(
    message: DiscordMessage,
    channel: DiscordChannel | null,
  ): Promise<string> {
    const config = this.config!;
    const inThread = Boolean(channel && isDiscordThreadType(channel.type));
    if (!inThread) return config.conversationId;
    const mapped = config.threads[message.channel_id];
    if (mapped) return mapped;
    const title =
      channel?.name?.trim() ||
      this.pendingThreadNames.get(message.channel_id)?.trim() ||
      titleFromText(message.content ?? "") ||
      `Discord thread ${message.channel_id}`;
    this.pendingThreadNames.delete(message.channel_id);
    const conversation = this.createThreadConversation(title);
    if (!conversation) return config.conversationId;
    this.saveConfig({
      threads: { ...config.threads, [message.channel_id]: conversation.id },
    });
    return conversation.id;
  }

  private async collectInboundImages(message: DiscordMessage): Promise<ConversationImageInput[]> {
    const attachments = (message.attachments ?? []).filter((item) =>
      isImageMime(item.content_type, item.filename),
    );
    if (attachments.length === 0 || !this.api) return [];
    if (!(await this.coworkerSupportsImages())) {
      await this.sendPlain(
        message.channel_id,
        `${this.linkedCoworkerName()}'s current model can't view photos, so I passed on your text only.`,
      );
      return [];
    }
    const images: ConversationImageInput[] = [];
    for (const attachment of attachments.slice(0, 4)) {
      if (attachment.size > maxAttachedImageBytes) {
        await this.sendPlain(
          message.channel_id,
          "That photo is too large for me to import (8 MB limit).",
        );
        continue;
      }
      try {
        const bytes = await this.api.downloadAttachment(attachment.url, maxAttachedImageBytes);
        images.push({
          data: Buffer.from(bytes).toString("base64"),
          mimeType: discordImageMime(attachment.content_type, attachment.filename) ?? "image/jpeg",
          name: safeInboxFileName(attachment.filename, `discord-photo-${attachment.id}.jpg`),
          size: bytes.byteLength,
        });
      } catch (error) {
        this.options.onError?.("discord.photo", error);
        await this.sendPlain(message.channel_id, "I couldn't download that photo from Discord.");
      }
    }
    return images;
  }

  private async collectInboundDocuments(message: DiscordMessage): Promise<string | null> {
    const documents = (message.attachments ?? []).filter(
      (item) => !isImageMime(item.content_type, item.filename),
    );
    if (documents.length === 0 || !this.api || !this.config) return null;
    const notes: string[] = [];
    for (const document of documents) {
      if (document.size > discordDownloadLimit) {
        await this.sendPlain(
          message.channel_id,
          "That file is larger than I can download from Discord (25 MB limit).",
        );
        continue;
      }
      try {
        const coworker = this.options.database.getCoworker(this.config.coworkerId);
        const bytes = await this.api.downloadAttachment(document.url);
        const fileName = safeInboxFileName(document.filename, `file-${document.id}`);
        const relativePath = posix.join("discord-inbox", `${document.id}-${fileName}`);
        const absolutePath = await resolveWorkspaceOutputPath(coworker.workspacePath, relativePath);
        await writeFile(absolutePath, bytes, { mode: 0o600 });
        notes.push(`(File received via Discord and saved in the workspace at ${relativePath})`);
      } catch (error) {
        this.options.onError?.("discord.document", error);
        await this.sendPlain(message.channel_id, "I couldn't download that file from Discord.");
      }
    }
    return notes.length > 0 ? notes.join("\n") : null;
  }

  private async handleStopCommand(message: DiscordMessage, threadId?: string): Promise<void> {
    const config = this.config!;
    const conversationId =
      threadId === undefined ? config.conversationId : config.threads[threadId] ?? config.conversationId;
    const running = [...this.runBuffers].filter(
      ([, buffer]) =>
        buffer.conversationId === conversationId && !buffer.finalized && !buffer.stopRequested,
    );
    if (running.length === 0) {
      await this.sendPlain(
        message.channel_id,
        `${this.linkedCoworkerName()} isn't working on anything right now.`,
      );
      return;
    }
    const stopped = await Promise.all(
      running.map(([runId, buffer]) => this.requestStop(runId, buffer)),
    );
    if (stopped.some(Boolean)) {
      await this.sendPlain(message.channel_id, `Stopping ${this.linkedCoworkerName()}…`);
    }
  }

  private async requestStop(runId: string, buffer: DiscordRunBuffer): Promise<boolean> {
    buffer.stopRequested = true;
    this.stoppedRuns.add(runId);
    try {
      await this.options.host.cancelTask(buffer.taskId);
      if (this.runBuffers.get(runId) !== buffer || buffer.finalized) return true;
      buffer.stopTimer = setTimeout(() => {
        buffer.stopTimer = null;
        this.finalizeRun(runId, true);
      }, stoppedFallbackMs);
      buffer.stopTimer.unref?.();
      return true;
    } catch (error) {
      buffer.stopRequested = false;
      this.stoppedRuns.delete(runId);
      this.options.onError?.("discord.stop", error);
      this.enqueueOutbound(() =>
        this.sendPlain(
          buffer.targetChannelId,
          `I couldn't stop ${this.linkedCoworkerName()}: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        ),
      );
      return false;
    }
  }

  private async syncApprovals(): Promise<void> {
    const config = this.config;
    if (!config || !config.channelId || !this.api) return;
    const pendingIds = new Set<string>();
    for (const approval of this.options.database.listApprovals("PENDING")) {
      if (approval.coworkerId !== config.coworkerId) continue;
      pendingIds.add(approval.id);
      if (this.notifiedApprovals.has(approval.id)) continue;
      let channelId: string | null = null;
      try {
        const task = this.options.database.getTask(approval.taskId);
        const target = await this.outboundTarget(task.threadId, task.id);
        if (!target) continue;
        channelId = target;
      } catch {
        continue;
      }
      try {
        const proposal = workspaceTextApproval(approval);
        const content = [
          `${this.linkedCoworkerName()} needs your approval:`,
          approval.summary,
          ...(proposal
            ? [
                "",
                ...(proposal.oldText
                  ? [proposal.text ? "Current text:" : "Text to remove:", proposal.oldText, ""]
                  : []),
                ...(proposal.text ? ["Proposed text:", proposal.text, ""] : []),
                ...(proposal.oldText === null ? ["This replaces the entire saved file."] : []),
                "Nothing is saved until you approve.",
              ]
            : []),
          "",
          "Other messages wait until you decide. You can also decide in the desktop app.",
        ].join("\n");
        const chunks = plainTextChunks(content);
        for (const chunk of chunks.slice(0, -1)) {
          await this.api.sendMessage({ channelId, content: chunk });
        }
        const buttons: DiscordMessageComponent[] = [
          {
            type: 1,
            components: [
              { type: 2, style: 3, label: "Approve", custom_id: `apr:${approval.id}:approve` },
              { type: 2, style: 4, label: "Reject", custom_id: `apr:${approval.id}:reject` },
            ],
          },
        ];
        if (proposal) {
          buttons.push({
            type: 1,
            components: [
              { type: 2, style: 2, label: "Edit & approve", custom_id: `apr:${approval.id}:edit` },
            ],
          });
        }
        if (!proposal?.requiresApproval) {
          buttons.push({
            type: 1,
            components: [
              { type: 2, style: 2, label: "Always allow", custom_id: `apr:${approval.id}:always` },
            ],
          });
        }
        const notice = await this.api.sendMessage({
          channelId,
          content: chunks.at(-1)!,
          components: buttons,
        });
        this.notifiedApprovals.add(approval.id);
        this.approvalNotices.set(approval.id, { messageId: notice.id, channelId });
      } catch (error) {
        this.options.onError?.("discord.approval", error);
      }
    }
    for (const [approvalId, notice] of [...this.approvalNotices]) {
      if (pendingIds.has(approvalId)) continue;
      this.approvalNotices.delete(approvalId);
      try {
        await this.api.editMessage({
          channelId: notice.channelId,
          messageId: notice.messageId,
          content: "This approval was handled in the desktop app.",
        });
      } catch (error) {
        this.options.onError?.("discord.approval", error);
      }
    }
  }

  private async handleInteraction(interaction: DiscordInteraction): Promise<void> {
    const config = this.config;
    if (!config || !this.api) return;
    const user = interaction.member?.user ?? interaction.user;
    const channelId = interaction.channel_id ?? interaction.message?.channel_id;
    const answer = async (type: number, content?: string, ephemeral = false) => {
      try {
        await this.api?.answerInteraction({
          interactionId: interaction.id,
          token: interaction.token,
          type,
          content,
          ephemeral,
        });
      } catch (error) {
        this.options.onError?.("discord.approval", error);
      }
    };
    if (
      !config.channelId ||
      !channelId ||
      !this.channelIsPaired(channelId, interaction.guild_id) ||
      user?.bot
    ) {
      await answer(4, "This channel isn't paired with Coworker.", true);
      return;
    }
    const match = interaction.data?.custom_id?.match(/^apr:([\w-]+):(approve|reject|always|edit)$/);
    if (!match) {
      await answer(4, "This action isn't supported.", true);
      return;
    }
    const [, approvalId, action] = match as unknown as [string, string, string];
    await answer(6);
    const release = this.tryBeginMutation();
    if (!release) {
      await this.sendPlain(channelId, "The app is briefly busy creating a backup. Try again in a moment.");
      return;
    }
    try {
      const pending = this.pendingDiscordApproval(approvalId);
      const proposal = workspaceTextApproval(pending);
      if (action === "edit") {
        if (!proposal) throw new Error("This approval does not support text editing.");
        const prompt = await this.api.sendMessage({
          channelId,
          content: `Edit & approve: ${pending.summary}\n\nReply to this message with the replacement text. Sending your reply approves that exact text. Reply /cancel to keep the original proposal pending. For longer text, use the desktop editor.`,
          ...(interaction.message?.id
            ? { messageReference: { message_id: interaction.message.id } }
            : {}),
        });
        this.saveConfig(
          {
            approvalEdits: {
              ...Object.fromEntries(Object.entries(this.config?.approvalEdits ?? {}).slice(-255)),
              [prompt.id]: {
                approvalId,
                noticeMessageId: interaction.message?.id ?? "",
                noticeChannelId: channelId,
                threadId: this.threadIdIfMapped(channelId),
              } satisfies DiscordApprovalEditRequest,
            },
          },
          { notify: false },
        );
        return;
      }
      if (action === "always") {
        if (proposal?.requiresApproval) throw new Error("This change requires approval every time.");
        const coworker = this.options.database.getCoworker(pending.coworkerId);
        this.options.database.updateCoworker(coworker.id, {
          policies: { ...coworker.policies, [pending.actionType]: "automatic" },
        });
        this.options.emit({ type: "entity.changed", entity: "coworkers", id: coworker.id });
      }
      const decision = action === "reject" ? "reject" : "approve";
      const approval = await this.options.host.decideApproval({ approvalId, decision });
      this.approvalNotices.delete(approvalId);
      const outcome =
        decision === "reject"
          ? "Rejected."
          : action === "always"
            ? `Approved — ${this.linkedCoworkerName()} won't ask again for this action.`
            : "Approved.";
      if (interaction.message) {
        try {
          await this.api.editMessage({
            channelId,
            messageId: interaction.message.id,
            content: `${approval.summary}\n\n${outcome}`,
          });
        } catch (error) {
          this.options.onError?.("discord.approval", error);
        }
      }
    } catch (error) {
      this.options.onError?.("discord.approval", error);
      const detail =
        error instanceof Error ? error.message.slice(0, 180) : "The approval could not be decided.";
      if (interaction.message) {
        try {
          await this.api.editMessage({
            channelId,
            messageId: interaction.message.id,
            content: detail,
          });
        } catch (editError) {
          this.options.onError?.("discord.approval", editError);
        }
      } else {
        await this.sendPlain(channelId, detail);
      }
    } finally {
      release();
    }
  }

  private channelIsPaired(channelId: string, guildId: string | undefined): boolean {
    const config = this.config;
    if (!config?.channelId || !config.guildId) return false;
    if (guildId && guildId !== config.guildId) return false;
    if (channelId === config.channelId) return true;
    return Boolean(config.threads[channelId]);
  }

  private threadIdIfMapped(channelId: string): string | undefined {
    const config = this.config;
    if (!config) return undefined;
    if (config.threads[channelId]) return channelId;
    return undefined;
  }

  private pendingDiscordApproval(id: string): Approval {
    const approval = this.options.database.getApproval(id);
    if (approval.coworkerId !== this.config?.coworkerId) {
      throw new Error("This approval belongs to another coworker.");
    }
    if (approval.status !== "PENDING") throw new Error("This approval has already been decided.");
    return approval;
  }

  private async handleApprovalEditReply(
    message: DiscordMessage,
    threadId?: string,
  ): Promise<boolean> {
    const config = this.config;
    const promptId = message.referenced_message?.id ?? message.message_reference?.message_id;
    const request = promptId === undefined ? undefined : config?.approvalEdits[promptId];
    if (!config || !request || !this.api) return false;
    if (threadId !== request.threadId) {
      await this.sendPlain(
        message.channel_id,
        "Reply to the edit prompt in its original channel and thread.",
      );
      return true;
    }
    if (request.cancelled) {
      await this.sendPlain(
        message.channel_id,
        "This edit was cancelled. Tap Edit & approve again to change the proposal.",
      );
      return true;
    }
    const release = this.tryBeginMutation();
    if (!release) {
      await this.sendPlain(
        message.channel_id,
        "The app is briefly busy creating a backup. Please resend this reply in a moment.",
      );
      return true;
    }
    try {
      const pending = this.pendingDiscordApproval(request.approvalId);
      if (message.content?.trim() === "/cancel") {
        this.saveConfig(
          {
            approvalEdits: {
              ...config.approvalEdits,
              [promptId!]: { ...request, cancelled: true },
            },
          },
          { notify: false },
        );
        await this.sendPlain(
          message.channel_id,
          "Edit cancelled. The original proposal is still waiting for approval.",
        );
        return true;
      }
      if (!message.content?.trim() || (message.attachments?.length ?? 0) > 0) {
        throw new Error("Reply with replacement text only, or /cancel. Nothing has been approved.");
      }
      const payload = editedWorkspaceTextPayload(pending, message.content);
      const approved = await this.options.host.decideApproval({
        approvalId: pending.id,
        decision: "edit",
        payload,
      });
      this.approvalNotices.delete(approved.id);
      try {
        await this.api.editMessage({
          channelId: request.noticeChannelId,
          messageId: request.noticeMessageId,
          content: `${approved.summary}\n\nEdited and approved. The reviewed text is in your reply.`,
        });
      } catch (error) {
        this.options.onError?.("discord.approval", error);
      }
      await this.sendPlain(
        message.channel_id,
        "Edited text approved. The coworker will now apply the change.",
      );
    } catch (error) {
      await this.sendPlain(
        message.channel_id,
        error instanceof Error ? error.message : "The edited approval could not be applied.",
      );
    } finally {
      release();
    }
    return true;
  }

  private handleEvent(event: DesktopEvent): void {
    try {
      if (event.type === "agent.event") this.handleAgentEvent(event);
      if (event.type === "entity.changed" && event.entity === "conversations" && event.id) {
        const conversationId = event.id;
        this.enqueueOutbound(() => this.mirrorConversation(conversationId));
      }
      if (event.type === "entity.changed" && event.entity === "approvals") {
        this.enqueueOutbound(() => this.syncApprovals());
      }
    } catch (error) {
      this.options.onError?.("discord.event", error);
    }
  }

  private handleAgentEvent(event: Extract<DesktopEvent, { type: "agent.event" }>): void {
    const config = this.config;
    if (!config || !config.channelId) return;
    if (event.coworkerId !== config.coworkerId) return;
    const live = this.runBuffers.get(event.runId);
    if (live) live.lastActivityAt = Date.now();
    const type = event.event.type;
    if (type === EventType.RUN_STARTED) {
      this.enqueueOutbound(() => this.reactToInbound(event.taskId));
      if (!this.runBuffers.has(event.runId)) {
        this.startRun(event.runId, event.conversationId, event.taskId);
      }
      return;
    }
    if (type === EventType.TEXT_MESSAGE_START) {
      if (!this.runBuffers.has(event.runId)) {
        this.startRun(event.runId, event.conversationId, event.taskId);
      }
      return;
    }
    if (type === EventType.TEXT_MESSAGE_CONTENT) {
      const delta = (event.event as { delta?: string }).delta ?? "";
      let buffer = this.runBuffers.get(event.runId);
      if (!buffer) {
        this.startRun(event.runId, event.conversationId, event.taskId);
        buffer = this.runBuffers.get(event.runId);
      }
      if (!buffer || buffer.finalized) return;
      if (buffer.pendingSeparator) {
        if (buffer.text.trim() && delta.trim()) buffer.text += "\n\n";
        buffer.pendingSeparator = false;
      }
      buffer.text += delta;
      return;
    }
    if (type === EventType.TEXT_MESSAGE_END) {
      const buffer = this.runBuffers.get(event.runId);
      if (buffer) buffer.pendingSeparator = true;
      return;
    }
    if (type === EventType.RUN_ERROR) {
      const aborted =
        this.stoppedRuns.delete(event.runId) ||
        (event.event as { code?: string }).code === "RUN_ABORTED";
      if (aborted) {
        this.finalizeRun(event.runId, true);
        return;
      }
      this.finalizeRun(event.runId, false);
      const message = (event.event as { message?: string }).message;
      this.enqueueOutbound(async () => {
        const target = await this.outboundTarget(event.conversationId, event.taskId);
        if (!target) return;
        await this.sendPlain(
          target,
          `${this.linkedCoworkerName()} hit an error: ${message || "the run failed"}`,
        );
      });
      return;
    }
    if (type === EventType.RUN_FINISHED) {
      this.finalizeRun(event.runId, this.stoppedRuns.delete(event.runId));
    }
  }

  private async reactToInbound(taskId: string): Promise<void> {
    const config = this.config;
    if (!config || !this.api) return;
    const emoji = resolveDiscordReceiptEmoji(config.receiptEmoji);
    const next = { ...config.inboundMessages };
    let changed = false;
    let denied = config.receiptReactionDenied;
    for (const [clientId, ref] of Object.entries(next)) {
      if (ref.taskId !== taskId || ref.reactedAt) continue;
      try {
        await this.api.addReaction({
          channelId: ref.channelId,
          messageId: ref.messageId,
          emoji,
        });
        next[clientId] = { ...ref, reactedAt: new Date().toISOString() };
        delete next[clientId];
        changed = true;
      } catch (error) {
        this.options.onError?.("discord.reaction", error);
        if (error instanceof DiscordApiError && error.status === 403) {
          denied = true;
        }
      }
    }
    if (changed || denied !== config.receiptReactionDenied) {
      this.saveConfig(
        { inboundMessages: next, receiptReactionDenied: denied },
        { notify: denied !== config.receiptReactionDenied },
      );
    }
  }

  private startRun(runId: string, conversationId: string, taskId: string): void {
    if (this.runBuffers.has(runId)) return;
    for (const [staleRunId, stale] of [...this.runBuffers]) {
      if (staleRunId !== runId && stale.taskId === taskId) {
        this.finalizeRun(staleRunId, false);
      }
    }
    const buffer: DiscordRunBuffer = {
      taskId,
      conversationId,
      text: "",
      lastActivityAt: Date.now(),
      targetChannelId: this.syncOutboundTarget(conversationId, taskId) ?? "",
      typingTimer: null,
      stopTimer: null,
      stopRequested: false,
      pendingSeparator: false,
      finalized: false,
    };
    this.runBuffers.set(runId, buffer);
    this.enqueueOutbound(async () => {
      if (this.runBuffers.get(runId) !== buffer || buffer.finalized) return;
      if (!buffer.targetChannelId) {
        const target = await this.outboundTarget(conversationId, taskId);
        if (!target) return;
        buffer.targetChannelId = target;
      }
      this.scheduleTyping(runId, buffer);
      await this.pushTyping(buffer);
    });
  }

  /** Thread or parent channel when no REST call is required (forums may need a new post). */
  private syncOutboundTarget(conversationId: string, taskId?: string): string | null {
    const config = this.config;
    if (!config?.channelId) return null;
    const mappedThread = this.threadForConversation(conversationId);
    if (mappedThread) return mappedThread;
    const last = this.replyThreadForTask(conversationId, taskId);
    if (last) return last;
    if (conversationId !== config.conversationId) return null;
    if (config.channelType !== null && isDiscordForumType(config.channelType)) return null;
    return config.channelId;
  }

  private scheduleTyping(runId: string, buffer: DiscordRunBuffer): void {
    if (buffer.typingTimer) clearTimeout(buffer.typingTimer);
    const interval = this.options.typingKeepAliveMs ?? typingKeepAliveMs;
    buffer.typingTimer = setTimeout(() => {
      buffer.typingTimer = null;
      if (this.runBuffers.get(runId) !== buffer || buffer.finalized) return;
      if (Date.now() - buffer.lastActivityAt > maxBackoffIdleMs) {
        this.finalizeRun(runId, false);
        return;
      }
      this.scheduleTyping(runId, buffer);
      if (buffer.stopRequested) return;
      this.enqueueOutbound(() => this.pushTyping(buffer));
    }, interval);
    buffer.typingTimer.unref?.();
  }

  private async pushTyping(buffer: DiscordRunBuffer): Promise<void> {
    if (!this.api || buffer.finalized) return;
    try {
      await this.api.triggerTyping(buffer.targetChannelId);
    } catch (error) {
      this.options.onError?.("discord.typing", error);
    }
  }

  private finalizeRun(runId: string, stopped: boolean): void {
    const buffer = this.runBuffers.get(runId);
    if (!buffer || buffer.finalized) return;
    buffer.finalized = true;
    if (buffer.typingTimer) clearTimeout(buffer.typingTimer);
    if (buffer.stopTimer) clearTimeout(buffer.stopTimer);
    this.runBuffers.delete(runId);
    const text = buffer.text.trim() ? buffer.text : stopped ? "Stopped." : "";
    if (!text) return;
    this.enqueueOutbound(async () => {
      if (!buffer.targetChannelId) {
        const target = await this.outboundTarget(buffer.conversationId, buffer.taskId);
        if (!target) return;
        buffer.targetChannelId = target;
      }
      if (stopped && !buffer.text.trim()) {
        await this.sendPlain(buffer.targetChannelId, text);
        return;
      }
      await this.sendMarkdown(buffer.targetChannelId, text);
    });
  }

  private async outboundTarget(
    conversationId: string,
    taskId?: string,
  ): Promise<string | null> {
    const config = this.config;
    if (!config || !config.channelId) return null;
    const mappedThread = this.threadForConversation(conversationId);
    if (mappedThread) return mappedThread;
    const last = this.replyThreadForTask(conversationId, taskId);
    if (last) return last;
    if (conversationId !== config.conversationId) return null;
    if (config.channelType !== null && isDiscordForumType(config.channelType)) {
      try {
        const conversation = this.options.database.getConversation(conversationId);
        return (await this.createOutboundThread(conversation)) ?? null;
      } catch {
        return null;
      }
    }
    return config.channelId;
  }

  private replyThreadForTask(conversationId: string, taskId?: string): string | undefined {
    if (taskId) {
      try {
        const sourceMessageId = this.options.database.getTask(taskId).sourceMessageId;
        if (sourceMessageId) {
          const origin = this.inboundThreadOrigins.get(sourceMessageId);
          if (origin) return origin;
        }
      } catch {
        // Fall through.
      }
    }
    return this.lastInboundThread.get(conversationId) ?? this.config?.lastThreads[conversationId];
  }

  private async mirrorConversation(conversationId: string): Promise<void> {
    const config = this.config;
    if (!config || !config.channelId) return;
    let conversation: Conversation;
    try {
      conversation = this.options.database.getConversation(conversationId);
    } catch {
      return;
    }
    if (conversation.kind !== "direct") return;
    if (!conversation.memberIds.includes(config.coworkerId)) return;
    if (conversation.archivedAt) return;

    let channelId = this.threadForConversation(conversationId);
    if (!channelId && conversationId !== config.conversationId) {
      channelId = await this.createOutboundThread(conversation);
      if (!channelId) return;
    }
    if (!channelId) {
      channelId =
        this.lastInboundThread.get(conversationId) ??
        this.config?.lastThreads[conversationId] ??
        null;
      if (!channelId && config.channelType !== null && isDiscordForumType(config.channelType)) {
        channelId = (await this.createOutboundThread(conversation)) ?? null;
        if (!channelId) return;
      } else if (!channelId) {
        channelId = config.channelId;
      }
    }

    if (!this.cursors.has(conversationId)) this.cursors.set(conversationId, "");
    const cursor = this.cursors.get(conversationId)!;
    const messages = this.options.database.listConversationMessages(conversationId);
    for (const message of messages) {
      if (message.role !== "user") continue;
      if (message.createdAt < cursor) continue;
      if (this.mirroredMessageIds.has(message.id)) continue;
      this.mirroredMessageIds.add(message.id);
      if (message.createdAt > (this.cursors.get(conversationId) ?? "")) {
        this.cursors.set(conversationId, message.createdAt);
      }
      if (this.injectedMessageIds.has(message.id)) continue;
      await this.sendPlain(channelId, `You (desktop): ${message.content}`);
      await this.mirrorMessageImages(message, channelId);
    }
  }

  private async createOutboundThread(conversation: Conversation): Promise<string | undefined> {
    const config = this.config!;
    if (!this.api || !config.channelId) return undefined;
    if (this.threadFailureLogged.has(conversation.id)) return undefined;
    try {
      const thread = await this.api.createThread({
        channelId: config.channelId,
        name: conversation.title,
        forum: config.channelType !== null && isDiscordForumType(config.channelType),
      });
      this.cacheChannel(thread);
      this.saveConfig({
        threads: { ...config.threads, [thread.id]: conversation.id },
      });
      return thread.id;
    } catch (error) {
      this.threadFailureLogged.add(conversation.id);
      this.options.onError?.("discord.thread", error);
      this.options.database.addActivity({
        type: "discord.thread_failed",
        summary: `Couldn't create a Discord thread for “${conversation.title}”; that conversation stays desktop-only`,
      });
      return undefined;
    }
  }

  private async mirrorMessageImages(message: Message, channelId: string): Promise<void> {
    const config = this.config!;
    const tasks = this.options.database.listTasksBySourceMessage(message.id);
    for (const task of tasks) {
      if (task.coworkerId !== config.coworkerId) continue;
      for (const attachment of this.options.database.listTaskImageAttachments(task.id)) {
        try {
          const coworker = this.options.database.getCoworker(task.coworkerId);
          const filePath = await resolveWorkspacePath(coworker.workspacePath, attachment.relativePath);
          const data = await readFile(filePath);
          await this.api?.sendAttachment({
            channelId,
            data: new Uint8Array(data),
            fileName: attachment.name,
            mimeType: attachment.mimeType,
          });
        } catch (error) {
          this.options.onError?.("discord.mirror-image", error);
        }
      }
    }
  }

  private enqueueOutbound(work: () => Promise<void>): void {
    this.outbound = this.outbound
      .then(work)
      .catch((error) => this.options.onError?.("discord.outbound", error));
  }

  private async sendMarkdown(channelId: string, markdown: string): Promise<void> {
    if (!this.api) return;
    for (const chunk of markdownToDiscordChunks(markdown)) {
      await this.api.sendMessage({ channelId, content: chunk });
    }
  }

  private async sendPlain(channelId: string, text: string): Promise<void> {
    if (!this.api) return;
    for (const chunk of plainTextChunks(text)) {
      await this.api.sendMessage({ channelId, content: chunk });
    }
  }

  private threadForConversation(conversationId: string): string | undefined {
    const threads = this.config?.threads ?? {};
    for (const [threadId, mapped] of Object.entries(threads)) {
      if (mapped === conversationId) return threadId;
    }
    return undefined;
  }

  private linkedCoworkerName(): string {
    try {
      return this.options.database.getCoworker(this.config!.coworkerId).name;
    } catch {
      return "your coworker";
    }
  }

  private async coworkerSupportsImages(): Promise<boolean> {
    try {
      const coworker = this.options.database.getCoworker(this.config!.coworkerId);
      const capabilities = await getModelCapabilities(
        coworker.modelProvider,
        coworker.modelName,
        this.options.credentials,
      );
      return capabilities.supportsImages;
    } catch {
      return true;
    }
  }

  private tryBeginMutation(): (() => void) | null {
    try {
      return this.options.host.beginDataMutation();
    } catch {
      return null;
    }
  }

  private renameMappedConversation(threadId: string, title: string): void {
    const conversationId = this.config?.threads[threadId];
    if (!conversationId) return;
    try {
      this.options.host.updateConversation(conversationId, { title });
    } catch (error) {
      this.options.onError?.("discord.thread", error);
    }
  }

  private queueSequenceWrite(lastSequence: number | null, sessionId: string | null): void {
    this.pendingSequence = { lastSequence, sessionId };
    if (this.sequenceTimer) return;
    this.sequenceTimer = setTimeout(() => {
      this.sequenceTimer = null;
      this.flushSequenceWrite();
    }, 2_000);
    this.sequenceTimer.unref?.();
  }

  private flushSequenceWrite(): void {
    if (this.sequenceTimer) {
      clearTimeout(this.sequenceTimer);
      this.sequenceTimer = null;
    }
    const pending = this.pendingSequence;
    this.pendingSequence = null;
    if (!pending || !this.config) return;
    this.saveConfig(
      { lastSequence: pending.lastSequence, sessionId: pending.sessionId },
      { notify: false },
    );
  }

  private saveConfig(
    patch: Partial<DiscordIntegrationConfig>,
    options: { notify?: boolean } = {},
  ): void {
    if (!this.config) return;
    this.config = { ...this.config, ...patch };
    try {
      this.options.database.updateDiscordIntegration({ config: patch });
    } catch (error) {
      this.options.onError?.("discord.config", error);
      return;
    }
    if (options.notify !== false) {
      this.options.emit({ type: "entity.changed", entity: "integrations" });
    }
  }
}
