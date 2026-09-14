import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventType } from "@ag-ui/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAppService } from "@main/app/app-service";
import { CoworkerDatabase } from "@main/db/database";
import { bundledDiscordMessagingSkill } from "@main/integrations/skills";
import { modelSupportsImageInput } from "@main/integrations/model-catalog";
import {
  discordCredentialKey,
  discordInvitePermissions,
  discordThreadTitleFromText,
  messageMentionsDiscordBot,
  parseDiscordConfig,
  stripDiscordBotMentions,
} from "@main/integrations/discord";
import type { DesktopEvent } from "@shared/contracts";

const testToken = "TESTTESTTESTTESTTEST.TEST1.TESTTESTTESTTESTTESTTEST";
const botUserId = "99";

function mention(text: string): string {
  return `<@${botUserId}> ${text}`;
}

function mappedThreads(database: CoworkerDatabase) {
  return parseDiscordConfig(database.getDiscordIntegration()!).threads;
}
const temporaryPaths: string[] = [];
const services: DesktopAppService[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const service of services.splice(0)) {
    await service.discord.stop();
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

type Listener = (event: Event) => void;

/** In-memory REST + Gateway double. The bridge talks to it through fetch and WebSocket. */
function fakeDiscord(
  options: {
    intentEnabled?: boolean;
    heartbeatInterval?: number;
    ackHeartbeats?: boolean;
    reactionStatus?: number;
    message429Remaining?: number;
    threadFromMessageStatus?: number;
  } = {},
) {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const files = new Map<string, Uint8Array>();
  const channels = new Map<string, Record<string, unknown>>([
    [
      "100",
      { id: "100", type: 0, guild_id: "10", name: "general", parent_id: null },
    ],
    [
      "200",
      { id: "200", type: 11, guild_id: "10", name: "research", parent_id: "100" },
    ],
    [
      "300",
      { id: "300", type: 15, guild_id: "10", name: "forum", parent_id: null },
    ],
    [
      "301",
      { id: "301", type: 11, guild_id: "10", name: "first post", parent_id: "300" },
    ],
  ]);
  let messageSeq = 1;
  let threadSeq = 400;
  let sequence = 1;
  const sockets: FakeWebSocket[] = [];

  class FakeWebSocket {
    readyState = 0;
    readonly url: string;
    lastCloseCode: number | null = null;
    readonly sentOps: number[] = [];
    private readonly listeners = new Map<string, Listener[]>();

    constructor(url: string) {
      this.url = url;
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open", {});
        this.emit("message", {
          data: JSON.stringify({
            op: 10,
            d: { heartbeat_interval: options.heartbeatInterval ?? 45_000 },
          }),
        });
      });
    }

    addEventListener(type: string, listener: Listener) {
      const list = this.listeners.get(type) ?? [];
      list.push(listener);
      this.listeners.set(type, list);
    }

    send(data: string) {
      const payload = JSON.parse(data) as { op?: number };
      if (typeof payload.op === "number") this.sentOps.push(payload.op);
      if (payload.op === 2 || payload.op === 6) {
        queueMicrotask(() => {
          this.emit("message", {
            data: JSON.stringify({
              op: 0,
              t: payload.op === 6 ? "RESUMED" : "READY",
              s: (sequence += 1),
              d: {
                session_id: "sess-1",
                resume_gateway_url: "wss://gateway-resume.test",
                user: { id: "99", username: "coworker-bot" },
              },
            }),
          });
        });
      }
      if (payload.op === 1 && options.ackHeartbeats !== false) {
        queueMicrotask(() => this.emit("message", { data: JSON.stringify({ op: 11 }) }));
      }
    }

    close(code = 1000, reason = "") {
      this.lastCloseCode = code;
      this.readyState = 3;
      this.emit("close", { code, reason });
    }

    closeFromServer(code: number, reason = "") {
      this.readyState = 3;
      this.emit("close", { code, reason });
    }

    dispatchOpcode(op: number, d: unknown = null) {
      this.emit("message", { data: JSON.stringify({ op, d, s: (sequence += 1) }) });
    }

    dispatch(event: string, data: Record<string, unknown>) {
      this.emit("message", {
        data: JSON.stringify({ op: 0, t: event, s: (sequence += 1), d: data }),
      });
    }

    private emit(type: string, event: object) {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(event as Event);
      }
    }
  }

  const respond = (result: unknown, status = 200) =>
    new Response(result === undefined ? null : JSON.stringify(result), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const attachment = url.match(/https:\/\/cdn\.discordapp\.com\/(.+)$/);
    if (attachment) {
      const bytes = files.get(attachment[1]!) ?? new Uint8Array();
      return new Response(bytes.slice() as unknown as BodyInit, { status: 200 });
    }
    const path = url.replace(/^https:\/\/discord\.com\/api\/v10/, "");
    const method = init?.method ?? "GET";
    let body: Record<string, unknown> = {};
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } else if (init?.body instanceof FormData) {
      const payload = init.body.get("payload_json");
      body = payload ? (JSON.parse(String(payload)) as Record<string, unknown>) : {};
      const file = init.body.get("files[0]");
      if (file instanceof File) body.filename = file.name;
    }
    calls.push({ method, path, body });

    if (path === "/users/@me") {
      return respond({ id: "99", username: "coworker-bot", bot: true });
    }
    if (path === "/applications/@me") {
      return respond({
        id: "88",
        flags: options.intentEnabled === false ? 0 : 1 << 19,
        name: "Coworker",
      });
    }
    if (path === "/gateway") return respond({ url: "wss://gateway.test" });
    if (path === "/guilds/10") return respond({ id: "10", name: "Test Server" });
    const channelMatch = path.match(/^\/channels\/(\d+)$/);
    if (method === "GET" && channelMatch) {
      return respond(channels.get(channelMatch[1]!) ?? { id: channelMatch[1], type: 0, guild_id: "10", name: "unknown" });
    }
    if (method === "POST" && path.endsWith("/typing")) return respond(undefined, 204);
    const fromMessage = path.match(/^\/channels\/(\d+)\/messages\/(\d+)\/threads$/);
    if (method === "POST" && fromMessage) {
      if (options.threadFromMessageStatus) {
        return respond({ message: "Missing Permissions" }, options.threadFromMessageStatus);
      }
      const parentId = fromMessage[1]!;
      const messageId = fromMessage[2]!;
      const existing = channels.get(messageId);
      if (existing && existing.type === 11) return respond(existing);
      const thread = {
        id: messageId,
        type: 11,
        guild_id: "10",
        name: body.name,
        parent_id: parentId,
      };
      channels.set(thread.id, thread);
      return respond(thread);
    }
    if (method === "POST" && path.endsWith("/threads")) {
      threadSeq += 1;
      const thread = {
        id: String(threadSeq),
        type: 11,
        guild_id: "10",
        name: body.name,
        parent_id: path.split("/")[2],
      };
      channels.set(thread.id, thread);
      return respond(thread);
    }
    const messageMatch = path.match(/^\/channels\/(\d+)\/messages$/);
    if (method === "POST" && messageMatch) {
      if (options.message429Remaining) {
        options.message429Remaining -= 1;
        return new Response(JSON.stringify({ retry_after: 0.01, message: "rate limited" }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "0.01" },
        });
      }
      return respond({
        id: String((messageSeq += 1)),
        channel_id: messageMatch[1],
        content: body.content,
      });
    }
    if (method === "PATCH" && /\/messages\/\d+$/.test(path)) {
      return respond({ id: path.split("/").at(-1), content: body.content });
    }
    if (method === "PUT" && path.includes("/reactions/")) {
      const status = options.reactionStatus ?? 204;
      if (status !== 204) return respond({ message: "Missing Permissions" }, status);
      return respond(undefined, 204);
    }
    if (method === "POST" && path.includes("/interactions/")) return respond(undefined, 204);
    return respond({});
  }) as typeof fetch;

  return {
    fetchImpl,
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    calls,
    registerFile(id: string, bytes: Uint8Array) {
      files.set(`attachments/${id}`, bytes);
    },
    sent(method: string, suffix?: string) {
      return calls.filter(
        (call) =>
          call.method === method && (suffix === undefined || call.path.endsWith(suffix) || call.path.includes(suffix)),
      );
    },
    sockets,
    lastSocket() {
      return sockets.at(-1);
    },
    pushMessage(input: {
      id?: string;
      channelId: string;
      content?: string;
      guildId?: string | null;
      authorId?: string;
      bot?: boolean;
      type?: number;
      attachments?: Array<{
        id: string;
        filename: string;
        size: number;
        url?: string;
        content_type?: string;
      }>;
      referencedMessageId?: string;
    }) {
      const socket = sockets.at(-1);
      if (!socket) throw new Error("Gateway is not connected");
      const channel = channels.get(input.channelId);
      const id = input.id ?? String((messageSeq += 1));
      socket.dispatch("MESSAGE_CREATE", {
        id,
        channel_id: input.channelId,
        guild_id: input.guildId === null ? undefined : (input.guildId ?? "10"),
        type: input.type ?? 0,
        author: {
          id: input.authorId ?? "7",
          username: "melvin",
          bot: input.bot === true,
        },
        content: input.content ?? "",
        attachments: (input.attachments ?? []).map((item) => ({
          ...item,
          url: item.url ?? `https://cdn.discordapp.com/attachments/${item.id}`,
        })),
        referenced_message: input.referencedMessageId
          ? { id: input.referencedMessageId, channel_id: input.channelId }
          : undefined,
        message_reference: input.referencedMessageId
          ? { message_id: input.referencedMessageId }
          : undefined,
      });
      return { channelType: channel?.type, parentId: channel?.parent_id };
    },
    pushInteraction(input: { channelId: string; customId: string; messageId?: string }) {
      const socket = sockets.at(-1);
      if (!socket) throw new Error("Gateway is not connected");
      socket.dispatch("INTERACTION_CREATE", {
        id: `int-${messageSeq}`,
        token: "interaction-token",
        type: 3,
        guild_id: "10",
        channel_id: input.channelId,
        data: { custom_id: input.customId },
        member: { user: { id: "7", username: "melvin", bot: false } },
        message: { id: input.messageId ?? "2", channel_id: input.channelId },
      });
    },
    pushThread(input: { id: string; name: string; parentId: string }) {
      channels.set(input.id, {
        id: input.id,
        type: 11,
        guild_id: "10",
        name: input.name,
        parent_id: input.parentId,
      });
      sockets.at(-1)?.dispatch("THREAD_CREATE", channels.get(input.id)!);
    },
  };
}

