import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { remoteModelProviders } from "@shared/contracts";
import type {
  ActivityItem,
  AppSettings,
  Approval,
  ApprovalDecisionInput,
  ApprovalStatus,
  Artifact,
  Conversation,
  Coworker,
  CreateConversationInput,
  CreateCoworkerInput,
  CreateScheduleInput,
  CreateTaskInput,
  Integration,
  Message,
  RuntimeStatus,
  Schedule,
  Skill,
  Task,
  TaskImageAttachment,
  TaskStatus,
  ToolCall,
  UpdateCoworkerInput,
  UpdateScheduleInput,
} from "@shared/contracts";
import { schemaSql } from "./schema";

type Row = Record<string, unknown>;
type SqlValue = null | number | bigint | string | NodeJS.ArrayBufferView;

const defaultSettings: AppSettings = {
  runInBackground: true,
  launchAtLogin: false,
  demoMode: true,
  globalOperatingInstructions:
    "When essential information is missing or ambiguous, ask a concise follow-up question before acting. Do not invent names, dates, recipients, amounts, document details, or other required information. Before creating a document, confirm its output format if the user has not already selected one.",
  defaultModelProvider: null,
  defaultModelName: null,
};

function now(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function coworkerFromRow(row: Row): Coworker {
  return {
    id: String(row.id),
    name: String(row.name),
    role: String(row.role),
    description: row.description === null ? null : String(row.description),
    systemPrompt: String(row.system_prompt),
    modelProvider: String(row.model_provider) as Coworker["modelProvider"],
    modelName: String(row.model_name),
    status: row.status as Coworker["status"],
    runtimeStatus: row.runtime_status as RuntimeStatus,
    workspacePath: String(row.workspace_path),
    enabledTools: parseJson<string[]>(row.enabled_tools_json, []),
    enabledSkillIds: [],
    policies: parseJson<Coworker["policies"]>(row.policies_json, {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function skillFromRow(row: Row): Skill {
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description),
    content: String(row.content),
    sourceUrl: row.source_url === null ? null : String(row.source_url),
    bundled: Number(row.bundled) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function taskFromRow(row: Row): Task {
  return {
    id: String(row.id),
    coworkerId: String(row.coworker_id),
    scheduleId: row.schedule_id === null ? null : String(row.schedule_id),
    runId: String(row.run_id),
    threadId: String(row.thread_id),
    title: String(row.title),
    input: String(row.input),
    status: row.status as TaskStatus,
    source: row.source as Task["source"],
    priority: Number(row.priority),
    result: row.result === null ? null : String(row.result),
    error: row.error === null ? null : String(row.error),
    createdAt: String(row.created_at),
    startedAt: row.started_at === null ? null : String(row.started_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
  };
}

function conversationFromRow(row: Row): Conversation {
  return {
    id: String(row.id),
    coworkerId: String(row.coworker_id),
    title: String(row.title),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function taskImageAttachmentFromRow(row: Row): TaskImageAttachment {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    coworkerId: String(row.coworker_id),
    name: String(row.name),
    mimeType: String(row.mime_type),
    relativePath: String(row.relative_path),
    size: Number(row.size),
    createdAt: String(row.created_at),
  };
}

function messageFromRow(row: Row): Message {
  return {
    id: String(row.id),
    coworkerId: String(row.coworker_id),
    taskId: row.task_id === null ? null : String(row.task_id),
    role: row.role as Message["role"],
    content: String(row.content),
    createdAt: String(row.created_at),
  };
}

function toolCallFromRow(row: Row): ToolCall {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    coworkerId: String(row.coworker_id),
    toolName: String(row.tool_name),
    arguments: parseJson(row.arguments_json, null),
    result: parseJson(row.result_json, null),
    status: row.status as ToolCall["status"],
    idempotencyKey: String(row.idempotency_key),
    createdAt: String(row.created_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
  };
}

function approvalFromRow(row: Row): Approval {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    coworkerId: String(row.coworker_id),
    toolCallId: String(row.tool_call_id),
    actionType: String(row.action_type),
    summary: String(row.summary),
    proposedPayload: parseJson(row.proposed_payload_json, null),
    decidedPayload: parseJson(row.decided_payload_json, null),
    riskLevel: row.risk_level as Approval["riskLevel"],
    status: row.status as ApprovalStatus,
    createdAt: String(row.created_at),
    decidedAt: row.decided_at === null ? null : String(row.decided_at),
  };
}

function scheduleFromRow(row: Row): Schedule {
  return {
    id: String(row.id),
    coworkerId: String(row.coworker_id),
    name: String(row.name),
    scheduleType: row.schedule_type as Schedule["scheduleType"],
    cronExpression: row.cron_expression === null ? null : String(row.cron_expression),
    runAt: row.run_at === null ? null : String(row.run_at),
    timezone: String(row.timezone),
    taskTemplate: parseJson<Schedule["taskTemplate"]>(row.task_template_json, {
      title: "Scheduled task",
      input: "",
    }),
    enabled: Number(row.enabled) === 1,
    lastRunAt: row.last_run_at === null ? null : String(row.last_run_at),
    nextRunAt: row.next_run_at === null ? null : String(row.next_run_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function artifactFromRow(row: Row): Artifact {
  return {
    id: String(row.id),
    taskId: row.task_id === null ? null : String(row.task_id),
    coworkerId: String(row.coworker_id),
    name: String(row.name),
    mimeType: String(row.mime_type),
    filePath: String(row.file_path),
    createdAt: String(row.created_at),
  };
}

function activityFromRow(row: Row): ActivityItem {
  return {
    id: String(row.id),
    coworkerId: row.coworker_id === null ? null : String(row.coworker_id),
    taskId: row.task_id === null ? null : String(row.task_id),
    type: String(row.type),
    summary: String(row.summary),
    metadata: parseJson(row.metadata_json, null),
    createdAt: String(row.created_at),
  };
}

function integrationFromRow(row: Row): Integration {
  return {
    id: String(row.id),
    type: row.type as Integration["type"],
    name: String(row.name),
    mode: row.mode as Integration["mode"],
    status: row.status as Integration["status"],
    credentialKey: row.credential_key === null ? null : String(row.credential_key),
    config: parseJson(row.config_json, {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class CoworkerDatabase {
  readonly path: string;
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
    });
    this.database.exec(schemaSql);
    this.ensureSettings();
  }

  close(): void {
    this.database.close();
  }

  transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  backup(destinationPath: string): string {
    if (this.path === ":memory:") throw new Error("In-memory databases cannot be backed up");
    mkdirSync(dirname(destinationPath), { recursive: true });
    const escaped = destinationPath.replaceAll("'", "''");
    this.database.exec(`VACUUM INTO '${escaped}'`);
    return destinationPath;
  }

  private ensureSettings(): void {
    const timestamp = now();
    const statement = this.database.prepare(
      "INSERT OR IGNORE INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)",
    );
    for (const [key, value] of Object.entries(defaultSettings)) {
      statement.run(key, json(value), timestamp);
    }
  }

  getSettings(): AppSettings {
    const rows = this.database.prepare("SELECT key, value_json FROM settings").all() as Row[];
    const stored = new Map(
      rows.map((row) => [String(row.key), parseJson<unknown>(row.value_json, undefined)]),
    );
    const provider = stored.get("defaultModelProvider");
    const modelName = stored.get("defaultModelName");
    const configuredProvider =
      typeof provider === "string" &&
      remoteModelProviders.some((candidate) => candidate === provider)
        ? (provider as AppSettings["defaultModelProvider"])
        : null;
    const configuredModelName =
      configuredProvider && typeof modelName === "string" && modelName.length > 0
        ? modelName
        : null;
    const settings: AppSettings = {
      runInBackground: Boolean(
        stored.get("runInBackground") ?? defaultSettings.runInBackground,
      ),
      launchAtLogin: Boolean(stored.get("launchAtLogin") ?? defaultSettings.launchAtLogin),
      demoMode: Boolean(stored.get("demoMode") ?? defaultSettings.demoMode),
      globalOperatingInstructions:
        typeof stored.get("globalOperatingInstructions") === "string"
          ? String(stored.get("globalOperatingInstructions"))
          : defaultSettings.globalOperatingInstructions,
      defaultModelProvider: configuredProvider,
      defaultModelName: configuredModelName,
    };
    return settings;
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const statement = this.database.prepare(
      `INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    );
    this.transaction(() => {
      for (const [key, value] of Object.entries(patch)) {
        statement.run(key, json(value), now());
      }
    });
    return this.getSettings();
  }

  getMetadata(key: string): string | null {
    const row = this.database
      .prepare("SELECT value FROM app_metadata WHERE key = ?")
      .get(key) as Row | undefined;
    return row ? String(row.value) : null;
  }

  setMetadata(key: string, value: string): void {
    this.database
      .prepare(
        `INSERT INTO app_metadata(key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, now());
  }

  listCoworkers(): Coworker[] {
    return (
      this.database.prepare("SELECT * FROM coworkers ORDER BY created_at ASC").all() as Row[]
    ).map((row) => this.withCoworkerSkills(coworkerFromRow(row)));
  }

  getCoworker(id: string): Coworker {
    const row = this.database.prepare("SELECT * FROM coworkers WHERE id = ?").get(id) as
      | Row
      | undefined;
    if (!row) throw new Error(`Coworker ${id} was not found`);
    return this.withCoworkerSkills(coworkerFromRow(row));
  }

  createCoworker(input: CreateCoworkerInput, workspacePath: string, id = randomUUID()): Coworker {
    const timestamp = now();
    this.database
      .prepare(
        `INSERT INTO coworkers(
          id, name, role, description, system_prompt, model_provider, model_name,
          status, runtime_status, workspace_path, enabled_tools_json, policies_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'STOPPED', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.role,
        input.description ?? null,
        input.systemPrompt,
        input.modelProvider,
        input.modelName,
        workspacePath,
        json(input.enabledTools),
        json(input.policies ?? {}),
        timestamp,
        timestamp,
      );
    this.createConversation({ coworkerId: id }, `coworker:${id}`);
    this.setCoworkerSkills(id, input.enabledSkillIds ?? []);
    this.addActivity({
      coworkerId: id,
      type: "coworker.created",
      summary: `${input.name} joined your team`,
      metadata: { role: input.role },
    });
    return this.getCoworker(id);
  }

  listConversations(coworkerId?: string): Conversation[] {
    const rows = coworkerId
      ? this.database
          .prepare(
            `SELECT * FROM conversations
             WHERE coworker_id = ?
             ORDER BY updated_at DESC, created_at DESC`,
          )
          .all(coworkerId)
      : this.database
          .prepare("SELECT * FROM conversations ORDER BY updated_at DESC, created_at DESC")
          .all();
    return (rows as Row[]).map(conversationFromRow);
  }

  getConversation(id: string): Conversation {
    const row = this.database.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as
      | Row
      | undefined;
    if (!row) throw new Error(`Conversation ${id} was not found`);
    return conversationFromRow(row);
  }

  createConversation(
    input: CreateConversationInput,
    id: string = randomUUID(),
  ): Conversation {
    this.getCoworker(input.coworkerId);
    const timestamp = now();
    this.database
      .prepare(
        `INSERT INTO conversations(id, coworker_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, input.coworkerId, input.title ?? "New conversation", timestamp, timestamp);
    return this.getConversation(id);
  }

  updateCoworker(id: string, input: UpdateCoworkerInput): Coworker {
    this.getCoworker(id);
    const columns: string[] = [];
    const values: SqlValue[] = [];
    const mappings: Array<[keyof UpdateCoworkerInput, string, (value: unknown) => SqlValue]> = [
      ["name", "name", (value) => String(value)],
      ["role", "role", (value) => String(value)],
      ["description", "description", (value) => (value === null ? null : String(value))],
      ["systemPrompt", "system_prompt", (value) => String(value)],
      ["modelProvider", "model_provider", (value) => String(value)],
      ["modelName", "model_name", (value) => String(value)],
      ["status", "status", (value) => String(value)],
      ["enabledTools", "enabled_tools_json", json],
      ["policies", "policies_json", json],
    ];
    for (const [key, column, transform] of mappings) {
      if (input[key] !== undefined) {
        columns.push(`${column} = ?`);
        values.push(transform(input[key]));
      }
    }
    columns.push("updated_at = ?");
    values.push(now(), id);
    this.database.prepare(`UPDATE coworkers SET ${columns.join(", ")} WHERE id = ?`).run(...values);
    if (input.enabledSkillIds !== undefined) {
      this.setCoworkerSkills(id, input.enabledSkillIds);
    }
    const coworker = this.getCoworker(id);
    this.addActivity({
      coworkerId: id,
      type: "coworker.updated",
      summary: `${coworker.name}'s configuration was updated`,
      metadata: { fields: Object.keys(input) },
    });
    return coworker;
  }

  deleteCoworker(id: string): void {
    const coworker = this.getCoworker(id);
    this.database.prepare("DELETE FROM coworkers WHERE id = ?").run(id);
    this.addActivity({
      type: "coworker.removed",
      summary: `${coworker.name} was removed`,
      metadata: { coworkerId: id },
    });
  }

  setRuntimeStatus(id: string, status: RuntimeStatus): Coworker {
    this.database
      .prepare("UPDATE coworkers SET runtime_status = ?, updated_at = ? WHERE id = ?")
      .run(status, now(), id);
    return this.getCoworker(id);
  }

  listSkills(): Skill[] {
    return (
      this.database.prepare("SELECT * FROM skills ORDER BY bundled DESC, name ASC").all() as Row[]
    ).map(skillFromRow);
  }

  getSkill(id: string): Skill {
    const row = this.database.prepare("SELECT * FROM skills WHERE id = ?").get(id) as
      | Row
      | undefined;
    if (!row) throw new Error(`Skill ${id} was not found`);
    return skillFromRow(row);
  }

  getSkillByName(name: string): Skill | null {
    const row = this.database.prepare("SELECT * FROM skills WHERE name = ?").get(name) as
      | Row
      | undefined;
    return row ? skillFromRow(row) : null;
  }

  upsertSkill(
    input: Pick<Skill, "name" | "description" | "content"> & {
      id?: string;
      sourceUrl?: string | null;
      bundled?: boolean;
    },
  ): Skill {
    const existing = this.getSkillByName(input.name);
    const id = existing?.id ?? input.id ?? randomUUID();
    const timestamp = now();
    this.database
      .prepare(
        `INSERT INTO skills(
          id, name, description, content, source_url, bundled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          description = excluded.description,
          content = excluded.content,
          source_url = excluded.source_url,
          bundled = MAX(skills.bundled, excluded.bundled),
          updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.name,
        input.description,
        input.content,
        input.sourceUrl ?? null,
        input.bundled ? 1 : 0,
        existing?.createdAt ?? timestamp,
        timestamp,
      );
    const skill = this.getSkill(existing?.id ?? id);
    this.addActivity({
      type: existing ? "skill.updated" : "skill.installed",
      summary: `${skill.name} ${existing ? "was updated" : "was installed"}`,
      metadata: { skillId: skill.id, sourceUrl: skill.sourceUrl },
    });
    return skill;
  }

  removeSkill(id: string): void {
    const skill = this.getSkill(id);
    if (skill.bundled) throw new Error("Bundled skills cannot be removed");
    this.database.prepare("DELETE FROM skills WHERE id = ?").run(id);
    this.addActivity({
      type: "skill.removed",
      summary: `${skill.name} was removed`,
      metadata: { skillId: id },
    });
  }

  replaceSkillResources(
    skillId: string,
    resources: Array<{ path: string; mimeType: string; content: Uint8Array }>,
  ): void {
    this.getSkill(skillId);
    this.transaction(() => {
      this.database.prepare("DELETE FROM skill_resources WHERE skill_id = ?").run(skillId);
      const insert = this.database.prepare(
        "INSERT INTO skill_resources(skill_id, path, mime_type, content) VALUES (?, ?, ?, ?)",
      );
      for (const resource of resources) {
        insert.run(skillId, resource.path, resource.mimeType, resource.content);
      }
    });
  }

  listSkillResources(skillId: string): Array<{ path: string; mimeType: string; size: number }> {
    this.getSkill(skillId);
    return (
      this.database
        .prepare(
          "SELECT path, mime_type, length(content) AS size FROM skill_resources WHERE skill_id = ? ORDER BY path",
        )
        .all(skillId) as Row[]
    ).map((row) => ({
      path: String(row.path),
      mimeType: String(row.mime_type),
      size: Number(row.size),
    }));
  }

  getSkillResource(
    skillId: string,
    path: string,
  ): { path: string; mimeType: string; content: Uint8Array } | null {
    const row = this.database
      .prepare(
        "SELECT path, mime_type, content FROM skill_resources WHERE skill_id = ? AND path = ?",
      )
      .get(skillId, path) as Row | undefined;
    if (!row) return null;
    return {
      path: String(row.path),
      mimeType: String(row.mime_type),
      content: row.content as Uint8Array,
    };
  }

  listCoworkerSkillIds(coworkerId: string): string[] {
    return (
      this.database
        .prepare(
          `SELECT skill_id FROM coworker_skills
           WHERE coworker_id = ? ORDER BY created_at ASC, skill_id ASC`,
        )
        .all(coworkerId) as Row[]
    ).map((row) => String(row.skill_id));
  }

  listCoworkerSkills(coworkerId: string): Skill[] {
    return (
      this.database
        .prepare(
          `SELECT skills.* FROM skills
           INNER JOIN coworker_skills ON coworker_skills.skill_id = skills.id
           WHERE coworker_skills.coworker_id = ?
           ORDER BY skills.bundled DESC, skills.name ASC`,
        )
        .all(coworkerId) as Row[]
    ).map(skillFromRow);
  }

  setCoworkerSkills(coworkerId: string, skillIds: string[]): void {
    const uniqueIds = [...new Set(skillIds)];
    this.transaction(() => {
      this.database.prepare("DELETE FROM coworker_skills WHERE coworker_id = ?").run(coworkerId);
      const statement = this.database.prepare(
        "INSERT INTO coworker_skills(coworker_id, skill_id, created_at) VALUES (?, ?, ?)",
      );
      for (const skillId of uniqueIds) {
        this.getSkill(skillId);
        statement.run(coworkerId, skillId, now());
      }
    });
  }

  private withCoworkerSkills(coworker: Coworker): Coworker {
    return { ...coworker, enabledSkillIds: this.listCoworkerSkillIds(coworker.id) };
  }

  createTask(input: CreateTaskInput, id = randomUUID()): Task {
    this.getCoworker(input.coworkerId);
    const timestamp = now();
    const runId = input.runId ?? randomUUID();
    const threadId = input.threadId ?? `coworker:${input.coworkerId}`;
    const conversationRow = this.database
      .prepare("SELECT * FROM conversations WHERE id = ?")
      .get(threadId) as Row | undefined;
    if (conversationRow && String(conversationRow.coworker_id) !== input.coworkerId) {
      throw new Error("Conversation does not belong to this coworker");
    }
    if (!conversationRow) {
      this.createConversation(
        { coworkerId: input.coworkerId, title: input.title },
        threadId,
      );
    } else {
      const existingTitle = String(conversationRow.title);
      this.database
        .prepare(
          `UPDATE conversations
           SET title = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(existingTitle === "New conversation" ? input.title : existingTitle, timestamp, threadId);
    }
    this.database
      .prepare(
        `INSERT INTO tasks(
          id, coworker_id, schedule_id, run_id, thread_id, title, input, status,
          source, priority, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?)`,
      )
      .run(
        id,
        input.coworkerId,
        input.scheduleId ?? null,
        runId,
        threadId,
        input.title,
        input.input,
        input.source ?? "manual",
        input.priority ?? 0,
        timestamp,
      );
    this.addMessage({
      coworkerId: input.coworkerId,
      taskId: id,
      role: "user",
      content: input.input,
    });
    this.addActivity({
      coworkerId: input.coworkerId,
      taskId: id,
      type: "task.queued",
      summary: input.title,
      metadata: { source: input.source ?? "manual" },
    });
    return this.getTask(id);
  }

  getTask(id: string): Task {
    const row = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | Row
      | undefined;
    if (!row) throw new Error(`Task ${id} was not found`);
    return taskFromRow(row);
  }

  getTaskByRunId(runId: string): Task | null {
    const row = this.database.prepare("SELECT * FROM tasks WHERE run_id = ?").get(runId) as
      | Row
      | undefined;
    return row ? taskFromRow(row) : null;
  }

  addTaskImageAttachment(
    input: Omit<TaskImageAttachment, "createdAt">,
  ): TaskImageAttachment {
    const task = this.getTask(input.taskId);
    if (task.coworkerId !== input.coworkerId) {
      throw new Error("Image attachment coworker does not match its task");
    }
    const timestamp = now();
    this.database
      .prepare(
        `INSERT INTO task_image_attachments(
          id, task_id, coworker_id, name, mime_type, relative_path, size, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.taskId,
        input.coworkerId,
        input.name,
        input.mimeType,
        input.relativePath,
        input.size,
        timestamp,
      );
    const row = this.database
      .prepare("SELECT * FROM task_image_attachments WHERE id = ?")
      .get(input.id) as Row;
    return taskImageAttachmentFromRow(row);
  }

  listTaskImageAttachments(taskId: string): TaskImageAttachment[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM task_image_attachments WHERE task_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(taskId) as Row[];
    return rows.map(taskImageAttachmentFromRow);
  }

  getTaskImageAttachment(id: string): TaskImageAttachment {
    const row = this.database
      .prepare("SELECT * FROM task_image_attachments WHERE id = ?")
      .get(id) as Row | undefined;
    if (!row) throw new Error(`Image attachment ${id} was not found`);
    return taskImageAttachmentFromRow(row);
  }

  listImageAttachments(coworkerId?: string): TaskImageAttachment[] {
    const rows = coworkerId
      ? this.database
          .prepare(
            `SELECT * FROM task_image_attachments
             WHERE coworker_id = ?
             ORDER BY created_at ASC, id ASC`,
          )
          .all(coworkerId)
      : this.database
          .prepare("SELECT * FROM task_image_attachments ORDER BY created_at ASC, id ASC")
          .all();
    return (rows as Row[]).map(taskImageAttachmentFromRow);
  }

  listTasks(coworkerId?: string, limit = 500): Task[] {
    const rows = coworkerId
      ? this.database
          .prepare("SELECT * FROM tasks WHERE coworker_id = ? ORDER BY created_at DESC LIMIT ?")
          .all(coworkerId, limit)
      : this.database.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?").all(limit);
    return (rows as Row[]).map(taskFromRow);
  }

  claimNextTask(coworkerId: string): Task | null {
    return this.transaction(() => {
      const active = this.database
        .prepare(
          `SELECT id FROM tasks
           WHERE coworker_id = ? AND status IN ('RUNNING', 'WAITING_FOR_APPROVAL')
           LIMIT 1`,
        )
        .get(coworkerId);
      if (active) return null;
      const row = this.database
        .prepare(
          `SELECT * FROM tasks
           WHERE coworker_id = ? AND status = 'QUEUED'
           ORDER BY priority DESC, created_at ASC
           LIMIT 1`,
        )
        .get(coworkerId) as Row | undefined;
      if (!row) return null;
      const timestamp = now();
      this.database
        .prepare("UPDATE tasks SET status = 'RUNNING', started_at = COALESCE(started_at, ?) WHERE id = ?")
        .run(timestamp, row.id as string);
      return this.getTask(String(row.id));
    });
  }

  setTaskStatus(
    id: string,
    status: TaskStatus,
    options: { result?: string | null; error?: string | null } = {},
  ): Task {
    const completed = ["COMPLETED", "FAILED", "CANCELLED"].includes(status) ? now() : null;
    this.database
      .prepare(
        `UPDATE tasks
         SET status = ?, result = COALESCE(?, result), error = COALESCE(?, error),
             completed_at = CASE WHEN ? IS NULL THEN completed_at ELSE ? END
         WHERE id = ?`,
      )
      .run(status, options.result ?? null, options.error ?? null, completed, completed, id);
    const task = this.getTask(id);
    this.addActivity({
      coworkerId: task.coworkerId,
      taskId: task.id,
      type: `task.${status.toLowerCase()}`,
      summary: task.title,
      metadata: options.error ? { error: options.error } : undefined,
    });
    return task;
  }

  cancelTask(id: string): Task {
    const task = this.getTask(id);
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(task.status)) return task;
    return this.transaction(() => {
      this.database
        .prepare(
          `UPDATE tool_calls
           SET status = 'DENIED', completed_at = ?
           WHERE task_id = ? AND id IN (
             SELECT tool_call_id FROM approvals WHERE task_id = ? AND status = 'PENDING'
           )`,
        )
        .run(now(), id, id);
      this.database
        .prepare(
          `UPDATE approvals
           SET status = 'EXPIRED', decided_at = ?
           WHERE task_id = ? AND status = 'PENDING'`,
        )
        .run(now(), id);
      return this.setTaskStatus(id, "CANCELLED");
    });
  }

  recoverInterruptedTasks(): number {
    return this.transaction(() => {
      const result = this.database
        .prepare(
          `UPDATE tasks
           SET status = 'QUEUED', source = 'recovery'
           WHERE status = 'RUNNING'`,
        )
        .run();
      this.database
        .prepare("UPDATE coworkers SET runtime_status = 'STOPPED', updated_at = ?")
        .run(now());
      return Number(result.changes);
    });
  }

  addMessage(input: Omit<Message, "id" | "createdAt">, id = randomUUID()): Message {
    const timestamp = now();
    this.database
      .prepare(
        `INSERT INTO messages(id, coworker_id, task_id, role, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.coworkerId, input.taskId, input.role, input.content, timestamp);
    return messageFromRow(
      this.database.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Row,
    );
  }

  listMessages(coworkerId: string, taskId?: string, limit = 500): Message[] {
    const rows = taskId
      ? this.database
          .prepare(
            `SELECT * FROM messages
             WHERE coworker_id = ? AND task_id = ?
             ORDER BY created_at ASC LIMIT ?`,
          )
          .all(coworkerId, taskId, limit)
      : this.database
          .prepare(
            `SELECT * FROM messages
             WHERE coworker_id = ?
             ORDER BY created_at ASC LIMIT ?`,
          )
          .all(coworkerId, limit);
    return (rows as Row[]).map(messageFromRow);
  }

  listConversationMessages(
    coworkerId: string,
    conversationId: string,
    limit = 500,
  ): Message[] {
    const conversation = this.getConversation(conversationId);
    if (conversation.coworkerId !== coworkerId) {
      throw new Error("Conversation does not belong to this coworker");
    }
    const rows = this.database
      .prepare(
        `SELECT messages.* FROM messages
         INNER JOIN tasks ON tasks.id = messages.task_id
         WHERE messages.coworker_id = ? AND tasks.thread_id = ?
         ORDER BY messages.created_at ASC LIMIT ?`,
      )
      .all(coworkerId, conversationId, limit);
    return (rows as Row[]).map(messageFromRow);
  }

  saveCheckpoint(taskId: string, messages: unknown[], pendingTool?: unknown): void {
    this.database
      .prepare(
        `INSERT INTO task_checkpoints(task_id, messages_json, pending_tool_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           messages_json = excluded.messages_json,
           pending_tool_json = excluded.pending_tool_json,
           updated_at = excluded.updated_at`,
      )
      .run(taskId, json(messages), pendingTool === undefined ? null : json(pendingTool), now());
  }

  getCheckpoint(taskId: string): { messages: unknown[]; pendingTool: unknown } | null {
    const row = this.database
      .prepare("SELECT * FROM task_checkpoints WHERE task_id = ?")
      .get(taskId) as Row | undefined;
    if (!row) return null;
    return {
      messages: parseJson<unknown[]>(row.messages_json, []),
      pendingTool: parseJson(row.pending_tool_json, null),
    };
  }

  createToolCall(input: {
    id?: string;
    taskId: string;
    coworkerId: string;
    toolName: string;
    arguments: unknown;
    idempotencyKey: string;
  }): ToolCall {
    const id = input.id ?? randomUUID();
    this.database
      .prepare(
        `INSERT OR IGNORE INTO tool_calls(
          id, task_id, coworker_id, tool_name, arguments_json, status,
          idempotency_key, created_at
        ) VALUES (?, ?, ?, ?, ?, 'REQUESTED', ?, ?)`,
      )
      .run(
        id,
        input.taskId,
        input.coworkerId,
        input.toolName,
        json(input.arguments),
        input.idempotencyKey,
        now(),
      );
    return this.getToolCallByIdempotencyKey(input.idempotencyKey);
  }

  getToolCall(id: string): ToolCall {
    const row = this.database.prepare("SELECT * FROM tool_calls WHERE id = ?").get(id) as
      | Row
      | undefined;
    if (!row) throw new Error(`Tool call ${id} was not found`);
    return toolCallFromRow(row);
  }

  getToolCallByIdempotencyKey(key: string): ToolCall {
    const row = this.database
      .prepare("SELECT * FROM tool_calls WHERE idempotency_key = ?")
      .get(key) as Row | undefined;
    if (!row) throw new Error(`Tool call with idempotency key ${key} was not found`);
    return toolCallFromRow(row);
  }

  listToolCalls(taskId?: string): ToolCall[] {
    const rows = taskId
      ? this.database
          .prepare("SELECT * FROM tool_calls WHERE task_id = ? ORDER BY created_at ASC")
          .all(taskId)
      : this.database.prepare("SELECT * FROM tool_calls ORDER BY created_at ASC").all();
    return (rows as Row[]).map(toolCallFromRow);
  }

  updateToolCall(
    id: string,
    status: ToolCall["status"],
    result?: unknown,
  ): ToolCall {
    const completed = ["COMPLETED", "FAILED", "DENIED"].includes(status) ? now() : null;
    this.database
      .prepare(
        `UPDATE tool_calls
         SET status = ?, result_json = COALESCE(?, result_json),
             completed_at = CASE WHEN ? IS NULL THEN completed_at ELSE ? END
         WHERE id = ?`,
      )
      .run(status, result === undefined ? null : json(result), completed, completed, id);
    return this.getToolCall(id);
  }

  createApproval(input: {
    taskId: string;
    coworkerId: string;
    toolCallId: string;
    actionType: string;
    summary: string;
    proposedPayload: unknown;
    riskLevel: Approval["riskLevel"];
  }): Approval {
    return this.transaction(() => {
      const existing = this.database
        .prepare("SELECT * FROM approvals WHERE tool_call_id = ?")
        .get(input.toolCallId) as Row | undefined;
      if (existing) return approvalFromRow(existing);
      const id = randomUUID();
      const timestamp = now();
      this.database
        .prepare(
          `INSERT INTO approvals(
            id, task_id, coworker_id, tool_call_id, action_type, summary,
            proposed_payload_json, risk_level, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
        )
        .run(
          id,
          input.taskId,
          input.coworkerId,
          input.toolCallId,
          input.actionType,
          input.summary,
          json(input.proposedPayload),
          input.riskLevel,
          timestamp,
        );
      this.database
        .prepare("UPDATE tool_calls SET status = 'WAITING_FOR_APPROVAL' WHERE id = ?")
        .run(input.toolCallId);
      this.database
        .prepare("UPDATE tasks SET status = 'WAITING_FOR_APPROVAL' WHERE id = ?")
        .run(input.taskId);
      this.addActivity({
        coworkerId: input.coworkerId,
        taskId: input.taskId,
        type: "approval.requested",
        summary: input.summary,
        metadata: { approvalId: id, toolCallId: input.toolCallId },
      });
      return this.getApproval(id);
    });
  }

  getApproval(id: string): Approval {
    const row = this.database.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as
      | Row
      | undefined;
    if (!row) throw new Error(`Approval ${id} was not found`);
    return approvalFromRow(row);
  }

  getApprovalForTask(taskId: string): Approval | null {
    const row = this.database
      .prepare(
        `SELECT * FROM approvals
         WHERE task_id = ? AND status IN ('PENDING', 'APPROVED', 'EDITED', 'REJECTED')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId) as Row | undefined;
    return row ? approvalFromRow(row) : null;
  }

  listApprovals(status?: ApprovalStatus): Approval[] {
    const rows = status
      ? this.database
          .prepare("SELECT * FROM approvals WHERE status = ? ORDER BY created_at ASC")
          .all(status)
      : this.database.prepare("SELECT * FROM approvals ORDER BY created_at DESC").all();
    return (rows as Row[]).map(approvalFromRow);
  }

  decideApproval(input: ApprovalDecisionInput): Approval {
    return this.transaction(() => {
      const approval = this.getApproval(input.approvalId);
      if (approval.status !== "PENDING") {
        throw new Error("This approval has already been decided");
      }
      const status: ApprovalStatus =
        input.decision === "approve" ? "APPROVED" : input.decision === "edit" ? "EDITED" : "REJECTED";
      const decidedPayload =
        input.decision === "edit" ? input.payload : input.payload ?? approval.proposedPayload;
      this.database
        .prepare(
          `UPDATE approvals
           SET status = ?, decided_payload_json = ?, decided_at = ?
           WHERE id = ?`,
        )
        .run(status, json(decidedPayload), now(), approval.id);
      this.database
        .prepare("UPDATE tasks SET status = 'QUEUED' WHERE id = ?")
        .run(approval.taskId);
      this.database
        .prepare("UPDATE tool_calls SET status = ? WHERE id = ?")
        .run(status === "REJECTED" ? "DENIED" : "REQUESTED", approval.toolCallId);
      this.addActivity({
        coworkerId: approval.coworkerId,
        taskId: approval.taskId,
        type: `approval.${status.toLowerCase()}`,
        summary: approval.summary,
        metadata: { approvalId: approval.id },
      });
      return this.getApproval(approval.id);
    });
  }

  createSchedule(input: CreateScheduleInput, nextRunAt: string | null): Schedule {
    const id = randomUUID();
    const timestamp = now();
    this.getCoworker(input.coworkerId);
    this.database
      .prepare(
        `INSERT INTO schedules(
          id, coworker_id, name, schedule_type, cron_expression, run_at, timezone,
          task_template_json, enabled, next_run_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.coworkerId,
        input.name,
        input.scheduleType,
        input.cronExpression ?? null,
        input.runAt ?? null,
        input.timezone,
        json(input.taskTemplate),
        input.enabled === false ? 0 : 1,
        nextRunAt,
        timestamp,
        timestamp,
      );
    this.addActivity({
      coworkerId: input.coworkerId,
      type: "schedule.created",
      summary: input.name,
      metadata: { scheduleId: id },
    });
    return this.getSchedule(id);
  }

  getSchedule(id: string): Schedule {
    const row = this.database.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as
      | Row
      | undefined;
    if (!row) throw new Error(`Schedule ${id} was not found`);
    return scheduleFromRow(row);
  }

  listSchedules(): Schedule[] {
    return (
      this.database.prepare("SELECT * FROM schedules ORDER BY created_at ASC").all() as Row[]
    ).map(scheduleFromRow);
  }

  updateSchedule(
    id: string,
    input: UpdateScheduleInput,
    nextRunAt: string | null,
  ): Schedule {
    this.getSchedule(id);
    const columns: string[] = [];
    const values: SqlValue[] = [];
    const mappings: Array<[keyof UpdateScheduleInput, string, (value: unknown) => SqlValue]> = [
      ["name", "name", (value) => String(value)],
      ["scheduleType", "schedule_type", (value) => String(value)],
      ["cronExpression", "cron_expression", (value) => (value === null ? null : String(value))],
      ["runAt", "run_at", (value) => (value === null ? null : String(value))],
      ["timezone", "timezone", (value) => String(value)],
      ["taskTemplate", "task_template_json", json],
      ["enabled", "enabled", (value) => (value ? 1 : 0)],
    ];
    for (const [key, column, transform] of mappings) {
      if (input[key] !== undefined) {
        columns.push(`${column} = ?`);
        values.push(transform(input[key]));
      }
    }
    columns.push("next_run_at = ?", "updated_at = ?");
    values.push(nextRunAt, now(), id);
    this.database.prepare(`UPDATE schedules SET ${columns.join(", ")} WHERE id = ?`).run(...values);
    return this.getSchedule(id);
  }

  deleteSchedule(id: string): void {
    const schedule = this.getSchedule(id);
    this.database.prepare("DELETE FROM schedules WHERE id = ?").run(id);
    this.addActivity({
      coworkerId: schedule.coworkerId,
      type: "schedule.removed",
      summary: schedule.name,
      metadata: { scheduleId: id },
    });
  }

  listDueSchedules(at = now()): Schedule[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM schedules
           WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
           ORDER BY next_run_at ASC`,
        )
        .all(at) as Row[]
    ).map(scheduleFromRow);
  }

  getEarliestNextRun(): string | null {
    const row = this.database
      .prepare(
        `SELECT next_run_at FROM schedules
         WHERE enabled = 1 AND next_run_at IS NOT NULL
         ORDER BY next_run_at ASC LIMIT 1`,
      )
      .get() as Row | undefined;
    return row ? String(row.next_run_at) : null;
  }

  markScheduleRun(id: string, ranAt: string, nextRunAt: string | null): Schedule {
    const enabled = nextRunAt === null ? 0 : 1;
    this.database
      .prepare(
        `UPDATE schedules
         SET last_run_at = ?, next_run_at = ?, enabled = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(ranAt, nextRunAt, enabled, now(), id);
    return this.getSchedule(id);
  }

  createArtifact(input: Omit<Artifact, "id" | "createdAt">): Artifact {
    if (input.taskId) {
      const existing = this.database
        .prepare("SELECT * FROM artifacts WHERE task_id = ? AND file_path = ? LIMIT 1")
        .get(input.taskId, input.filePath) as Row | undefined;
      if (existing) return artifactFromRow(existing);
    }
    const id = randomUUID();
    this.database
      .prepare(
        `INSERT INTO artifacts(id, task_id, coworker_id, name, mime_type, file_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.taskId, input.coworkerId, input.name, input.mimeType, input.filePath, now());
    return artifactFromRow(
      this.database.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as Row,
    );
  }

  getArtifact(id: string): Artifact {
    const row = this.database.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as
      | Row
      | undefined;
    if (!row) throw new Error(`Artifact ${id} was not found`);
    return artifactFromRow(row);
  }

  deleteArtifact(id: string): Artifact {
    const artifact = this.getArtifact(id);
    this.database
      .prepare("DELETE FROM artifacts WHERE coworker_id = ? AND file_path = ?")
      .run(artifact.coworkerId, artifact.filePath);
    this.addActivity({
      coworkerId: artifact.coworkerId,
      taskId: artifact.taskId,
      type: "artifact.deleted",
      summary: `Deleted ${artifact.name}`,
      metadata: { artifactId: artifact.id },
    });
    return artifact;
  }

  listArtifacts(coworkerId?: string): Artifact[] {
    const rows = coworkerId
      ? this.database
          .prepare("SELECT * FROM artifacts WHERE coworker_id = ? ORDER BY created_at DESC")
          .all(coworkerId)
      : this.database.prepare("SELECT * FROM artifacts ORDER BY created_at DESC").all();
    return (rows as Row[]).map(artifactFromRow);
  }

  addActivity(
    input: {
      coworkerId?: string | null;
      taskId?: string | null;
      type: string;
      summary: string;
      metadata?: unknown;
    },
    id = randomUUID(),
  ): ActivityItem {
    this.database
      .prepare(
        `INSERT INTO activity(
          id, coworker_id, task_id, type, summary, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.coworkerId ?? null,
        input.taskId ?? null,
        input.type,
        input.summary,
        input.metadata === undefined ? null : json(input.metadata),
        now(),
      );
    return activityFromRow(
      this.database.prepare("SELECT * FROM activity WHERE id = ?").get(id) as Row,
    );
  }

  listActivity(limit = 200): ActivityItem[] {
    return (
      this.database
        .prepare("SELECT * FROM activity ORDER BY created_at DESC LIMIT ?")
        .all(limit) as Row[]
    ).map(activityFromRow);
  }

  listIntegrations(): Integration[] {
    return (
      this.database.prepare("SELECT * FROM integrations ORDER BY created_at ASC").all() as Row[]
    ).map(integrationFromRow);
  }

  upsertEmailIntegration(input: {
    name: string;
    mode: Integration["mode"];
    credentialKey: string | null;
    fromAddress?: string;
  }): Integration {
    const existing = this.database
      .prepare("SELECT * FROM integrations WHERE type = 'email' LIMIT 1")
      .get() as Row | undefined;
    const timestamp = now();
    const config = { fromAddress: input.fromAddress ?? "" };
    if (existing) {
      this.database
        .prepare(
          `UPDATE integrations
           SET name = ?, mode = ?, status = 'connected', credential_key = ?,
               config_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.name,
          input.mode,
          input.credentialKey,
          json(config),
          timestamp,
          existing.id as string,
        );
      return this.getIntegration(String(existing.id));
    }
    const id = randomUUID();
    this.database
      .prepare(
        `INSERT INTO integrations(
          id, type, name, mode, status, credential_key, config_json, created_at, updated_at
        ) VALUES (?, 'email', ?, ?, 'connected', ?, ?, ?, ?)`,
      )
      .run(id, input.name, input.mode, input.credentialKey, json(config), timestamp, timestamp);
    return this.getIntegration(id);
  }

  getIntegration(id: string): Integration {
    const row = this.database.prepare("SELECT * FROM integrations WHERE id = ?").get(id) as
      | Row
      | undefined;
    if (!row) throw new Error(`Integration ${id} was not found`);
    return integrationFromRow(row);
  }

  getEmailIntegration(): Integration | null {
    const row = this.database
      .prepare("SELECT * FROM integrations WHERE type = 'email' LIMIT 1")
      .get() as Row | undefined;
    return row ? integrationFromRow(row) : null;
  }

  getSideEffect(key: string): { status: string; result: unknown } | null {
    const row = this.database
      .prepare("SELECT status, result_json FROM side_effects WHERE idempotency_key = ?")
      .get(key) as Row | undefined;
    return row
      ? { status: String(row.status), result: parseJson(row.result_json, null) }
      : null;
  }

  startSideEffect(key: string, toolCallId: string): boolean {
    const result = this.database
      .prepare(
        `INSERT INTO side_effects(
          idempotency_key, tool_call_id, status, created_at
        ) VALUES (?, ?, 'RUNNING', ?)
        ON CONFLICT(idempotency_key) DO UPDATE SET
          status = 'RUNNING',
          result_json = NULL,
          completed_at = NULL`,
      )
      .run(key, toolCallId, now());
    return Number(result.changes) === 1;
  }

  finishSideEffect(key: string, status: "COMPLETED" | "FAILED", result: unknown): void {
    this.database
      .prepare(
        `UPDATE side_effects
         SET status = ?, result_json = ?, completed_at = ?
         WHERE idempotency_key = ?`,
      )
      .run(status, json(result), now(), key);
  }
}
