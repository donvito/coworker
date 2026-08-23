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
  CreateConversationInput,
  CreateCoworkerInput,
  CreateScheduleInput,
  CreateTaskInput,
  DesktopEvent,
  Integration,
  ModelProvider,
  RemoteModelProvider,
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
  modelProviderBaseUrlKey,
  modelProviderCredentialKey,
  modelProviderName,
} from "@shared/model-providers";
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
import { ProviderErrorLogger } from "@main/runtime/provider-error-logger";
import {
  bundledSkills,
  installSkillFromUrl,
  parseSkillMarkdown,
  parseSkillPackage,
  skillUrlFromPrompt,
} from "@main/integrations/skills";
import { webSearchCredentialKey } from "@main/integrations/web-search";

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
  readonly providerErrors: ProviderErrorLogger;
  private readonly listeners = new Set<(event: DesktopEvent) => void>();
  private initialized = false;

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
    );
    this.runtime = new CoworkerRuntimeManager({
      database: this.database,
      tools: this.tools,
      credentials: options.credentials,
      emit: (event) => this.emit(event),
      providerErrors: this.providerErrors,
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
    this.seedSkills();
    await this.seedCoworkers();
    this.enableBundledSkills();
    this.enableDocumentExports();
    this.enableScheduleCreation();
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
      conversations: this.database.listConversations(),
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
      skills: this.database.listSkills(),
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
    const coworker = this.database.createCoworker(
      {
        ...input,
        enabledSkillIds:
          input.enabledSkillIds ??
          this.database.listSkills().filter((skill) => skill.bundled).map((skill) => skill.id),
      },
      provisionalPath,
    );
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

  createConversation(input: CreateConversationInput) {
    const conversation = this.database.createConversation(input);
    this.emit({ type: "entity.changed", entity: "conversations", id: conversation.id });
    return conversation;
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
    apiKey?: string;
    baseUrl?: string;
  }) {
    try {
      const definition = getModelProviderDefinition(input.provider);
      const key = modelProviderCredentialKey(input.provider);
      const storedApiKey = await this.options.credentials.get(key);
      const submittedApiKey = input.apiKey?.trim();
      const apiKey =
        submittedApiKey ||
        storedApiKey ||
        (definition.apiKeyRequired ? "" : localModelCredentialMarker);
      if (!apiKey) {
        throw new Error(`A ${modelProviderName(input.provider)} API key is required`);
      }
      const storedBaseUrl =
        definition.baseUrlMode === "none"
          ? undefined
          : await this.options.credentials.get(modelProviderBaseUrlKey(input.provider));
      const baseUrl = input.baseUrl?.trim() || storedBaseUrl || definition.defaultBaseUrl;
      if (definition.baseUrlMode === "required" && !baseUrl) {
        throw new Error(`A base URL is required for ${modelProviderName(input.provider)}`);
      }
      const availableModels = await queryProviderModels(input.provider, apiKey, fetch, { baseUrl });
      if (availableModels.length === 0) {
        throw new Error(
          `${modelProviderName(input.provider)} returned no compatible chat models`,
        );
      }
      await this.options.credentials.set(key, apiKey);
      if (definition.baseUrlMode !== "none" && baseUrl) {
        await this.options.credentials.set(modelProviderBaseUrlKey(input.provider), baseUrl);
      }
      return { key, configured: true };
    } catch (error) {
      await this.providerErrors.log(
        { phase: "configuration", provider: input.provider },
        error,
      );
      throw error;
    }
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
    const migrationKey = "bundled-skills-enabled-v2";
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