async function setup(
  options: {
    intentEnabled?: boolean;
    heartbeatInterval?: number;
    ackHeartbeats?: boolean;
    reactionStatus?: number;
    message429Remaining?: number;
    threadFromMessageStatus?: number;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "coworker-discord-"));
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
  const fake = fakeDiscord(options);
  const credentials = credentialStore();
  const service = new DesktopAppService({
    dataPath: root,
    database,
    credentials,
    discord: {
      fetchImpl: fake.fetchImpl,
      WebSocketImpl: fake.WebSocketImpl,
      typingKeepAliveMs: 50,
    },
  });
  services.push(service);
  const enqueue = vi.spyOn(service.runtime, "enqueueTask").mockImplementation(() => undefined);
  const emit = (event: DesktopEvent) =>
    (service as unknown as { emit(event: DesktopEvent): void }).emit(event);
  return { root, database, ava, fake, credentials, service, enqueue, emit };
}

async function connectAndPair(
  context: Awaited<ReturnType<typeof setup>>,
  options: { channelId?: string } = {},
) {
  const status = await context.service.configureDiscord({
    botToken: testToken,
    coworkerId: context.ava.id,
  });
  await waitFor(() => context.fake.sent("GET", "/gateway").length > 0, "the gateway connect");
  await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  const code = status.pairingCode!;
  context.fake.pushMessage({ channelId: options.channelId ?? "100", content: code });
  await waitFor(
    () => context.service.discordStatus().pairingCode === null,
    "the channel to pair",
  );
  return status;
}

async function proposeMemory(context: Awaited<ReturnType<typeof setup>>, newText = "- Reporting currency: SGD.\n") {
  const coworker = context.database.getCoworker(context.ava.id);
  const enabled = context.database.updateCoworker(coworker.id, {
    enabledTools: [...new Set([...coworker.enabledTools, "files.edit"])],
  });
  const before = await context.service.readMemory(coworker.id);
  const task = context.database.createTask({
    coworkerId: coworker.id,
    title: "Remember a preference",
    input: "Remember my currency",
    threadId: `coworker:${coworker.id}`,
  });
  const result = await context.service.tools.request({
    task,
    coworker: enabled,
    toolName: "files.edit",
    toolCallId: `memory-${task.id}`,
    arguments: {
      path: "MEMORY.md",
      oldText: "",
      newText,
      expectedRevision: before.revision,
    },
  });
  if (result.kind !== "approval") throw new Error("Memory approval missing");
  context.emit({ type: "entity.changed", entity: "approvals", id: result.approval.id });
  return result.approval;
}

