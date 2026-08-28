import { randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import type {
  AgentRunReceipt,
  AgentRunRequest,
  AppSettings,
  AppSnapshot,
  Approval,
  ApprovalDecisionInput,
  ApprovalStatus,
  ConfigureModelResult,
  Conversation,
  CreateConversationInput,
  CreateCoworkerInput,
  CreateScheduleInput,
  CreateTaskInput,
  DesktopEvent,
  DiscussionSession,
  EmailIntegrationMode,
  Integration,
  ModelProvider,
  RemoteModelProvider,
  SendConversationMessageInput,
  Task,
  TelegramIntegrationStatus,
  UpdateConversationInput,
  WebSearchProvider,
  UpdateCoworkerInput,
  UpdateScheduleInput,
} from "@shared/contracts";
import { CoworkerDatabase } from "@main/db/database";
import {
  getModelCapabilities,
  localModelCredentialMarker,
  listAvailableModels,
  queryProviderModels,
} from "@main/integrations/model-catalog";
import {
  getModelProviderDefinition,
  isModelEndpointProvider,
  modelProviderBaseUrlKey,
  modelProviderCredentialKey,
  modelProviderName,
} from "@shared/model-providers";
import { deleteArtifactFile } from "@main/integrations/artifact-files";
import {
  loadImageAttachments,
  parseAgentPrompt,
  parseConversationImages,
  persistImageAttachments,
  removePersistedImageAttachments,
  type IncomingImageAttachment,
} from "@main/integrations/image-attachments";
import {
  CredentialDecryptionError,
  type CredentialStore,
} from "@main/security/credential-store";
import { SchedulerService } from "@main/scheduler/scheduler-service";
import { resolveSharedFolderGrants } from "@main/tools/shared-folders";
import { ToolGateway } from "@main/tools/tool-gateway";
import { CoworkerRuntimeManager } from "@main/runtime/runtime-manager";
import { ProviderErrorLogger } from "@main/runtime/provider-error-logger";
import type { ApplicationLogger } from "@main/runtime/application-logger";
import {
  bundledSkills,
  installSkillFromUrl,
  parseSkillMarkdown,
  parseSkillPackage,
  skillUrlFromPrompt,
} from "@main/integrations/skills";
import { createDataBackup } from "@main/integrations/archives";
import { webSearchCredentialKey } from "@main/integrations/web-search";
import {
  TelegramBotApi,
  parseTelegramConfig,
  telegramCredentialKey,
  telegramPairingLink,
  type TelegramIntegrationConfig,
} from "@main/integrations/telegram";
import { TelegramBridgeService } from "@main/integrations/telegram-bridge";
import { DISCUSSION_PASS_MARKER, isDiscussionPass } from "@shared/discussion";

export interface DesktopAppServiceOptions {
  dataPath: string;
  appVersion?: string;
  applicationLogger?: ApplicationLogger;
  database?: CoworkerDatabase;
  credentials: CredentialStore;
  workerFactory?: () => Worker;
  onSettingsChanged?: (settings: AppSettings) => void | Promise<void>;
  /** Test hooks for the Telegram bridge (fake fetch, short poll windows). */
  telegram?: { fetchImpl?: typeof fetch; pollTimeoutSeconds?: number };
}

function safeDirectoryName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50) || "coworker"
  );
}

function taskTitle(text: string): string {
  const firstLine = text.split("\n")[0]?.trim() || "New task";
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
}

async function readableCredential(
  credentials: CredentialStore,
  key: string,
): Promise<string | null> {
  try {
    return await credentials.get(key);
  } catch (error) {
    if (error instanceof CredentialDecryptionError) return null;
    throw error;
  }
}

export class DesktopAppService {
  readonly database: CoworkerDatabase;
  readonly runtime: CoworkerRuntimeManager;
  readonly scheduler: SchedulerService;
  readonly telegram: TelegramBridgeService;
  readonly tools: ToolGateway;
  readonly providerErrors: ProviderErrorLogger;
  private readonly listeners = new Set<(event: DesktopEvent) => void>();
  private initialized = false;
  private dataExportInProgress = false;
  private activeDataMutations = 0;
  private readonly dataMutationWaiters = new Set<() => void>();

