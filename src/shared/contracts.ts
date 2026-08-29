import type { BaseEvent, RunAgentInput } from "@ag-ui/core";

export const taskStatuses = [
  "QUEUED",
  "RUNNING",
  "WAITING_FOR_APPROVAL",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export type TaskStatus = (typeof taskStatuses)[number];

export const runtimeStatuses = [
  "STOPPED",
  "STARTING",
  "IDLE",
  "WORKING",
  "WAITING_FOR_APPROVAL",
  "ERROR",
] as const;
export type RuntimeStatus = (typeof runtimeStatuses)[number];

export const approvalStatuses = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "EDITED",
  "EXPIRED",
] as const;
export type ApprovalStatus = (typeof approvalStatuses)[number];

export const toolPolicies = ["automatic", "approval", "denied"] as const;
export type ToolPolicy = (typeof toolPolicies)[number];
export type RiskLevel = "low" | "medium" | "high";

export const remoteModelProviders = [
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "ollama",
  "lmstudio",
  "openai-compatible",
] as const;
export const modelProviders = ["demo", ...remoteModelProviders] as const;
export type KnownModelProvider = (typeof modelProviders)[number];
export type KnownRemoteModelProvider = (typeof remoteModelProviders)[number];
/**
 * A user-registered OpenAI-compatible endpoint. Each endpoint is a
 * first-class model provider identified as "openai-compatible:<slug>";
 * the bare "openai-compatible" id remains valid for the legacy single slot.
 */
export type CustomModelProviderId = `openai-compatible:${string}`;
export type ModelProvider = KnownModelProvider | CustomModelProviderId;
export type RemoteModelProvider = KnownRemoteModelProvider | CustomModelProviderId;

export interface ModelEndpoint {
  /** Provider id: "openai-compatible" (legacy slot) or "openai-compatible:<slug>". */
  id: RemoteModelProvider;
  /** User-chosen display name, e.g. "LM Studio on my Mac". */
  name: string;
  baseUrl: string;
  createdAt: string;
  updatedAt: string;
}

export const providerErrorPhases = [
  "configuration",
  "model_catalog",
  "capabilities",
  "runtime_start",
  "inference",
  "runtime_exit",
] as const;
export type ProviderErrorPhase = (typeof providerErrorPhases)[number];

export interface ProviderErrorDiagnostic {
  timestamp: string;
  level: "error";
  category: "model_provider";
  phase: ProviderErrorPhase;
  provider: ModelProvider;
  model?: string;
  coworkerId?: string;
  taskId?: string;
  runId?: string;
  message: string;
  stack?: string;
  code?: string;
  status?: number;
}

export interface ModelOption {
  id: string;
  name: string;
  supportsImages: boolean;
  pricing?: {
    currency: "USD";
    inputPerMillion?: number;
    outputPerMillion?: number;
    request?: number;
  };
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  content: string;
  sourceUrl: string | null;
  bundled: boolean;
  createdAt: string;
  updatedAt: string;
}

export const webSearchProviders = ["tavily", "exa", "firecrawl", "serpapi"] as const;
export type WebSearchProvider = (typeof webSearchProviders)[number];

export interface SharedFolder {
  /** Absolute path of a folder this coworker may read (never write). */
  path: string;
  /** Stable name the coworker uses to address the folder in tools. */
  alias: string;
}

