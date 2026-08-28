import { sql } from "drizzle-orm";
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const taskStatuses = [
  "QUEUED",
  "RUNNING",
  "WAITING_FOR_APPROVAL",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

const approvalStatuses = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "EDITED",
  "EXPIRED",
] as const;

const toolCallStatuses = [
  "REQUESTED",
  "WAITING_FOR_APPROVAL",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "DENIED",
] as const;

const discussionStatuses = [
  "active",
  "awaiting_user",
  "completed",
  "cancelled",
  "failed",
] as const;

export const schemaMigrations = sqliteTable("schema_migrations", {
  version: integer("version").primaryKey(),
  appliedAt: text("applied_at").notNull(),
});

export const coworkers = sqliteTable(
  "coworkers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    role: text("role").notNull(),
    description: text("description"),
    avatarIndex: integer("avatar_index"),
    systemPrompt: text("system_prompt").notNull(),
    modelProvider: text("model_provider").notNull(),
    modelName: text("model_name").notNull(),
    status: text("status", { enum: ["active", "paused"] }).notNull().default("active"),
    runtimeStatus: text("runtime_status", {
      enum: ["STOPPED", "STARTING", "IDLE", "WORKING", "WAITING_FOR_APPROVAL", "ERROR"],
    })
      .notNull()
      .default("STOPPED"),
    workspacePath: text("workspace_path").notNull(),
    enabledToolsJson: text("enabled_tools_json").notNull().default("[]"),
    policiesJson: text("policies_json").notNull().default("{}"),
    sharedFoldersJson: text("shared_folders_json").notNull().default("[]"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("coworkers_status_check", sql`${table.status} in ('active', 'paused')`),
    check(
      "coworkers_runtime_status_check",
      sql`${table.runtimeStatus} in ('STOPPED', 'STARTING', 'IDLE', 'WORKING', 'WAITING_FOR_APPROVAL', 'ERROR')`,
    ),
  ],
);

export const schedules = sqliteTable(
  "schedules",
  {
    id: text("id").primaryKey(),
    coworkerId: text("coworker_id")
      .notNull()
      .references(() => coworkers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    scheduleType: text("schedule_type", { enum: ["cron", "once"] }).notNull(),
    cronExpression: text("cron_expression"),
    runAt: text("run_at"),
    timezone: text("timezone").notNull(),
    taskTemplateJson: text("task_template_json").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lastRunAt: text("last_run_at"),
    nextRunAt: text("next_run_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("schedules_type_check", sql`${table.scheduleType} in ('cron', 'once')`),
    check("schedules_enabled_check", sql`${table.enabled} in (0, 1)`),
  ],
);

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    coworkerId: text("coworker_id")
      .references(() => coworkers.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["direct", "group"] }).notNull().default("direct"),
    title: text("title").notNull(),
    archivedAt: text("archived_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("conversations_kind_check", sql`${table.kind} in ('direct', 'group')`),
    index("conversations_coworker_updated_idx").on(
      table.coworkerId,
      sql`${table.updatedAt} desc`,
    ),
  ],
);

export const conversationMembers = sqliteTable(
  "conversation_members",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    coworkerId: text("coworker_id")
      .notNull()
      .references(() => coworkers.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.coworkerId] }),
    index("conversation_members_coworker_idx").on(table.coworkerId, table.conversationId),
  ],
);

