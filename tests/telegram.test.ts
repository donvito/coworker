import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventType } from "@ag-ui/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAppService } from "@main/app/app-service";
import { CoworkerDatabase } from "@main/db/database";
import { modelSupportsImageInput } from "@main/integrations/model-catalog";
import { telegramCredentialKey } from "@main/integrations/telegram";
import type { DesktopEvent } from "@shared/contracts";

const temporaryPaths: string[] = [];
const services: DesktopAppService[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const service of services.splice(0)) {
    await service.telegram.stop();
  }
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function credentialStore() {
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

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

interface FakeMessageInput {
  chatId: number;
  text?: string;
  caption?: string;
  threadId?: number;
  updateId?: number;
  chatType?: string;
  photo?: Array<{ file_id: string; file_size: number }>;
  document?: { file_id: string; file_name?: string; file_size?: number };
  forumTopicCreated?: { name: string };
}

/** In-memory Bot API double; the bridge talks to it through fetchImpl. */
function fakeTelegram(options: { threadsEnabled?: boolean } = {}) {
  const updates: Array<Record<string, unknown>> = [];
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const files = new Map<string, Uint8Array>();
  let updateSeq = 1;
  let topicSeq = 100;
  let messageSeq = 1;

  const respond = (result: unknown) =>
    new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const download = url.match(/\/file\/bot[^/]+\/(.+)$/);
    if (download) {
      const bytes = files.get(download[1]!) ?? new Uint8Array();
      return new Response(bytes.slice() as unknown as BodyInit, { status: 200 });
    }
    const method = url.match(/\/bot[^/]+\/(\w+)$/)?.[1] ?? "";
    let body: Record<string, unknown> = {};
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } else if (init?.body instanceof FormData) {
      body = Object.fromEntries(init.body.entries());
    }
    switch (method) {
      case "getMe":
        return respond({
          id: 42,
          is_bot: true,
          first_name: "Coworker Test",
          username: "coworker_test_bot",
          has_topics_enabled: options.threadsEnabled === true,
        });
      case "getUpdates": {
        const offset = typeof body.offset === "number" ? body.offset : 0;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if (updates.some((update) => (update.update_id as number) >= offset)) break;
          await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        }
        return respond(updates.filter((update) => (update.update_id as number) >= offset));
      }
      case "sendMessage": {
        calls.push({ method, body });
        return respond({
          message_id: (messageSeq += 1),
          chat: { id: Number(body.chat_id), type: "private" },
          date: 0,
        });
      }
      case "sendChatAction": {
        calls.push({ method, body });
        return respond(true);
      }
      case "sendMessageDraft": {
        calls.push({ method, body });
        return respond(true);
      }
      case "sendPhoto":
      case "sendDocument": {
        calls.push({ method, body });
        return respond({
          message_id: (messageSeq += 1),
          chat: { id: Number(body.chat_id), type: "private" },
          date: 0,
        });
      }
      case "createForumTopic": {
        calls.push({ method, body });
        topicSeq += 1;
        return respond({ message_thread_id: topicSeq, name: body.name });
      }
      case "editMessageText":
      case "answerCallbackQuery": {
        calls.push({ method, body });
        return respond(true);
      }
      case "getFile": {
        const fileId = String(body.file_id);
        return respond({
          file_id: fileId,
          file_unique_id: `u-${fileId}`,
          file_path: `files/${fileId}`,
          file_size: files.get(`files/${fileId}`)?.byteLength,
        });
      }
      default:
        return respond(true);
    }
  }) as typeof fetch;

  return {
    fetchImpl,
    calls,
    registerFile(fileId: string, bytes: Uint8Array) {
      files.set(`files/${fileId}`, bytes);
    },
    sent(method: string) {
      return calls.filter((call) => call.method === method).map((call) => call.body);
    },
    push(input: FakeMessageInput): number {
      const updateId = input.updateId ?? (updateSeq += 1);
      updates.push({
        update_id: updateId,
        message: {
          message_id: (messageSeq += 1),
          message_thread_id: input.threadId,
          is_topic_message: input.threadId !== undefined ? true : undefined,
          from: { id: input.chatId, is_bot: false, first_name: "Melvin" },
          chat: { id: input.chatId, type: input.chatType ?? "private" },
          date: Math.floor(Date.now() / 1000),
          text: input.text,
          caption: input.caption,
          photo: input.photo,
          document: input.document,
          forum_topic_created: input.forumTopicCreated,
        },
      });
      return updateId;
    },
    pushCallback(input: { chatId: number; data: string; messageId?: number }): number {
      const updateId = (updateSeq += 1);
      updates.push({
        update_id: updateId,
        callback_query: {
          id: `cb-${updateId}`,
          from: { id: input.chatId, is_bot: false, first_name: "Melvin" },
          message: {
            message_id: input.messageId ?? 1,
            chat: { id: input.chatId, type: "private" },
            date: Math.floor(Date.now() / 1000),
          },
          data: input.data,
        },
      });
      return updateId;
    },
    pushStoppedGeneration(input: { chatId: number; draftId: number; threadId?: number }): number {
      const updateId = (updateSeq += 1);
      updates.push({
        update_id: updateId,
        stopped_message_generation: {
          chat: { id: input.chatId, type: "private" },
          message_thread_id: input.threadId,
          draft_id: input.draftId,
        },
      });
      return updateId;
    },
  };
}