  constructor(private readonly options: DesktopAppServiceOptions) {
    this.database = options.database ?? new CoworkerDatabase(join(options.dataPath, "coworker.db"));
    this.providerErrors = new ProviderErrorLogger(
      join(options.dataPath, "logs", "provider-errors.jsonl"),
    );
    this.tools = new ToolGateway(
      this.database,
      options.credentials,
      join(options.dataPath, "outbox"),
      {
        createSchedule: (input) => this.createSchedule(input),
      },
      { dataPath: options.dataPath, telegramFetch: options.telegram?.fetchImpl },
    );
    this.runtime = new CoworkerRuntimeManager({
      database: this.database,
      tools: this.tools,
      credentials: options.credentials,
      emit: (event) => this.emit(event),
      providerErrors: this.providerErrors,
      applicationErrors: options.applicationLogger,
      workerFactory: options.workerFactory,
      onTaskCompleted: (task) => this.advanceDiscussion(task),
      onTaskFailed: (task, error) => this.failDiscussion(task, error),
    });
    this.scheduler = new SchedulerService(this.database, async (task) => {
      this.emit({ type: "entity.changed", entity: "tasks", id: task.id });
      this.emit({ type: "entity.changed", entity: "schedules" });
      this.emit({ type: "entity.changed", entity: "activity" });
      this.runtime.enqueueTask(task.coworkerId);
    }, (error) => options.applicationLogger?.error("scheduler", error));
    this.telegram = new TelegramBridgeService({
      database: this.database,
      credentials: options.credentials,
      host: this,
      emit: (event) => this.emit(event),
      onError: (scope, error) => void options.applicationLogger?.error(scope, error),
      fetchImpl: options.telegram?.fetchImpl,
      pollTimeoutSeconds: options.telegram?.pollTimeoutSeconds,
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.options.dataPath, { recursive: true });
    const recovered = this.database.recoverInterruptedTasks();
    if (recovered > 0) {
      this.database.addActivity({
        type: "app.recovered",
        summary: `Recovered ${recovered} interrupted task${recovered === 1 ? "" : "s"}`,
      });
    }
    if (!this.database.getEmailIntegration()) {
      this.database.upsertEmailIntegration({
        name: "Local outbox",
        mode: "local-outbox",
        credentialKey: null,
        fromAddress: "coworker@localhost",
      });
    }
    this.seedSkills();
    await this.seedCoworkers();
    await this.seedLegacyModelEndpoint();
    this.enableBundledSkills();
    this.enableDocumentExports();
    this.enableScheduleCreation();
    await this.options.onSettingsChanged?.(this.database.getSettings());
    await this.scheduler.start();
    await this.telegram.start();
    await this.recoverDiscussions();
    for (const coworker of this.database.listCoworkers()) {
      if (this.database.listTasks(coworker.id).some((task) => task.status === "QUEUED")) {
        this.runtime.enqueueTask(coworker.id);
      }
    }
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    this.scheduler.stop();
    await this.telegram.stop();
    await this.runtime.stopAll();
    this.database.close();
    this.initialized = false;
  }

  subscribe(listener: (event: DesktopEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): AppSnapshot {
    return {
      coworkers: this.database.listCoworkers(),
      conversations: this.database.listConversations(),
      discussions: this.database.listDiscussions(),
      tasks: this.database.listTasks(),
      messages: this.database.listAllMessages(),
      imageAttachments: this.database.listImageAttachments().map((attachment) => ({
        id: attachment.id,
        taskId: attachment.taskId,
        coworkerId: attachment.coworkerId,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        createdAt: attachment.createdAt,
      })),
      approvals: this.database.listApprovals(),
      schedules: this.database.listSchedules(),
      artifacts: this.database.listArtifacts(),
      activity: this.database.listActivity(),
      integrations: this.database.listIntegrations(),
      modelEndpoints: this.database.listModelEndpoints(),
      skills: this.database.listSkills(),
      settings: this.database.getSettings(),
      dataPath: this.options.dataPath,
      version: this.options.appVersion ?? "development",
    };
  }

  /**
   * A pre-existing OpenAI-compatible credential predates named endpoints;
   * surface it as a manageable endpoint entry once.
   */
  private async seedLegacyModelEndpoint(): Promise<void> {
    if (this.database.getModelEndpoint("openai-compatible")) return;
    const legacyKey = modelProviderCredentialKey("openai-compatible");
    if (!(await this.options.credentials.has(legacyKey))) return;
    const baseUrl = await readableCredential(
      this.options.credentials,
      modelProviderBaseUrlKey("openai-compatible"),
    );
    this.database.upsertModelEndpoint({
      id: "openai-compatible",
      name: "OpenAI-compatible",
      baseUrl: baseUrl ?? "",
    });
  }

  async createCoworker(input: CreateCoworkerInput) {
    const sharedFolders = await resolveSharedFolderGrants(input.sharedFolderPaths ?? [], {
      dataPath: this.options.dataPath,
    });
    const provisionalPath = join(
      this.options.dataPath,
      "workspaces",
      `${safeDirectoryName(input.name)}-${Date.now().toString(36)}`,
    );
    await mkdir(provisionalPath, { recursive: true });
    const coworker = this.database.createCoworker(
      {
        ...input,
        enabledSkillIds:
          input.enabledSkillIds ??
          this.database.listSkills().filter((skill) => skill.bundled).map((skill) => skill.id),
        sharedFolders,
      },
      provisionalPath,
    );
    this.emit({ type: "entity.changed", entity: "coworkers", id: coworker.id });
    this.emit({ type: "entity.changed", entity: "activity" });
    return coworker;
  }

  async updateCoworker(id: string, input: UpdateCoworkerInput) {
    const sharedFolders =
      input.sharedFolderPaths === undefined
        ? undefined
        : await resolveSharedFolderGrants(input.sharedFolderPaths, {
            dataPath: this.options.dataPath,
          });
    const coworker = this.database.updateCoworker(id, { ...input, sharedFolders });
    if (this.runtime) await this.runtime.stop(id);
    if (coworker.status === "active") this.runtime.enqueueTask(id);
    this.emit({ type: "entity.changed", entity: "coworkers", id });
    this.emit({ type: "entity.changed", entity: "activity" });
    return coworker;
  }

  async removeCoworker(id: string): Promise<void> {
    await this.runtime.stop(id);
    this.database.deleteCoworker(id);
    this.emit({ type: "entity.changed", entity: "coworkers", id });
    this.emit({ type: "entity.changed", entity: "activity" });
  }

  createConversation(input: CreateConversationInput) {
    const conversation = this.database.createConversation(input);
    this.emit({ type: "entity.changed", entity: "conversations", id: conversation.id });
    return conversation;
  }

  updateConversation(id: string, input: UpdateConversationInput) {
    if (input.memberIds) {
      const current = this.database.getConversation(id);
      const nextMembers = new Set(input.memberIds);
      const removed = current.memberIds.filter((memberId) => !nextMembers.has(memberId));
      const activeRemovedTask = this.database
        .listTasks()
        .find(
          (task) =>
            task.threadId === id &&
            removed.includes(task.coworkerId) &&
            ["QUEUED", "RUNNING", "WAITING_FOR_APPROVAL"].includes(task.status),
        );
      if (activeRemovedTask) {
        const coworker = this.database.getCoworker(activeRemovedTask.coworkerId);
        throw new Error(`Wait for or cancel ${coworker.name}'s channel work before removing them`);
      }
    }
    const conversation = this.database.updateConversation(id, input);
    this.emit({ type: "entity.changed", entity: "conversations", id });
    return conversation;
  }

  /** The default direct conversation is each coworker's permanent anchor. */
  private isDefaultConversation(conversation: { id: string; coworkerId: string | null }): boolean {
    return conversation.coworkerId !== null && conversation.id === `coworker:${conversation.coworkerId}`;
  }

  archiveConversation(id: string): Conversation {
    const conversation = this.database.getConversation(id);
    if (this.isDefaultConversation(conversation)) {
      throw new Error("A coworker's main conversation can't be archived");
    }
    const archived = this.database.setConversationArchived(id, true);
    this.emit({ type: "entity.changed", entity: "conversations", id });
    this.emit({ type: "entity.changed", entity: "activity" });
    return archived;
  }

  restoreConversation(id: string): Conversation {
    const restored = this.database.setConversationArchived(id, false);
    this.emit({ type: "entity.changed", entity: "conversations", id });
    this.emit({ type: "entity.changed", entity: "activity" });
    return restored;
  }

  removeConversation(id: string): void {
    const conversation = this.database.getConversation(id);
    if (this.isDefaultConversation(conversation)) {
      throw new Error("A coworker's main conversation can't be deleted");
    }
    if (conversation.kind !== "group" && !conversation.archivedAt) {
      throw new Error("Archive this conversation before deleting it permanently");
    }
    const activeTask = this.database
      .listTasks()
      .find(
        (task) =>
          task.threadId === id &&
          ["QUEUED", "RUNNING", "WAITING_FOR_APPROVAL"].includes(task.status),
      );
    if (activeTask) {
      const owner = this.database.getCoworker(activeTask.coworkerId);
      throw new Error(
        `Wait for or cancel ${owner.name}'s work in this conversation before deleting it`,
      );
    }
    this.database.deleteConversation(id);
    this.emit({ type: "entity.changed", entity: "conversations", id });
    this.emit({ type: "entity.changed", entity: "discussions" });
    this.emit({ type: "entity.changed", entity: "tasks" });
    this.emit({ type: "entity.changed", entity: "activity" });
  }

  async sendConversationMessage(input: SendConversationMessageInput) {
    let conversation = this.database.getConversation(input.conversationId);
    if (conversation.archivedAt) {
      // New activity brings an archived conversation back, so messages
      // arriving from Telegram or a schedule can never disappear unseen.
      conversation = this.database.setConversationArchived(conversation.id, false);
      this.emit({ type: "entity.changed", entity: "conversations", id: conversation.id });
    }
    const existingMessage = this.database.findMessage(input.clientMessageId);
    if (existingMessage) {
      if (existingMessage.conversationId !== input.conversationId) {
        throw new Error("This message identifier is already used in another conversation");
      }
      const existingMentions = [...existingMessage.mentionedCoworkerIds].sort().join("\0");
      const rawMentions = [...new Set(input.mentionedCoworkerIds)].sort().join("\0");
      const expandedMentions = [
        ...new Set(
          input.mentionedCoworkerIds.length === 0
            ? conversation.memberIds
            : input.mentionedCoworkerIds,
        ),
      ]
        .sort()
        .join("\0");
      if (
        existingMessage.content !== (input.content || "Analyze the attached image.") ||
        (existingMentions !== rawMentions && existingMentions !== expandedMentions)
      ) {
        throw new Error("This message identifier was already used with different content");
      }
      const existingDiscussion = this.database.findDiscussionBySourceMessage(
        existingMessage.id,
      );
      return {
        message: existingMessage,
        runs: this.database.listTasksBySourceMessage(existingMessage.id).map((task) => ({
          coworkerId: task.coworkerId,
          runId: task.runId,
          taskId: task.id,
        })),
        discussion: existingDiscussion,
      };
    }

    const mentionedCoworkerIds = [...new Set(input.mentionedCoworkerIds)];
    const ongoingDiscussion =
      conversation.kind === "group"
        ? this.database
            .listDiscussions(conversation.id)
            .find((item) => ["active", "awaiting_user"].includes(item.status))
        : undefined;
    if (ongoingDiscussion && mentionedCoworkerIds.length === 0) {
      return this.interjectInDiscussion(conversation.id, ongoingDiscussion, input);
    }
    if (ongoingDiscussion) {
      throw new Error(
        "A discussion is in progress. Reply without mentions to join it, or end it before starting new work.",
      );
    }
    const targetIds =
      mentionedCoworkerIds.length === 0
        ? conversation.memberIds
        : mentionedCoworkerIds;
    if (targetIds.length === 0) {
      throw new Error("This conversation has no coworkers to respond");
    }
    const isDiscussion = targetIds.length >= 2;
    if (targetIds.some((id) => !conversation.memberIds.includes(id))) {
      throw new Error("Messages can only mention coworkers who belong to this conversation");
    }
    const targets = targetIds.map((id) => this.database.getCoworker(id));
    const paused = targets.find((coworker) => coworker.status !== "active");
    if (paused) throw new Error(`${paused.name} is paused`);

    const images = parseConversationImages(input.images);
    if (images.length > 0) {
      const capabilities = await Promise.all(
        targets.map((coworker) =>
          getModelCapabilities(
            coworker.modelProvider,
            coworker.modelName,
            this.options.credentials,
          ),
        ),
      );
      const unsupportedIndex = capabilities.findIndex((item) => !item.supportsImages);
      if (unsupportedIndex >= 0) {
        const unsupported = targets[unsupportedIndex]!;
        throw new Error(
          `${unsupported.modelName} does not support image input. Choose a vision-capable model for ${unsupported.name}.`,
        );
      }
    }

    const discussionId = isDiscussion ? randomUUID() : null;
    const dispatchTargets = isDiscussion ? targets.slice(0, 1) : targets;
    const prepared = dispatchTargets.map((coworker) => ({
      coworker,
      taskId: randomUUID(),
      runId: randomUUID(),
    }));
    const persisted = new Map<string, Awaited<ReturnType<typeof persistImageAttachments>>>();
    try {
      for (const item of prepared) {
        persisted.set(
          item.taskId,
          await persistImageAttachments(
            item.coworker.workspacePath,
            item.taskId,
            images,
          ),
        );
      }
      const message = this.database.transaction(() => {
        const createdMessage = this.database.addMessage(
          {
            conversationId: conversation.id,
            coworkerId: null,
            authorName: "You",
            taskId: null,
            role: "user",
            content: input.content || "Analyze the attached image.",
            mentionedCoworkerIds: targetIds,
          },
          input.clientMessageId,
        );
        if (discussionId) {
          this.database.createDiscussion({
            id: discussionId,
            conversationId: conversation.id,
            sourceMessageId: createdMessage.id,
            participantIds: targetIds,
          });
        }
        for (const item of prepared) {
          const task = this.database.createTask(
            {
              coworkerId: item.coworker.id,
              title: taskTitle(createdMessage.content),
              input: createdMessage.content,
              source: "manual",
              runId: item.runId,
              threadId: conversation.id,
              sourceMessageId: createdMessage.id,
              discussionId: discussionId ?? undefined,
              discussionTurn: discussionId ? 0 : undefined,
              persistUserMessage: false,
            },
            item.taskId,
          );
          for (const attachment of persisted.get(item.taskId) ?? []) {
            this.database.addTaskImageAttachment({
              ...attachment,
              coworkerId: item.coworker.id,
              taskId: task.id,
            });
          }
        }
        return createdMessage;
      });
      this.emit({ type: "entity.changed", entity: "conversations", id: conversation.id });
      if (discussionId) {
        this.emit({ type: "entity.changed", entity: "discussions", id: discussionId });
      }
      this.emit({ type: "entity.changed", entity: "tasks" });
      this.emit({ type: "entity.changed", entity: "activity" });
      for (const item of prepared) this.runtime.enqueueTask(item.coworker.id);
      return {
        message,
        runs: prepared.map((item) => ({
          coworkerId: item.coworker.id,
          runId: item.runId,
          taskId: item.taskId,
        })),
        discussion: discussionId ? this.database.getDiscussion(discussionId) : null,
      };
    } catch (error) {
      await Promise.all(
        prepared.map((item) =>
          removePersistedImageAttachments(item.coworker.workspacePath, item.taskId).catch(
            () => undefined,
          ),
        ),
      );
      throw error;
    }
  }

  private async interjectInDiscussion(
    conversationId: string,
    discussion: DiscussionSession,
    input: SendConversationMessageInput,
  ) {
    if (input.images && input.images.length > 0) {
      throw new Error("Images cannot be attached while a discussion is in progress");
    }
    if (!input.content.trim()) {
      throw new Error("Write a message to add to the discussion");
    }
    const message = this.database.addMessage(
      {
        conversationId,
        coworkerId: null,
        authorName: "You",
        taskId: null,
        role: "user",
        content: input.content,
        mentionedCoworkerIds: [],
      },
      input.clientMessageId,
    );
    this.emit({ type: "entity.changed", entity: "conversations", id: conversationId });
    let run: (AgentRunReceipt & { coworkerId: string }) | null = null;
    if (discussion.status === "awaiting_user") {
      const extended = this.extendDiscussion(discussion);
      try {
        run = await this.createDiscussionTurn(extended, extended.nextTurn);
      } catch (error) {
        await this.markDiscussionFailed(
          discussion.id,
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
    }
    return {
      message,
      runs: run ? [run] : [],
      discussion: this.database.getDiscussion(discussion.id),
    };
  }

  async continueDiscussion(id: string) {
    const discussion = this.database.getDiscussion(id);
    if (discussion.status !== "awaiting_user") {
      throw new Error("This discussion is not waiting to continue");
    }
    const extended = this.extendDiscussion(discussion);
    try {
      const run = await this.createDiscussionTurn(extended, extended.nextTurn);
      return { discussion: this.database.getDiscussion(id), run };
    } catch (error) {
      await this.markDiscussionFailed(
        id,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  /** Grants another two rounds of runway when a paused discussion resumes. */
  private extendDiscussion(discussion: DiscussionSession): DiscussionSession {
    const extension = discussion.participantIds.length * 2;
    const hardLimit = Math.max(
      discussion.hardLimit,
      discussion.nextTurn + extension,
    );
    return this.database.updateDiscussion(discussion.id, {
      status: "active",
      turnLimit: hardLimit,
      hardLimit,
      error: null,
    });
  }

  async stopDiscussion(id: string) {
    const discussion = this.database.getDiscussion(id);
    if (["completed", "cancelled"].includes(discussion.status)) return discussion;
    const cancelled = this.database.updateDiscussion(id, {
      status: "cancelled",
      error: null,
    });
    this.emit({ type: "entity.changed", entity: "discussions", id });
    const activeTasks = this.database
      .listTasks()
      .filter(
        (task) =>
          task.discussionId === id &&
          ["QUEUED", "RUNNING", "WAITING_FOR_APPROVAL"].includes(task.status),
      );
    for (const task of activeTasks) await this.cancelTask(task.id);
    return cancelled;
  }

  async advanceDiscussion(task: Task): Promise<void> {
    if (!task.discussionId || task.discussionTurn === null) return;
    try {
      const discussion = this.database.getDiscussion(task.discussionId);
      if (
        discussion.status !== "active" ||
        task.discussionTurn !== discussion.nextTurn - 1
      ) {
        return;
      }
      if (this.hasDiscussionConsensus(discussion)) {
        this.database.updateDiscussion(discussion.id, { status: "completed" });
        this.emit({
          type: "entity.changed",
          entity: "discussions",
          id: discussion.id,
        });
        return;
      }
      if (discussion.nextTurn >= discussion.hardLimit) {
        this.database.updateDiscussion(discussion.id, { status: "awaiting_user" });
        this.emit({
          type: "entity.changed",
          entity: "discussions",
          id: discussion.id,
        });
        return;
      }
      await this.createDiscussionTurn(discussion, discussion.nextTurn);
    } catch (error) {
      await this.markDiscussionFailed(
        task.discussionId,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * A discussion concludes when every participant has passed in a row: each
   * coworker looked at the latest state and had nothing more to add.
   */
  private hasDiscussionConsensus(discussion: DiscussionSession): boolean {
    const completedTurns = this.database
      .listTasks()
      .filter(
        (task) =>
          task.discussionId === discussion.id && task.status === "COMPLETED",
      )
      .sort((left, right) => (left.discussionTurn ?? 0) - (right.discussionTurn ?? 0));
    let trailingPasses = 0;
    for (let index = completedTurns.length - 1; index >= 0; index -= 1) {
      if (!isDiscussionPass(completedTurns[index]?.result)) break;
      trailingPasses += 1;
    }
    return trailingPasses >= discussion.participantIds.length;
  }

  private async failDiscussion(task: Task, error: string): Promise<void> {
    if (!task.discussionId) return;
    const discussion = this.database.getDiscussion(task.discussionId);
    if (discussion.status !== "active") return;
    await this.markDiscussionFailed(discussion.id, error);
  }

  private async markDiscussionFailed(id: string, error: string): Promise<void> {
    this.database.updateDiscussion(id, { status: "failed", error });
    this.emit({ type: "entity.changed", entity: "discussions", id });
    await this.options.applicationLogger?.error(
      "discussion.advance",
      new Error(error),
      { discussionId: id },
    );
  }

  private async createDiscussionTurn(
    discussion: DiscussionSession,
    turn: number,
  ): Promise<AgentRunReceipt & { coworkerId: string }> {
    if (discussion.status !== "active") {
      throw new Error("Discussion is not active");
    }
    if (turn >= discussion.hardLimit) {
      throw new Error("Discussion turn limit reached");
    }
    const coworkerId =
      discussion.participantIds[turn % discussion.participantIds.length];
    if (!coworkerId) throw new Error("Discussion has no available speaker");
    const coworker = this.database.getCoworker(coworkerId);
    if (coworker.status !== "active") throw new Error(`${coworker.name} is paused`);
    const sourceMessage = this.database.getMessage(discussion.sourceMessageId);
    const taskId = randomUUID();
    const runId = randomUUID();
    const images = await this.loadDiscussionSourceImages(
      discussion.sourceMessageId,
    );
    const persisted = await persistImageAttachments(
      coworker.workspacePath,
      taskId,
      images,
    );
    try {
      this.database.transaction(() => {
        const task = this.database.createTask(
          {
            coworkerId,
            title: taskTitle(sourceMessage.content),
            input:
              turn === 0
                ? sourceMessage.content
                : `[Channel discussion turn ${turn + 1}. First decide whether you can add real value right now: new information, a concrete disagreement, a resolved dependency, or a distinct perspective your role is suited for. If not, reply with exactly ${DISCUSSION_PASS_MARKER}. Otherwise react to the newest coworker and user messages before adding your own contribution.]\n\nOriginal request:\n${sourceMessage.content}`,
            source: "manual",
            runId,
            threadId: discussion.conversationId,
            sourceMessageId: sourceMessage.id,
            discussionId: discussion.id,
            discussionTurn: turn,
            persistUserMessage: false,
          },
          taskId,
        );
        for (const attachment of persisted) {
          this.database.addTaskImageAttachment({
            ...attachment,
            coworkerId,
            taskId: task.id,
          });
        }
        this.database.updateDiscussion(discussion.id, {
          nextTurn: turn + 1,
          status: "active",
          error: null,
        });
      });
    } catch (error) {
      await removePersistedImageAttachments(coworker.workspacePath, taskId).catch(
        () => undefined,
      );
      throw error;
    }
    this.emit({ type: "entity.changed", entity: "tasks", id: taskId });
    this.emit({
      type: "entity.changed",
      entity: "discussions",
      id: discussion.id,
    });
    this.emit({
      type: "entity.changed",
      entity: "conversations",
      id: discussion.conversationId,
    });
    this.emit({ type: "entity.changed", entity: "activity" });
    this.runtime.enqueueTask(coworkerId);
    return { coworkerId, runId, taskId };
  }

  private async loadDiscussionSourceImages(
    sourceMessageId: string,
  ): Promise<IncomingImageAttachment[]> {
    for (const task of this.database.listTasksBySourceMessage(sourceMessageId)) {
      const attachments = this.database.listTaskImageAttachments(task.id);
      if (attachments.length === 0) continue;
      const coworker = this.database.getCoworker(task.coworkerId);
      const images = await loadImageAttachments(
        coworker.workspacePath,
        attachments,
      );
      return images.map((image, index) => ({
        data: Buffer.from(image.data, "base64"),
        mimeType: image.mimeType as IncomingImageAttachment["mimeType"],
        name: attachments[index]?.name ?? `image-${index + 1}`,
      }));
    }
    return [];
  }

  private async recoverDiscussions(): Promise<void> {
    for (const discussion of this.database
      .listDiscussions()
      .filter((item) => item.status === "active")) {
      const tasks = this.database
        .listTasks()
        .filter((task) => task.discussionId === discussion.id)
        .sort(
          (left, right) =>
            (left.discussionTurn ?? -1) - (right.discussionTurn ?? -1),
        );
      if (
        tasks.some((task) =>
          ["QUEUED", "RUNNING", "WAITING_FOR_APPROVAL"].includes(task.status),
        )
      ) {
        continue;
      }
      const latest = tasks.at(-1);
      if (!latest) {
        await this.markDiscussionFailed(
          discussion.id,
          "Discussion has no durable task to resume",
        );
      } else if (latest.status === "COMPLETED") {
        await this.advanceDiscussion(latest);
      } else if (latest.status === "FAILED") {
        await this.failDiscussion(
          latest,
          latest.error ?? "The latest discussion turn failed",
        );
      }
    }
  }

  createTask(input: CreateTaskInput) {
    const coworker = this.database.getCoworker(input.coworkerId);
    if (coworker.status !== "active") {
      throw new Error(`${coworker.name} is paused`);
    }
    const task = this.database.createTask(input);
    this.emit({ type: "entity.changed", entity: "tasks", id: task.id });
    this.emit({ type: "entity.changed", entity: "conversations", id: task.threadId });
    this.emit({ type: "entity.changed", entity: "activity" });
    this.runtime.enqueueTask(task.coworkerId);
    return task;
  }

  async cancelTask(id: string) {
    const task = this.database.getTask(id);
    await this.runtime.abort(task.coworkerId, task.runId);
    const cancelled = this.database.cancelTask(id);
    this.emit({ type: "entity.changed", entity: "tasks", id });
    this.emit({ type: "entity.changed", entity: "approvals" });
    this.emit({ type: "entity.changed", entity: "activity" });
    this.runtime.enqueueTask(task.coworkerId);
    return cancelled;
  }

  decideApproval(input: ApprovalDecisionInput): Approval {
    const pending = this.database.getApproval(input.approvalId);
    const decision =
      input.decision === "edit"
        ? {
            ...input,
            payload: this.tools.validateArguments(pending.actionType, input.payload),
          }
        : input;
    const approval = this.database.decideApproval(decision);
    this.emit({ type: "entity.changed", entity: "approvals", id: approval.id });
    this.emit({ type: "entity.changed", entity: "tasks", id: approval.taskId });
    this.emit({ type: "entity.changed", entity: "activity" });
    this.runtime.enqueueTask(approval.coworkerId);
    return approval;
  }

  createSchedule(input: CreateScheduleInput) {
    const schedule = this.scheduler.create(input);
    this.emit({ type: "entity.changed", entity: "schedules", id: schedule.id });
    this.emit({ type: "entity.changed", entity: "activity" });
    return schedule;
  }

  updateSchedule(id: string, input: UpdateScheduleInput) {
    const schedule = this.scheduler.update(id, input);
    this.emit({ type: "entity.changed", entity: "schedules", id });
    return schedule;
  }

  removeSchedule(id: string): void {
    this.scheduler.remove(id);
    this.emit({ type: "entity.changed", entity: "schedules", id });
    this.emit({ type: "entity.changed", entity: "activity" });
  }

  async runScheduleNow(id: string) {
    const task = await this.scheduler.runNow(id);
    const coworker = this.database.getCoworker(task.coworkerId);
    this.emit({
      type: "notification",
      title: "Scheduled task started",
      body: `${coworker.name} is working on “${task.title}”.`,
    });
    return task;
  }

  async runAgent(request: AgentRunRequest): Promise<AgentRunReceipt> {
    const existing = this.database.getTaskByRunId(request.input.runId);
    if (existing) return { runId: existing.runId, taskId: existing.id };
    const coworker = this.database.getCoworker(request.coworkerId);
    const prompt = parseAgentPrompt(request.input);
    const skillUrl = skillUrlFromPrompt(prompt.text);
    const installedSkill = skillUrl
      ? await this.installSkillFromUrl(skillUrl, coworker.id)
      : null;
    const capabilities = await getModelCapabilities(
      coworker.modelProvider,
      coworker.modelName,
      this.options.credentials,
    );
    if (
      prompt.images.length > 0 &&
      !capabilities.supportsImages
    ) {
      throw new Error(
        `${coworker.modelName} does not support image input. Choose a vision-capable model in coworker settings.`,
      );
    }

    const taskId = randomUUID();
    let committed = false;
    try {
      const attachments = await persistImageAttachments(
        coworker.workspacePath,
        taskId,
        prompt.images,
      );
      const task = this.database.transaction(() => {
        const created = this.database.createTask(
          {
            coworkerId: request.coworkerId,
            title: taskTitle(prompt.text),
            input: installedSkill
              ? `${prompt.text}\n\n[Workroom installed and enabled the Agent Skill “${installedSkill.name}” for this coworker. Confirm the installation and briefly explain when you will use it.]`
              : prompt.text,
            source: "manual",
            runId: request.input.runId,
            threadId: request.input.threadId,
          },
          taskId,
        );
        for (const attachment of attachments) {
          this.database.addTaskImageAttachment({
            ...attachment,
            coworkerId: coworker.id,
            taskId: created.id,
          });
        }
        return created;
      });
      committed = true;
      this.emit({ type: "entity.changed", entity: "tasks", id: task.id });
      this.emit({ type: "entity.changed", entity: "conversations", id: task.threadId });
      this.emit({ type: "entity.changed", entity: "activity" });
      this.runtime.enqueueTask(task.coworkerId);
      return { runId: task.runId, taskId: task.id };
    } catch (error) {
      if (!committed && prompt.images.length > 0) {
        await removePersistedImageAttachments(coworker.workspacePath, taskId).catch(() => undefined);
      }
      throw error;
    }
  }

  async configureEmail(input: {
    name: string;
    mode: EmailIntegrationMode;
    apiKey?: string;
    fromAddress?: string;
  }): Promise<Integration> {
    const credentialKey = input.mode === "resend" ? "integration:email:resend" : null;
    if (input.mode === "resend") {
      if (input.apiKey) await this.options.credentials.set(credentialKey!, input.apiKey);
      if (!(await this.options.credentials.has(credentialKey!))) {
        throw new Error("A Resend API key is required");
      }
    }
    const integration = this.database.upsertEmailIntegration({
      name: input.name,
      mode: input.mode,
      credentialKey,
      fromAddress: input.fromAddress,
    });
    this.emit({ type: "entity.changed", entity: "integrations", id: integration.id });
    return integration;
  }

  async configureTelegram(input: {
    botToken?: string;
    coworkerId: string;
  }): Promise<TelegramIntegrationStatus> {
    const coworker = this.database.getCoworker(input.coworkerId);
    const submittedToken = input.botToken?.trim();
    const storedToken = submittedToken
      ? null
      : await readableCredential(this.options.credentials, telegramCredentialKey);
    const token = submittedToken || storedToken;
    if (!token) throw new Error("A Telegram bot token from @BotFather is required");

    const api = new TelegramBotApi(token, this.options.telegram?.fetchImpl ?? fetch);
    let me: Awaited<ReturnType<TelegramBotApi["getMe"]>>;
    try {
      me = await api.getMe();
    } catch (error) {
      throw new Error(
        `Telegram did not accept that bot token: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
    if (!me.username) throw new Error("Telegram did not return the bot's username");

    await this.options.credentials.set(telegramCredentialKey, token);
    const existing = this.database.getTelegramIntegration();
    const previous = existing ? parseTelegramConfig(existing) : null;
    const sameBot = previous?.botUsername === me.username;
    const sameCoworker = previous?.coworkerId === coworker.id;
    const config: TelegramIntegrationConfig = {
      botUsername: me.username,
      coworkerId: coworker.id,
      conversationId: `coworker:${coworker.id}`,
      chatId: sameBot ? previous?.chatId ?? null : null,
      pairingCode:
        (sameBot && previous?.pairingCode) || randomBytes(9).toString("base64url"),
      topics: sameBot && sameCoworker ? previous?.topics ?? {} : {},
      lastThreads: sameBot && sameCoworker ? previous?.lastThreads ?? {} : {},
      lastUpdateId: sameBot ? previous?.lastUpdateId ?? null : null,
      threadsEnabled: me.has_topics_enabled === true,
    };
    const integration = this.database.upsertTelegramIntegration({
      name: `@${me.username}`,
      credentialKey: telegramCredentialKey,
      status: "connected",
      config: { ...config },
    });
    this.enableTelegramTool(coworker.id);

    // Moving the bot between coworkers keeps the paired chat; hand off
    // loudly so neither side is left guessing where messages go now.
    const previousCoworkerId = previous?.coworkerId ?? null;
    if (sameBot && previousCoworkerId && previousCoworkerId !== coworker.id) {
      this.disableTelegramTool(previousCoworkerId);
      const previousName = this.coworkerNameOrNull(previousCoworkerId);
      this.database.addActivity({
        type: "telegram.relinked",
        summary: `Telegram bot @${me.username} moved from ${previousName ?? "another coworker"} to ${coworker.name}`,
      });
      this.emit({ type: "entity.changed", entity: "activity" });
      if (config.chatId !== null) {
        try {
          await api.sendMessage({
            chatId: config.chatId,
            text: `This chat now goes to ${coworker.name}${previousName ? ` (previously ${previousName})` : ""}. No re-pairing needed — just send a message.`,
          });
        } catch (error) {
          void this.options.applicationLogger?.error("telegram.relink-notice", error);
        }
      }
    }

    this.emit({ type: "entity.changed", entity: "integrations", id: integration.id });
    await this.telegram.restart();
    return this.telegramStatus();
  }

  telegramStatus(): TelegramIntegrationStatus {
    const integration = this.database.getTelegramIntegration();
    if (!integration || integration.status !== "connected") {
      return { integration, pairingLink: null };
    }
    const config = parseTelegramConfig(integration);
    return {
      integration,
      pairingLink:
        config.chatId === null
          ? telegramPairingLink(config.botUsername, config.pairingCode)
          : null,
    };
  }

  async unpairTelegram(): Promise<TelegramIntegrationStatus> {
    const integration = this.database.getTelegramIntegration();
    if (!integration) throw new Error("The Telegram integration is not configured");
    this.database.updateTelegramIntegration({
      config: { chatId: null, pairingCode: randomBytes(9).toString("base64url") },
    });
    this.emit({ type: "entity.changed", entity: "integrations", id: integration.id });
    await this.telegram.restart();
    return this.telegramStatus();
  }

  async disconnectTelegram(): Promise<void> {
    await this.telegram.stop();
    const integration = this.database.getTelegramIntegration();
    if (integration) {
      this.database.updateTelegramIntegration({
        status: "disconnected",
        config: { chatId: null },
      });
      this.emit({ type: "entity.changed", entity: "integrations", id: integration.id });
    }
    try {
      await this.options.credentials.delete(telegramCredentialKey);
    } catch {
      // The credential may already be gone; disconnecting stays idempotent.
    }
  }

  /** Turns on the policy-gated telegram.send tool for the linked coworker. */
  private enableTelegramTool(coworkerId: string): void {
    const coworker = this.database.getCoworker(coworkerId);
    if (coworker.enabledTools.includes("telegram.send")) return;
    this.database.updateCoworker(coworkerId, {
      enabledTools: [...coworker.enabledTools, "telegram.send"],
      policies: {
        ...coworker.policies,
        "telegram.send": coworker.policies["telegram.send"] ?? "approval",
      },
    });
    this.emit({ type: "entity.changed", entity: "coworkers", id: coworkerId });
  }

  /** Removes telegram.send from a coworker that lost its Telegram link. */
  private disableTelegramTool(coworkerId: string): void {
    const name = this.coworkerNameOrNull(coworkerId);
    if (name === null) return;
    const coworker = this.database.getCoworker(coworkerId);
    if (!coworker.enabledTools.includes("telegram.send")) return;
    this.database.updateCoworker(coworkerId, {
      enabledTools: coworker.enabledTools.filter((tool) => tool !== "telegram.send"),
    });
    this.emit({ type: "entity.changed", entity: "coworkers", id: coworkerId });
  }

  private coworkerNameOrNull(coworkerId: string): string | null {
    try {
      return this.database.getCoworker(coworkerId).name;
    } catch {
      return null;
    }
  }

  async configureModel(input: {
    provider: RemoteModelProvider;
    apiKey?: string;
    baseUrl?: string;
    defaultModelName?: string;
    endpointName?: string;
  }): Promise<ConfigureModelResult> {
    try {
      const definition = getModelProviderDefinition(input.provider);
      const key = modelProviderCredentialKey(input.provider);
      const endpoint = isModelEndpointProvider(input.provider)
        ? this.database.getModelEndpoint(input.provider)
        : null;
      const submittedApiKey = input.apiKey?.trim();
      const storedApiKey = submittedApiKey
        ? null
        : await readableCredential(this.options.credentials, key);
      const apiKey =
        submittedApiKey ||
        storedApiKey ||
        (definition.apiKeyRequired ? "" : localModelCredentialMarker);
      if (!apiKey) {
        throw new Error(`A ${modelProviderName(input.provider)} API key is required`);
      }
      const submittedBaseUrl = input.baseUrl?.trim();
      const storedBaseUrl =
        definition.baseUrlMode === "none" || submittedBaseUrl
          ? undefined
          : (await readableCredential(
              this.options.credentials,
              modelProviderBaseUrlKey(input.provider),
            )) || endpoint?.baseUrl;
      const baseUrl = submittedBaseUrl || storedBaseUrl || definition.defaultBaseUrl;
      if (definition.baseUrlMode === "required" && !baseUrl) {
        throw new Error(`A base URL is required for ${modelProviderName(input.provider)}`);
      }
      const availableModels = await queryProviderModels(input.provider, apiKey, fetch, { baseUrl });
      if (availableModels.length === 0) {
        throw new Error(
          `${modelProviderName(input.provider)} returned no compatible chat models`,
        );
      }
      if (
        input.defaultModelName !== undefined &&
        !availableModels.some((model) => model.id === input.defaultModelName)
      ) {
        throw new Error(
          `Model ${input.defaultModelName} is not available to this ${modelProviderName(input.provider)} credential`,
        );
      }
      await this.options.credentials.set(key, apiKey);
      if (definition.baseUrlMode !== "none" && baseUrl) {
        await this.options.credentials.set(modelProviderBaseUrlKey(input.provider), baseUrl);
      }
      if (isModelEndpointProvider(input.provider)) {
        this.database.upsertModelEndpoint({
          id: input.provider,
          name: input.endpointName ?? endpoint?.name ?? "OpenAI-compatible",
          baseUrl: baseUrl ?? "",
        });
        this.emit({ type: "entity.changed", entity: "integrations" });
      }
      if (input.defaultModelName !== undefined) {
        await this.updateSettings({
          defaultModelProvider: input.provider,
          defaultModelName: input.defaultModelName,
        });
      }
      return {
        key,
        configured: true,
        models: availableModels,
        defaultApplied: input.defaultModelName !== undefined,
      };
    } catch (error) {
      await this.providerErrors.log(
        { phase: "configuration", provider: input.provider },
        error,
      );
      throw error;
    }
  }

  async addModelEndpoint(input: {
    name: string;
    baseUrl: string;
    apiKey?: string;
    defaultModelName?: string;
  }): Promise<ConfigureModelResult & { provider: RemoteModelProvider }> {
    const provider =
      `openai-compatible:${randomUUID().replaceAll("-", "").slice(0, 10)}` as const;
    const result = await this.configureModel({
      provider,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      defaultModelName: input.defaultModelName,
      endpointName: input.name,
    });
    return { ...result, provider };
  }

  async removeModelEndpoint(id: RemoteModelProvider): Promise<void> {
    if (!isModelEndpointProvider(id)) {
      throw new Error("Only OpenAI-compatible endpoints can be removed");
    }
    const endpoint = this.database.getModelEndpoint(id);
    if (!endpoint) throw new Error("This endpoint is no longer configured");
    const dependents = this.database
      .listCoworkers()
      .filter((coworker) => coworker.modelProvider === id)
      .map((coworker) => coworker.name);
    if (dependents.length > 0) {
      throw new Error(
        `${endpoint.name} is still used by ${dependents.join(", ")}. Move ${dependents.length === 1 ? "that coworker" : "those coworkers"} to another model first.`,
      );
    }
    this.database.deleteModelEndpoint(id);
    await this.options.credentials.delete(modelProviderCredentialKey(id));
    await this.options.credentials.delete(modelProviderBaseUrlKey(id));
    const settings = this.database.getSettings();
    if (settings.defaultModelProvider === id) {
      await this.updateSettings({ defaultModelProvider: null, defaultModelName: null });
    }
    this.emit({ type: "entity.changed", entity: "integrations" });
  }

  async configureWebSearch(input: {
    provider: WebSearchProvider;
    apiKey: string;
  }) {
    const key = webSearchCredentialKey(input.provider);
    await this.options.credentials.set(key, input.apiKey.trim());
    this.database.addActivity({
      type: "web-search.configured",
      summary: `${input.provider} web search was configured`,
      metadata: { provider: input.provider },
    });
    this.emit({ type: "entity.changed", entity: "integrations" });
    this.emit({ type: "entity.changed", entity: "activity" });
    return { key, configured: true };
  }

  async installSkillFromUrl(url: string, coworkerId?: string) {
    const skill = await installSkillFromUrl(this.database, url, coworkerId);
    this.database.replaceSkillResources(skill.id, []);
    if (coworkerId) await this.runtime.stop(coworkerId);
    this.emit({ type: "entity.changed", entity: "skills", id: skill.id });
    this.emit({ type: "entity.changed", entity: "coworkers", id: coworkerId });
    this.emit({ type: "entity.changed", entity: "activity" });
    return skill;
  }

  async installSkillFromContent(content: string, coworkerId?: string) {
    const parsed = parseSkillMarkdown(content);
    const existing = this.database.getSkillByName(parsed.name);
    if (existing?.bundled) throw new Error(`The bundled skill “${parsed.name}” cannot be replaced`);
    const skill = this.database.upsertSkill({ ...parsed, bundled: false });
    this.database.replaceSkillResources(skill.id, []);
    if (coworkerId) {
      const coworker = this.database.getCoworker(coworkerId);
      this.database.setCoworkerSkills(coworkerId, [...coworker.enabledSkillIds, skill.id]);
      await this.runtime.stop(coworkerId);
    }
    this.emit({ type: "entity.changed", entity: "skills", id: skill.id });
    this.emit({ type: "entity.changed", entity: "coworkers", id: coworkerId });
    this.emit({ type: "entity.changed", entity: "activity" });
    return skill;
  }

  async installSkillFromPackage(
    fileName: string,
    dataBase64: string,
    coworkerId?: string,
  ) {
    if (!/\.(?:skill|zip)$/i.test(fileName)) {
      throw new Error("Skill packages must use a .skill or .zip extension");
    }
    const bytes = Buffer.from(dataBase64, "base64");
    const parsed = await parseSkillPackage(bytes);
    const existing = this.database.getSkillByName(parsed.skill.name);
    if (existing?.bundled) {
      throw new Error(`The bundled skill “${parsed.skill.name}” cannot be replaced`);
    }
    const skill = this.database.upsertSkill({
      ...parsed.skill,
      sourceUrl: null,
      bundled: false,
    });
    this.database.replaceSkillResources(skill.id, parsed.resources);
    if (coworkerId) {
      const coworker = this.database.getCoworker(coworkerId);
      this.database.setCoworkerSkills(coworkerId, [...coworker.enabledSkillIds, skill.id]);
      await this.runtime.stop(coworkerId);
    }
    this.emit({ type: "entity.changed", entity: "skills", id: skill.id });
    this.emit({ type: "entity.changed", entity: "coworkers", id: coworkerId });
    this.emit({ type: "entity.changed", entity: "activity" });
    return skill;
  }

  async removeSkill(id: string): Promise<void> {
    const affected = this.database
      .listCoworkers()
      .filter((coworker) => coworker.enabledSkillIds.includes(id));
    await Promise.all(affected.map((coworker) => this.runtime.stop(coworker.id)));
    this.database.removeSkill(id);
    this.emit({ type: "entity.changed", entity: "skills", id });
    this.emit({ type: "entity.changed", entity: "coworkers" });
    this.emit({ type: "entity.changed", entity: "activity" });
  }

  async listModels(provider: ModelProvider) {
    try {
      return await listAvailableModels(provider, this.options.credentials);
    } catch (error) {
      await this.providerErrors.log({ phase: "model_catalog", provider }, error);
      throw error;
    }
  }

  async modelCapabilities(provider: ModelProvider, modelId: string) {
    try {
      return await getModelCapabilities(provider, modelId, this.options.credentials);
    } catch (error) {
      await this.providerErrors.log(
        { phase: "capabilities", provider, model: modelId },
        error,
      );
      throw error;
    }
  }

  async updateSettings(input: Partial<AppSettings>): Promise<AppSettings> {
    const previous = this.database.getSettings();
    const settings = this.database.updateSettings(input);
    if (
      input.globalOperatingInstructions !== undefined &&
      settings.globalOperatingInstructions !== previous.globalOperatingInstructions
    ) {
      await this.runtime.stopAll();
    }
    await this.options.onSettingsChanged?.(settings);
    this.emit({ type: "entity.changed", entity: "settings" });
    return settings;
  }

  listApprovals(status?: ApprovalStatus) {
    return this.database.listApprovals(status);
  }

  async deleteArtifact(id: string): Promise<void> {
    const artifact = await deleteArtifactFile(this.database, id);
    this.emit({ type: "entity.changed", entity: "artifacts", id: artifact.id });
    this.emit({ type: "entity.changed", entity: "activity" });
  }

  async readImageAttachment(id: string) {
    const attachment = this.database.getTaskImageAttachment(id);
    const coworker = this.database.getCoworker(attachment.coworkerId);
    const [image] = await loadImageAttachments(coworker.workspacePath, [attachment]);
    if (!image) throw new Error(`Image attachment ${id} could not be loaded`);
    return { data: image.data, mimeType: image.mimeType };
  }

  backup(destinationPath?: string): string {
    const path =
      destinationPath ??
      join(
        this.options.dataPath,
        "backups",
        `Coworker-Backup-${new Date().toISOString().replaceAll(":", "-")}.db`,
      );
    return this.database.backup(path);
  }

  async exportDataBackup(destinationPath: string): Promise<string> {
    if (this.dataExportInProgress) throw new Error("A complete data backup is already running");
    this.dataExportInProgress = true;
    this.runtime.pauseDispatch();
    this.scheduler.stop();
    try {
      const runningTasks = this.database
        .listTasks(undefined, Number.MAX_SAFE_INTEGER)
        .filter((task) => task.status === "RUNNING");
      if (runningTasks.length > 0) {
        throw new Error("Wait for active coworker tasks to finish before exporting all data");
      }
      await this.waitForDataMutations();
      await this.runtime.stopAll();
      const path = await createDataBackup({
        destinationPath,
        dataPath: this.options.dataPath,
        coworkers: this.database.listCoworkers(),
        createDatabaseSnapshot: (path) => this.database.backup(path),
        appVersion: this.options.appVersion ?? "development",
      });
      await this.options.applicationLogger?.info("data.export", "Complete data backup created");
      return path;
    } catch (error) {
      await this.options.applicationLogger?.error("data.export", error);
      throw error;
    } finally {
      this.dataExportInProgress = false;
      if (this.initialized) await this.scheduler.start();
      this.runtime.resumeDispatch();
    }
  }

  assertDataMutationAllowed(): void {
    if (this.dataExportInProgress) {
      throw new Error("Coworker data is temporarily read-only while a complete backup is created");
    }
  }

  beginDataMutation(): () => void {
    this.assertDataMutationAllowed();
    this.activeDataMutations += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.activeDataMutations = Math.max(0, this.activeDataMutations - 1);
      if (this.activeDataMutations === 0) {
        for (const resolve of this.dataMutationWaiters) resolve();
        this.dataMutationWaiters.clear();
      }
    };
  }

  private waitForDataMutations(): Promise<void> {
    if (this.activeDataMutations === 0) return Promise.resolve();
    return new Promise((resolve) => this.dataMutationWaiters.add(resolve));
  }

  private emit(event: DesktopEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private enableDocumentExports(): void {
    const migrationKey = "documents-export-tool-enabled-v1";
    if (this.database.getMetadata(migrationKey) === "true") return;
    for (const coworker of this.database.listCoworkers()) {
      if (
        coworker.enabledTools.includes("files.write") &&
        !coworker.enabledTools.includes("documents.export")
      ) {
        this.database.updateCoworker(coworker.id, {
          enabledTools: [...coworker.enabledTools, "documents.export"],
        });
      }
    }
    this.database.setMetadata(migrationKey, "true");
  }

  private enableScheduleCreation(): void {
    const migrationKey = "schedule-create-tool-enabled-v1";
    if (this.database.getMetadata(migrationKey) === "true") return;
    for (const coworker of this.database.listCoworkers()) {
      this.database.updateCoworker(coworker.id, {
        enabledTools: coworker.enabledTools.includes("schedules.create")
          ? coworker.enabledTools
          : [...coworker.enabledTools, "schedules.create"],
        policies: {
          ...coworker.policies,
          "schedules.create": coworker.policies["schedules.create"] ?? "approval",
        },
      });
    }
    this.database.setMetadata(migrationKey, "true");
  }

  private seedSkills(): void {
    for (const bundledSkill of bundledSkills) {
      const existing = this.database.getSkillByName(bundledSkill.name);
      if (
        !existing ||
        existing.content !== bundledSkill.content ||
        existing.description !== bundledSkill.description
      ) {
        this.database.upsertSkill(bundledSkill);
      }
    }
  }

  private enableBundledSkills(): void {
    const migrationKey = "bundled-skills-enabled-v4";
    if (this.database.getMetadata(migrationKey) === "true") return;
    const bundledIds = this.database
      .listSkills()
      .filter((skill) => skill.bundled)
      .map((skill) => skill.id);
    for (const coworker of this.database.listCoworkers()) {
      this.database.setCoworkerSkills(coworker.id, [
        ...coworker.enabledSkillIds,
        ...bundledIds,
      ]);
    }
    this.database.setMetadata(migrationKey, "true");
  }

  private async seedCoworkers(): Promise<void> {
    if (this.database.getMetadata("default-coworkers-seeded") === "true") return;
    const names = new Set(this.database.listCoworkers().map((coworker) => coworker.name));
    if (!names.has("Ava")) {
      await this.createCoworker({
        name: "Ava",
        role: "Accounting Coworker",
        description: "Prepares invoices, reports, and customer correspondence.",
        systemPrompt:
          "You are Ava, a careful accounting coworker. Use controlled tools to create accurate artifacts. Never claim an external action happened unless its tool succeeded.",
        modelProvider: "demo",
        modelName: "faux-1",
        enabledTools: [
          "files.list",
          "files.read",
          "files.write",
          "invoice.create",
          "documents.export",
          "email.create_draft",
          "schedules.create",
          "email.send",
        ],
        policies: { "email.send": "approval", "schedules.create": "approval" },
      });
    }
    if (!names.has("Sarah")) {
      await this.createCoworker({
        name: "Sarah",
        role: "Sales Coworker",
        description: "Prepares lead follow-ups and concise sales reports.",
        systemPrompt:
          "You are Sarah, a focused sales coworker. Prepare useful local reports and drafts while respecting approval policies.",
        modelProvider: "demo",
        modelName: "faux-1",
        enabledTools: [
          "files.list",
          "files.read",
          "files.write",
          "documents.export",
          "email.create_draft",
          "schedules.create",
          "email.send",
        ],
        policies: { "email.send": "approval", "schedules.create": "approval" },
      });
    }
    this.database.setMetadata("default-coworkers-seeded", "true");
  }
}