export const discussionSessions = sqliteTable(
  "discussion_sessions",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    sourceMessageId: text("source_message_id").notNull(),
    participantIdsJson: text("participant_ids_json").notNull(),
    nextTurn: integer("next_turn").notNull(),
    turnLimit: integer("turn_limit").notNull(),
    hardLimit: integer("hard_limit").notNull().default(8),
    status: text("status", { enum: discussionStatuses }).notNull(),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check(
      "discussion_sessions_status_check",
      sql`${table.status} in ('active', 'awaiting_user', 'completed', 'cancelled', 'failed')`,
    ),
    check("discussion_sessions_next_turn_check", sql`${table.nextTurn} >= 0`),
    check("discussion_sessions_turn_limit_check", sql`${table.turnLimit} > 0`),
    check(
      "discussion_sessions_hard_limit_check",
      sql`${table.hardLimit} >= ${table.turnLimit}`,
    ),
    index("discussion_sessions_conversation_idx").on(
      table.conversationId,
      sql`${table.updatedAt} desc`,
    ),
    uniqueIndex("discussion_sessions_source_message_idx").on(table.sourceMessageId),
  ],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    coworkerId: text("coworker_id")
      .notNull()
      .references(() => coworkers.id, { onDelete: "cascade" }),
    scheduleId: text("schedule_id").references(() => schedules.id, { onDelete: "set null" }),
    runId: text("run_id"),
    threadId: text("thread_id").references(() => conversations.id, { onDelete: "cascade" }),
    sourceMessageId: text("source_message_id"),
    discussionId: text("discussion_id").references(() => discussionSessions.id, {
      onDelete: "set null",
    }),
    discussionTurn: integer("discussion_turn"),
    title: text("title").notNull(),
    input: text("input").notNull(),
    status: text("status", { enum: taskStatuses }).notNull(),
    source: text("source", { enum: ["manual", "schedule", "recovery"] })
      .notNull()
      .default("manual"),
    priority: integer("priority").notNull().default(0),
    result: text("result"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
  },
  (table) => [
    check(
      "tasks_status_check",
      sql`${table.status} in ('QUEUED', 'RUNNING', 'WAITING_FOR_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED')`,
    ),
    check("tasks_source_check", sql`${table.source} in ('manual', 'schedule', 'recovery')`),
    uniqueIndex("tasks_run_id_idx").on(table.runId).where(sql`${table.runId} is not null`),
    uniqueIndex("tasks_source_message_coworker_idx")
      .on(table.sourceMessageId, table.coworkerId)
      .where(
        sql`${table.sourceMessageId} is not null and ${table.discussionId} is null`,
      ),
    uniqueIndex("tasks_discussion_turn_idx")
      .on(table.discussionId, table.discussionTurn)
      .where(sql`${table.discussionId} is not null`),
    index("tasks_coworker_queue_idx").on(
      table.coworkerId,
      table.status,
      sql`${table.priority} desc`,
      sql`${table.createdAt} asc`,
    ),
  ],
);

export const taskImageAttachments = sqliteTable(
  "task_image_attachments",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    coworkerId: text("coworker_id")
      .notNull()
      .references(() => coworkers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    relativePath: text("relative_path").notNull(),
    size: integer("size").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("task_image_attachments_size_check", sql`${table.size} > 0`),
    index("task_image_attachments_task_idx").on(
      table.taskId,
      sql`${table.createdAt} asc`,
    ),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    coworkerId: text("coworker_id").references(() => coworkers.id, { onDelete: "set null" }),
    authorName: text("author_name").notNull(),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "set null" }),
    role: text("role", { enum: ["user", "assistant", "system", "tool"] }).notNull(),
    content: text("content").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("messages_role_check", sql`${table.role} in ('user', 'assistant', 'system', 'tool')`),
    index("messages_conversation_created_idx").on(
      table.conversationId,
      sql`${table.createdAt} asc`,
    ),
  ],
);

export const messageMentions = sqliteTable(
  "message_mentions",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    coworkerId: text("coworker_id")
      .notNull()
      .references(() => coworkers.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.coworkerId] }),
    index("message_mentions_coworker_idx").on(table.coworkerId, table.messageId),
  ],
);

export const taskCheckpoints = sqliteTable("task_checkpoints", {
  taskId: text("task_id")
    .primaryKey()
    .references(() => tasks.id, { onDelete: "cascade" }),
  messagesJson: text("messages_json").notNull().default("[]"),
  pendingToolJson: text("pending_tool_json"),
  updatedAt: text("updated_at").notNull(),
});

export const toolCalls = sqliteTable(
  "tool_calls",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    coworkerId: text("coworker_id")
      .notNull()
      .references(() => coworkers.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    argumentsJson: text("arguments_json"),
    resultJson: text("result_json"),
    status: text("status", { enum: toolCallStatuses }).notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    check(
      "tool_calls_status_check",
      sql`${table.status} in ('REQUESTED', 'WAITING_FOR_APPROVAL', 'RUNNING', 'COMPLETED', 'FAILED', 'DENIED')`,
    ),
  ],
);

