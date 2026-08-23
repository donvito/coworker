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
export type ModelProvider = (typeof modelProviders)[number];
export type RemoteModelProvider = (typeof remoteModelProviders)[number];

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

export interface Coworker {
  id: string;
  name: string;
  role: string;
  description: string | null;
  systemPrompt: string;
  modelProvider: ModelProvider;
  modelName: string;
  status: "active" | "paused";
  runtimeStatus: RuntimeStatus;
  workspacePath: string;
  enabledTools: string[];
  enabledSkillIds: string[];
  policies: Record<string, ToolPolicy>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCoworkerInput {
  name: string;
  role: string;
  description?: string;
  systemPrompt: string;
  modelProvider: ModelProvider;
  modelName: string;
  enabledTools: string[];
  enabledSkillIds?: string[];
  policies?: Record<string, ToolPolicy>;
}

export interface UpdateCoworkerInput {
  name?: string;
  role?: string;
  description?: string | null;
  systemPrompt?: string;
  modelProvider?: ModelProvider;
  modelName?: string;
  status?: "active" | "paused";
  enabledTools?: string[];
  enabledSkillIds?: string[];
  policies?: Record<string, ToolPolicy>;
}

export interface Task {
  id: string;
  coworkerId: string;
  scheduleId: string | null;
  runId: string;
  threadId: string;
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
}

export interface Message {
  id: string;
  coworkerId: string;
  taskId: string | null;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
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
  name: string;
  scheduleType: Schedule["scheduleType"];
  cronExpression?: string;
  runAt?: string;
  timezone: string;
  taskTemplate: ScheduleTaskTemplate;
  enabled?: boolean;
}

export interface UpdateScheduleInput {
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
  type: "email";
  name: string;
  mode: "local-outbox" | "resend";
  status: "connected" | "disconnected" | "error";
  credentialKey: string | null;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AppSettings {
  runInBackground: boolean;
  launchAtLogin: boolean;
  demoMode: boolean;
  defaultModelProvider: RemoteModelProvider | null;
  defaultModelName: string | null;
}

export interface AppSnapshot {
  coworkers: Coworker[];
  tasks: Task[];
  messages: Message[];
  imageAttachments: TaskImageAttachmentSummary[];
  approvals: Approval[];
  schedules: Schedule[];
  artifacts: Artifact[];
  activity: ActivityItem[];
  integrations: Integration[];
  skills: Skill[];
  settings: AppSettings;
  dataPath: string;
}

export type EntityName =
  | "coworkers"
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
  | { type: "agent.event"; coworkerId: string; runId: string; taskId: string; event: BaseEvent }
  | { type: "notification"; title: string; body: string }
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
}

export interface DesktopApi {
  app: {
    bootstrap(): Promise<AppSnapshot>;
    openDataFolder(): Promise<void>;
    backup(): Promise<string | null>;
    getSettings(): Promise<AppSettings>;
    updateSettings(settings: Partial<AppSettings>): Promise<AppSettings>;
  };
  coworkers: {
    list(): Promise<Coworker[]>;
    create(input: CreateCoworkerInput): Promise<Coworker>;
    update(id: string, input: UpdateCoworkerInput): Promise<Coworker>;
    remove(id: string): Promise<void>;
  };
  tasks: {
    list(coworkerId?: string): Promise<Task[]>;
    create(input: CreateTaskInput): Promise<Task>;
    cancel(id: string): Promise<Task>;
  };
  messages: {
    list(coworkerId: string, taskId?: string): Promise<Message[]>;
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
    exportProviderReport(): Promise<string | null>;
  };
  integrations: {
    list(): Promise<Integration[]>;
    configureEmail(input: {
      name: string;
      mode: Integration["mode"];
      apiKey?: string;
      fromAddress?: string;
    }): Promise<Integration>;
    configureModel(input: {
      provider: RemoteModelProvider;
      apiKey?: string;
      baseUrl?: string;
    }): Promise<CredentialStatus>;
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