async function setup(options: { threadsEnabled?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "coworker-telegram-"));
  temporaryPaths.push(root);
  const database = new CoworkerDatabase(join(root, "coworker.db"));
  const ava = database.createCoworker(
    {
      name: "Ava",
      role: "Accounting",
      systemPrompt: "You are Ava.",
      modelProvider: "demo",
      modelName: "faux-1",
      enabledTools: ["files.write"],
    },
    join(root, "ava"),
  );
  const fake = fakeTelegram(options);
  const credentials = credentialStore();
  const service = new DesktopAppService({
    dataPath: root,
    database,
    credentials,
    telegram: { fetchImpl: fake.fetchImpl, pollTimeoutSeconds: 0 },
  });
  services.push(service);
  const enqueue = vi.spyOn(service.runtime, "enqueueTask").mockImplementation(() => undefined);
  const emit = (event: DesktopEvent) =>
    (service as unknown as { emit(event: DesktopEvent): void }).emit(event);
  return { root, database, ava, fake, credentials, service, enqueue, emit };
}

async function connectAndPair(context: Awaited<ReturnType<typeof setup>>) {
  const status = await context.service.configureTelegram({
    botToken: "12345:test-token-abcdefghijklmnop",
    coworkerId: context.ava.id,
  });
  const code = status.pairingLink!.split("start=")[1]!;
  context.fake.push({ chatId: 777, text: `/start ${code}` });
  await waitFor(
    () => context.service.telegramStatus().pairingLink === null,
    "the chat to pair",
  );
  return status;
}