export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    coworkerId: text("coworker_id")
      .notNull()
      .references(() => coworkers.id, { onDelete: "cascade" }),
    toolCallId: text("tool_call_id")
      .notNull()
      .unique()
      .references(() => toolCalls.id, { onDelete: "cascade" }),
    actionType: text("action_type").notNull(),
    summary: text("summary").notNull(),
    proposedPayloadJson: text("proposed_payload_json"),
    decidedPayloadJson: text("decided_payload_json"),
    riskLevel: text("risk_level", { enum: ["low", "medium", "high"] }).notNull(),
    status: text("status", { enum: approvalStatuses }).notNull(),
    createdAt: text("created_at").notNull(),
    decidedAt: text("decided_at"),
  },
  (table) => [
    check("approvals_risk_level_check", sql`${table.riskLevel} in ('low', 'medium', 'high')`),
    check(
      "approvals_status_check",
      sql`${table.status} in ('PENDING', 'APPROVED', 'REJECTED', 'EDITED', 'EXPIRED')`,
    ),
    index("approvals_status_created_idx").on(table.status, sql`${table.createdAt} asc`),
  ],
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "set null" }),
    coworkerId: text("coworker_id")
      .notNull()
      .references(() => coworkers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    filePath: text("file_path").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("artifacts_task_path_idx")
      .on(table.taskId, table.filePath)
      .where(sql`${table.taskId} is not null`),
  ],
);

export const activity = sqliteTable(
  "activity",
  {
    id: text("id").primaryKey(),
    coworkerId: text("coworker_id").references(() => coworkers.id, { onDelete: "set null" }),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    summary: text("summary").notNull(),
    metadataJson: text("metadata_json"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("activity_created_idx").on(sql`${table.createdAt} desc`),
  ],
);

export const integrations = sqliteTable(
  "integrations",
  {
    id: text("id").primaryKey(),
    type: text("type", { enum: ["email", "telegram"] }).notNull(),
    name: text("name").notNull(),
    mode: text("mode", { enum: ["local-outbox", "resend", "bot"] }).notNull(),
    status: text("status", { enum: ["connected", "disconnected", "error"] }).notNull(),
    credentialKey: text("credential_key"),
    configJson: text("config_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("integrations_type_check", sql`${table.type} in ('email', 'telegram')`),
    check(
      "integrations_mode_check",
      sql`${table.mode} in ('local-outbox', 'resend', 'bot')`,
    ),
    check(
      "integrations_status_check",
      sql`${table.status} in ('connected', 'disconnected', 'error')`,
    ),
  ],
);

export const sideEffects = sqliteTable(
  "side_effects",
  {
    idempotencyKey: text("idempotency_key").primaryKey(),
    toolCallId: text("tool_call_id")
      .notNull()
      .references(() => toolCalls.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["RUNNING", "COMPLETED", "FAILED"] }).notNull(),
    resultJson: text("result_json"),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    check("side_effects_status_check", sql`${table.status} in ('RUNNING', 'COMPLETED', 'FAILED')`),
  ],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const modelEndpoints = sqliteTable("model_endpoints", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const appMetadata = sqliteTable("app_metadata", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const skills = sqliteTable(
  "skills",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    description: text("description").notNull(),
    content: text("content").notNull(),
    sourceUrl: text("source_url"),
    bundled: integer("bundled", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("skills_bundled_check", sql`${table.bundled} in (0, 1)`),
  ],
);

export const coworkerSkills = sqliteTable(
  "coworker_skills",
  {
    coworkerId: text("coworker_id")
      .notNull()
      .references(() => coworkers.id, { onDelete: "cascade" }),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.coworkerId, table.skillId] }),
  ],
);

export const skillResources = sqliteTable(
  "skill_resources",
  {
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    mimeType: text("mime_type").notNull(),
    content: blob("content", { mode: "buffer" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.skillId, table.path] }),
  ],
);

export const databaseSchema = {
  schemaMigrations,
  coworkers,
  schedules,
  conversations,
  conversationMembers,
  discussionSessions,
  tasks,
  taskImageAttachments,
  messages,
  messageMentions,
  taskCheckpoints,
  toolCalls,
  approvals,
  artifacts,
  activity,
  integrations,
  sideEffects,
  settings,
  modelEndpoints,
  appMetadata,
  skills,
  coworkerSkills,
  skillResources,
};
