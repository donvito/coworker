import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentRunReceipt,
  AgentRunRequest,
  AppSettings,
  AppSnapshot,
  Approval,
  ApprovalDecisionInput,
  ApprovalStatus,
  CreateCoworkerInput,
  CreateScheduleInput,
  CreateTaskInput,
  DesktopEvent,
  Integration,
  ModelProvider,
  RemoteModelProvider,
  UpdateCoworkerInput,
  UpdateScheduleInput,
} from "@shared/contracts";
import { CoworkerDatabase } from "@main/db/database";
import {
  listAvailableModels,
  modelSupportsImageInput,
  queryProviderModels,
} from "@main/integrations/model-catalog";
import { deleteArtifactFile } from "@main/integrations/artifact-files";
import {
  loadImageAttachments,
  parseAgentPrompt,
  persistImageAttachments,
  removePersistedImageAttachments,
} from "@main/integrations/image-attachments";
import type { CredentialStore } from "@main/security/credential-store";
import { SchedulerService } from "@main/scheduler/scheduler-service";
import { ToolGateway } from "@main/tools/tool-gateway";
import { CoworkerRuntimeManager } from "@main/runtime/runtime-manager";

export interface DesktopAppServiceOptions {
  dataPath: string;
  database?: CoworkerDatabase;
  credentials: CredentialStore;
  onSettingsChanged?: (settings: AppSettings) => void | Promise<void>;
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

export class DesktopAppService {
  readonly database: CoworkerDatabase;
  readonly runtime: CoworkerRuntimeManager;
  readonly scheduler: SchedulerService;
  readonly tools: ToolGateway;
  private readonly listeners = new Set<(event: DesktopEvent) => void>();
  private initialized = false;

  constructor(private readonly options: DesktopAppServiceOptions) {
    this.database = options.database ?? new CoworkerDatabase(join(options.dataPath, "coworker.db"));
    this.tools = new ToolGateway(
      this.database,
      options.credentials,
      join(options.dataPath, "outbox"),
    );
    this.runtime = new CoworkerRuntimeManager({
      database: this.database,
      tools: this.tools,
      credentials: options.credentials,
      emit: (event) => this.emit(event),
    });
    this.scheduler = new SchedulerService(this.database, async (task) => {
      this.emit({ type: "entity.changed", entity: "tasks", id: task.id });
      this.emit({ type: "entity.changed", entity: "schedules" });
      this.emit({ type: "entity.changed", entity: "activity" });
      this.runtime.enqueueTask(task.coworkerId);
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
    await this.seedCoworkers();
    this.enableDocumentExports();
    await this.options.onSettingsChanged?.(this.database.getSettings());
    await this.scheduler.start();
    for (const coworker of this.database.listCoworkers()) {
      if (this.database.listTasks(coworker.id).some((task) => task.status === "QUEUED")) {
        this.runtime.enqueueTask(coworker.id);
      }
    }
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    this.scheduler.stop();
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
      tasks: this.database.listTasks(),
      messages: this.database
        .listCoworkers()
        .flatMap((coworker) => this.database.listMessages(coworker.id)),
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
      settings: this.database.getSettings(),
      dataPath: this.options.dataPath,
    };
  }

  async createCoworker(input: CreateCoworkerInput) {
    const provisionalPath = join(
      this.options.dataPath,
      "workspaces",
      `${safeDirectoryName(input.name)}-${Date.now().toString(36)}`,
    );
    await mkdir(provisionalPath, { recursive: true });
    const coworker = this.database.createCoworker(input, provisionalPath);
    this.emit({ type: "entity.changed", entity: "coworkers", id: coworker.id });
    this.emit({ type: "entity.changed", entity: "activity" });
    return coworker;
  }

  async updateCoworker(id: string, input: UpdateCoworkerInput) {
    const coworker = this.database.updateCoworker(id, input);
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

  createTask(input: CreateTaskInput) {
    const coworker = this.database.getCoworker(input.coworkerId);
    if (coworker.status !== "active") {
      throw new Error(`${coworker.name} is paused`);
    }
    const task = this.database.createTask(input);
    this.emit({ type: "entity.changed", entity: "tasks", id: task.id });
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
    return this.scheduler.runNow(id);
  }

  async runAgent(request: AgentRunRequest): Promise<AgentRunReceipt> {
    const existing = this.database.getTaskByRunId(request.input.runId);
    if (existing) return { runId: existing.runId, taskId: existing.id };
    const coworker = this.database.getCoworker(request.coworkerId);
    const prompt = parseAgentPrompt(request.input);
    if (
      prompt.images.length > 0 &&
      !modelSupportsImageInput(coworker.modelProvider, coworker.modelName)
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
            input: prompt.text,
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
    mode: Integration["mode"];
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

  async configureModel(input: {
    provider: RemoteModelProvider;
    apiKey: string;
  }) {
    const availableModels = await queryProviderModels(input.provider, input.apiKey);
    if (availableModels.length === 0) {
      throw new Error(
        `This ${input.provider} credential has no models supported by the local runtime`,
      );
    }
    const key = `model:${input.provider}`;
    await this.options.credentials.set(key, input.apiKey);
    return { key, configured: true };
  }

  listModels(provider: ModelProvider) {
    return listAvailableModels(provider, this.options.credentials);
  }

  modelCapabilities(provider: ModelProvider, modelId: string) {
    return { supportsImages: modelSupportsImageInput(provider, modelId) };
  }

  async updateSettings(input: Partial<AppSettings>): Promise<AppSettings> {
    const settings = this.database.updateSettings(input);
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
        `AI-Coworker-Backup-${new Date().toISOString().replaceAll(":", "-")}.db`,
      );
    return this.database.backup(path);
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
          "email.send",
        ],
        policies: { "email.send": "approval" },
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
          "email.send",
        ],
        policies: { "email.send": "approval" },
      });
    }
    this.database.setMetadata("default-coworkers-seeded", "true");
  }
}
