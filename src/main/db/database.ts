import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  lte,
  sql,
} from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle, type NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import { appThemes, remoteModelProviders } from "@shared/contracts";
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
import {
  activity,
  appMetadata,
  approvals,
  artifacts,
  conversations,
  coworkerSkills,
  coworkers,
  integrations,
  messages,
  schedules,
  settings,
  sideEffects,
  skillResources,
  skills,
  taskCheckpoints,
  taskImageAttachments,
  tasks,
  toolCalls,
} from "./schema";

type DrizzleDatabase = NodeSQLiteDatabase;

const defaultSettings: AppSettings = {
  runInBackground: true,
  launchAtLogin: false,
  demoMode: true,
  theme: "graphite",
  showReasoning: true,
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

function coworkerFromRow(row: typeof coworkers.$inferSelect): Coworker {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    description: row.description,
    systemPrompt: row.systemPrompt,
    modelProvider: row.modelProvider as Coworker["modelProvider"],
    modelName: row.modelName,
    status: row.status,
    runtimeStatus: row.runtimeStatus as RuntimeStatus,
    workspacePath: row.workspacePath,
    enabledTools: parseJson<string[]>(row.enabledToolsJson, []),
    enabledSkillIds: [],
    policies: parseJson<Coworker["policies"]>(row.policiesJson, {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function skillFromRow(row: typeof skills.$inferSelect): Skill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    content: row.content,
    sourceUrl: row.sourceUrl,
    bundled: row.bundled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function taskFromRow(row: typeof tasks.$inferSelect): Task {
  return {
    id: row.id,
    coworkerId: row.coworkerId,
    scheduleId: row.scheduleId,
    runId: String(row.runId),
    threadId: String(row.threadId),
    title: row.title,
    input: row.input,
    status: row.status as TaskStatus,
    source: row.source,
    priority: row.priority,
    result: row.result,
    error: row.error,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

function conversationFromRow(row: typeof conversations.$inferSelect): Conversation {
  return {
    id: row.id,
    coworkerId: row.coworkerId,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function taskImageAttachmentFromRow(
  row: typeof taskImageAttachments.$inferSelect,
): TaskImageAttachment {
  return {
    id: row.id,
    taskId: row.taskId,
    coworkerId: row.coworkerId,
    name: row.name,
    mimeType: row.mimeType,
    relativePath: row.relativePath,
    size: row.size,
    createdAt: row.createdAt,
  };
}

function messageFromRow(row: typeof messages.$inferSelect): Message {
  return {
    id: row.id,
    coworkerId: row.coworkerId,
    taskId: row.taskId,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt,
  };
}

function toolCallFromRow(row: typeof toolCalls.$inferSelect): ToolCall {
  return {
    id: row.id,
    taskId: row.taskId,
    coworkerId: row.coworkerId,
    toolName: row.toolName,
    arguments: parseJson(row.argumentsJson, null),
    result: parseJson(row.resultJson, null),
    status: row.status,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

function approvalFromRow(row: typeof approvals.$inferSelect): Approval {
  return {
    id: row.id,
    taskId: row.taskId,
    coworkerId: row.coworkerId,
    toolCallId: row.toolCallId,
    actionType: row.actionType,
    summary: row.summary,
    proposedPayload: parseJson(row.proposedPayloadJson, null),
    decidedPayload: parseJson(row.decidedPayloadJson, null),
    riskLevel: row.riskLevel,
    status: row.status as ApprovalStatus,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
  };
}

function scheduleFromRow(row: typeof schedules.$inferSelect): Schedule {
  return {
    id: row.id,
    coworkerId: row.coworkerId,
    name: row.name,
    scheduleType: row.scheduleType,
    cronExpression: row.cronExpression,
    runAt: row.runAt,
    timezone: row.timezone,
    taskTemplate: parseJson<Schedule["taskTemplate"]>(row.taskTemplateJson, {
      title: "Scheduled task",
      input: "",
    }),
    enabled: row.enabled,
    lastRunAt: row.lastRunAt,
    nextRunAt: row.nextRunAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function artifactFromRow(row: typeof artifacts.$inferSelect): Artifact {
  return {
    id: row.id,
    taskId: row.taskId,
    coworkerId: row.coworkerId,
    name: row.name,
    mimeType: row.mimeType,
    filePath: row.filePath,
    createdAt: row.createdAt,
  };
}

function activityFromRow(row: typeof activity.$inferSelect): ActivityItem {
  return {
    id: row.id,
    coworkerId: row.coworkerId,
    taskId: row.taskId,
    type: row.type,
    summary: row.summary,
    metadata: parseJson(row.metadataJson, null),
    createdAt: row.createdAt,
  };
}

function integrationFromRow(row: typeof integrations.$inferSelect): Integration {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    mode: row.mode,
    status: row.status,
    credentialKey: row.credentialKey,
    config: parseJson(row.configJson, {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function resolveMigrationsFolder(): string {
  const resourcesPath = Reflect.get(process, "resourcesPath");
  if (typeof resourcesPath === "string") {
    const packaged = join(resourcesPath, "drizzle");
    if (existsSync(packaged)) return packaged;
  }
  const development = join(process.cwd(), "drizzle");
  if (existsSync(development)) return development;
  throw new Error(`Drizzle migrations were not found at ${development}`);
}

export class CoworkerDatabase {
  readonly path: string;
  private readonly sqlite: DatabaseSync;
  private readonly database: DrizzleDatabase;

  constructor(path: string) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.sqlite = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
    });
    this.sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.database = drizzle({ client: this.sqlite });
    const migrationsFolder = resolveMigrationsFolder();
    this.backupBeforePendingMigrations(migrationsFolder);
    migrate(this.database, { migrationsFolder });
    this.backfillLegacyConversations();
    this.ensureSettings();
  }

  close(): void {
    this.sqlite.close();
  }

  transaction<T>(operation: () => T): T {
    return this.database.transaction(() => operation() as never, { behavior: "immediate" }) as T;
  }

  backup(destinationPath: string): string {
    if (this.path === ":memory:") throw new Error("In-memory databases cannot be backed up");
    mkdirSync(dirname(destinationPath), { recursive: true });
    const escaped = destinationPath.replaceAll("'", "''");
    this.sqlite.exec(`VACUUM INTO '${escaped}'`);
    return destinationPath;
  }

  private backupBeforePendingMigrations(migrationsFolder: string): string | null {
    if (this.path === ":memory:") return null;
    const userTableCount =
      this.database.get<{ count: number }>(sql`
        SELECT count(*) AS count
        FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
          AND name <> '__drizzle_migrations'
      `)?.count ?? 0;
    if (userTableCount === 0) return null;

    const hasMigrationJournal = this.database.get<{ name: string }>(sql`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = '__drizzle_migrations'
    `);
    const appliedHashes = new Set(
      hasMigrationJournal
        ? this.database
            .all<{ hash: string }>(sql`SELECT hash FROM __drizzle_migrations`)
            .map((migration) => migration.hash)
        : [],
    );
    const pendingMigrations = readMigrationFiles({ migrationsFolder }).filter(
      (migration) => !appliedHashes.has(migration.hash),
    );
    const latestPending = pendingMigrations.at(-1);
    if (!latestPending) return null;

    const databaseName = basename(this.path, extname(this.path));
    const migrationName = latestPending.name.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
    const destinationPath = join(
      dirname(this.path),
      "backups",
      `${databaseName}-before-${migrationName}-${latestPending.hash.slice(0, 12)}.db`,
    );
    if (existsSync(destinationPath)) return destinationPath;
    return this.backup(destinationPath);
  }

  private backfillLegacyConversations(): void {
    this.database.run(sql`
      INSERT OR IGNORE INTO conversations(id, coworker_id, title, created_at, updated_at)
      SELECT
        ${tasks.threadId},
        ${tasks.coworkerId},
        MIN(${tasks.title}),
        MIN(${tasks.createdAt}),
        MAX(COALESCE(${tasks.completedAt}, ${tasks.startedAt}, ${tasks.createdAt}))
      FROM ${tasks}
      WHERE ${tasks.threadId} IS NOT NULL AND ${tasks.threadId} <> ''
      GROUP BY ${tasks.threadId}, ${tasks.coworkerId}
    `);
    this.database.run(sql`
      INSERT OR IGNORE INTO conversations(id, coworker_id, title, created_at, updated_at)
      SELECT
        'coworker:' || ${coworkers.id},
        ${coworkers.id},
        'New conversation',
        ${coworkers.createdAt},
        ${coworkers.updatedAt}
      FROM ${coworkers}
      WHERE NOT EXISTS (
        SELECT 1 FROM ${conversations}
        WHERE ${conversations.coworkerId} = ${coworkers.id}
      )
    `);
  }

  private ensureSettings(): void {
    const timestamp = now();
    for (const [key, value] of Object.entries(defaultSettings)) {
      this.database
        .insert(settings)
        .values({ key, valueJson: json(value), updatedAt: timestamp })
        .onConflictDoNothing()
        .run();
    }
  }

  getSettings(): AppSettings {
    const rows = this.database
      .select({ key: settings.key, valueJson: settings.valueJson })
      .from(settings)
      .all();
    const stored = new Map(
      rows.map((row) => [row.key, parseJson<unknown>(row.valueJson, undefined)]),
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
    const storedTheme = stored.get("theme");
    const appSettings: AppSettings = {
      runInBackground: Boolean(
        stored.get("runInBackground") ?? defaultSettings.runInBackground,
      ),
      launchAtLogin: Boolean(stored.get("launchAtLogin") ?? defaultSettings.launchAtLogin),
      demoMode: Boolean(stored.get("demoMode") ?? defaultSettings.demoMode),
      theme: appThemes.find((candidate) => candidate === storedTheme) ?? defaultSettings.theme,
      showReasoning: Boolean(stored.get("showReasoning") ?? defaultSettings.showReasoning),
      globalOperatingInstructions:
        typeof stored.get("globalOperatingInstructions") === "string"
          ? String(stored.get("globalOperatingInstructions"))
          : defaultSettings.globalOperatingInstructions,
      defaultModelProvider: configuredProvider,
      defaultModelName: configuredModelName,
    };
    return appSettings;
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    this.transaction(() => {
      for (const [key, value] of Object.entries(patch)) {
        const valueJson = json(value);
        const updatedAt = now();
        this.database
          .insert(settings)
          .values({ key, valueJson, updatedAt })
          .onConflictDoUpdate({
            target: settings.key,
            set: { valueJson, updatedAt },
          })
          .run();
      }
    });
    return this.getSettings();
  }

  getMetadata(key: string): string | null {
    return (
      this.database
        .select({ value: appMetadata.value })
        .from(appMetadata)
        .where(eq(appMetadata.key, key))
        .get()?.value ?? null
    );
  }

  setMetadata(key: string, value: string): void {
    const updatedAt = now();
    this.database
      .insert(appMetadata)
      .values({ key, value, updatedAt })
      .onConflictDoUpdate({
        target: appMetadata.key,
        set: { value, updatedAt },
      })
      .run();
  }

  listCoworkers(): Coworker[] {
    return this.database
      .select()
      .from(coworkers)
      .orderBy(asc(coworkers.createdAt))
      .all()
      .map((row) => this.withCoworkerSkills(coworkerFromRow(row)));
  }

  getCoworker(id: string): Coworker {
    const row = this.database.select().from(coworkers).where(eq(coworkers.id, id)).get();
    if (!row) throw new Error(`Coworker ${id} was not found`);
    return this.withCoworkerSkills(coworkerFromRow(row));
  }

  createCoworker(input: CreateCoworkerInput, workspacePath: string, id = randomUUID()): Coworker {
    const timestamp = now();
    this.database
      .insert(coworkers)
      .values({
        id,
        name: input.name,
        role: input.role,
        description: input.description ?? null,
        systemPrompt: input.systemPrompt,
        modelProvider: input.modelProvider,
        modelName: input.modelName,
        status: "active",
        runtimeStatus: "STOPPED",
        workspacePath,
        enabledToolsJson: json(input.enabledTools),
        policiesJson: json(input.policies ?? {}),
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
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
          .select()
          .from(conversations)
          .where(eq(conversations.coworkerId, coworkerId))
          .orderBy(desc(conversations.updatedAt), desc(conversations.createdAt))
          .all()
      : this.database
          .select()
          .from(conversations)
          .orderBy(desc(conversations.updatedAt), desc(conversations.createdAt))
          .all();
    return rows.map(conversationFromRow);
  }

  searchConversations(coworkerId: string, query: string, limit = 100): Conversation[] {
    const escapedQuery = query.trim().replaceAll(/([!%_])/g, "!$1").toLowerCase();
    if (!escapedQuery) return this.listConversations(coworkerId).slice(0, limit);
    const pattern = `%${escapedQuery}%`;
    return this.database
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.coworkerId, coworkerId),
          sql<boolean>`(
            lower(${conversations.title}) LIKE ${pattern} ESCAPE '!'
            OR EXISTS (
              SELECT 1 FROM tasks search_tasks
              WHERE search_tasks.thread_id = ${conversations.id}
                AND (
                  lower(search_tasks.title) LIKE ${pattern} ESCAPE '!'
                  OR lower(search_tasks.input) LIKE ${pattern} ESCAPE '!'
                  OR lower(coalesce(search_tasks.result, '')) LIKE ${pattern} ESCAPE '!'
                  OR lower(coalesce(search_tasks.error, '')) LIKE ${pattern} ESCAPE '!'
                )
            )
            OR EXISTS (
              SELECT 1
              FROM messages search_messages
              INNER JOIN tasks message_tasks ON message_tasks.id = search_messages.task_id
              WHERE message_tasks.thread_id = ${conversations.id}
                AND lower(search_messages.content) LIKE ${pattern} ESCAPE '!'
            )
          )`,
        ),
      )
      .orderBy(desc(conversations.updatedAt), desc(conversations.createdAt))
      .limit(limit)
      .all()
      .map(conversationFromRow);
  }

  getConversation(id: string): Conversation {
    const row = this.database.select().from(conversations).where(eq(conversations.id, id)).get();
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
      .insert(conversations)
      .values({
        id,
        coworkerId: input.coworkerId,
        title: input.title ?? "New conversation",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    return this.getConversation(id);
  }

  updateCoworker(id: string, input: UpdateCoworkerInput): Coworker {
    this.getCoworker(id);
    const patch: Partial<typeof coworkers.$inferInsert> = { updatedAt: now() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.role !== undefined) patch.role = input.role;
    if (input.description !== undefined) patch.description = input.description;
    if (input.systemPrompt !== undefined) patch.systemPrompt = input.systemPrompt;
    if (input.modelProvider !== undefined) patch.modelProvider = input.modelProvider;
    if (input.modelName !== undefined) patch.modelName = input.modelName;
    if (input.status !== undefined) patch.status = input.status;
    if (input.enabledTools !== undefined) patch.enabledToolsJson = json(input.enabledTools);
    if (input.policies !== undefined) patch.policiesJson = json(input.policies);
    this.database.update(coworkers).set(patch).where(eq(coworkers.id, id)).run();
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
    this.database.delete(coworkers).where(eq(coworkers.id, id)).run();
    this.addActivity({
      type: "coworker.removed",
      summary: `${coworker.name} was removed`,
      metadata: { coworkerId: id },
    });
  }

  setRuntimeStatus(id: string, status: RuntimeStatus): Coworker {
    this.database
      .update(coworkers)
      .set({ runtimeStatus: status, updatedAt: now() })
      .where(eq(coworkers.id, id))
      .run();
    return this.getCoworker(id);
  }

  listSkills(): Skill[] {
    return this.database
      .select()
      .from(skills)
      .orderBy(desc(skills.bundled), asc(skills.name))
      .all()
      .map(skillFromRow);
  }

  getSkill(id: string): Skill {
    const row = this.database.select().from(skills).where(eq(skills.id, id)).get();
    if (!row) throw new Error(`Skill ${id} was not found`);
    return skillFromRow(row);
  }

  getSkillByName(name: string): Skill | null {
    const row = this.database.select().from(skills).where(eq(skills.name, name)).get();
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
    const bundled = input.bundled ?? false;
    this.database
      .insert(skills)
      .values({
        id,
        name: input.name,
        description: input.description,
        content: input.content,
        sourceUrl: input.sourceUrl ?? null,
        bundled,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: skills.name,
        set: {
          description: input.description,
          content: input.content,
          sourceUrl: input.sourceUrl ?? null,
          bundled: sql<boolean>`max(${skills.bundled}, ${bundled ? 1 : 0})`,
          updatedAt: timestamp,
        },
      })
      .run();
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
    this.database.delete(skills).where(eq(skills.id, id)).run();
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
      this.database.delete(skillResources).where(eq(skillResources.skillId, skillId)).run();
      for (const resource of resources) {
        this.database
          .insert(skillResources)
          .values({
            skillId,
            path: resource.path,
            mimeType: resource.mimeType,
            content: Buffer.from(resource.content),
          })
          .run();
      }
    });
  }

  listSkillResources(skillId: string): Array<{ path: string; mimeType: string; size: number }> {
    this.getSkill(skillId);
    return this.database
      .select({
        path: skillResources.path,
        mimeType: skillResources.mimeType,
        size: sql<number>`length(${skillResources.content})`,
      })
      .from(skillResources)
      .where(eq(skillResources.skillId, skillId))
      .orderBy(asc(skillResources.path))
      .all();
  }

  getSkillResource(
    skillId: string,
    path: string,
  ): { path: string; mimeType: string; content: Uint8Array } | null {
    const row = this.database
      .select({
        path: skillResources.path,
        mimeType: skillResources.mimeType,
        content: skillResources.content,
      })
      .from(skillResources)
      .where(and(eq(skillResources.skillId, skillId), eq(skillResources.path, path)))
      .get();
    if (!row) return null;
    return row;
  }

  listCoworkerSkillIds(coworkerId: string): string[] {
    return this.database
      .select({ skillId: coworkerSkills.skillId })
      .from(coworkerSkills)
      .where(eq(coworkerSkills.coworkerId, coworkerId))
      .orderBy(asc(coworkerSkills.createdAt), asc(coworkerSkills.skillId))
      .all()
      .map((row) => row.skillId);
  }

  listCoworkerSkills(coworkerId: string): Skill[] {
    return this.database
      .select()
      .from(skills)
      .innerJoin(coworkerSkills, eq(coworkerSkills.skillId, skills.id))
      .where(eq(coworkerSkills.coworkerId, coworkerId))
      .orderBy(desc(skills.bundled), asc(skills.name))
      .all()
      .map((row) => skillFromRow(row.skills));
  }

  setCoworkerSkills(coworkerId: string, skillIds: string[]): void {
    const uniqueIds = [...new Set(skillIds)];
    this.transaction(() => {
      this.database.delete(coworkerSkills).where(eq(coworkerSkills.coworkerId, coworkerId)).run();
      for (const skillId of uniqueIds) {
        this.getSkill(skillId);
        this.database
          .insert(coworkerSkills)
          .values({ coworkerId, skillId, createdAt: now() })
          .run();
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
      .select()
      .from(conversations)
      .where(eq(conversations.id, threadId))
      .get();
    if (conversationRow && conversationRow.coworkerId !== input.coworkerId) {
      throw new Error("Conversation does not belong to this coworker");
    }
    if (!conversationRow) {
      this.createConversation(
        { coworkerId: input.coworkerId, title: input.title },
        threadId,
      );
    } else {
      const existingTitle = conversationRow.title;
      this.database
        .update(conversations)
        .set({
          title: existingTitle === "New conversation" ? input.title : existingTitle,
          updatedAt: timestamp,
        })
        .where(eq(conversations.id, threadId))
        .run();
    }
    this.database
      .insert(tasks)
      .values({
        id,
        coworkerId: input.coworkerId,
        scheduleId: input.scheduleId ?? null,
        runId,
        threadId,
        title: input.title,
        input: input.input,
        status: "QUEUED",
        source: input.source ?? "manual",
        priority: input.priority ?? 0,
        createdAt: timestamp,
      })
      .run();
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
    const row = this.database.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!row) throw new Error(`Task ${id} was not found`);
    return taskFromRow(row);
  }

  getTaskByRunId(runId: string): Task | null {
    const row = this.database.select().from(tasks).where(eq(tasks.runId, runId)).get();
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
      .insert(taskImageAttachments)
      .values({ ...input, createdAt: timestamp })
      .run();
    const row = this.database
      .select()
      .from(taskImageAttachments)
      .where(eq(taskImageAttachments.id, input.id))
      .get();
    if (!row) throw new Error(`Image attachment ${input.id} was not found`);
    return taskImageAttachmentFromRow(row);
  }

  listTaskImageAttachments(taskId: string): TaskImageAttachment[] {
    const rows = this.database
      .select()
      .from(taskImageAttachments)
      .where(eq(taskImageAttachments.taskId, taskId))
      .orderBy(asc(taskImageAttachments.createdAt), asc(taskImageAttachments.id))
      .all();
    return rows.map(taskImageAttachmentFromRow);
  }

  getTaskImageAttachment(id: string): TaskImageAttachment {
    const row = this.database
      .select()
      .from(taskImageAttachments)
      .where(eq(taskImageAttachments.id, id))
      .get();
    if (!row) throw new Error(`Image attachment ${id} was not found`);
    return taskImageAttachmentFromRow(row);
  }

  listImageAttachments(coworkerId?: string): TaskImageAttachment[] {
    const rows = coworkerId
      ? this.database
          .select()
          .from(taskImageAttachments)
          .where(eq(taskImageAttachments.coworkerId, coworkerId))
          .orderBy(asc(taskImageAttachments.createdAt), asc(taskImageAttachments.id))
          .all()
      : this.database
          .select()
          .from(taskImageAttachments)
          .orderBy(asc(taskImageAttachments.createdAt), asc(taskImageAttachments.id))
          .all();
    return rows.map(taskImageAttachmentFromRow);
  }

  listTasks(coworkerId?: string, limit = 500): Task[] {
    const rows = coworkerId
      ? this.database
          .select()
          .from(tasks)
          .where(eq(tasks.coworkerId, coworkerId))
          .orderBy(desc(tasks.createdAt))
          .limit(limit)
          .all()
      : this.database.select().from(tasks).orderBy(desc(tasks.createdAt)).limit(limit).all();
    return rows.map(taskFromRow);
  }

  claimNextTask(coworkerId: string): Task | null {
    return this.transaction(() => {
      const active = this.database
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.coworkerId, coworkerId),
            inArray(tasks.status, ["RUNNING", "WAITING_FOR_APPROVAL"]),
          ),
        )
        .limit(1)
        .get();
      if (active) return null;
      const row = this.database
        .select()
        .from(tasks)
        .where(and(eq(tasks.coworkerId, coworkerId), eq(tasks.status, "QUEUED")))
        .orderBy(desc(tasks.priority), asc(tasks.createdAt))
        .limit(1)
        .get();
      if (!row) return null;
      const timestamp = now();
      this.database
        .update(tasks)
        .set({
          status: "RUNNING",
          startedAt: sql<string>`coalesce(${tasks.startedAt}, ${timestamp})`,
        })
        .where(eq(tasks.id, row.id))
        .run();
      return this.getTask(row.id);
    });
  }

  setTaskStatus(
    id: string,
    status: TaskStatus,
    options: { result?: string | null; error?: string | null } = {},
  ): Task {
    const completed = ["COMPLETED", "FAILED", "CANCELLED"].includes(status) ? now() : null;
    const patch: Partial<typeof tasks.$inferInsert> = { status };
    if (options.result != null) patch.result = options.result;
    if (options.error != null) patch.error = options.error;
    if (completed) patch.completedAt = completed;
    this.database.update(tasks).set(patch).where(eq(tasks.id, id)).run();
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
      const pendingApprovalToolCalls = this.database
        .select({ toolCallId: approvals.toolCallId })
        .from(approvals)
        .where(and(eq(approvals.taskId, id), eq(approvals.status, "PENDING")));
      this.database
        .update(toolCalls)
        .set({ status: "DENIED", completedAt: now() })
        .where(and(eq(toolCalls.taskId, id), inArray(toolCalls.id, pendingApprovalToolCalls)))
        .run();
      this.database
        .update(approvals)
        .set({ status: "EXPIRED", decidedAt: now() })
        .where(and(eq(approvals.taskId, id), eq(approvals.status, "PENDING")))
        .run();
      return this.setTaskStatus(id, "CANCELLED");
    });
  }

  recoverInterruptedTasks(): number {
    return this.transaction(() => {
      const result = this.database
        .update(tasks)
        .set({ status: "QUEUED", source: "recovery" })
        .where(eq(tasks.status, "RUNNING"))
        .run();
      this.database
        .update(coworkers)
        .set({ runtimeStatus: "STOPPED", updatedAt: now() })
        .run();
      return Number(result.changes);
    });
  }

  addMessage(input: Omit<Message, "id" | "createdAt">, id = randomUUID()): Message {
    const timestamp = now();
    this.database
      .insert(messages)
      .values({ id, ...input, createdAt: timestamp })
      .run();
    const row = this.database.select().from(messages).where(eq(messages.id, id)).get();
    if (!row) throw new Error(`Message ${id} was not found`);
    return messageFromRow(row);
  }

  listMessages(coworkerId: string, taskId?: string, limit = 500): Message[] {
    const rows = taskId
      ? this.database
          .select()
          .from(messages)
          .where(and(eq(messages.coworkerId, coworkerId), eq(messages.taskId, taskId)))
          .orderBy(asc(messages.createdAt))
          .limit(limit)
          .all()
      : this.database
          .select()
          .from(messages)
          .where(eq(messages.coworkerId, coworkerId))
          .orderBy(asc(messages.createdAt))
          .limit(limit)
          .all();
    return rows.map(messageFromRow);
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
      .select()
      .from(messages)
      .innerJoin(tasks, eq(tasks.id, messages.taskId))
      .where(and(eq(messages.coworkerId, coworkerId), eq(tasks.threadId, conversationId)))
      .orderBy(asc(messages.createdAt))
      .limit(limit)
      .all();
    return rows.map((row) => messageFromRow(row.messages));
  }

  saveCheckpoint(taskId: string, messages: unknown[], pendingTool?: unknown): void {
    const messagesJson = json(messages);
    const pendingToolJson = pendingTool === undefined ? null : json(pendingTool);
    const updatedAt = now();
    this.database
      .insert(taskCheckpoints)
      .values({ taskId, messagesJson, pendingToolJson, updatedAt })
      .onConflictDoUpdate({
        target: taskCheckpoints.taskId,
        set: { messagesJson, pendingToolJson, updatedAt },
      })
      .run();
  }

  getCheckpoint(taskId: string): { messages: unknown[]; pendingTool: unknown } | null {
    const row = this.database
      .select()
      .from(taskCheckpoints)
      .where(eq(taskCheckpoints.taskId, taskId))
      .get();
    if (!row) return null;
    return {
      messages: parseJson<unknown[]>(row.messagesJson, []),
      pendingTool: parseJson(row.pendingToolJson, null),
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
      .insert(toolCalls)
      .values({
        id,
        taskId: input.taskId,
        coworkerId: input.coworkerId,
        toolName: input.toolName,
        argumentsJson: json(input.arguments),
        status: "REQUESTED",
        idempotencyKey: input.idempotencyKey,
        createdAt: now(),
      })
      .onConflictDoNothing()
      .run();
    return this.getToolCallByIdempotencyKey(input.idempotencyKey);
  }

  getToolCall(id: string): ToolCall {
    const row = this.database.select().from(toolCalls).where(eq(toolCalls.id, id)).get();
    if (!row) throw new Error(`Tool call ${id} was not found`);
    return toolCallFromRow(row);
  }

  getToolCallByIdempotencyKey(key: string): ToolCall {
    const row = this.database
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.idempotencyKey, key))
      .get();
    if (!row) throw new Error(`Tool call with idempotency key ${key} was not found`);
    return toolCallFromRow(row);
  }

  listToolCalls(taskId?: string): ToolCall[] {
    const rows = taskId
      ? this.database
          .select()
          .from(toolCalls)
          .where(eq(toolCalls.taskId, taskId))
          .orderBy(asc(toolCalls.createdAt))
          .all()
      : this.database.select().from(toolCalls).orderBy(asc(toolCalls.createdAt)).all();
    return rows.map(toolCallFromRow);
  }

  updateToolCall(
    id: string,
    status: ToolCall["status"],
    result?: unknown,
  ): ToolCall {
    const completed = ["COMPLETED", "FAILED", "DENIED"].includes(status) ? now() : null;
    const patch: Partial<typeof toolCalls.$inferInsert> = { status };
    if (result !== undefined) patch.resultJson = json(result);
    if (completed) patch.completedAt = completed;
    this.database.update(toolCalls).set(patch).where(eq(toolCalls.id, id)).run();
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
        .select()
        .from(approvals)
        .where(eq(approvals.toolCallId, input.toolCallId))
        .get();
      if (existing) return approvalFromRow(existing);
      const id = randomUUID();
      const timestamp = now();
      this.database
        .insert(approvals)
        .values({
          id,
          taskId: input.taskId,
          coworkerId: input.coworkerId,
          toolCallId: input.toolCallId,
          actionType: input.actionType,
          summary: input.summary,
          proposedPayloadJson: json(input.proposedPayload),
          riskLevel: input.riskLevel,
          status: "PENDING",
          createdAt: timestamp,
        })
        .run();
      this.database
        .update(toolCalls)
        .set({ status: "WAITING_FOR_APPROVAL" })
        .where(eq(toolCalls.id, input.toolCallId))
        .run();
      this.database
        .update(tasks)
        .set({ status: "WAITING_FOR_APPROVAL" })
        .where(eq(tasks.id, input.taskId))
        .run();
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
    const row = this.database.select().from(approvals).where(eq(approvals.id, id)).get();
    if (!row) throw new Error(`Approval ${id} was not found`);
    return approvalFromRow(row);
  }

  getApprovalForTask(taskId: string): Approval | null {
    const row = this.database
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.taskId, taskId),
          inArray(approvals.status, ["PENDING", "APPROVED", "EDITED", "REJECTED"]),
        ),
      )
      .orderBy(desc(approvals.createdAt))
      .limit(1)
      .get();
    return row ? approvalFromRow(row) : null;
  }

  listApprovals(status?: ApprovalStatus): Approval[] {
    const rows = status
      ? this.database
          .select()
          .from(approvals)
          .where(eq(approvals.status, status))
          .orderBy(asc(approvals.createdAt))
          .all()
      : this.database.select().from(approvals).orderBy(desc(approvals.createdAt)).all();
    return rows.map(approvalFromRow);
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
        .update(approvals)
        .set({ status, decidedPayloadJson: json(decidedPayload), decidedAt: now() })
        .where(eq(approvals.id, approval.id))
        .run();
      this.database
        .update(tasks)
        .set({ status: "QUEUED" })
        .where(eq(tasks.id, approval.taskId))
        .run();
      this.database
        .update(toolCalls)
        .set({ status: status === "REJECTED" ? "DENIED" : "REQUESTED" })
        .where(eq(toolCalls.id, approval.toolCallId))
        .run();
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
      .insert(schedules)
      .values({
        id,
        coworkerId: input.coworkerId,
        name: input.name,
        scheduleType: input.scheduleType,
        cronExpression: input.cronExpression ?? null,
        runAt: input.runAt ?? null,
        timezone: input.timezone,
        taskTemplateJson: json(input.taskTemplate),
        enabled: input.enabled !== false,
        nextRunAt,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    this.addActivity({
      coworkerId: input.coworkerId,
      type: "schedule.created",
      summary: input.name,
      metadata: { scheduleId: id },
    });
    return this.getSchedule(id);
  }

  getSchedule(id: string): Schedule {
    const row = this.database.select().from(schedules).where(eq(schedules.id, id)).get();
    if (!row) throw new Error(`Schedule ${id} was not found`);
    return scheduleFromRow(row);
  }

  listSchedules(): Schedule[] {
    return this.database
      .select()
      .from(schedules)
      .orderBy(asc(schedules.createdAt))
      .all()
      .map(scheduleFromRow);
  }

  updateSchedule(
    id: string,
    input: UpdateScheduleInput,
    nextRunAt: string | null,
  ): Schedule {
    this.getSchedule(id);
    const patch: Partial<typeof schedules.$inferInsert> = {
      nextRunAt,
      updatedAt: now(),
    };
    if (input.name !== undefined) patch.name = input.name;
    if (input.scheduleType !== undefined) patch.scheduleType = input.scheduleType;
    if (input.cronExpression !== undefined) patch.cronExpression = input.cronExpression;
    if (input.runAt !== undefined) patch.runAt = input.runAt;
    if (input.timezone !== undefined) patch.timezone = input.timezone;
    if (input.taskTemplate !== undefined) patch.taskTemplateJson = json(input.taskTemplate);
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    this.database.update(schedules).set(patch).where(eq(schedules.id, id)).run();
    return this.getSchedule(id);
  }

  deleteSchedule(id: string): void {
    const schedule = this.getSchedule(id);
    this.database.delete(schedules).where(eq(schedules.id, id)).run();
    this.addActivity({
      coworkerId: schedule.coworkerId,
      type: "schedule.removed",
      summary: schedule.name,
      metadata: { scheduleId: id },
    });
  }

  listDueSchedules(at = now()): Schedule[] {
    return this.database
      .select()
      .from(schedules)
      .where(
        and(
          eq(schedules.enabled, true),
          isNotNull(schedules.nextRunAt),
          lte(schedules.nextRunAt, at),
        ),
      )
      .orderBy(asc(schedules.nextRunAt))
      .all()
      .map(scheduleFromRow);
  }

  getEarliestNextRun(): string | null {
    const row = this.database
      .select({ nextRunAt: schedules.nextRunAt })
      .from(schedules)
      .where(and(eq(schedules.enabled, true), isNotNull(schedules.nextRunAt)))
      .orderBy(asc(schedules.nextRunAt))
      .limit(1)
      .get();
    return row?.nextRunAt ?? null;
  }

  markScheduleRun(id: string, ranAt: string, nextRunAt: string | null): Schedule {
    const enabled = nextRunAt !== null;
    this.database
      .update(schedules)
      .set({ lastRunAt: ranAt, nextRunAt, enabled, updatedAt: now() })
      .where(eq(schedules.id, id))
      .run();
    return this.getSchedule(id);
  }

  createArtifact(input: Omit<Artifact, "id" | "createdAt">): Artifact {
    if (input.taskId) {
      const existing = this.database
        .select()
        .from(artifacts)
        .where(and(eq(artifacts.taskId, input.taskId), eq(artifacts.filePath, input.filePath)))
        .limit(1)
        .get();
      if (existing) return artifactFromRow(existing);
    }
    const id = randomUUID();
    this.database
      .insert(artifacts)
      .values({ id, ...input, createdAt: now() })
      .run();
    return this.getArtifact(id);
  }

  getArtifact(id: string): Artifact {
    const row = this.database.select().from(artifacts).where(eq(artifacts.id, id)).get();
    if (!row) throw new Error(`Artifact ${id} was not found`);
    return artifactFromRow(row);
  }

  deleteArtifact(id: string): Artifact {
    const artifact = this.getArtifact(id);
    this.database
      .delete(artifacts)
      .where(
        and(
          eq(artifacts.coworkerId, artifact.coworkerId),
          eq(artifacts.filePath, artifact.filePath),
        ),
      )
      .run();
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
          .select()
          .from(artifacts)
          .where(eq(artifacts.coworkerId, coworkerId))
          .orderBy(desc(artifacts.createdAt))
          .all()
      : this.database.select().from(artifacts).orderBy(desc(artifacts.createdAt)).all();
    return rows.map(artifactFromRow);
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
      .insert(activity)
      .values({
        id,
        coworkerId: input.coworkerId ?? null,
        taskId: input.taskId ?? null,
        type: input.type,
        summary: input.summary,
        metadataJson: input.metadata === undefined ? null : json(input.metadata),
        createdAt: now(),
      })
      .run();
    const row = this.database.select().from(activity).where(eq(activity.id, id)).get();
    if (!row) throw new Error(`Activity ${id} was not found`);
    return activityFromRow(row);
  }

  listActivity(limit = 200): ActivityItem[] {
    return this.database
      .select()
      .from(activity)
      .orderBy(desc(activity.createdAt))
      .limit(limit)
      .all()
      .map(activityFromRow);
  }

  listIntegrations(): Integration[] {
    return this.database
      .select()
      .from(integrations)
      .orderBy(asc(integrations.createdAt))
      .all()
      .map(integrationFromRow);
  }

  upsertEmailIntegration(input: {
    name: string;
    mode: Integration["mode"];
    credentialKey: string | null;
    fromAddress?: string;
  }): Integration {
    const existing = this.database
      .select()
      .from(integrations)
      .where(eq(integrations.type, "email"))
      .limit(1)
      .get();
    const timestamp = now();
    const config = { fromAddress: input.fromAddress ?? "" };
    if (existing) {
      this.database
        .update(integrations)
        .set({
          name: input.name,
          mode: input.mode,
          status: "connected",
          credentialKey: input.credentialKey,
          configJson: json(config),
          updatedAt: timestamp,
        })
        .where(eq(integrations.id, existing.id))
        .run();
      return this.getIntegration(existing.id);
    }
    const id = randomUUID();
    this.database
      .insert(integrations)
      .values({
        id,
        type: "email",
        name: input.name,
        mode: input.mode,
        status: "connected",
        credentialKey: input.credentialKey,
        configJson: json(config),
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    return this.getIntegration(id);
  }

  getIntegration(id: string): Integration {
    const row = this.database.select().from(integrations).where(eq(integrations.id, id)).get();
    if (!row) throw new Error(`Integration ${id} was not found`);
    return integrationFromRow(row);
  }

  getEmailIntegration(): Integration | null {
    const row = this.database
      .select()
      .from(integrations)
      .where(eq(integrations.type, "email"))
      .limit(1)
      .get();
    return row ? integrationFromRow(row) : null;
  }

  getSideEffect(key: string): { status: string; result: unknown } | null {
    const row = this.database
      .select({ status: sideEffects.status, resultJson: sideEffects.resultJson })
      .from(sideEffects)
      .where(eq(sideEffects.idempotencyKey, key))
      .get();
    return row
      ? { status: row.status, result: parseJson(row.resultJson, null) }
      : null;
  }

  startSideEffect(key: string, toolCallId: string): boolean {
    const result = this.database
      .insert(sideEffects)
      .values({ idempotencyKey: key, toolCallId, status: "RUNNING", createdAt: now() })
      .onConflictDoUpdate({
        target: sideEffects.idempotencyKey,
        set: { status: "RUNNING", resultJson: null, completedAt: null },
      })
      .run();
    return Number(result.changes) === 1;
  }

  finishSideEffect(key: string, status: "COMPLETED" | "FAILED", result: unknown): void {
    this.database
      .update(sideEffects)
      .set({ status, resultJson: json(result), completedAt: now() })
      .where(eq(sideEffects.idempotencyKey, key))
      .run();
  }
}
