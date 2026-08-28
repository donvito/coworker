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
} from "@shared/contracts";
import type { CoworkerDatabase } from "@main/db/database";
import type { CredentialStore } from "@main/security/credential-store";
import { maxAttachedImageBytes } from "@main/integrations/image-attachments";
import { getModelCapabilities } from "@main/integrations/model-catalog";
import { resolveWorkspacePath } from "@main/tools/workspace-path";
import {
  markdownToTelegramChunks,
  plainTextChunks,
  telegramHtmlToPlainText,
} from "./telegram-format";
import {
  TelegramApiError,
  TelegramBotApi,
  parseTelegramConfig,
  telegramCredentialKey,
  telegramDownloadLimit,
  type TelegramCallbackQuery,
  type TelegramIntegrationConfig,
  type TelegramMessage,
  type TelegramUpdate,
} from "./telegram";

/** The narrow DesktopAppService surface the bridge depends on. */
export interface TelegramBridgeHost {
  sendConversationMessage(
    input: SendConversationMessageInput,
  ): Promise<ConversationDispatchReceipt>;
  createConversation(input: CreateConversationInput): Conversation;
  decideApproval(input: ApprovalDecisionInput): Approval;
  subscribe(listener: (event: DesktopEvent) => void): () => void;
  beginDataMutation(): () => void;
}

export interface TelegramBridgeOptions {
  database: CoworkerDatabase;
  credentials: CredentialStore;
  host: TelegramBridgeHost;
  emit: (event: DesktopEvent) => void;
  onError?: (scope: string, error: unknown) => void;
  fetchImpl?: typeof fetch;
  /** Long-poll window; tests shrink this to keep the loop fast. */
  pollTimeoutSeconds?: number;
}

const maxBackoffMs = 60_000;
const conflictPauseMs = 60_000;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** A conversation title derived from the first message, Telegram-style. */
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

/**
 * Two-way bridge between one Telegram bot's private chat and the linked
 * coworker's conversations. Inbound updates arrive over getUpdates long
 * polling and are injected with the same service call the desktop UI uses;
 * outbound mirroring listens to the service event bus. Lifecycle mirrors
 * SchedulerService: owned by DesktopAppService, started in initialize(),
 * stopped in shutdown(), woken on OS resume.
 */
export class TelegramBridgeService {
  private running = false;
  private api: TelegramBotApi | null = null;
  private config: TelegramIntegrationConfig | null = null;
  private pollAbort: AbortController | null = null;
  private unsubscribe: (() => void) | null = null;
  private loop: Promise<void> = Promise.resolve();
  /** Serializes every outbound Telegram send so ordering matches the app. */
  private outbound: Promise<void> = Promise.resolve();
  /** clientMessageIds this bridge injected, so mirroring never echoes them. */
  private readonly injectedMessageIds = new Set<string>();
  /** conversationId → newest createdAt already mirrored (or seen at startup). */
  private readonly cursors = new Map<string, string>();
  private readonly mirroredMessageIds = new Set<string>();
  /** runId → assistant text buffered from TEXT_MESSAGE_CONTENT deltas. */
  private readonly runBuffers = new Map<string, { conversationId: string; text: string }>();
  private readonly refusedChats = new Set<number>();
  private readonly topicFailureLogged = new Set<string>();
  /**
   * Telegram's threaded bot chats open a fresh topic for every message typed
   * from the "New Chat" composer. Those messages all route to the main
   * conversation, and these maps remember which topic each one came from so
   * the coworker's reply threads back to where the user actually wrote.
   */
  private readonly inboundThreadOrigins = new Map<string, number>();
  private readonly lastInboundThread = new Map<string, number>();
  /** Pending approvals already announced in Telegram, and their notice messages. */
  private readonly notifiedApprovals = new Set<string>();
  private readonly approvalNotices = new Map<string, { messageId: number }>();
  /** Topic names seen in forum_topic_created, used to title new conversations. */
  private readonly pendingTopicNames = new Map<number, string>();

