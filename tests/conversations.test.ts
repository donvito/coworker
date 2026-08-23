import { mkdtemp, rm } from "node:fs/promises";
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
      ).toThrow("Conversation does not belong to this coworker");
      expect(() =>
        database.listConversationMessages(hermi.id, conversation.id),
      ).toThrow("Conversation does not belong to this coworker");
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
});
