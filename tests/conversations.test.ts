import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CoworkerDatabase } from "@main/db/database";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function createCoworker(database: CoworkerDatabase, root: string, name: string) {
  return database.createCoworker(
    {
      name,
      role: "General Coworker",
      systemPrompt: "Help with the selected conversation.",
      modelProvider: "demo",
      modelName: "faux-1",
      enabledTools: [],
    },
    join(root, name.toLowerCase()),
  );
}

describe("durable coworker conversations", () => {
  it("creates a default conversation and keeps separate conversation histories", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-conversations-"));
    temporaryPaths.push(root);
    const databasePath = join(root, "coworker.db");
    const database = new CoworkerDatabase(databasePath);

    const coworker = createCoworker(database, root, "Hermi");
    const [firstConversation] = database.listConversations(coworker.id);
    expect(firstConversation).toMatchObject({
      id: `coworker:${coworker.id}`,
      coworkerId: coworker.id,
      title: "New conversation",
    });

    const firstTask = database.createTask({
      coworkerId: coworker.id,
      threadId: firstConversation!.id,
      title: "Review the August lease",
      input: "Review the August lease.",
    });
    database.addMessage({
      coworkerId: coworker.id,
      taskId: firstTask.id,
      role: "assistant",
      content: "I found three clauses to discuss.",
    });
    expect(database.getConversation(firstConversation!.id).title).toBe(
      "Review the August lease",
    );

    const secondConversation = database.createConversation({ coworkerId: coworker.id });
    const secondTask = database.createTask({
      coworkerId: coworker.id,
      threadId: secondConversation.id,
      title: "Format a proposal",
      input: "Format this proposal as a PDF.",
    });
    database.addMessage({
      coworkerId: coworker.id,
      taskId: secondTask.id,
      role: "assistant",
      content: "The proposal is ready.",
    });

    expect(
      database
        .listConversationMessages(coworker.id, firstConversation!.id)
        .map((message) => message.content),
    ).toEqual(["Review the August lease.", "I found three clauses to discuss."]);
    expect(
      database
        .listConversationMessages(coworker.id, secondConversation.id)
        .map((message) => message.content),
    ).toEqual(["Format this proposal as a PDF.", "The proposal is ready."]);
    expect(
      new Set(database.listConversations(coworker.id).map((conversation) => conversation.id)),
    ).toEqual(new Set([secondConversation.id, firstConversation!.id]));

    database.close();
    const reopened = new CoworkerDatabase(databasePath);
    expect(reopened.listConversations(coworker.id)).toHaveLength(2);
    expect(
      reopened.listConversationMessages(coworker.id, firstConversation!.id),
    ).toHaveLength(2);
    reopened.close();
  });

  it("prevents a conversation from being used by another coworker", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-conversation-ownership-"));
    temporaryPaths.push(root);
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    try {
      const ava = createCoworker(database, root, "Ava");
      const hermi = createCoworker(database, root, "Hermi");
      const conversation = database.createConversation({ coworkerId: ava.id });

      expect(() =>
        database.createTask({
          coworkerId: hermi.id,
          threadId: conversation.id,
          title: "Wrong owner",
          input: "Continue Ava's conversation.",
        }),
      ).toThrow("Coworker is not a member of this conversation");
      expect(() =>
        database.listConversationMessages(hermi.id, conversation.id),
      ).toThrow("Coworker is not a member of this conversation");
    } finally {
      database.close();
    }
  });

  it("searches the complete stored conversation history beyond bootstrap limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-conversation-search-"));
    temporaryPaths.push(root);
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    try {
      const ava = createCoworker(database, root, "Ava");
      const [conversation] = database.listConversations(ava.id);
      const task = database.createTask({
        coworkerId: ava.id,
        threadId: conversation!.id,
        title: "Long-running account review",
        input: "Review the account.",
      });
      for (let index = 0; index < 500; index += 1) {
        database.addMessage({
          coworkerId: ava.id,
          taskId: task.id,
          role: "assistant",
          content: `Routine update ${index}`,
        });
      }
      database.addMessage({
        coworkerId: ava.id,
        taskId: task.id,
        role: "assistant",
        content: "The hidden renewal code is ORCHID-742.",
      });

      expect(database.listMessages(ava.id).some((message) => message.content.includes("ORCHID"))).toBe(
        false,
      );
      expect(database.searchConversations(ava.id, "orchid-742")).toEqual([
        expect.objectContaining({ id: conversation!.id }),
      ]);
      expect(
        database
          .listConversationMessages(ava.id, conversation!.id, Number.MAX_SAFE_INTEGER)
          .some((message) => message.content.includes("ORCHID")),
      ).toBe(true);
    } finally {
      database.close();
    }
  });

  it("backfills conversation history for databases created before conversations existed", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-conversation-backfill-"));
    temporaryPaths.push(root);
    const databasePath = join(root, "coworker.db");
    const database = new CoworkerDatabase(databasePath);
    const coworker = createCoworker(database, root, "Sarah");
    const task = database.createTask({
      coworkerId: coworker.id,
      title: "Historical handoff",
      input: "Prepare the handoff.",
    });
    database.close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec("PRAGMA foreign_keys = OFF");
    legacy.prepare("DELETE FROM conversations").run();
    legacy.close();

    const migrated = new CoworkerDatabase(databasePath);
    try {
      expect(migrated.listConversations(coworker.id)).toEqual([
        expect.objectContaining({
          id: task.threadId,
          coworkerId: coworker.id,
          title: task.title,
        }),
      ]);
      expect(
        migrated.listConversationMessages(coworker.id, task.threadId).map((message) => message.content),
      ).toEqual(["Prepare the handoff."]);
    } finally {
      migrated.close();
    }
  });

  it("upgrades a partial legacy schema without losing durable data", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-drizzle-baseline-"));
    temporaryPaths.push(root);
    const databasePath = join(root, "coworker.db");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE coworkers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        description TEXT,
        system_prompt TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        model_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        runtime_status TEXT NOT NULL DEFAULT 'STOPPED',
        workspace_path TEXT NOT NULL,
        enabled_tools_json TEXT NOT NULL DEFAULT '[]',
        policies_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        coworker_id TEXT NOT NULL,
        schedule_id TEXT,
        run_id TEXT,
        thread_id TEXT,
        title TEXT NOT NULL,
        input TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        priority INTEGER NOT NULL DEFAULT 0,
        result TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );
      INSERT INTO schema_migrations(version, applied_at)
      VALUES (1, datetime('now'));
      INSERT INTO coworkers(
        id, name, role, system_prompt, model_provider, model_name,
        workspace_path, created_at, updated_at
      ) VALUES (
        'legacy-coworker', 'Legacy', 'General Coworker', 'Preserve state.',
        'demo', 'faux-1', '${root.replaceAll("'", "''")}/legacy',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO tasks(
        id, coworker_id, run_id, thread_id, title, input, status, created_at
      ) VALUES (
        'legacy-task', 'legacy-coworker', 'legacy-run', 'coworker:legacy-coworker',
        'Preserve this task', 'Keep my durable state.', 'COMPLETED',
        '2026-01-01T00:01:00.000Z'
      );
    `);
    legacy.close();

    const migrated = new CoworkerDatabase(databasePath);
    try {
      expect(migrated.getCoworker("legacy-coworker")).toMatchObject({
        id: "legacy-coworker",
        name: "Legacy",
      });
      expect(migrated.getTask("legacy-task")).toMatchObject({
        id: "legacy-task",
        input: "Keep my durable state.",
      });
      expect(migrated.getConversation("coworker:legacy-coworker")).toMatchObject({
        title: "Preserve this task",
      });
      expect(migrated.listSkills()).toEqual([]);
    } finally {
      migrated.close();
    }

    const backupFiles = await readdir(join(root, "backups"));
    expect(backupFiles).toHaveLength(1);
    expect(backupFiles[0]).toMatch(
      /^coworker-before-\d{14}_[a-z0-9_-]+-[a-f0-9]{12}\.db$/,
    );
    const backup = new DatabaseSync(join(root, "backups", backupFiles[0]!));
    try {
      expect(
        backup.prepare("SELECT name FROM coworkers WHERE id = 'legacy-coworker'").get(),
      ).toEqual({ name: "Legacy" });
      expect(
        backup
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      backup.close();
    }

    const restarted = new CoworkerDatabase(databasePath);
    restarted.close();
    expect(await readdir(join(root, "backups"))).toEqual(backupFiles);

    const verified = new DatabaseSync(databasePath);
    try {
      const migrationCount = verified
        .prepare("SELECT count(*) AS count FROM __drizzle_migrations")
        .get() as { count: number };
      expect(migrationCount.count).toBe(5);
    } finally {
      verified.close();
    }
  });

  it("does not create a migration backup for a new empty database", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-drizzle-new-"));
    temporaryPaths.push(root);
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    database.close();

    await expect(readdir(join(root, "backups"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