describe("discord-messaging skill", () => {
  it("is discoverable for Discord delivery and not for ordinary chat or email", () => {
    expect(bundledDiscordMessagingSkill.name).toBe("discord-messaging");
    expect(bundledDiscordMessagingSkill.description).toMatch(/Discord/i);
    expect(bundledDiscordMessagingSkill.description).toMatch(/do not use for ordinary conversation/i);
    expect(bundledDiscordMessagingSkill.description).toMatch(/email/i);
  });
});

describe("discord bridge", { timeout: 20_000 }, () => {
  it("rejects a bad token and stores a good token only in the credential store", async () => {
    const context = await setup();
    await expect(
      context.service.configureDiscord({
        botToken: "not-a-discord-token",
        coworkerId: context.ava.id,
      }),
    ).rejects.toThrow();
    const status = await context.service.configureDiscord({
      botToken: testToken,
      coworkerId: context.ava.id,
    });
    expect(status.integration?.status).toBe("connected");
    expect(status.inviteUrl).toContain("client_id=88");
    expect(status.inviteUrl).toContain(`permissions=${discordInvitePermissions.toString()}`);
    expect(status.pairingCode).toMatch(/^[0-9A-F]{16}$/);
    expect(status.intentSettingsUrl).toContain("/applications/88/bot");
    expect(status.messageContentIntentEnabled).toBe(true);
    expect(JSON.stringify(status.integration?.config)).not.toContain(testToken);
    expect(await context.credentials.get(discordCredentialKey)).toBe(testToken);
    expect(context.database.getCoworker(context.ava.id).enabledTools).toContain("discord.send");
    expect(context.database.getCoworker(context.ava.id).policies["discord.send"]).toBe("approval");
  });

  it("pairs a guild channel by posted code and ignores DMs and wrong codes", async () => {
    const context = await setup();
    const status = await context.service.configureDiscord({
      botToken: testToken,
      coworkerId: context.ava.id,
    });
    await waitFor(() => context.fake.sent("GET", "/gateway").length > 0, "gateway");
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));

    context.fake.pushMessage({ channelId: "100", content: "WRONGCODE", guildId: "10" });
    await waitFor(
      () =>
        context.fake
          .sent("POST", "/messages")
          .some((call) => String(call.body.content).includes("This bot is private")),
      "the refusal",
    );
    expect(context.service.discordStatus().pairingCode).toBe(status.pairingCode);

    context.fake.pushMessage({
      channelId: "999",
      content: status.pairingCode!,
      guildId: null,
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    expect(context.service.discordStatus().pairingCode).toBe(status.pairingCode);

    context.fake.pushMessage({ channelId: "100", content: status.pairingCode! });
    await waitFor(
      () =>
        context.fake
          .sent("POST", "/messages")
          .some((call) => String(call.body.content).startsWith("Connected.")),
      "the pairing confirmation",
    );
    const connected = context.service.discordStatus();
    expect(connected.pairingCode).toBeNull();
    expect(connected.channelName).toBe("general");
    expect(connected.guildName).toBe("Test Server");
    const inbound = vi.spyOn(context.service, "sendConversationMessage");
    expect(inbound).not.toHaveBeenCalled();
  });

  it("pairs from a thread and maps that thread to a titled conversation", async () => {
    const context = await setup();
    const status = await context.service.configureDiscord({
      botToken: testToken,
      coworkerId: context.ava.id,
    });
    await waitFor(() => context.fake.sent("GET", "/gateway").length > 0, "gateway");
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    context.fake.pushMessage({ channelId: "200", content: status.pairingCode! });
    await waitFor(
      () => context.service.discordStatus().pairingCode === null,
      "thread pairing",
    );
    const config = parseDiscordConfig(context.database.getDiscordIntegration()!);
    expect(config.channelId).toBe("100");
    expect(config.threads["200"]).toBeDefined();
    const conversation = context.database.getConversation(config.threads["200"]!);
    expect(conversation.title).toBe("research");
    expect(context.service.discordStatus().threadName).toBe("research");
  });

  it("injects inbound text idempotently, ignores other channels, and does not echo", async () => {
    const context = await setup();
    await connectAndPair(context);
    context.enqueue.mockClear();
    context.fake.pushMessage({ id: "55", channelId: "100", content: mention("Hello from Discord") });
    await waitFor(() => Object.keys(mappedThreads(context.database)).length === 1, "mention thread");
    const conversationId = Object.values(mappedThreads(context.database))[0]!;
    expect(conversationId).not.toBe(`coworker:${context.ava.id}`);
    await waitFor(
      () =>
        context.database
          .listConversationMessages(conversationId)
          .some((message) => message.content === "Hello from Discord"),
      "the inbound message",
    );
    const matching = context.database
      .listConversationMessages(conversationId)
      .filter((message) => message.content === "Hello from Discord");
    expect(matching).toHaveLength(1);
    expect(matching[0]!.id.startsWith("discord:")).toBe(true);
    expect(context.enqueue).toHaveBeenCalledTimes(1);
    expect(context.fake.sent("POST", "/100/messages/55/threads")).toHaveLength(1);

    context.fake.pushMessage({
      channelId: "55",
      content: "from another member",
      authorId: "42",
    });
    await waitFor(
      () =>
        context.database
          .listConversationMessages(conversationId)
          .some((message) => message.content === "from another member"),
      "any human in the mapped thread",
    );

    const before = context.fake.sent("POST", "/messages").length;
    context.fake.pushMessage({ channelId: "999", content: "other channel", guildId: "10" });
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    expect(context.fake.sent("POST", "/messages").length).toBe(before);
    expect(
      context.database
        .listConversationMessages(conversationId)
        .some((message) => message.content === "other channel"),
    ).toBe(false);
  });

  it("reacts with 👀 only after RUN_STARTED and survives a restart", async () => {
    const context = await setup();
    await connectAndPair(context);
    context.fake.pushMessage({ channelId: "100", content: mention("please look") });
    await waitFor(() => Object.keys(mappedThreads(context.database)).length === 1, "mention thread");
    const conversationId = Object.values(mappedThreads(context.database))[0]!;
    await waitFor(
      () =>
        context.database
          .listConversationMessages(conversationId)
          .some((message) => message.content === "please look"),
      "inject",
    );
    const config = () => parseDiscordConfig(context.database.getDiscordIntegration()!);
    const refs = () => Object.values(config().inboundMessages);
    await waitFor(() => refs().length === 1, "persisted snowflake");
    expect(refs()[0]!.reactedAt).toBeUndefined();
    expect(context.fake.sent("PUT", "/reactions/").length).toBe(0);

    const taskId = refs()[0]!.taskId!;
    await context.service.discord.stop();
    await context.service.discord.start();
    await waitFor(() => context.fake.sent("GET", "/gateway").length > 1, "reconnect");
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));

    context.emit({
      type: "agent.event",
      coworkerId: context.ava.id,
      conversationId,
      runId: "run-1",
      taskId,
      event: { type: EventType.RUN_STARTED } as never,
    });
    await waitFor(() => context.fake.sent("PUT", "/reactions/").length === 1, "the receipt reaction");
    const reaction = context.fake.sent("PUT", "/reactions/")[0]!;
    expect(decodeURIComponent(reaction.path)).toContain("👀");
    await waitFor(() => refs().length === 0, "pruned inbound ref");

    context.emit({
      type: "agent.event",
      coworkerId: context.ava.id,
      conversationId,
      runId: "run-1",
      taskId,
      event: { type: EventType.RUN_STARTED } as never,
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    expect(context.fake.sent("PUT", "/reactions/").length).toBe(1);
  });

  it("falls back to 👀 when receiptEmoji is invalid", async () => {
    const context = await setup();
    await connectAndPair(context);
    context.database.updateDiscordIntegration({ config: { receiptEmoji: "not-an-emoji" } });
    await context.service.discord.restart();
    await waitFor(() => context.fake.sent("GET", "/gateway").length > 1, "restart");
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    context.fake.pushMessage({ channelId: "100", content: mention("emoji fallback") });
    await waitFor(
      () =>
        Object.values(parseDiscordConfig(context.database.getDiscordIntegration()!).inboundMessages)
          .length === 1,
      "inject",
    );
    const taskId = Object.values(
      parseDiscordConfig(context.database.getDiscordIntegration()!).inboundMessages,
    )[0]!.taskId!;
    context.emit({
      type: "agent.event",
      coworkerId: context.ava.id,
      conversationId: `coworker:${context.ava.id}`,
      runId: "run-emoji",
      taskId,
      event: { type: EventType.RUN_STARTED } as never,
    });
    await waitFor(() => context.fake.sent("PUT", "/reactions/").length === 1, "fallback reaction");
    expect(decodeURIComponent(context.fake.sent("PUT", "/reactions/")[0]!.path)).toContain("👀");
  });

  it("maps threads both ways and delivers discord.send into the last inbound thread", async () => {
    const context = await setup();
    await connectAndPair(context);
    context.fake.pushThread({ id: "210", name: "quarterly", parentId: "100" });
    context.fake.pushMessage({ channelId: "210", content: "topic question" });
    await waitFor(() => {
      return context.database
        .listConversations(context.ava.id)
        .some((conversation) =>
          context.database
            .listConversationMessages(conversation.id)
            .some((message) => message.content === "topic question"),
        );
    }, "thread conversation");
    const research = context.database
      .listConversations(context.ava.id)
      .find((conversation) =>
        context.database
          .listConversationMessages(conversation.id)
          .some((message) => message.content === "topic question"),
      )!;
    expect(research.title).toBe("quarterly");

    const coworkerBefore = context.database.getCoworker(context.ava.id);
    context.database.updateCoworker(context.ava.id, {
      policies: { ...coworkerBefore.policies, "discord.send": "automatic" },
    });
    await mkdir(join(context.root, "ava"), { recursive: true });
    await writeFile(join(context.root, "ava", "bp_reading.csv"), "sys,dia\n120,80");
    const task = context.database.createTask({
      coworkerId: context.ava.id,
      title: "Send the reading",
      input: "send it",
      threadId: research.id,
    });
    const result = await context.service.tools.request({
      task,
      coworker: context.database.getCoworker(context.ava.id),
      toolCallId: "call-thread",
      toolName: "discord.send",
      arguments: { message: "Here is the CSV", attachments: ["bp_reading.csv"] },
    });
    expect(result.kind).toBe("completed");
    expect(
      context.fake
        .sent("POST", "/messages")
        .some((call) => call.path.includes("/210/") && call.body.content === "Here is the CSV"),
    ).toBe(true);

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
    await waitFor(() => context.fake.sent("POST", "/threads").length === 1, "outbound thread");
    expect(context.fake.sent("POST", "/threads")[0]!.body.name).toBe("Quarterly plan");
  });

  it("mirrors desktop messages and posts the finished coworker reply without streaming drafts", async () => {
    const context = await setup();
    await connectAndPair(context);
    const conversationId = `coworker:${context.ava.id}`;
    await context.service.sendConversationMessage({
      conversationId,
      clientMessageId: "desk-1",
      content: "typed on desktop",
      mentionedCoworkerIds: [],
    });
    await waitFor(
      () =>
        context.fake
          .sent("POST", "/messages")
          .some((call) => call.body.content === "You (desktop): typed on desktop"),
      "desktop mirror",
    );

    const base = { coworkerId: context.ava.id, conversationId, runId: "run-1", taskId: "t-1" };
    context.emit({
      type: "agent.event",
      ...base,
      event: { type: EventType.RUN_STARTED } as never,
    });
    await waitFor(() => context.fake.sent("POST", "/typing").length > 0, "typing indicator");
    context.emit({
      type: "agent.event",
      ...base,
      event: {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "**Done!** See `report.txt`",
      } as never,
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));
    expect(
      context.fake
        .sent("POST", "/messages")
        .some((call) => String(call.body.content).includes("Done!")),
    ).toBe(false);
    context.emit({
      type: "agent.event",
      ...base,
      event: { type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as never,
    });
    context.emit({
      type: "agent.event",
      ...base,
      event: { type: EventType.RUN_FINISHED } as never,
    });
    await waitFor(
      () =>
        context.fake
          .sent("POST", "/messages")
          .some((call) => call.body.content === "**Done!** See `report.txt`"),
      "finished reply",
    );
  });

  it("cancels a run from /stop", async () => {
    const context = await setup();
    await connectAndPair(context);
    const cancel = vi
      .spyOn(context.service, "cancelTask")
      .mockResolvedValue({} as Awaited<ReturnType<DesktopAppService["cancelTask"]>>);
    const base = {
      coworkerId: context.ava.id,
      conversationId: `coworker:${context.ava.id}`,
      runId: "run-stop",
      taskId: "task-stop",
    };
    context.emit({
      type: "agent.event",
      ...base,
      event: { type: EventType.RUN_STARTED } as never,
    });
    await waitFor(() => context.fake.sent("POST", "/typing").length > 0, "run started");
    context.fake.pushMessage({ channelId: "100", content: "/stop" });
    await waitFor(() => cancel.mock.calls.length === 1, "stop");
    expect(cancel).toHaveBeenCalledWith("task-stop");
  });

  it("saves inbound documents into discord-inbox", async () => {
    const context = await setup();
    await connectAndPair(context);
    context.fake.registerFile("file-1", new Uint8Array([1, 2, 3, 4]));
    context.fake.pushMessage({
      channelId: "100",
      content: mention("see attached"),
      attachments: [
        {
          id: "file-1",
          filename: "notes.txt",
          size: 4,
          content_type: "text/plain",
        },
      ],
    });
    await waitFor(
      () =>
        context.database
          .listConversations(context.ava.id)
          .some((conversation) =>
            context.database
              .listConversationMessages(conversation.id)
              .some((message) => message.content.includes("discord-inbox/")),
          ),
      "inbox note",
    );
    const inbox = join(context.root, "ava", "discord-inbox");
    const names = await readdir(inbox);
    expect(names.some((name) => name.endsWith("notes.txt"))).toBe(true);
    expect(await readFile(join(inbox, names[0]!))).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("keeps discord.send approval-gated by default and errors when disconnected", async () => {
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
      toolName: "discord.send",
      arguments: { message: "needs approval" },
    });
    expect(gated.kind).toBe("approval");
    if (gated.kind === "approval") {
      expect(gated.approval.summary).toContain("Send Discord message");
    }
    await context.service.disconnectDiscord();
    expect(await context.credentials.has(discordCredentialKey)).toBe(false);
    const coworker = context.database.getCoworker(context.ava.id);
    context.database.updateCoworker(context.ava.id, {
      policies: { ...coworker.policies, "discord.send": "automatic" },
    });
    await expect(
      context.service.tools.request({
        task,
        coworker: context.database.getCoworker(context.ava.id),
        toolCallId: "call-3",
        toolName: "discord.send",
        arguments: { message: "should fail" },
      }),
    ).rejects.toThrow(/not connected/i);
  });

  it("announces pending approvals and applies button decisions", async () => {
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
      toolName: "discord.send",
      arguments: { message: "the invoice" },
    });
    expect(result.kind).toBe("approval");
    if (result.kind !== "approval") return;
    context.emit({ type: "entity.changed", entity: "approvals", id: result.approval.id });
    await waitFor(
      () =>
        context.fake
          .sent("POST", "/messages")
          .some((call) => JSON.stringify(call.body.components ?? {}).includes(`apr:${result.approval.id}:approve`)),
      "approval buttons",
    );
    context.fake.pushInteraction({
      channelId: "100",
      customId: `apr:${result.approval.id}:approve`,
      messageId: "5",
    });
    await waitFor(
      () => context.database.getApproval(result.approval.id).status === "APPROVED",
      "approved",
    );
    await waitFor(
      () =>
        context.fake
          .calls
          .some(
            (call) =>
              call.method === "PATCH" &&
              String(call.body.content).includes("Approved.") &&
              !String(call.body.content).includes("desktop app"),
          ),
      "approved notice text",
    );
    expect(
      context.fake.calls.some(
        (call) => call.method === "PATCH" && String(call.body.content).includes("handled in the desktop app"),
      ),
    ).toBe(false);
  });

  it("moves the bot to another coworker and keeps the paired channel", async () => {
    const context = await setup();
    await connectAndPair(context);
    context.fake.pushMessage({ channelId: "200", content: "thread for ava" });
    await waitFor(
      () => Object.keys(parseDiscordConfig(context.database.getDiscordIntegration()!).threads).length > 0,
      "ava thread map",
    );
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
    await context.service.configureDiscord({ coworkerId: sarah.id });
    const config = parseDiscordConfig(context.database.getDiscordIntegration()!);
    expect(config.coworkerId).toBe(sarah.id);
    expect(config.channelId).toBe("100");
    expect(config.guildId).toBe("10");
    expect(config.threads).toEqual({});
    expect(config.lastThreads).toEqual({});
    expect(context.database.getCoworker(sarah.id).enabledTools).toContain("discord.send");
    expect(context.database.getCoworker(context.ava.id).enabledTools).not.toContain("discord.send");
    await waitFor(
      () =>
        context.fake
          .sent("POST", "/messages")
          .some((call) => String(call.body.content).includes("This channel now goes to Sarah")),
      "handoff notice",
    );
  });

  it("unpairs with a new code and disconnects by deleting the token", async () => {
    const context = await setup();
    const first = await context.service.configureDiscord({
      botToken: testToken,
      coworkerId: context.ava.id,
    });
    await waitFor(() => context.fake.sent("GET", "/gateway").length > 0, "gateway");
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    context.fake.pushMessage({ channelId: "100", content: first.pairingCode! });
    await waitFor(() => context.service.discordStatus().pairingCode === null, "paired");
    const unpaired = await context.service.unpairDiscord();
    expect(unpaired.pairingCode).toBeTruthy();
    expect(unpaired.pairingCode).not.toBe(first.pairingCode);
    expect(unpaired.inviteUrl).toBe(first.inviteUrl);
    expect(parseDiscordConfig(unpaired.integration!).channelId).toBeNull();
    expect(await context.credentials.has(discordCredentialKey)).toBe(true);
    await context.service.disconnectDiscord();
    expect(await context.credentials.has(discordCredentialKey)).toBe(false);
  });

  it("stops reconnecting on 4014 and surfaces a Settings gateway error", async () => {
    const context = await setup();
    await context.service.configureDiscord({ botToken: testToken, coworkerId: context.ava.id });
    await waitFor(() => context.fake.sent("GET", "/gateway").length === 1, "first identify");
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    context.fake.lastSocket()!.closeFromServer(4014, "Disallowed intent(s)");
    await waitFor(() => context.service.discordStatus().integration?.status === "error", "fatal status");
    expect(context.service.discordStatus().gatewayError).toMatch(/Message Content Intent/i);
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    expect(context.fake.sent("GET", "/gateway").length).toBe(1);
  });

  it("backs off after a drop instead of tight-looping IDENTIFY", async () => {
    const context = await setup();
    await context.service.configureDiscord({ botToken: testToken, coworkerId: context.ava.id });
    await waitFor(() => context.fake.sent("GET", "/gateway").length === 1, "first identify");
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    context.fake.lastSocket()!.closeFromServer(1006);
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    expect(context.fake.sent("GET", "/gateway").length).toBe(1);
  });

  it("closes and resumes when a heartbeat ACK is missing", async () => {
    const context = await setup({ heartbeatInterval: 40, ackHeartbeats: false });
    await context.service.configureDiscord({ botToken: testToken, coworkerId: context.ava.id });
    await waitFor(() => Boolean(context.fake.lastSocket()?.sentOps.includes(2)), "identify");
    await waitFor(
      () => context.fake.sockets.some((socket) => socket.lastCloseCode === 4000),
      "missing ACK close",
    );
  });

  it("wakes with a resumable close and does not log a second-instance conflict", async () => {
    const context = await setup();
    await connectAndPair(context);
    const before = context.database.listActivity().filter((item) => item.type === "discord.conflict");
    await context.service.discord.wake();
    await waitFor(() => context.fake.sockets.length >= 2, "wake reconnect");
    expect(context.fake.sockets[0]!.lastCloseCode).toBe(4000);
    await waitFor(
      () => Boolean(context.fake.lastSocket()?.sentOps.includes(6)),
      "resume after wake",
    );
    expect(context.database.listActivity().filter((item) => item.type === "discord.conflict")).toEqual(
      before,
    );
  });

  it("re-identifies after an invalid session without a conflict activity", async () => {
    const context = await setup();
    await connectAndPair(context);
    const before = context.database.listActivity().filter((item) => item.type === "discord.conflict");
    context.fake.lastSocket()!.dispatchOpcode(9, false);
    await waitFor(() => context.fake.sockets.length >= 2, "invalid-session reconnect");
    await waitFor(
      () => context.fake.sockets.some((socket) => socket.sentOps.includes(2) && socket !== context.fake.sockets[0]),
      "fresh identify",
    );
    expect(context.database.listActivity().filter((item) => item.type === "discord.conflict")).toEqual(
      before,
    );
  });

  it("pairs a forum post and never posts to the forum channel itself", async () => {
    const context = await setup();
    await connectAndPair(context, { channelId: "301" });
    const config = parseDiscordConfig(context.database.getDiscordIntegration()!);
    expect(config.channelId).toBe("300");
    expect(config.channelType).toBe(15);
    const coworker = context.database.getCoworker(context.ava.id);
    context.database.updateCoworker(context.ava.id, {
      policies: { ...coworker.policies, "discord.send": "automatic" },
    });
    const task = context.database.createTask({
      coworkerId: context.ava.id,
      title: "Send to Discord",
      input: "send it",
      threadId: `coworker:${context.ava.id}`,
    });
    await context.service.tools.request({
      task,
      coworker: context.database.getCoworker(context.ava.id),
      toolCallId: "forum-send",
      toolName: "discord.send",
      arguments: { message: "x".repeat(4500) },
    });
    expect(context.fake.sent("POST", "/threads").length).toBeGreaterThan(0);
    expect(context.fake.sent("POST", "/channels/300/messages")).toHaveLength(0);
    const posts = context.fake.sent("POST", "/channels/300/threads");
    const starter = (posts.at(-1)!.body.message as { content: string }).content;
    const threadId = Object.entries(mappedThreads(context.database)).find(([, id]) => id === task.threadId)![0];
    const delivered = [starter, ...context.fake.sent("POST", `/channels/${threadId}/messages`).map((call) => String(call.body.content))];
    expect(delivered.every((chunk) => chunk.length <= 2000)).toBe(true);
    expect(delivered.join("")).toBe("x".repeat(4500));
  });

  it("does not create a forum post when an attachment cannot be read", async () => {
    const context = await setup();
    await connectAndPair(context, { channelId: "301" });
    const coworker = context.database.getCoworker(context.ava.id);
    const task = context.database.createTask({ coworkerId: coworker.id, title: "Send file", input: "send file" });
    const before = context.fake.sent("POST", "/threads").length;
    await expect(context.service.tools.request({
      task, coworker: { ...coworker, policies: { ...coworker.policies, "discord.send": "automatic" } },
      toolCallId: "invalid-forum-attachment", toolName: "discord.send",
      arguments: { message: "Here is the file", attachments: ["missing.pdf"] },
    })).rejects.toThrow();
    expect(context.fake.sent("POST", "/threads")).toHaveLength(before);
  });

  it("ignores system messages and does not answer them", async () => {
    const context = await setup();
    await connectAndPair(context);
    const before = context.fake.sent("POST", "/messages").length;
    context.fake.pushMessage({ channelId: "100", content: "", type: 18 });
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    expect(context.fake.sent("POST", "/messages").length).toBe(before);
    expect(
      context.database
        .listConversationMessages(`coworker:${context.ava.id}`)
        .some((message) => message.id.startsWith("discord:")),
    ).toBe(false);
  });

  it("imports inbound photos for vision models and degrades otherwise", async () => {
    const context = await setup();
    await connectAndPair(context);
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
    context.fake.pushMessage({
      channelId: "100",
      content: mention("look at this"),
      attachments: [
        { id: "photo-1", filename: "shot.jpg", size: jpeg.byteLength, content_type: "image/jpeg" },
      ],
    });
    await waitFor(
      () => context.database.listImageAttachments(context.ava.id).length === 1,
      "the photo attachment",
    );
    expect(context.database.listImageAttachments(context.ava.id)[0]!.mimeType).toBe("image/jpeg");

    context.database.updateCoworker(context.ava.id, {
      modelProvider: "demo",
      modelName: "faux-1",
    });
    context.fake.registerFile("photo-2", jpeg);
    context.fake.pushMessage({
      channelId: "100",
      content: mention("caption survives"),
      attachments: [
        { id: "photo-2", filename: "shot2.jpg", size: jpeg.byteLength, content_type: "image/jpeg" },
      ],
    });
    await waitFor(
      () =>
        context.database
          .listConversations(context.ava.id)
          .some((conversation) =>
            context.database
              .listConversationMessages(conversation.id)
              .some((message) => message.content === "caption survives"),
          ),
      "caption without image",
    );
    expect(
      context.fake.sent("POST", "/messages").some((call) => String(call.body.content).includes("can't view photos")),
    ).toBe(true);
  });

  it("edits and approves a memory item by reply, and cancels with /cancel", async () => {
    const context = await setup();
    await connectAndPair(context);
    const approval = await proposeMemory(context);
    await waitFor(
      () =>
        context.fake
          .sent("POST", "/messages")
          .some((call) => JSON.stringify(call.body.components ?? {}).includes(`apr:${approval.id}:edit`)),
      "edit button",
    );
    const inbound = vi.spyOn(context.service, "sendConversationMessage");
    context.fake.pushInteraction({
      channelId: "100",
      customId: `apr:${approval.id}:edit`,
      messageId: "5",
    });
    const edits = () => parseDiscordConfig(context.database.getDiscordIntegration()!).approvalEdits;
    await waitFor(() => Object.values(edits()).some((item) => item.approvalId === approval.id), "edit prompt");
    const promptId = Object.keys(edits())[0]!;
    context.fake.pushMessage({
      channelId: "100",
      content: "/cancel",
      referencedMessageId: promptId,
    });
    await waitFor(() => Object.values(edits()).some((item) => item.cancelled), "cancelled");
    expect(context.database.getApproval(approval.id).status).toBe("PENDING");
    expect(inbound).not.toHaveBeenCalled();

    const beforeSecond = Object.keys(edits()).length;
    context.fake.pushInteraction({
      channelId: "100",
      customId: `apr:${approval.id}:edit`,
      messageId: "5",
    });
    await waitFor(() => Object.keys(edits()).length > beforeSecond, "second edit prompt");
    const promptId2 = Object.keys(edits()).at(-1)!;
    context.fake.pushMessage({
      channelId: "100",
      content: "- Reporting currency: EUR.\n",
      referencedMessageId: promptId2,
    });
    await waitFor(() => context.database.getApproval(approval.id).status === "EDITED", "edited");
    expect(inbound).not.toHaveBeenCalled();
  });

  it("applies Always allow and ignores unpaired-channel interactions", async () => {
    const context = await setup();
    await connectAndPair(context);
    const task = context.database.createTask({
      coworkerId: context.ava.id,
      title: "Ping me",
      input: "ping",
      threadId: `coworker:${context.ava.id}`,
    });
    const result = await context.service.tools.request({
      task,
      coworker: context.database.getCoworker(context.ava.id),
      toolCallId: "always-1",
      toolName: "discord.send",
      arguments: { message: "later" },
    });
    expect(result.kind).toBe("approval");
    if (result.kind !== "approval") return;
    context.emit({ type: "entity.changed", entity: "approvals", id: result.approval.id });
    await waitFor(
      () =>
        context.fake
          .sent("POST", "/messages")
          .some((call) => JSON.stringify(call.body.components ?? {}).includes(`apr:${result.approval.id}:always`)),
      "always button",
    );
    context.fake.pushInteraction({
      channelId: "999",
      customId: `apr:${result.approval.id}:approve`,
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    expect(context.database.getApproval(result.approval.id).status).toBe("PENDING");
    context.fake.pushInteraction({
      channelId: "100",
      customId: `apr:${result.approval.id}:always`,
      messageId: "5",
    });
    await waitFor(() => context.database.getApproval(result.approval.id).status === "APPROVED", "always approved");
    expect(context.database.getCoworker(context.ava.id).policies["discord.send"]).toBe("automatic");
  });

  it("finalizes a partial /stop reply", async () => {
    const context = await setup();
    await connectAndPair(context);
    const cancel = vi
      .spyOn(context.service, "cancelTask")
      .mockResolvedValue({} as Awaited<ReturnType<DesktopAppService["cancelTask"]>>);
    const base = {
      coworkerId: context.ava.id,
      conversationId: `coworker:${context.ava.id}`,
      runId: "run-stop-partial",
      taskId: "task-stop-partial",
    };
    context.emit({ type: "agent.event", ...base, event: { type: EventType.RUN_STARTED } as never });
    context.emit({
      type: "agent.event",
      ...base,
      event: { type: EventType.TEXT_MESSAGE_CONTENT, delta: "Half" } as never,
    });
    await waitFor(() => context.fake.sent("POST", "/typing").length > 0, "typing");
    context.fake.pushMessage({ channelId: "100", content: "/stop" });
    await waitFor(() => cancel.mock.calls.length === 1, "cancelled");
    expect(cancel).toHaveBeenCalledWith("task-stop-partial");
    expect(
      context.database
        .listConversationMessages(`coworker:${context.ava.id}`)
        .some((message) => message.content.includes("/stop")),
    ).toBe(false);
    context.emit({
      type: "agent.event",
      ...base,
      event: { type: EventType.RUN_ERROR, message: "Stopped", code: "RUN_ABORTED" } as never,
    });
    await waitFor(
      () => context.fake.sent("POST", "/messages").some((call) => String(call.body.content).includes("Half")),
      "partial reply",
    );
  });

  it("records receiptReactionDenied when the reaction PUT is 403", async () => {
    const context = await setup({ reactionStatus: 403 });
    await connectAndPair(context);
    context.fake.pushMessage({ channelId: "100", content: mention("please look") });
    await waitFor(
      () =>
        Object.values(parseDiscordConfig(context.database.getDiscordIntegration()!).inboundMessages).length === 1,
      "inject",
    );
    const taskId = Object.values(
      parseDiscordConfig(context.database.getDiscordIntegration()!).inboundMessages,
    )[0]!.taskId!;
    context.emit({
      type: "agent.event",
      coworkerId: context.ava.id,
      conversationId: `coworker:${context.ava.id}`,
      runId: "run-403",
      taskId,
      event: { type: EventType.RUN_STARTED } as never,
    });
    await waitFor(() => context.service.discordStatus().receiptReactionDenied === true, "denied hint");
  });

  it("renames a mapped conversation when the Discord thread title changes", async () => {
    const context = await setup();
    await connectAndPair(context, { channelId: "200" });
    const conversationId = parseDiscordConfig(context.database.getDiscordIntegration()!).threads["200"]!;
    context.fake.lastSocket()!.dispatch("THREAD_UPDATE", {
      id: "200",
      type: 11,
      guild_id: "10",
      name: "renamed research",
      parent_id: "100",
    });
    await waitFor(
      () => context.database.getConversation(conversationId).title === "renamed research",
      "thread rename",
    );
  });

  it("retries a 429 and still delivers the finished reply", async () => {
    const context = await setup({ message429Remaining: 1 });
    await connectAndPair(context);
    const conversationId = `coworker:${context.ava.id}`;
    context.emit({
      type: "entity.changed",
      entity: "conversations",
      id: conversationId,
    });
    context.database.addMessage({
      id: "desktop-1",
      conversationId,
      coworkerId: context.ava.id,
      role: "user",
      content: "typed on desktop",
      createdAt: new Date().toISOString(),
    } as never);
    context.emit({ type: "entity.changed", entity: "conversations", id: conversationId });
    await waitFor(
      () =>
        context.fake
          .sent("POST", "/messages")
          .some((call) => String(call.body.content).includes("typed on desktop")),
      "retried mirror",
    );
  });

  it("ignores parent-channel chatter and opens a thread only on @mention", async () => {
    const context = await setup();
    await connectAndPair(context);
    const beforeMessages = context.database.listConversationMessages(`coworker:${context.ava.id}`).length;
    const beforePosts = context.fake.sent("POST", "/messages").length;
    context.fake.pushMessage({ channelId: "100", content: "just chatting in general" });
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    expect(Object.keys(mappedThreads(context.database))).toHaveLength(0);
    expect(context.database.listConversationMessages(`coworker:${context.ava.id}`)).toHaveLength(
      beforeMessages,
    );
    expect(context.fake.sent("POST", "/messages").length).toBe(beforePosts);
    expect(context.fake.sent("POST", "/threads")).toHaveLength(0);

    context.fake.pushMessage({ id: "77", channelId: "100", content: mention("find AI jobs") });
    await waitFor(() => Object.keys(mappedThreads(context.database))[0] === "77", "mention thread id");
    const conversationId = mappedThreads(context.database)["77"]!;
    expect(context.database.getConversation(conversationId).title).toBe("find AI jobs");
    expect(
      context.database
        .listConversationMessages(conversationId)
        .some((message) => message.content === "find AI jobs"),
    ).toBe(true);
    expect(
      context.database
        .listConversationMessages(`coworker:${context.ava.id}`)
        .some((message) => message.content.includes("find AI jobs")),
    ).toBe(false);
    expect(context.fake.sent("POST", "/channels/100/messages/77/threads")).toHaveLength(1);
  });

  it("reuses one thread and conversation when the same mention is dispatched twice", async () => {
    const context = await setup();
    await connectAndPair(context);
    const payload = { id: "88", channelId: "100", content: mention("dedupe me") };
    context.fake.pushMessage(payload);
    context.fake.pushMessage(payload);
    await waitFor(
      () =>
        context.database
          .listConversations(context.ava.id)
          .some((conversation) =>
            context.database
              .listConversationMessages(conversation.id)
              .some((message) => message.content === "dedupe me"),
          ),
      "injected once",
    );
    expect(Object.keys(mappedThreads(context.database))).toEqual(["88"]);
    expect(context.fake.sent("POST", "/channels/100/messages/88/threads")).toHaveLength(1);
    const conversationId = mappedThreads(context.database)["88"]!;
    expect(
      context.database
        .listConversationMessages(conversationId)
        .filter((message) => message.content === "dedupe me"),
    ).toHaveLength(1);
  });

  it("keeps talking in a mapped thread without another mention and never nests threads", async () => {
    const context = await setup();
    await connectAndPair(context);
    context.fake.pushMessage({ id: "90", channelId: "100", content: mention("first turn") });
    await waitFor(() => Boolean(mappedThreads(context.database)["90"]), "first thread");
    const conversationId = mappedThreads(context.database)["90"]!;
    context.enqueue.mockClear();
    context.fake.pushMessage({
      id: "91",
      channelId: "90",
      content: mention("follow up still this conversation"),
    });
    await waitFor(
      () =>
        context.database
          .listConversationMessages(conversationId)
          .some((message) => message.content === "follow up still this conversation"),
      "thread follow-up",
    );
    expect(Object.keys(mappedThreads(context.database))).toEqual(["90"]);
    expect(context.fake.sent("POST", "/channels/90/messages/91/threads")).toHaveLength(0);
    expect(context.enqueue).toHaveBeenCalledTimes(1);
  });

  it("does not inject when creating a mention thread is forbidden", async () => {
    const context = await setup({ threadFromMessageStatus: 403 });
    await connectAndPair(context);
    context.fake.pushMessage({ id: "92", channelId: "100", content: mention("please thread") });
    await waitFor(
      () =>
        context.database.listActivity().some((item) => item.type === "discord.thread_failed"),
      "thread failure activity",
    );
    expect(Object.keys(mappedThreads(context.database))).toHaveLength(0);
    expect(
      context.database
        .listConversations(context.ava.id)
        .some((conversation) =>
          context.database
            .listConversationMessages(conversation.id)
            .some((message) => message.content.includes("please thread")),
        ),
    ).toBe(false);
    expect(
      context.fake
        .sent("POST", "/messages")
        .some((call) => String(call.body.content).includes("Create Public Threads")),
    ).toBe(true);
  });

  it("restores mention-thread mapping after a restart", async () => {
    const context = await setup();
    await connectAndPair(context);
    context.fake.pushMessage({ id: "93", channelId: "100", content: mention("persist this") });
    await waitFor(() => Boolean(mappedThreads(context.database)["93"]), "mapped before restart");
    const conversationId = mappedThreads(context.database)["93"]!;
    await context.service.discord.stop();
    await context.service.discord.start();
    await waitFor(() => context.fake.sent("GET", "/gateway").length > 1, "reconnect");
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    expect(mappedThreads(context.database)["93"]).toBe(conversationId);
    context.fake.pushMessage({ channelId: "93", content: "still the same thread" });
    await waitFor(
      () =>
        context.database
          .listConversationMessages(conversationId)
          .some((message) => message.content === "still the same thread"),
      "post-restart thread message",
    );
    expect(context.fake.sent("POST", "/channels/100/messages/93/threads").length).toBe(1);
  });

  it("does not rewrite a Discord Approve notice as handled on desktop", async () => {
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
      toolCallId: "call-apr-race",
      toolName: "discord.send",
      arguments: { message: "the invoice" },
    });
    expect(result.kind).toBe("approval");
    if (result.kind !== "approval") return;
    context.emit({ type: "entity.changed", entity: "approvals", id: result.approval.id });
    await waitFor(
      () =>
        context.fake
          .sent("POST", "/messages")
          .some((call) => JSON.stringify(call.body.components ?? {}).includes(`apr:${result.approval.id}:approve`)),
      "approval buttons",
    );
    context.fake.pushInteraction({
      channelId: "100",
      customId: `apr:${result.approval.id}:approve`,
      messageId: "5",
    });
    await waitFor(
      () => context.database.getApproval(result.approval.id).status === "APPROVED",
      "approved",
    );
    await waitFor(
      () =>
        context.fake.calls.some(
          (call) => call.method === "PATCH" && String(call.body.content).includes("Approved."),
        ),
      "approved label",
    );
    expect(
      context.fake.calls.filter((call) => call.method === "PATCH").map((call) => call.body.content),
    ).not.toContain("This approval was handled in the desktop app.");
  });
});

describe("discord mention helpers", () => {
  it("strips user and nick mentions and titles threads safely", () => {
    expect(messageMentionsDiscordBot("hey <@99> there", "99")).toBe(true);
    expect(messageMentionsDiscordBot("hey <@!99>", "99")).toBe(true);
    expect(messageMentionsDiscordBot("hey <@88>", "99")).toBe(false);
    expect(stripDiscordBotMentions("<@99> find AI jobs", "99")).toBe("find AI jobs");
    expect(stripDiscordBotMentions("<@!99>", "99")).toBe("");
    expect(discordThreadTitleFromText("")).toBe("Conversation");
    expect(discordThreadTitleFromText("   \n\t")).toBe("Conversation");
    expect(discordThreadTitleFromText("x".repeat(120)).length).toBeLessThanOrEqual(100);
  });
});