  constructor(private readonly options: TelegramBridgeOptions) {}

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    const integration = this.options.database.getTelegramIntegration();
    if (!integration || integration.status !== "connected") return;
    const token = await this.readToken();
    if (!token) return;

    this.config = parseTelegramConfig(integration);
    this.api = new TelegramBotApi(token, this.options.fetchImpl ?? fetch);
    this.running = true;
    this.initializeCursors();
    this.unsubscribe = this.options.host.subscribe((event) => this.handleEvent(event));
    this.pollAbort = new AbortController();
    this.loop = this.pollLoop().catch((error) => {
      this.options.onError?.("telegram.poll", error);
    });
    // Approvals created while the bridge was down still block their runs;
    // announce them right away so a phone-only user can unblock.
    this.enqueueOutbound(() => this.syncApprovals());
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.pollAbort?.abort();
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.loop.catch(() => undefined);
    await this.outbound.catch(() => undefined);
    this.api = null;
    this.config = null;
    this.runBuffers.clear();
    this.cursors.clear();
    this.mirroredMessageIds.clear();
    this.injectedMessageIds.clear();
    this.refusedChats.clear();
    this.topicFailureLogged.clear();
    this.inboundThreadOrigins.clear();
    this.lastInboundThread.clear();
    this.notifiedApprovals.clear();
    this.approvalNotices.clear();
    this.pendingTopicNames.clear();
  }

  /** Restarts the poll cycle immediately (OS resume, reconfiguration). */
  async wake(): Promise<void> {
    if (this.running) {
      // Abort the in-flight long poll; the loop re-arms with a fresh signal.
      this.pollAbort?.abort();
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
      return await this.options.credentials.get(telegramCredentialKey);
    } catch (error) {
      this.options.onError?.("telegram.credentials", error);
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

  // ---------------------------------------------------------------- inbound

  private async pollLoop(): Promise<void> {
    let backoffMs = 1_000;
    let lastProfileCheck = 0;
    while (this.running) {
      const signal = this.rearmedSignal();
      try {
        // Re-read getMe periodically so BotFather Threaded Mode toggles are
        // picked up without reconnecting.
        if (Date.now() - lastProfileCheck > 5 * 60_000) {
          await this.refreshBotProfile();
          lastProfileCheck = Date.now();
        }
        const offset =
          this.config?.lastUpdateId == null ? undefined : this.config.lastUpdateId + 1;
        const updates = await this.api!.getUpdates({
          offset,
          timeoutSeconds: this.options.pollTimeoutSeconds ?? 50,
          signal,
        });
        for (const update of updates) {
          if (!this.running) return;
          await this.handleUpdate(update);
          this.saveConfig({ lastUpdateId: update.update_id }, { notify: false });
        }
        backoffMs = 1_000;
      } catch (error) {
        if (!this.running) return;
        if (signal.aborted) continue; // wake() aborted the poll on purpose.
        this.options.onError?.("telegram.poll", error);
        if (error instanceof TelegramApiError && error.errorCode === 409) {
          this.options.database.addActivity({
            type: "telegram.conflict",
            summary:
              "Another process is polling this Telegram bot; pausing this bridge for a minute",
          });
          await delay(conflictPauseMs, this.pollAbort?.signal);
        } else {
          const retryAfter =
            error instanceof TelegramApiError && error.retryAfterSeconds
              ? error.retryAfterSeconds * 1000
              : backoffMs;
          await delay(Math.min(retryAfter, maxBackoffMs), this.pollAbort?.signal);
          backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
        }
      }
    }
  }

  private rearmedSignal(): AbortSignal {
    if (!this.pollAbort || this.pollAbort.signal.aborted) {
      this.pollAbort = new AbortController();
    }
    return this.pollAbort.signal;
  }

  private async refreshBotProfile(): Promise<void> {
    const me = await this.api!.getMe();
    const config = this.config!;
    const threadsEnabled = me.has_topics_enabled === true;
    const botUsername = me.username ?? config.botUsername;
    if (threadsEnabled !== config.threadsEnabled || botUsername !== config.botUsername) {
      this.saveConfig({ threadsEnabled, botUsername });
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    try {
      if (update.callback_query) {
        await this.handleCallback(update.callback_query);
        return;
      }
      const message = update.message;
      const config = this.config;
      if (!message || !config || !this.api) return;
      if (message.chat.type !== "private") return;
      if (message.from?.is_bot) return;

      const text = message.text ?? "";
      if (text.startsWith("/start")) {
        await this.handlePairing(message, text);
        return;
      }
      // Some Telegram clients drop the deep link's start payload when the bot
      // chat already exists, so the raw pairing code pasted as a message must
      // also pair.
      if (
        config.chatId === null &&
        config.pairingCode &&
        text.trim() === config.pairingCode
      ) {
        await this.completePairing(message.chat.id);
        return;
      }
      if (config.chatId === null || message.chat.id !== config.chatId) {
        await this.refuseUnpairedChat(message.chat.id);
        return;
      }

      if (message.forum_topic_created && message.message_thread_id !== undefined) {
        // The topic's first real message follows in the same batch; remember
        // the name so its new conversation gets a meaningful title.
        this.pendingTopicNames.set(
          message.message_thread_id,
          message.forum_topic_created.name,
        );
        return;
      }

      const conversationId = this.resolveInboundConversation(message);
      const content = message.text ?? message.caption ?? "";
      const images = await this.collectInboundImages(message);
      const documentNote = await this.collectInboundDocument(update.update_id, message);
      const combined = [content, documentNote].filter(Boolean).join("\n\n");
      if (!combined && images.length === 0) {
        await this.sendPlain(
          message.chat.id,
          "I can only receive text, photos, and files here for now.",
          message.message_thread_id,
        );
        return;
      }

      const clientMessageId = `telegram:${update.update_id}`;
      this.injectedMessageIds.add(clientMessageId);
      if (message.message_thread_id !== undefined) {
        this.inboundThreadOrigins.set(clientMessageId, message.message_thread_id);
        this.lastInboundThread.set(conversationId, message.message_thread_id);
        // Persisted so telegram.send (which runs in the tool gateway) and the
        // bridge after a restart can still target the user's thread.
        if (config.lastThreads[conversationId] !== message.message_thread_id) {
          this.saveConfig(
            {
              lastThreads: {
                ...config.lastThreads,
                [conversationId]: message.message_thread_id,
              },
            },
            { notify: false },
          );
        }
      }
      const release = this.tryBeginMutation();
      if (!release) {
        await this.sendPlain(
          message.chat.id,
          "The app is briefly busy creating a backup. Please resend this in a moment.",
          message.message_thread_id,
        );
        return;
      }
      try {
        await this.options.host.sendConversationMessage({
          conversationId,
          clientMessageId,
          content: combined,
          mentionedCoworkerIds: [],
          images: images.length > 0 ? images : undefined,
        });
        // Lets the desktop follow the message into its conversation.
        this.options.emit({
          type: "conversation.inbound",
          coworkerId: config.coworkerId,
          conversationId,
          source: "telegram",
        });
      } catch (error) {
        this.options.onError?.("telegram.inbound", error);
        await this.sendPlain(
          message.chat.id,
          `I couldn't pass that on: ${error instanceof Error ? error.message : "unknown error"}`,
          message.message_thread_id,
        );
      } finally {
        release();
      }
    } catch (error) {
      this.options.onError?.("telegram.update", error);
    }
  }

  private async handlePairing(message: TelegramMessage, text: string): Promise<void> {
    const config = this.config!;
    const chatId = message.chat.id;
    const payload = text.split(/\s+/)[1] ?? "";
    if (config.chatId !== null) {
      await this.sendPlain(
        chatId,
        chatId === config.chatId
          ? "You're already connected. Just send a message."
          : "This bot is already paired with another chat. Unpair it from Coworker's Settings first.",
      );
      return;
    }
    if (!payload || payload !== config.pairingCode) {
      await this.sendPlain(
        chatId,
        "This bot is private. To connect, open the pairing link from Coworker's Settings → Integrations — or paste the pairing code shown there as a message.",
      );
      return;
    }
    await this.completePairing(chatId);
  }

  private async completePairing(chatId: number): Promise<void> {
    this.saveConfig({ chatId });
    const coworkerName = this.linkedCoworkerName();
    this.options.database.addActivity({
      type: "telegram.paired",
      summary: `Telegram chat paired with ${coworkerName}`,
    });
    this.options.emit({ type: "entity.changed", entity: "activity" });
    await this.sendPlain(
      chatId,
      `Connected! You're now chatting with ${coworkerName}. Messages here appear in the desktop app and vice versa.`,
    );
  }

  private async refuseUnpairedChat(chatId: number): Promise<void> {
    if (this.refusedChats.has(chatId)) return;
    this.refusedChats.add(chatId);
    this.options.database.addActivity({
      type: "telegram.refused",
      summary:
        "Refused a Telegram message from an unpaired chat — open the pairing link or send the pairing code from Settings → Integrations",
    });
    this.options.emit({ type: "entity.changed", entity: "activity" });
    await this.sendPlain(
      chatId,
      "This bot is private. To connect, open the pairing link from Coworker's Settings → Integrations — or paste the pairing code shown there as a message.",
    );
  }

  /**
   * Each Telegram topic maps to its own desktop conversation, mirroring
   * Telegram's chat-per-topic model. Unknown topics create a conversation on
   * first contact, titled from the topic name (or the message text). If
   * creation fails the message still lands in the main conversation, where
   * inboundThreadOrigins keeps replies threading back correctly.
   */
  private resolveInboundConversation(message: TelegramMessage): string {
    const config = this.config!;
    const threadId = message.message_thread_id;
    if (threadId === undefined) return config.conversationId;
    const mapped = config.topics[String(threadId)];
    if (mapped) return mapped;
    const title =
      this.pendingTopicNames.get(threadId)?.trim() ||
      titleFromText(message.text ?? message.caption ?? "") ||
      `Telegram topic ${threadId}`;
    this.pendingTopicNames.delete(threadId);
    const release = this.tryBeginMutation();
    if (!release) return config.conversationId;
    try {
      const conversation = this.options.host.createConversation({
        coworkerId: config.coworkerId,
        title,
      });
      this.cursors.set(conversation.id, "");
      this.saveConfig({
        topics: { ...config.topics, [String(threadId)]: conversation.id },
      });
      return conversation.id;
    } catch (error) {
      this.options.onError?.("telegram.topic", error);
      return config.conversationId;
    } finally {
      release();
    }
  }

  private async collectInboundImages(
    message: TelegramMessage,
  ): Promise<ConversationImageInput[]> {
    if (!message.photo?.length || !this.api) return [];
    if (!(await this.coworkerSupportsImages())) {
      // Degrade instead of failing the whole message: the caption still
      // reaches the coworker as text.
      await this.sendPlain(
        message.chat.id,
        `${this.linkedCoworkerName()}'s current model can't view photos, so I passed on your text only.`,
        message.message_thread_id,
      );
      return [];
    }
    // Sizes arrive smallest → largest; take the largest that fits the app cap.
    const candidates = [...message.photo]
      .reverse()
      .filter((size) => (size.file_size ?? 0) <= maxAttachedImageBytes);
    const chosen = candidates[0] ?? null;
    if (!chosen) {
      await this.sendPlain(
        message.chat.id,
        "That photo is too large for me to import (8 MB limit).",
        message.message_thread_id,
      );
      return [];
    }
    try {
      const file = await this.api.getFile(chosen.file_id);
      if (!file.file_path) throw new Error("Telegram did not return a file path");
      const bytes = await this.api.downloadFile(file.file_path, maxAttachedImageBytes);
      return [
        {
          data: Buffer.from(bytes).toString("base64"),
          mimeType: "image/jpeg",
          name: `telegram-photo-${message.message_id}.jpg`,
          size: bytes.byteLength,
        },
      ];
    } catch (error) {
      this.options.onError?.("telegram.photo", error);
      await this.sendPlain(
        message.chat.id,
        "I couldn't download that photo from Telegram.",
        message.message_thread_id,
      );
      return [];
    }
  }

  /** Downloads an inbound document into the coworker workspace inbox. */
  private async collectInboundDocument(
    updateId: number,
    message: TelegramMessage,
  ): Promise<string | null> {
    const document = message.document;
    if (!document || !this.api || !this.config) return null;
    if ((document.file_size ?? 0) > telegramDownloadLimit) {
      await this.sendPlain(
        message.chat.id,
        "That file is larger than Telegram lets bots download (20 MB limit).",
        message.message_thread_id,
      );
      return null;
    }
    try {
      const coworker = this.options.database.getCoworker(this.config.coworkerId);
      const file = await this.api.getFile(document.file_id);
      if (!file.file_path) throw new Error("Telegram did not return a file path");
      const bytes = await this.api.downloadFile(file.file_path);
      const fileName = safeInboxFileName(document.file_name, `file-${updateId}`);
      const relativePath = posix.join("telegram-inbox", `${updateId}-${fileName}`);
      const absolutePath = await resolveWorkspacePath(coworker.workspacePath, relativePath, {
        createParent: true,
      });
      await writeFile(absolutePath, bytes, { mode: 0o600 });
      return `(File received via Telegram and saved in the workspace at ${relativePath})`;
    } catch (error) {
      this.options.onError?.("telegram.document", error);
      await this.sendPlain(
        message.chat.id,
        "I couldn't download that file from Telegram.",
        message.message_thread_id,
      );
      return null;
    }
  }

  // -------------------------------------------------------------- approvals

  /**
   * Announces pending approvals for the linked coworker in Telegram with
   * Approve / Reject / Always-allow buttons, and retires notices for
   * approvals that were decided elsewhere (for example on the desktop).
   */
  private async syncApprovals(): Promise<void> {
    const config = this.config;
    if (!config || config.chatId === null || !this.api) return;
    const pendingIds = new Set<string>();
    for (const approval of this.options.database.listApprovals("PENDING")) {
      if (approval.coworkerId !== config.coworkerId) continue;
      pendingIds.add(approval.id);
      if (this.notifiedApprovals.has(approval.id)) continue;
      this.notifiedApprovals.add(approval.id);
      let threadId: number | undefined;
      try {
        const task = this.options.database.getTask(approval.taskId);
        const target = this.outboundTarget(task.threadId, task.id);
        if (!target) continue; // The conversation isn't synced to Telegram.
        threadId = target.threadId;
      } catch {
        continue;
      }
      try {
        const notice = await this.api.sendMessage({
          chatId: config.chatId,
          text: [
            `${this.linkedCoworkerName()} needs your approval:`,
            approval.summary,
            "",
            "Other messages wait until you decide. You can also decide in the desktop app.",
          ].join("\n"),
          messageThreadId: threadId,
          replyMarkup: {
            inline_keyboard: [
              [
                { text: "Approve", callback_data: `apr:${approval.id}:approve` },
                { text: "Reject", callback_data: `apr:${approval.id}:reject` },
              ],
              [{ text: "Always allow", callback_data: `apr:${approval.id}:always` }],
            ],
          },
        });
        this.approvalNotices.set(approval.id, { messageId: notice.message_id });
      } catch (error) {
        this.options.onError?.("telegram.approval", error);
      }
    }
    for (const [approvalId, notice] of [...this.approvalNotices]) {
      if (pendingIds.has(approvalId)) continue;
      this.approvalNotices.delete(approvalId);
      try {
        await this.api.editMessageText({
          chatId: config.chatId,
          messageId: notice.messageId,
          text: "This approval was handled in the desktop app.",
        });
      } catch (error) {
        this.options.onError?.("telegram.approval", error);
      }
    }
  }

  /** Applies an Approve / Reject / Always-allow button tap from Telegram. */
  private async handleCallback(query: TelegramCallbackQuery): Promise<void> {
    const config = this.config;
    if (!config || !this.api) return;
    const answer = async (text: string) => {
      try {
        await this.api?.answerCallbackQuery({ callbackQueryId: query.id, text });
      } catch (error) {
        this.options.onError?.("telegram.approval", error);
      }
    };
    if (config.chatId === null || query.message?.chat.id !== config.chatId) {
      await answer("This chat isn't paired with Coworker.");
      return;
    }
    const match = query.data?.match(/^apr:([\w-]+):(approve|reject|always)$/);
    if (!match) {
      await answer("This action isn't supported.");
      return;
    }
    const [, approvalId, action] = match as unknown as [string, string, string];
    const release = this.tryBeginMutation();
    if (!release) {
      await answer("The app is briefly busy creating a backup. Try again in a moment.");
      return;
    }
    try {
      if (action === "always") {
        // Flip the policy first so future calls run without asking; the
        // pending approval itself still executes through the normal path.
        const approval = this.options.database.getApproval(approvalId);
        const coworker = this.options.database.getCoworker(approval.coworkerId);
        this.options.database.updateCoworker(coworker.id, {
          policies: { ...coworker.policies, [approval.actionType]: "automatic" },
        });
        this.options.emit({ type: "entity.changed", entity: "coworkers", id: coworker.id });
      }
      const decision = action === "reject" ? "reject" : "approve";
      const approval = this.options.host.decideApproval({ approvalId, decision });
      this.approvalNotices.delete(approvalId);
      await answer(decision === "approve" ? "Approved" : "Rejected");
      if (query.message) {
        const outcome =
          decision === "reject"
            ? "Rejected."
            : action === "always"
              ? `Approved — ${this.linkedCoworkerName()} won't ask again for this action.`
              : "Approved.";
        try {
          await this.api.editMessageText({
            chatId: config.chatId,
            messageId: query.message.message_id,
            text: `${approval.summary}\n\n${outcome}`,
          });
        } catch (error) {
          this.options.onError?.("telegram.approval", error);
        }
      }
    } catch (error) {
      this.options.onError?.("telegram.approval", error);
      await answer(
        error instanceof Error
          ? error.message.slice(0, 180)
          : "The approval could not be decided.",
      );
    } finally {
      release();
    }
  }

  // --------------------------------------------------------------- outbound

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
      this.options.onError?.("telegram.event", error);
    }
  }

  private handleAgentEvent(
    event: Extract<DesktopEvent, { type: "agent.event" }>,
  ): void {
    const config = this.config;
    if (!config || config.chatId === null) return;
    if (event.coworkerId !== config.coworkerId) return;
    const conversationId = event.conversationId;

    const taskId = event.taskId;
    const type = event.event.type;
    if (type === EventType.RUN_STARTED || type === EventType.TEXT_MESSAGE_START) {
      this.enqueueOutbound(async () => {
        const target = this.outboundTarget(conversationId, taskId);
        if (!target) return;
        await this.api?.sendChatAction({
          chatId: target.chatId,
          action: "typing",
          messageThreadId: target.threadId,
        });
      });
      return;
    }
    if (type === EventType.TEXT_MESSAGE_CONTENT) {
      const delta = (event.event as { delta?: string }).delta ?? "";
      const buffer = this.runBuffers.get(event.runId) ?? { conversationId, text: "" };
      buffer.text += delta;
      this.runBuffers.set(event.runId, buffer);
      return;
    }
    if (type === EventType.TEXT_MESSAGE_END) {
      const buffer = this.runBuffers.get(event.runId);
      this.runBuffers.delete(event.runId);
      if (!buffer?.text.trim()) return;
      const text = buffer.text;
      this.enqueueOutbound(async () => {
        const target = this.outboundTarget(conversationId, taskId);
        if (!target) return;
        await this.sendMarkdown(target.chatId, text, target.threadId);
      });
      return;
    }
    if (type === EventType.RUN_ERROR) {
      this.runBuffers.delete(event.runId);
      const message = (event.event as { message?: string }).message;
      this.enqueueOutbound(async () => {
        const target = this.outboundTarget(conversationId, taskId);
        if (!target) return;
        await this.sendPlain(
          target.chatId,
          `${this.linkedCoworkerName()} hit an error: ${message || "the run failed"}`,
          target.threadId,
        );
      });
    }
  }

  /**
   * Resolves where a conversation's traffic goes, at send time so that a
   * topic created moments earlier (ahead of us in the outbound queue) is
   * already visible. Returns null when the conversation is not synced.
   */
  private outboundTarget(
    conversationId: string,
    taskId?: string,
  ): { chatId: number; threadId: number | undefined } | null {
    const config = this.config;
    if (!config || config.chatId === null) return null;
    const mappedThread = this.topicForConversation(conversationId);
    if (mappedThread !== undefined) return { chatId: config.chatId, threadId: mappedThread };
    if (conversationId !== config.conversationId) return null;
    // Main conversation: reply into the topic the triggering message came
    // from, falling back to wherever the user last wrote.
    return { chatId: config.chatId, threadId: this.replyThreadForTask(conversationId, taskId) };
  }

  private replyThreadForTask(conversationId: string, taskId?: string): number | undefined {
    if (taskId) {
      try {
        const sourceMessageId = this.options.database.getTask(taskId).sourceMessageId;
        if (sourceMessageId) {
          const origin = this.inboundThreadOrigins.get(sourceMessageId);
          if (origin !== undefined) return origin;
        }
      } catch {
        // Task lookup is best-effort; fall through to the last known thread.
      }
    }
    return (
      this.lastInboundThread.get(conversationId) ??
      this.config?.lastThreads[conversationId]
    );
  }

  /** Forwards new desktop-typed user messages (and their images) to Telegram. */
  private async mirrorConversation(conversationId: string): Promise<void> {
    const config = this.config;
    if (!config || config.chatId === null) return;
    let conversation: Conversation;
    try {
      conversation = this.options.database.getConversation(conversationId);
    } catch {
      return; // Deleted before we got to it.
    }
    if (conversation.kind !== "direct") return;
    if (!conversation.memberIds.includes(config.coworkerId)) return;
    // Archived conversations don't mirror (new inbound activity un-archives
    // them through the send path before this runs).
    if (conversation.archivedAt) return;

    let threadId = this.topicForConversation(conversationId);
    if (threadId === undefined && conversationId !== config.conversationId) {
      threadId = await this.createOutboundTopic(conversation);
      if (threadId === undefined) return; // Not synced (threads off or failed).
    }
    if (threadId === undefined) {
      // Main conversation: keep the Telegram side coherent by mirroring into
      // the topic the user last wrote from, when there is one.
      threadId =
        this.lastInboundThread.get(conversationId) ??
        this.config?.lastThreads[conversationId];
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
      if (this.injectedMessageIds.has(message.id)) continue; // Came from Telegram.
      await this.sendPlain(
        config.chatId,
        `You (desktop): ${message.content}`,
        threadId,
      );
      await this.mirrorMessageImages(message, config.chatId, threadId);
    }
  }

  /** Creates a Telegram topic for a desktop conversation in Threaded Mode. */
  private async createOutboundTopic(conversation: Conversation): Promise<number | undefined> {
    const config = this.config!;
    if (!config.threadsEnabled || !this.api || config.chatId === null) return undefined;
    if (this.topicFailureLogged.has(conversation.id)) return undefined;
    try {
      const topic = await this.api.createForumTopic({
        chatId: config.chatId,
        name: conversation.title,
      });
      this.saveConfig({
        topics: { ...config.topics, [String(topic.message_thread_id)]: conversation.id },
      });
      return topic.message_thread_id;
    } catch (error) {
      this.topicFailureLogged.add(conversation.id);
      this.options.onError?.("telegram.topic", error);
      this.options.database.addActivity({
        type: "telegram.topic_failed",
        summary: `Couldn't create a Telegram topic for “${conversation.title}”; that conversation stays desktop-only`,
      });
      return undefined;
    }
  }

  private async mirrorMessageImages(
    message: Message,
    chatId: number,
    threadId: number | undefined,
  ): Promise<void> {
    const config = this.config!;
    const tasks = this.options.database.listTasksBySourceMessage(message.id);
    for (const task of tasks) {
      if (task.coworkerId !== config.coworkerId) continue;
        for (const attachment of this.options.database.listTaskImageAttachments(task.id)) {
        try {
          const coworker = this.options.database.getCoworker(task.coworkerId);
          const filePath = await resolveWorkspacePath(
            coworker.workspacePath,
            attachment.relativePath,
          );
          const data = await readFile(filePath);
          await this.api?.sendPhoto({
            chatId,
            data: new Uint8Array(data),
            fileName: attachment.name,
            mimeType: attachment.mimeType,
            messageThreadId: threadId,
          });
        } catch (error) {
          this.options.onError?.("telegram.mirror-image", error);
        }
      }
    }
  }

  // ---------------------------------------------------------------- helpers

  private enqueueOutbound(work: () => Promise<void>): void {
    this.outbound = this.outbound
      .then(work)
      .catch((error) => this.options.onError?.("telegram.outbound", error));
  }

  private async sendMarkdown(
    chatId: number,
    markdown: string,
    threadId: number | undefined,
  ): Promise<void> {
    if (!this.api) return;
    for (const chunk of markdownToTelegramChunks(markdown)) {
      try {
        await this.api.sendMessage({
          chatId,
          text: chunk,
          parseMode: "HTML",
          messageThreadId: threadId,
        });
      } catch (error) {
        if (error instanceof TelegramApiError && error.errorCode === 400) {
          // Malformed HTML must never block delivery; retry as plain text.
          await this.api.sendMessage({
            chatId,
            text: telegramHtmlToPlainText(chunk),
            messageThreadId: threadId,
          });
        } else {
          throw error;
        }
      }
    }
  }

  private async sendPlain(
    chatId: number,
    text: string,
    threadId?: number,
  ): Promise<void> {
    if (!this.api) return;
    for (const chunk of plainTextChunks(text)) {
      await this.api.sendMessage({ chatId, text: chunk, messageThreadId: threadId });
    }
  }

  private topicForConversation(conversationId: string): number | undefined {
    const topics = this.config?.topics ?? {};
    for (const [threadId, mapped] of Object.entries(topics)) {
      if (mapped === conversationId) return Number(threadId);
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
      // When the capability lookup itself fails, attempt the attach and let
      // the send path report the real problem.
      return true;
    }
  }

  private tryBeginMutation(): (() => void) | null {
    try {
      return this.options.host.beginDataMutation();
    } catch {
      return null; // A full data export is in progress.
    }
  }

  private saveConfig(
    patch: Partial<TelegramIntegrationConfig>,
    options: { notify?: boolean } = {},
  ): void {
    if (!this.config) return;
    this.config = { ...this.config, ...patch };
    try {
      this.options.database.updateTelegramIntegration({ config: patch });
    } catch (error) {
      this.options.onError?.("telegram.config", error);
      return;
    }
    if (options.notify !== false) {
      this.options.emit({ type: "entity.changed", entity: "integrations" });
    }
  }
}