describe("telegram bridge", () => {
  it("connects, refuses wrong codes, and pairs the chat with the right code", async () => {
    const context = await setup();
    const status = await context.service.configureTelegram({
      botToken: "12345:test-token-abcdefghijklmnop",
      coworkerId: context.ava.id,
    });
    expect(status.integration?.status).toBe("connected");
    expect(status.integration?.name).toBe("@coworker_test_bot");
    expect(status.pairingLink).toContain("https://t.me/coworker_test_bot?start=");
    expect(context.database.getCoworker(context.ava.id).enabledTools).toContain(
      "telegram.send",
    );

    context.fake.push({ chatId: 500, text: "/start wrong-code" });
    await waitFor(
      () =>
        context.fake
          .sent("sendMessage")
          .some((body) => String(body.text).includes("This bot is private")),
      "the refusal reply",
    );
    expect(context.service.telegramStatus().pairingLink).not.toBeNull();

    const code = status.pairingLink!.split("start=")[1]!;
    context.fake.push({ chatId: 777, text: `/start ${code}` });
    await waitFor(
      () =>
        context.fake
          .sent("sendMessage")
          .some((body) => String(body.text).startsWith("Connected!")),
      "the pairing confirmation",
    );
    expect(context.service.telegramStatus().pairingLink).toBeNull();
  });

  it("pairs when the raw pairing code is sent as a plain message", async () => {
    // Telegram clients sometimes drop the deep link payload for a chat that
    // already exists, so pasting the code must work too.
    const context = await setup();
    const status = await context.service.configureTelegram({
      botToken: "12345:test-token-abcdefghijklmnop",
      coworkerId: context.ava.id,
    });
    const code = status.pairingLink!.split("start=")[1]!;
    context.fake.push({ chatId: 888, text: ` ${code} ` });
    await waitFor(
      () =>
        context.fake
          .sent("sendMessage")
          .some((body) => String(body.text).startsWith("Connected!")),
      "the pairing confirmation",
    );
    expect(context.service.telegramStatus().pairingLink).toBeNull();
    const config = context.service.telegramStatus().integration?.config as {
      chatId?: number;
    };
    expect(config.chatId).toBe(888);
  });

  it("moves the bot to another coworker, keeping the paired chat and handing off loudly", async () => {
    const context = await setup();
    await connectAndPair(context);
    const sarah = context.database.createCoworker(
      {
        name: "Sarah",
        role: "Research",
        systemPrompt: "You are Sarah.",
        modelProvider: "demo",
        modelName: "faux-1",
        enabledTools: [],
      },
      join(context.root, "sarah"),
    );

    // Re-configuring the stored bot for Sarah keeps the paired chat.
    const status = await context.service.configureTelegram({ coworkerId: sarah.id });
    const config = status.integration?.config as {
      coworkerId?: string;
      chatId?: number | null;
      pairingCode?: string;
    };
    expect(config.coworkerId).toBe(sarah.id);
    expect(config.chatId).toBe(777);
    expect(status.pairingLink).toBeNull();

    // The telegram.send tool follows the link.
    expect(context.database.getCoworker(sarah.id).enabledTools).toContain("telegram.send");
    expect(context.database.getCoworker(context.ava.id).enabledTools).not.toContain(
      "telegram.send",
    );

    // The chat is told about the hand-off.
    await waitFor(
      () =>
        context.fake
          .sent("sendMessage")
          .some((body) => String(body.text).includes("This chat now goes to Sarah")),
      "the relink notice",
    );

    // Pasting the pairing code in the already-paired chat confirms the link
    // instead of forwarding the code to Sarah as a message.
    context.fake.push({ chatId: 777, text: config.pairingCode! });
    await waitFor(
      () =>
        context.fake
          .sent("sendMessage")
          .some((body) => String(body.text).includes("already connected")),
      "the already-connected reply",
    );
    expect(context.enqueue).not.toHaveBeenCalled();
  });

  it("injects inbound text idempotently and queues the coworker", async () => {
    const context = await setup();
    await connectAndPair(context);
    context.enqueue.mockClear();

    const updateId = context.fake.push({ chatId: 777, text: "Hello from my phone" });
    // A Telegram redelivery of the same update must not double-inject.
    context.fake.push({ chatId: 777, text: "Hello from my phone", updateId });

    const conversationId = `coworker:${context.ava.id}`;
    await waitFor(
      () =>
        context.database
          .listConversationMessages(conversationId)
          .some((message) => message.content === "Hello from my phone"),
      "the inbound message to appear",
    );
    // Let the duplicate delivery drain before asserting.
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    const matching = context.database
      .listConversationMessages(conversationId)
      .filter((message) => message.content === "Hello from my phone");
    expect(matching).toHaveLength(1);
    expect(matching[0]!.id).toBe(`telegram:${updateId}`);
    expect(matching[0]!.role).toBe("user");
    expect(context.enqueue).toHaveBeenCalledTimes(1);
  });

  it("mirrors coworker replies to Telegram as HTML and desktop messages without echo", async () => {
    const context = await setup();
    await connectAndPair(context);
    const conversationId = `coworker:${context.ava.id}`;

    // A message typed in the desktop UI forwards with the desktop label.
    await context.service.sendConversationMessage({
      conversationId,
      clientMessageId: "desk-1",
      content: "typed on desktop",
      mentionedCoworkerIds: [],
    });
    await waitFor(
      () =>
        context.fake
          .sent("sendMessage")
          .some((body) => body.text === "You (desktop): typed on desktop"),
      "the desktop message mirror",
    );

    // A message arriving from Telegram must not be echoed back.
    context.fake.push({ chatId: 777, text: "from phone, do not echo" });
    await waitFor(
      () =>
        context.database
          .listConversationMessages(conversationId)
          .some((message) => message.content === "from phone, do not echo"),
      "the inbound message",
    );

    // Stream an assistant reply; it must arrive converted to Telegram HTML.
    const base = { coworkerId: context.ava.id, conversationId, runId: "run-1", taskId: "t-1" };
    context.emit({
      type: "agent.event",
      ...base,
      event: { type: EventType.TEXT_MESSAGE_START, messageId: "m1" } as never,
    });
    context.emit({
      type: "agent.event",
      ...base,
      event: {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "**Done!** See `report.txt`",
      } as never,
    });
    await waitFor(
      () =>
        context.fake
          .sent("sendMessageDraft")
          .some(
            (body) =>
              body.text === "**Done!** See `report.txt`" &&
              body.can_stop === true &&
              body.keep_on_stop === true,
          ),
      "the streamed Telegram draft",
    );
    context.emit({
      type: "agent.event",
      ...base,
      event: { type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as never,
    });
    await waitFor(
      () =>
        context.fake
          .sent("sendMessage")
          .some(
            (body) =>
              body.text === "<b>Done!</b> See <code>report.txt</code>" &&
              body.parse_mode === "HTML",
          ),
      "the assistant reply mirror",
    );
    // The outbound queue is serialized, so any echo would have landed by now.
    expect(
      context.fake
        .sent("sendMessage")
        .filter((body) => String(body.text).includes("do not echo")),
    ).toHaveLength(0);
    expect(context.fake.sent("sendMessageDraft")[0]?.text).toBe("");
  });

  it("cancels a run from Telegram Stop and finalizes its partial response once", async () => {
    const context = await setup();
    await connectAndPair(context);
    const conversationId = `coworker:${context.ava.id}`;
    const cancel = vi
      .spyOn(context.service, "cancelTask")
      .mockResolvedValue({} as Awaited<ReturnType<DesktopAppService["cancelTask"]>>);
    const base = {
      coworkerId: context.ava.id,
      conversationId,
      runId: "run-stop",
      taskId: "task-stop",
    };
    context.emit({
      type: "agent.event",
      ...base,
      event: { type: EventType.RUN_STARTED } as never,
    });
    context.emit({
      type: "agent.event",
      ...base,
      event: {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "stop-message",
        delta: "Partial **answer**",
      } as never,
    });
    await waitFor(
      () =>
        context.fake
          .sent("sendMessageDraft")
          .some((body) => body.text === "Partial **answer**"),
      "the partial draft",
    );
    const draft = context.fake
      .sent("sendMessageDraft")
      .find((body) => body.text === "Partial **answer**")!;
    context.fake.pushStoppedGeneration({
      chatId: 777,
      draftId: Number(draft.draft_id),
    });
    await waitFor(() => cancel.mock.calls.length === 1, "the Telegram stop cancellation");
    expect(cancel).toHaveBeenCalledWith("task-stop");

    context.emit({
      type: "agent.event",
      ...base,
      event: { type: EventType.TEXT_MESSAGE_END, messageId: "stop-message" } as never,
    });
    context.emit({
      type: "agent.event",
      ...base,
      event: {
        type: EventType.RUN_ERROR,
        message: "Stopped",
        code: "RUN_ABORTED",
      } as never,
    });
    await waitFor(
      () =>
        context.fake
          .sent("sendMessage")
          .some((body) => body.text === "Partial <b>answer</b>"),
      "the finalized partial response",
    );
    expect(
      context.fake
        .sent("sendMessage")
        .filter((body) => String(body.text).includes("Partial")),
    ).toHaveLength(1);
    expect(
      context.fake
        .sent("sendMessage")
        .some((body) => String(body.text).includes("hit an error")),
    ).toBe(false);
  });

  it("imports inbound photos as conversation images for vision models", async () => {
    const context = await setup();
    await connectAndPair(context);
    // The static catalog needs no network or credentials for built-in providers.
    const visionModel = [
      "claude-sonnet-4-5",
      "claude-opus-4-5",
      "claude-haiku-4-5",
      "claude-3-7-sonnet",
    ].find((id) => modelSupportsImageInput("anthropic", id));
    expect(visionModel).toBeDefined();
    context.database.updateCoworker(context.ava.id, {
      modelProvider: "anthropic",
      modelName: visionModel!,
    });

    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(64).fill(0)]);
    context.fake.registerFile("photo-1", jpeg);
    context.fake.push({
      chatId: 777,
      caption: "look at this",
      photo: [{ file_id: "photo-1", file_size: jpeg.byteLength }],
    });
    await waitFor(
      () => context.database.listImageAttachments(context.ava.id).length === 1,
      "the photo attachment",
    );
    const attachment = context.database.listImageAttachments(context.ava.id)[0]!;
    expect(attachment.mimeType).toBe("image/jpeg");
    expect(attachment.size).toBe(jpeg.byteLength);
    const message = context.database
      .listConversationMessages(`coworker:${context.ava.id}`)
      .find((entry) => entry.content === "look at this");
    expect(message).toBeDefined();
  });

  it("degrades photos to caption-only text when the model can't view images", async () => {
    const context = await setup();
    await connectAndPair(context);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(16).fill(0)]);
    context.fake.registerFile("photo-2", jpeg);
    context.fake.push({
      chatId: 777,
      caption: "caption survives",
      photo: [{ file_id: "photo-2", file_size: jpeg.byteLength }],
    });
    const conversationId = `coworker:${context.ava.id}`;
    await waitFor(
      () =>
        context.database
          .listConversationMessages(conversationId)
          .some((message) => message.content === "caption survives"),
      "the caption to arrive without the image",
    );
    expect(context.database.listImageAttachments(context.ava.id)).toHaveLength(0);
    expect(
      context.fake
        .sent("sendMessage")
        .some((body) => String(body.text).includes("can't view photos")),
    ).toBe(true);
  });

  it("saves inbound documents into the workspace telegram-inbox", async () => {
    const context = await setup();
    await connectAndPair(context);
    context.fake.registerFile("doc-1", new TextEncoder().encode("hello document"));
    context.fake.push({
      chatId: 777,
      document: { file_id: "doc-1", file_name: "notes.txt", file_size: 14 },
    });
    const conversationId = `coworker:${context.ava.id}`;
    await waitFor(
      () =>
        context.database
          .listConversationMessages(conversationId)
          .some((message) => message.content.includes("telegram-inbox/")),
      "the document note",
    );
    const inbox = join(context.root, "ava", "telegram-inbox");
    const entries = await readdir(inbox);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("notes.txt");
    expect(await readFile(join(inbox, entries[0]!), "utf8")).toBe("hello document");
  });

  it("maps Telegram topics to their own conversations and threads replies back", async () => {
    const context = await setup({ threadsEnabled: true });
    await connectAndPair(context);
    const mainConversation = `coworker:${context.ava.id}`;
    const inboundEvents: Array<{ conversationId: string }> = [];
    context.service.subscribe((event) => {
      if (event.type === "conversation.inbound") inboundEvents.push(event);
    });

    // Two Telegram topics: each becomes its own desktop conversation, the
    // first titled from its forum_topic_created name.
    context.fake.push({
      chatId: 777,
      threadId: 42,
      forumTopicCreated: { name: "research businesses" },
    });
    const firstUpdate = context.fake.push({
      chatId: 777,
      text: "topic question",
      threadId: 42,
    });
    context.fake.push({ chatId: 777, text: "second topic message", threadId: 43 });
    await waitFor(() => {
      const conversations = context.database.listConversations(context.ava.id);
      return (
        conversations.some((conversation) =>
          context.database
            .listConversationMessages(conversation.id)
            .some((message) => message.content === "topic question"),
        ) &&
        conversations.some((conversation) =>
          context.database
            .listConversationMessages(conversation.id)
            .some((message) => message.content === "second topic message"),
        )
      );
    }, "both topics to map to conversations");
    const conversations = context.database.listConversations(context.ava.id);
    const researchConversation = conversations.find((conversation) =>
      context.database
        .listConversationMessages(conversation.id)
        .some((message) => message.content === "topic question"),
    )!;
    const secondConversation = conversations.find((conversation) =>
      context.database
        .listConversationMessages(conversation.id)
        .some((message) => message.content === "second topic message"),
    )!;
    expect(researchConversation.id).not.toBe(mainConversation);
    expect(researchConversation.title).toBe("research businesses");
    expect(secondConversation.id).not.toBe(researchConversation.id);
    expect(secondConversation.title).toBe("second topic message");
    // The desktop is told where each message landed so it can follow.
    expect(
      inboundEvents.some((event) => event.conversationId === researchConversation.id),
    ).toBe(true);

    // A follow-up in the same topic reuses the mapping.
    context.fake.push({ chatId: 777, text: "follow-up", threadId: 42 });
    await waitFor(
      () =>
        context.database
          .listConversationMessages(researchConversation.id)
          .some((message) => message.content === "follow-up"),
      "the follow-up in the mapped conversation",
    );

    // The coworker's reply routes back into topic 42.
    const task = context.database.listTasksBySourceMessage(`telegram:${firstUpdate}`)[0]!;
    const base = {
      coworkerId: context.ava.id,
      conversationId: researchConversation.id,
      runId: task.runId,
      taskId: task.id,
    };
    context.emit({
      type: "agent.event",
      ...base,
      event: { type: EventType.TEXT_MESSAGE_START, messageId: "m2" } as never,
    });
    context.emit({
      type: "agent.event",
      ...base,
      event: {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m2",
        delta: "answered in thread",
      } as never,
    });
    context.emit({
      type: "agent.event",
      ...base,
      event: { type: EventType.TEXT_MESSAGE_END, messageId: "m2" } as never,
    });
    await waitFor(
      () =>
        context.fake
          .sent("sendMessage")
          .some(
            (body) => body.text === "answered in thread" && body.message_thread_id === 42,
          ),
      "the threaded reply",
    );

    // Outbound: a new desktop conversation still gets its own Telegram topic
    // with a strict two-way mapping.
    const fresh = context.service.createConversation({
      coworkerId: context.ava.id,
      title: "Quarterly plan",
    });
    await context.service.sendConversationMessage({
      conversationId: fresh.id,
      clientMessageId: "desk-2",
      content: "plan the quarter",
      mentionedCoworkerIds: [],
    });
    await waitFor(
      () => context.fake.sent("createForumTopic").length === 1,
      "the created forum topic",
    );
    expect(context.fake.sent("createForumTopic")[0]!.name).toBe("Quarterly plan");
    await waitFor(
      () =>
        context.fake
          .sent("sendMessage")
          .some(
            (body) =>
              body.text === "You (desktop): plan the quarter" &&
              typeof body.message_thread_id === "number" &&
              body.message_thread_id > 100,
          ),
      "the mirrored message in the new topic",
    );
    const bridgeTopic = context.fake.sent("createForumTopic").length;
    expect(bridgeTopic).toBe(1);
    // A Telegram reply inside the bridge-created topic routes to that
    // conversation, not the main one.
    const mappedThreadId = 101; // First topic id the fake hands out.
    context.fake.push({ chatId: 777, text: "inside mapped topic", threadId: mappedThreadId });
    await waitFor(
      () =>
        context.database
          .listConversationMessages(fresh.id)
          .some((message) => message.content === "inside mapped topic"),
      "the reply inside the mapped conversation",
    );

    // Untopiced traffic still lands in the main conversation.
    context.fake.push({ chatId: 777, text: "plain message" });
    await waitFor(
      () =>
        context.database
          .listConversationMessages(mainConversation)
          .some((message) => message.content === "plain message"),
      "the main-conversation message",
    );
  });

  it("delivers telegram.send files into the thread the user wrote from", async () => {
    const context = await setup({ threadsEnabled: true });
    await connectAndPair(context);

    // The request arrives from a Telegram topic; Threaded Mode chats swallow
    // messages sent without a thread id, so delivery must target it.
    context.fake.push({ chatId: 777, text: "send me the file", threadId: 55 });
    await waitFor(
      () =>
        context.database
          .listConversations(context.ava.id)
          .some((conversation) =>
            context.database
              .listConversationMessages(conversation.id)
              .some((message) => message.content === "send me the file"),
          ),
      "the threaded request to arrive",
    );
    const conversationId = context.database
      .listConversations(context.ava.id)
      .find((conversation) =>
        context.database
          .listConversationMessages(conversation.id)
          .some((message) => message.content === "send me the file"),
      )!.id;

    const coworkerBefore = context.database.getCoworker(context.ava.id);
    context.database.updateCoworker(context.ava.id, {
      policies: { ...coworkerBefore.policies, "telegram.send": "automatic" },
    });
    await mkdir(join(context.root, "ava"), { recursive: true });
    await writeFile(join(context.root, "ava", "bp_reading.csv"), "sys,dia\n120,80");
    const task = context.database.createTask({
      coworkerId: context.ava.id,
      title: "Send the reading",
      input: "send it",
      threadId: conversationId,
    });
    const result = await context.service.tools.request({
      task,
      coworker: context.database.getCoworker(context.ava.id),
      toolCallId: "call-thread",
      toolName: "telegram.send",
      arguments: { message: "Here is the CSV", attachments: ["bp_reading.csv"] },
    });
    expect(result.kind).toBe("completed");
    const sentText = context.fake
      .sent("sendMessage")
      .find((body) => body.text === "Here is the CSV")!;
    expect(sentText.message_thread_id).toBe(55);
    const sentFile = context.fake.sent("sendDocument")[0]!;
    expect(String(sentFile.message_thread_id)).toBe("55");
    expect((sentFile.document as File).name).toBe("bp_reading.csv");
  });

  it("delivers telegram.send messages and workspace files through the gateway", async () => {
    const context = await setup();
    await connectAndPair(context);
    const coworkerBefore = context.database.getCoworker(context.ava.id);
    context.database.updateCoworker(context.ava.id, {
      policies: { ...coworkerBefore.policies, "telegram.send": "automatic" },
    });
    await mkdir(join(context.root, "ava"), { recursive: true });
    await writeFile(join(context.root, "ava", "report.txt"), "quarterly numbers");
    const task = context.database.createTask({
      coworkerId: context.ava.id,
      title: "Send the report",
      input: "send it",
      threadId: `coworker:${context.ava.id}`,
    });

    const result = await context.service.tools.request({
      task,
      coworker: context.database.getCoworker(context.ava.id),
      toolCallId: "call-1",
      toolName: "telegram.send",
      arguments: { message: "Here is the **report**", attachments: ["report.txt"] },
    });
    expect(result.kind).toBe("completed");
    expect(
      context.fake
        .sent("sendMessage")
        .some((body) => body.text === "Here is the <b>report</b>"),
    ).toBe(true);
    const document = context.fake.sent("sendDocument")[0]!;
    expect((document.document as File).name).toBe("report.txt");
  });

  it("keeps telegram.send approval-gated by default and errors when disconnected", async () => {
    const context = await setup();
    await connectAndPair(context);
    const task = context.database.createTask({
      coworkerId: context.ava.id,
      title: "Ping me",
      input: "ping",
      threadId: `coworker:${context.ava.id}`,
    });

    const gated = await context.service.tools.request({
      task,
      coworker: context.database.getCoworker(context.ava.id),
      toolCallId: "call-2",
      toolName: "telegram.send",
      arguments: { message: "needs approval" },
    });
    expect(gated.kind).toBe("approval");
    if (gated.kind === "approval") {
      expect(gated.approval.summary).toContain("Send Telegram message");
    }

    await context.service.disconnectTelegram();
    expect(await context.credentials.has(telegramCredentialKey)).toBe(false);
    const coworker = context.database.getCoworker(context.ava.id);
    context.database.updateCoworker(context.ava.id, {
      policies: { ...coworker.policies, "telegram.send": "automatic" },
    });
    await expect(
      context.service.tools.request({
        task,
        coworker: context.database.getCoworker(context.ava.id),
        toolCallId: "call-3",
        toolName: "telegram.send",
        arguments: { message: "should fail" },
      }),
    ).rejects.toThrow(/not connected/i);
  });

  it("announces pending approvals in Telegram and applies button decisions", async () => {
    const context = await setup();
    await connectAndPair(context);
    const task = context.database.createTask({
      coworkerId: context.ava.id,
      title: "Send the file",
      input: "send it to me",
      threadId: `coworker:${context.ava.id}`,
    });
    const result = await context.service.tools.request({
      task,
      coworker: context.database.getCoworker(context.ava.id),
      toolCallId: "call-apr",
      toolName: "telegram.send",
      arguments: { message: "the invoice" },
    });
    expect(result.kind).toBe("approval");
    if (result.kind !== "approval") return;
    // In production the runtime emits this after creating the approval.
    context.emit({ type: "entity.changed", entity: "approvals", id: result.approval.id });

    await waitFor(
      () =>
        context.fake
          .sent("sendMessage")
          .some(
            (body) =>
              String(body.text).includes("needs your approval") &&
              Boolean(body.reply_markup),
          ),
      "the approval notice with buttons",
    );
    const notice = context.fake
      .sent("sendMessage")
      .find((body) => String(body.text).includes("needs your approval"))!;
    const keyboard = (
      notice.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }
    ).inline_keyboard;
    expect(keyboard[0]![0]!.callback_data).toBe(`apr:${result.approval.id}:approve`);

    context.enqueue.mockClear();
    context.fake.pushCallback({
      chatId: 777,
      data: `apr:${result.approval.id}:approve`,
      messageId: 5,
    });
    await waitFor(
      () =>
        context.fake
          .sent("answerCallbackQuery")
          .some((body) => body.text === "Approved"),
      "the callback acknowledgement",
    );
    expect(context.database.getApproval(result.approval.id).status).toBe("APPROVED");
    // Deciding re-queues the blocked task so the run resumes.
    expect(context.enqueue).toHaveBeenCalledWith(context.ava.id);
    await waitFor(
      () =>
        context.fake
          .sent("editMessageText")
          .some((body) => String(body.text).includes("Approved.")),
      "the notice edit",
    );
  });

  it("supports Always allow, ignores foreign chats, and retires desktop-decided notices", async () => {
    const context = await setup();
    await connectAndPair(context);
    const makeApproval = async (toolCallId: string) => {
      const task = context.database.createTask({
        coworkerId: context.ava.id,
        title: "Send",
        input: "send",
        threadId: `coworker:${context.ava.id}`,
      });
      const result = await context.service.tools.request({
        task,
        coworker: context.database.getCoworker(context.ava.id),
        toolCallId,
        toolName: "telegram.send",
        arguments: { message: `notify ${toolCallId}` },
      });
      if (result.kind !== "approval") throw new Error("expected an approval");
      context.emit({ type: "entity.changed", entity: "approvals", id: result.approval.id });
      return result.approval;
    };

    const first = await makeApproval("call-1");
    // A callback from an unpaired chat cannot decide anything.
    context.fake.pushCallback({ chatId: 999, data: `apr:${first.id}:approve`, messageId: 2 });
    await waitFor(
      () =>
        context.fake
          .sent("answerCallbackQuery")
          .some((body) => String(body.text).includes("isn't paired")),
      "the foreign-chat refusal",
    );
    expect(context.database.getApproval(first.id).status).toBe("PENDING");

    // Always allow approves and flips the tool policy to automatic.
    context.fake.pushCallback({ chatId: 777, data: `apr:${first.id}:always`, messageId: 2 });
    await waitFor(
      () => context.database.getApproval(first.id).status === "APPROVED",
      "the always-allow approval",
    );
    expect(context.database.getCoworker(context.ava.id).policies["telegram.send"]).toBe(
      "automatic",
    );

    // An approval decided on the desktop retires its Telegram notice.
    context.database.updateCoworker(context.ava.id, {
      policies: {
        ...context.database.getCoworker(context.ava.id).policies,
        "telegram.send": "approval",
      },
    });
    const second = await makeApproval("call-2");
    await waitFor(
      () =>
        context.fake
          .sent("sendMessage")
          .filter((body) => String(body.text).includes("needs your approval")).length >= 2,
      "the second approval notice",
    );
    context.service.decideApproval({ approvalId: second.id, decision: "reject" });
    await waitFor(
      () =>
        context.fake
          .sent("editMessageText")
          .some((body) => String(body.text).includes("handled in the desktop app")),
      "the retired notice",
    );
  });

  it("unpairs with a fresh pairing code and reports status", async () => {
    const context = await setup();
    const before = await connectAndPair(context);
    const unpaired = await context.service.unpairTelegram();
    expect(unpaired.pairingLink).not.toBeNull();
    expect(unpaired.pairingLink).not.toBe(before.pairingLink);
    const config = unpaired.integration?.config as { chatId?: number | null };
    expect(config.chatId ?? null).toBeNull();
  });
});