export interface Coworker {
  id: string;
  name: string;
  role: string;
  description: string | null;
  /** User-chosen avatar from the bundled set; null falls back to an id hash. */
  avatarIndex?: number | null;
  systemPrompt: string;
  modelProvider: ModelProvider;
  modelName: string;
  status: "active" | "paused";
  runtimeStatus: RuntimeStatus;
  workspacePath: string;
  enabledTools: string[];
  enabledSkillIds: string[];
  policies: Record<string, ToolPolicy>;
  sharedFolders: SharedFolder[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateCoworkerInput {
  name: string;
  role: string;
  description?: string;
  avatarIndex?: number;
  systemPrompt: string;
  modelProvider: ModelProvider;
  modelName: string;
  enabledTools: string[];
  enabledSkillIds?: string[];
  policies?: Record<string, ToolPolicy>;
  sharedFolderPaths?: string[];
}

export interface UpdateCoworkerInput {
  name?: string;
  role?: string;
  description?: string | null;
  avatarIndex?: number;
  systemPrompt?: string;
  modelProvider?: ModelProvider;
  modelName?: string;
  status?: "active" | "paused";
  enabledTools?: string[];
  enabledSkillIds?: string[];
  policies?: Record<string, ToolPolicy>;
  sharedFolderPaths?: string[];
}

export interface Task {
  id: string;
  coworkerId: string;
  scheduleId: string | null;
  runId: string;
  threadId: string;
  sourceMessageId: string | null;
  discussionId: string | null;
  discussionTurn: number | null;
  title: string;
  input: string;
  status: TaskStatus;
  source: "manual" | "schedule" | "recovery";
  priority: number;
  result: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface Conversation {
  id: string;
  coworkerId: string | null;
  kind: "direct" | "group";
  memberIds: string[];
  title: string;
  /** Set while the conversation is archived; null when active. */
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateConversationInput {
  coworkerId?: string;
  kind?: Conversation["kind"];
  memberIds?: string[];
  title?: string;
}

export interface UpdateConversationInput {
  title?: string;
  memberIds?: string[];
}

export interface ConversationImageInput {
  data: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  name: string;
  size: number;
}

export interface SendConversationMessageInput {
  conversationId: string;
  clientMessageId: string;
  content: string;
  mentionedCoworkerIds: string[];
  images?: ConversationImageInput[];
}

export interface ConversationDispatchReceipt {
  message: Message;
  runs: Array<AgentRunReceipt & { coworkerId: string }>;
  discussion: DiscussionSession | null;
}

export interface DiscussionSession {
  id: string;
  conversationId: string;
  sourceMessageId: string;
  participantIds: string[];
  nextTurn: number;
  turnLimit: number;
  hardLimit: number;
  status: "active" | "awaiting_user" | "completed" | "cancelled" | "failed";
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DiscussionAdvanceReceipt {
  discussion: DiscussionSession;
  run: (AgentRunReceipt & { coworkerId: string }) | null;
}

export interface TaskImageAttachment {
  id: string;
  taskId: string;
  coworkerId: string;
  name: string;
  mimeType: string;
  relativePath: string;
  size: number;
  createdAt: string;
}

export type TaskImageAttachmentSummary = Omit<TaskImageAttachment, "relativePath">;

export interface ImageAttachmentData {
  data: string;
  mimeType: string;
}

export interface CreateTaskInput {
  coworkerId: string;
  title: string;
  input: string;
  priority?: number;
  source?: Task["source"];
  scheduleId?: string;
  runId?: string;
  threadId?: string;
  sourceMessageId?: string;
  discussionId?: string;
  discussionTurn?: number;
  persistUserMessage?: boolean;
}

export interface Message {
  id: string;
  conversationId: string;
  coworkerId: string | null;
  authorName: string;
  taskId: string | null;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  mentionedCoworkerIds: string[];
  createdAt: string;
}

export interface ToolCall {
  id: string;
  taskId: string;
  coworkerId: string;
  toolName: string;
  arguments: unknown;
  result: unknown;
  status: "REQUESTED" | "WAITING_FOR_APPROVAL" | "RUNNING" | "COMPLETED" | "FAILED" | "DENIED";
  idempotencyKey: string;
  createdAt: string;
  completedAt: string | null;
}

export interface Approval {
  id: string;
  taskId: string;
  coworkerId: string;
  toolCallId: string;
  actionType: string;
  summary: string;
  proposedPayload: unknown;
  decidedPayload: unknown;
  riskLevel: RiskLevel;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt: string | null;
}

export interface ApprovalDecisionInput {
  approvalId: string;
  decision: "approve" | "reject" | "edit";
  payload?: unknown;
}

export interface ScheduleTaskTemplate {
  title: string;
  input: string;
  priority?: number;
}

export interface Schedule {
  id: string;
  coworkerId: string;
  /** Conversation a run replies into; null uses the coworker's default thread. */
  conversationId: string | null;
  name: string;
  scheduleType: "cron" | "once";
  cronExpression: string | null;
  runAt: string | null;
  timezone: string;
  taskTemplate: ScheduleTaskTemplate;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateScheduleInput {
  coworkerId: string;
  conversationId?: string | null;
  name: string;
  scheduleType: Schedule["scheduleType"];
  cronExpression?: string;
  runAt?: string;
  timezone: string;
  taskTemplate: ScheduleTaskTemplate;
  enabled?: boolean;
}

export interface UpdateScheduleInput {
  conversationId?: string | null;
  name?: string;
  scheduleType?: Schedule["scheduleType"];
  cronExpression?: string | null;
  runAt?: string | null;
  timezone?: string;
  taskTemplate?: ScheduleTaskTemplate;
  enabled?: boolean;
}

export interface Artifact {
  id: string;
  taskId: string | null;
  coworkerId: string;
  name: string;
  mimeType: string;
  filePath: string;
  createdAt: string;
}

export interface ActivityItem {
  id: string;
  coworkerId: string | null;
  taskId: string | null;
  type: string;
  summary: string;
  metadata: unknown;
  createdAt: string;
}

export interface Integration {
  id: string;
  type: "email" | "telegram";
  name: string;
  mode: "local-outbox" | "resend" | "bot";
  status: "connected" | "disconnected" | "error";
  credentialKey: string | null;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type EmailIntegrationMode = "local-outbox" | "resend";

export interface TelegramIntegrationStatus {
  integration: Integration | null;
  /** Deep link that pairs the user's Telegram chat: https://t.me/<bot>?start=<code>. */
  pairingLink: string | null;
}

export const appThemes = ["forest", "ocean", "plum", "clay", "graphite"] as const;

export type AppTheme = (typeof appThemes)[number];

export interface AppSettings {
  runInBackground: boolean;
  launchAtLogin: boolean;
  demoMode: boolean;
  theme: AppTheme;
  showReasoning: boolean;
  globalOperatingInstructions: string;
  defaultModelProvider: RemoteModelProvider | null;
  defaultModelName: string | null;
}

export interface AppSnapshot {
  coworkers: Coworker[];
  conversations: Conversation[];
  discussions: DiscussionSession[];
  tasks: Task[];
  messages: Message[];
  imageAttachments: TaskImageAttachmentSummary[];
  approvals: Approval[];
  schedules: Schedule[];
  artifacts: Artifact[];
  activity: ActivityItem[];
  integrations: Integration[];
  modelEndpoints: ModelEndpoint[];
  skills: Skill[];
  settings: AppSettings;
  dataPath: string;
  version: string;
}

export type EntityName =
  | "coworkers"
  | "conversations"
  | "discussions"
  | "tasks"
  | "approvals"
  | "schedules"
  | "artifacts"
  | "activity"
  | "integrations"
  | "skills"
  | "settings";

export type DesktopEvent =
  | { type: "entity.changed"; entity: EntityName; id?: string }
  | { type: "runtime.status"; coworkerId: string; status: RuntimeStatus; taskId?: string }
  | {
      type: "agent.event";
      coworkerId: string;
      conversationId: string;
      runId: string;
      taskId: string;
      event: BaseEvent;
    }
  | { type: "notification"; title: string; body: string }
  | {
      /** A user message arrived from an external channel (e.g. Telegram). */
      type: "conversation.inbound";
      coworkerId: string;
      conversationId: string;
      source: "telegram";
    }
  | {
      type: "navigation.requested";
      page:
        | "home"
        | "coworkers"
        | "files"
        | "approvals"
        | "schedules"
        | "activity"
        | "settings";
    };

export interface AgentRunRequest {
  coworkerId: string;
  input: RunAgentInput;
}

export interface AgentRunReceipt {
  runId: string;
  taskId: string;
}

export interface CredentialStatus {
  key: string;
  configured: boolean;
  needsReentry?: boolean;
}

export interface ConfigureModelResult extends CredentialStatus {
  /** Chat models available to the verified credential. */
  models: ModelOption[];
  /** True when this call also updated the global default model. */
  defaultApplied: boolean;
}

export interface DesktopApi {
  /** The operating system platform, as reported by Node's process.platform. */
  platform: string;
  app: {
    bootstrap(): Promise<AppSnapshot>;
    copyText(text: string): Promise<void>;
    openDataFolder(): Promise<void>;
    backup(): Promise<string | null>;
    exportDataBackup(): Promise<string | null>;
    getSettings(): Promise<AppSettings>;
    updateSettings(settings: Partial<AppSettings>): Promise<AppSettings>;
  };
  coworkers: {
    list(): Promise<Coworker[]>;
    create(input: CreateCoworkerInput): Promise<Coworker>;
    update(id: string, input: UpdateCoworkerInput): Promise<Coworker>;
    remove(id: string): Promise<void>;
  };
  browser: {
    clearProfile(coworkerId: string): Promise<void>;
  };
  folders: {
    /** Open the native directory picker; returns the selected absolute paths. */
    pick(): Promise<string[]>;
    /** Reveal one of a coworker's granted folders in the OS file manager. */
    reveal(coworkerId: string, path: string): Promise<void>;
  };
  conversations: {
    list(coworkerId?: string): Promise<Conversation[]>;
    search(coworkerId: string, query: string): Promise<Conversation[]>;
    create(input: CreateConversationInput): Promise<Conversation>;
    update(id: string, input: UpdateConversationInput): Promise<Conversation>;
    remove(id: string): Promise<void>;
    archive(id: string): Promise<Conversation>;
    restore(id: string): Promise<Conversation>;
    send(input: SendConversationMessageInput): Promise<ConversationDispatchReceipt>;
    continueDiscussion(id: string): Promise<DiscussionAdvanceReceipt>;
    stopDiscussion(id: string): Promise<DiscussionSession>;
  };
  tasks: {
    list(coworkerId?: string): Promise<Task[]>;
    create(input: CreateTaskInput): Promise<Task>;
    cancel(id: string): Promise<Task>;
  };
  messages: {
    list(coworkerId: string, taskId?: string): Promise<Message[]>;
    listConversation(conversationId: string): Promise<Message[]>;
  };
  approvals: {
    list(status?: ApprovalStatus): Promise<Approval[]>;
    decide(input: ApprovalDecisionInput): Promise<Approval>;
  };
  artifacts: {
    open(id: string): Promise<void>;
    download(id: string): Promise<string | null>;
    remove(id: string): Promise<void>;
  };
  imageAttachments: {
    read(id: string): Promise<ImageAttachmentData>;
  };
  schedules: {
    list(): Promise<Schedule[]>;
    create(input: CreateScheduleInput): Promise<Schedule>;
    update(id: string, input: UpdateScheduleInput): Promise<Schedule>;
    remove(id: string): Promise<void>;
    runNow(id: string): Promise<Task>;
  };
  activity: {
    list(limit?: number): Promise<ActivityItem[]>;
  };
  diagnostics: {
    listProviderErrors(limit?: number): Promise<ProviderErrorDiagnostic[]>;
    copyProviderReport(): Promise<{ count: number }>;
    exportSupportBundle(): Promise<string | null>;
  };
  integrations: {
    list(): Promise<Integration[]>;
    configureEmail(input: {
      name: string;
      mode: EmailIntegrationMode;
      apiKey?: string;
      fromAddress?: string;
    }): Promise<Integration>;
    configureTelegram(input: {
      botToken?: string;
      coworkerId: string;
    }): Promise<TelegramIntegrationStatus>;
    telegramStatus(): Promise<TelegramIntegrationStatus>;
    unpairTelegram(): Promise<TelegramIntegrationStatus>;
    disconnectTelegram(): Promise<void>;
    configureModel(input: {
      provider: RemoteModelProvider;
      apiKey?: string;
      baseUrl?: string;
      defaultModelName?: string;
      endpointName?: string;
    }): Promise<ConfigureModelResult>;
    addModelEndpoint(input: {
      name: string;
      baseUrl: string;
      apiKey?: string;
      defaultModelName?: string;
    }): Promise<ConfigureModelResult & { provider: RemoteModelProvider }>;
    removeModelEndpoint(id: RemoteModelProvider): Promise<void>;
    listModels(provider: ModelProvider): Promise<ModelOption[]>;
    modelCapabilities(
      provider: ModelProvider,
      modelId: string,
    ): Promise<{ supportsImages: boolean }>;
    credentialStatus(key: string): Promise<CredentialStatus>;
    removeCredential(key: string): Promise<void>;
    configureWebSearch(input: {
      provider: WebSearchProvider;
      apiKey: string;
    }): Promise<CredentialStatus>;
  };
  skills: {
    list(): Promise<Skill[]>;
    installFromUrl(url: string, coworkerId?: string): Promise<Skill>;
    installFromContent(content: string, coworkerId?: string): Promise<Skill>;
    installFromPackage(
      fileName: string,
      dataBase64: string,
      coworkerId?: string,
    ): Promise<Skill>;
    remove(id: string): Promise<void>;
  };
  agents: {
    run(request: AgentRunRequest): Promise<AgentRunReceipt>;
    abort(coworkerId: string, runId: string): Promise<void>;
  };
  events: {
    subscribe(listener: (event: DesktopEvent) => void): () => void;
  };
}

declare global {
  interface Window {
    coworker: DesktopApi;
  }
}
