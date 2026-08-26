import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAppService } from "@main/app/app-service";
import { CoworkerDatabase } from "@main/db/database";
import { CoworkerRuntimeManager } from "@main/runtime/runtime-manager";
import type { DesktopEvent } from "@shared/contracts";

const temporaryPaths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function credentials() {
  const values = new Map<string, string>();
  return {
    async set(key: string, value: string) {
      values.set(key, value);
    },
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async has(key: string) {
      return values.has(key);
    },
    async delete(key: string) {
      values.delete(key);
    },
  };
}

function createCoworker(database: CoworkerDatabase, root: string, name: string) {
  return database.createCoworker(
    {
      name,
      role: `${name} specialist`,
      systemPrompt: `You are ${name}.`,
      modelProvider: "demo",
      modelName: "faux-1",
      enabledTools: [],
    },
    join(root, name.toLowerCase()),
  );
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

describe("multi-coworker channels", () => {
  it("stores one canonical message and starts a turn-based discussion", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-channels-"));
    temporaryPaths.push(root);
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    const ava = createCoworker(database, root, "Ava");
    const sarah = createCoworker(database, root, "Sarah");
    const channel = database.createConversation({
      kind: "group",
      memberIds: [ava.id, sarah.id],
      title: "Launch review",
    });
    const service = new DesktopAppService({
      dataPath: root,
      database,
      credentials: credentials(),
    });
    const enqueue = vi.spyOn(service.runtime, "enqueueTask").mockImplementation(() => undefined);

    try {
      const first = await service.sendConversationMessage({
        conversationId: channel.id,
        clientMessageId: "message-1",
        content: "@Ava check the numbers and @Sarah review the pitch.",
        mentionedCoworkerIds: [ava.id, sarah.id],
      });

      expect(first.message).toMatchObject({
        id: "message-1",
        conversationId: channel.id,
        coworkerId: null,
        authorName: "You",
      });
      expect(first.message.mentionedCoworkerIds.sort()).toEqual(
        [ava.id, sarah.id].sort(),
      );
      expect([...first.discussion!.participantIds].sort()).toEqual(
        [ava.id, sarah.id].sort(),
      );
      expect(first.runs).toHaveLength(1);
      expect(database.listConversationMessages(channel.id)).toHaveLength(1);
      expect(database.listTasksBySourceMessage(first.message.id)).toHaveLength(1);
      expect(enqueue).toHaveBeenCalledTimes(1);

      const retried = await service.sendConversationMessage({
        conversationId: channel.id,
        clientMessageId: "message-1",
        content: "@Ava check the numbers and @Sarah review the pitch.",
        mentionedCoworkerIds: [ava.id, sarah.id],
      });
      expect(retried.runs).toHaveLength(1);
      expect(retried.discussion?.id).toBe(first.discussion!.id);
      expect(database.listConversationMessages(channel.id)).toHaveLength(1);
      expect(enqueue).toHaveBeenCalledTimes(1);
    } finally {
      await service.runtime.stopAll();
      database.close();
    }
  });

  it("routes unmentioned messages to every member and auto-routes direct chats", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-channel-routing-"));
    temporaryPaths.push(root);
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    const ava = createCoworker(database, root, "Ava");
    const sarah = createCoworker(database, root, "Sarah");
    const group = database.createConversation({
      kind: "group",
      memberIds: [ava.id, sarah.id],
    });
    const direct = database.createConversation({ coworkerId: ava.id });
    const service = new DesktopAppService({
      dataPath: root,
      database,
      credentials: credentials(),
    });
    vi.spyOn(service.runtime, "enqueueTask").mockImplementation(() => undefined);

    try {
      const broadcast = await service.sendConversationMessage({
        conversationId: group.id,
        clientMessageId: "group-without-mention",
        content: "Please review this.",
        mentionedCoworkerIds: [],
      });
      expect([...broadcast.discussion!.participantIds].sort()).toEqual(
        [ava.id, sarah.id].sort(),
      );
      expect(broadcast.runs).toHaveLength(1);

      const retried = await service.sendConversationMessage({
        conversationId: group.id,
        clientMessageId: "group-without-mention",
        content: "Please review this.",
        mentionedCoworkerIds: [],
      });
      expect(retried.runs).toHaveLength(1);
      expect(retried.discussion?.id).toBe(broadcast.discussion!.id);

      const receipt = await service.sendConversationMessage({
        conversationId: direct.id,
        clientMessageId: "direct-without-mention",
        content: "Please review this.",
        mentionedCoworkerIds: [],
      });
      expect(receipt.runs).toEqual([
        expect.objectContaining({ coworkerId: ava.id }),
      ]);
      expect(receipt.discussion).toBeNull();
    } finally {
      await service.runtime.stopAll();
      database.close();
    }
  });

  it("runs mentioned coworkers independently and records their identities", { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-channel-runtime-"));
    temporaryPaths.push(root);
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    const ava = createCoworker(database, root, "Ava");
    const sarah = createCoworker(database, root, "Sarah");
    const channel = database.createConversation({
      kind: "group",
      memberIds: [ava.id, sarah.id],
      title: "Parallel review",
    });
    const credentialStore = credentials();
    const service = new DesktopAppService({
      dataPath: root,
      database,
      credentials: credentialStore,
    });
    vi.spyOn(service.runtime, "enqueueTask").mockImplementation(() => undefined);
    const events: DesktopEvent[] = [];
    const runtime = new CoworkerRuntimeManager({
      database,
      credentials: credentialStore,
      tools: service.tools,
      emit: (event) => events.push(event),
      idleTimeoutMs: 60_000,
      workerFactory: () =>
        new Worker(resolve(process.cwd(), "out/main/runtime/coworker-worker.js")),
    });

    try {
      const forAva = await service.sendConversationMessage({
        conversationId: channel.id,
        clientMessageId: "for-ava",
        content: "@Ava review the numbers.",
        mentionedCoworkerIds: [ava.id],
      });
      const forSarah = await service.sendConversationMessage({
        conversationId: channel.id,
        clientMessageId: "for-sarah",
        content: "@Sarah review the pitch.",
        mentionedCoworkerIds: [sarah.id],
      });
      expect(forAva.discussion).toBeNull();
      expect(forSarah.discussion).toBeNull();
      const runs = [...forAva.runs, ...forSarah.runs];
      runtime.enqueueTask(ava.id);
      runtime.enqueueTask(sarah.id);
      await waitFor(
        () =>
          runs.every(
            (run) => database.getTask(run.taskId).status === "COMPLETED",
          ),
        "both channel responses",
      );

      const history = database.listConversationMessages(channel.id);
      expect(history.filter((message) => message.role === "user")).toHaveLength(2);
      expect(
        history
          .filter((message) => message.role === "assistant")
          .map((message) => message.authorName)
          .sort(),
      ).toEqual(["Ava", "Sarah"]);
      expect(
        events
          .filter((event) => event.type === "agent.event")
          .every((event) => event.conversationId === channel.id),
      ).toBe(true);
    } finally {
      await runtime.stopAll();
      await service.runtime.stopAll();
      database.close();
    }
  });

  it("preserves shared history when a coworker leaves a group channel", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-channel-member-removal-"));
    temporaryPaths.push(root);
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    try {
      const ava = createCoworker(database, root, "Ava");
      const sarah = createCoworker(database, root, "Sarah");
      const channel = database.createConversation({
        kind: "group",
        memberIds: [ava.id, sarah.id],
      });
      const task = database.createTask({
        coworkerId: ava.id,
        threadId: channel.id,
        title: "Review",
        input: "Review this.",
      });
      database.addMessage({
        coworkerId: ava.id,
        taskId: task.id,
        role: "assistant",
        content: "The review is complete.",
      });

      database.deleteCoworker(ava.id);

      expect(database.getConversation(channel.id).memberIds).toEqual([sarah.id]);
      expect(
        database
          .listConversationMessages(channel.id)
          .find((message) => message.role === "assistant"),
      ).toMatchObject({
        coworkerId: null,
        authorName: "Ava",
        taskId: null,
        content: "The review is complete.",
      });
    } finally {
      database.close();
    }
  });

  it("runs a discussion continuously and checks in only at the safety limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-channel-discussion-"));
    temporaryPaths.push(root);
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    const ava = createCoworker(database, root, "Ava");
    const sarah = createCoworker(database, root, "Sarah");
    const channel = database.createConversation({
      kind: "group",
      memberIds: [ava.id, sarah.id],
      title: "Marketing discussion",
    });
    const service = new DesktopAppService({
      dataPath: root,
      database,
      credentials: credentials(),
    });
    vi.spyOn(service.runtime, "enqueueTask").mockImplementation(() => undefined);

    async function completeCurrentTurn(text: string) {
      const task = database
        .listTasksBySourceMessage("discussion-message")
        .sort(
          (left, right) => (left.discussionTurn ?? 0) - (right.discussionTurn ?? 0),
        )
        .at(-1)!;
      database.setTaskStatus(task.id, "COMPLETED", { result: text });
      await service.advanceDiscussion(database.getTask(task.id));
      return task;
    }

    try {
      const receipt = await service.sendConversationMessage({
        conversationId: channel.id,
        clientMessageId: "discussion-message",
        content: "Discuss our marketing plan together.",
        mentionedCoworkerIds: [],
      });
      const discussionId = receipt.discussion!.id;
      expect(receipt.discussion).toMatchObject({
        nextTurn: 1,
        hardLimit: 8,
        status: "active",
      });
      expect(receipt.runs).toHaveLength(1);

      const speakers: string[] = [];
      for (let turn = 0; turn < 8; turn += 1) {
        speakers.push((await completeCurrentTurn(`Contribution ${turn}`)).coworkerId);
      }
      const discussion = database.getDiscussion(discussionId);
      expect(discussion.status).toBe("awaiting_user");
      expect(discussion.nextTurn).toBe(8);
      expect(new Set(speakers)).toEqual(new Set([ava.id, sarah.id]));
      expect(speakers.slice(0, 4)).toEqual([
        speakers[0],
        speakers[0] === ava.id ? sarah.id : ava.id,
        speakers[0],
        speakers[0] === ava.id ? sarah.id : ava.id,
      ]);

      const continued = await service.continueDiscussion(discussionId);
      expect(continued.discussion.status).toBe("active");
      expect(continued.discussion.hardLimit).toBe(12);
      expect(continued.run).not.toBeNull();
      expect(database.listTasksBySourceMessage("discussion-message")).toHaveLength(9);
    } finally {
      await service.runtime.stopAll();
      database.close();
    }
  });

  it("lets the user interject while coworkers discuss and after the check-in", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-channel-interject-"));
    temporaryPaths.push(root);
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    const ava = createCoworker(database, root, "Ava");
    const sarah = createCoworker(database, root, "Sarah");
    const channel = database.createConversation({
      kind: "group",
      memberIds: [ava.id, sarah.id],
      title: "Interjection test",
    });
    const service = new DesktopAppService({
      dataPath: root,
      database,
      credentials: credentials(),
    });
    vi.spyOn(service.runtime, "enqueueTask").mockImplementation(() => undefined);

    async function completeCurrentTurn(text: string) {
      const task = database
        .listTasksBySourceMessage("interject-source")
        .sort(
          (left, right) => (left.discussionTurn ?? 0) - (right.discussionTurn ?? 0),
        )
        .at(-1)!;
      database.setTaskStatus(task.id, "COMPLETED", { result: text });
      await service.advanceDiscussion(database.getTask(task.id));
    }

    try {
      const receipt = await service.sendConversationMessage({
        conversationId: channel.id,
        clientMessageId: "interject-source",
        content: "Discuss the launch checklist.",
        mentionedCoworkerIds: [],
      });
      const discussionId = receipt.discussion!.id;

      await expect(
        service.sendConversationMessage({
          conversationId: channel.id,
          clientMessageId: "interject-with-mentions",
          content: "@Ava do something else instead.",
          mentionedCoworkerIds: [ava.id],
        }),
      ).rejects.toThrow("A discussion is in progress");

      const midDiscussion = await service.sendConversationMessage({
        conversationId: channel.id,
        clientMessageId: "interjection-live",
        content: "Please keep the budget under $10k.",
        mentionedCoworkerIds: [],
      });
      expect(midDiscussion.message).toMatchObject({
        conversationId: channel.id,
        authorName: "You",
        role: "user",
      });
      expect(midDiscussion.runs).toHaveLength(0);
      expect(midDiscussion.discussion?.status).toBe("active");

      for (let turn = 0; turn < 8; turn += 1) {
        await completeCurrentTurn(`Contribution ${turn}`);
      }
      expect(database.getDiscussion(discussionId).status).toBe("awaiting_user");

      const resumed = await service.sendConversationMessage({
        conversationId: channel.id,
        clientMessageId: "interjection-resume",
        content: "One more thing: include the retail partners.",
        mentionedCoworkerIds: [],
      });
      expect(resumed.discussion).toMatchObject({
        id: discussionId,
        status: "active",
        hardLimit: 12,
      });
      expect(resumed.runs).toHaveLength(1);
      expect(database.listTasksBySourceMessage("interject-source")).toHaveLength(9);
    } finally {
      await service.runtime.stopAll();
      database.close();
    }
  });

  it("executes discussion turns sequentially with real workers", { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-channel-live-discussion-"));
    temporaryPaths.push(root);
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    const ava = createCoworker(database, root, "Ava");
    const sarah = createCoworker(database, root, "Sarah");
    const channel = database.createConversation({
      kind: "group",
      memberIds: [ava.id, sarah.id],
      title: "Live discussion",
    });
    const service = new DesktopAppService({
      dataPath: root,
      database,
      credentials: credentials(),
      workerFactory: () =>
        new Worker(resolve(process.cwd(), "out/main/runtime/coworker-worker.js")),
    });

    try {
      const receipt = await service.sendConversationMessage({
        conversationId: channel.id,
        clientMessageId: "live-discussion",
        content: "Discuss our marketing plan together.",
        mentionedCoworkerIds: [],
      });
      await waitFor(
        () =>
          database
            .listTasksBySourceMessage("live-discussion")
            .filter((task) => task.status === "COMPLETED").length >= 3,
        "three completed discussion turns",
      );
      await service.stopDiscussion(receipt.discussion!.id);

      const turns = database
        .listTasksBySourceMessage("live-discussion")
        .filter((task) => task.status === "COMPLETED")
        .sort(
          (left, right) => (left.discussionTurn ?? 0) - (right.discussionTurn ?? 0),
        );
      expect(turns.length).toBeGreaterThanOrEqual(3);
      for (const [index, task] of turns.entries()) {
        expect(task.discussionTurn).toBe(index);
        if (index > 0) {
          expect(task.coworkerId).not.toBe(turns[index - 1]!.coworkerId);
        }
      }
      const authors = database
        .listConversationMessages(channel.id)
        .filter((message) => message.role === "assistant")
        .map((message) => message.authorName);
      expect(new Set(authors)).toEqual(new Set(["Ava", "Sarah"]));
    } finally {
      await service.runtime.stopAll();
      database.close();
    }
  });

  it("concludes a discussion when every participant passes in a row", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-channel-consensus-"));
    temporaryPaths.push(root);
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    const ava = createCoworker(database, root, "Ava");
    const sarah = createCoworker(database, root, "Sarah");
    const channel = database.createConversation({
      kind: "group",
      memberIds: [ava.id, sarah.id],
    });
    const service = new DesktopAppService({
      dataPath: root,
      database,
      credentials: credentials(),
    });
    vi.spyOn(service.runtime, "enqueueTask").mockImplementation(() => undefined);

    try {
      const receipt = await service.sendConversationMessage({
        conversationId: channel.id,
        clientMessageId: "consensus-discussion",
        content: "@Ava @Sarah anything left before launch?",
        mentionedCoworkerIds: [ava.id, sarah.id],
      });
      const discussionId = receipt.discussion!.id;
      const firstTurn = receipt.runs[0]!.taskId;

      database.setTaskStatus(firstTurn, "COMPLETED", { result: "PASS" });
      await service.advanceDiscussion(database.getTask(firstTurn));

      const secondTurn = database
        .listTasksBySourceMessage("consensus-discussion")
        .find((task) => task.discussionTurn === 1);
      expect(secondTurn).toMatchObject({ coworkerId: sarah.id });

      database.setTaskStatus(secondTurn!.id, "COMPLETED", { result: "pass." });
      await service.advanceDiscussion(database.getTask(secondTurn!.id));

      expect(database.getDiscussion(discussionId).status).toBe("completed");
      expect(database.listTasksBySourceMessage("consensus-discussion")).toHaveLength(2);
    } finally {
      await service.runtime.stopAll();
      database.close();
    }
  });

  it("stops a discussion without dispatching another coworker", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-channel-stop-discussion-"));
    temporaryPaths.push(root);
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    const ava = createCoworker(database, root, "Ava");
    const sarah = createCoworker(database, root, "Sarah");
    const channel = database.createConversation({
      kind: "group",
      memberIds: [ava.id, sarah.id],
    });
    const service = new DesktopAppService({
      dataPath: root,
      database,
      credentials: credentials(),
    });
    vi.spyOn(service.runtime, "enqueueTask").mockImplementation(() => undefined);

    try {
      const receipt = await service.sendConversationMessage({
        conversationId: channel.id,
        clientMessageId: "stopped-discussion",
        content: "Discuss this together.",
        mentionedCoworkerIds: [],
      });
      expect([...receipt.discussion!.participantIds].sort()).toEqual(
        [ava.id, sarah.id].sort(),
      );
      const stopped = await service.stopDiscussion(receipt.discussion!.id);
      expect(stopped.status).toBe("cancelled");
      expect(database.getTask(receipt.runs[0]!.taskId).status).toBe("CANCELLED");
      expect(database.listTasksBySourceMessage("stopped-discussion")).toHaveLength(1);
    } finally {
      await service.runtime.stopAll();
      database.close();
    }
  });
});
