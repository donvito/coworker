import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAppService } from "@main/app/app-service";
import { createAdministration } from "@main/control/administration";
import { getRuntimeModelConfiguration } from "@main/integrations/model-catalog";
import { MemoryCredentialStore } from "@main/security/credential-store";
import type { MainToWorkerMessage, WorkerToMainMessage } from "@main/runtime/protocol";
import { ipcChannels } from "@shared/ipc";
import { configureModelSchema, credentialKeySchema } from "@shared/validation";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function authState(
  mode: "api-key" | "chatgpt-subscription" = "chatgpt-subscription",
  accounts = [
    { id: "acct-one", clientId: "dynamic-one", subject: "subject-one", label: "Personal", email: "one@example.test", accessToken: "access-one", expiresAt: Date.now() + 3_600_000, scopes: ["chatgpt.tokens.use.direct", "resource.invoke"] },
    { id: "acct-two", clientId: "dynamic-two", subject: "subject-two", label: "Work", email: "two@example.test", accessToken: "access-two", expiresAt: Date.now() + 3_600_000, scopes: ["chatgpt.tokens.use.direct", "resource.invoke"] },
  ],
) {
  return JSON.stringify({
    schema: 1,
    hostId: "urn:uuid:1ecb05e4-6a13-4b93-bc0d-7b78b9d626e2",
    mode,
    activeAccountId: accounts[0]?.id ?? null,
    welcomeSeen: false,
    accounts,
  });
}

function catalogResponse(accountToken: string) {
  const models = accountToken === "access-two"
    ? [
        { slug: "custom-unbundled-b", display_name: "Shared coworker model", visibility: "list" },
        { slug: "account-two-only", display_name: "Account Two", visibility: "list", capabilities: ["ignored"] },
      ]
    : [
        { slug: "custom-unbundled-b", display_name: "Second in server order", visibility: "list" },
        { slug: "hidden", display_name: "Hidden", visibility: "hidden" },
        { slug: "custom-unbundled-a", display_name: "First in server order", visibility: "list" },
      ];
  return new Response(JSON.stringify({ models }), { status: 200, headers: { "content-type": "application/json" } });
}

function fakeFetch() {
  return vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const token = new Headers(init?.headers).get("Authorization")?.replace(/^Bearer\s+/i, "");
    return catalogResponse(token ?? "");
  });
}

class FakeWorker extends EventEmitter {
  readonly messages: MainToWorkerMessage[] = [];
  private coworkerId: string | null = null;
  private exited = false;

  postMessage(message: MainToWorkerMessage): void {
    this.messages.push(message);
    if (message.type === "initialize") {
      this.coworkerId = message.config.coworker.id;
      queueMicrotask(() => this.emit("message", { type: "ready", coworkerId: this.coworkerId }));
    } else if (message.type === "shutdown") {
      queueMicrotask(() => this.emitExit(0));
    }
  }

  async terminate(): Promise<number> {
    this.emitExit(0);
    return 0;
  }

  emitMessage(message: WorkerToMainMessage): void {
    this.emit("message", message);
  }

  private emitExit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code);
  }
}

describe("ChatGPT subscription as the OpenAI provider", () => {
  it("validates OpenAI auth-mode choices and keeps the encrypted account blob out of generic credential access", () => {
    expect(configureModelSchema.safeParse({
      provider: "openai",
      authMode: "chatgpt-subscription",
    }).success).toBe(true);
    expect(configureModelSchema.safeParse({
      provider: "openai",
      authMode: "chatgpt-subscription",
      apiKey: "should-not-be-combined",
    }).success).toBe(false);
    expect(configureModelSchema.safeParse({
      provider: "anthropic",
      authMode: "api-key",
    }).success).toBe(false);
    expect(credentialKeySchema.safeParse("model:openai:chatgpt").success).toBe(false);
  });

  it("uses the selected account catalog in server order without a bundled-model intersection", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-chatgpt-catalog-"));
    temporaryPaths.push(root);
    const credentials = new MemoryCredentialStore();
    await credentials.set("model:openai:chatgpt", authState());
    await credentials.set("model:openai", "inactive-api-key");
    const fetchImpl = fakeFetch();
    const service = new DesktopAppService({
      dataPath: root,
      credentials,
      chatgpt: { fetchImpl: fetchImpl as unknown as typeof fetch, openExternal: async () => undefined },
    });
    try {
      const models = await service.listModels("openai");
      expect(models.map(({ id }) => id)).toEqual(["custom-unbundled-b", "custom-unbundled-a"]);
      expect(models.every((model) => !model.supportsImages)).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe("Bearer access-one");

      const runtime = await getRuntimeModelConfiguration(
        "openai",
        "custom-unbundled-b",
        credentials,
        service.chatgptAuth,
        fetchImpl as unknown as typeof fetch,
      );
      expect(runtime).toMatchObject({
        authMode: "chatgpt-subscription",
        chatgptAccountId: "acct-one",
        supportsImages: false,
        contextWindow: 32_768,
      });
      expect(runtime).not.toHaveProperty("apiKey");
    } finally {
      await service.shutdown();
    }
  });

  it("redacts subscription tokens and auth callback details echoed by the model server", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-chatgpt-redaction-"));
    temporaryPaths.push(root);
    const credentials = new MemoryCredentialStore();
    await credentials.set("model:openai:chatgpt", authState());
    const service = new DesktopAppService({
      dataPath: root,
      credentials,
      chatgpt: {
        fetchImpl: vi.fn(async () => new Response(JSON.stringify({
          error: {
            message: "Bearer fakebearer access-one http://localhost/oauth/callback?code=callback-secret",
          },
        }), { status: 500 })) as unknown as typeof fetch,
        openExternal: async () => undefined,
      },
    });
    try {
      const error = await service.listModels("openai").then(
        () => new Error("Expected model discovery to fail"),
        (reason: unknown) => reason instanceof Error ? reason : new Error(String(reason)),
      );
      const message = error.message;
      expect(message).toContain("Could not query OpenAI models");
      expect(message).not.toContain("access-one");
      expect(message).not.toContain("fakebearer");
      expect(message).not.toContain("callback-secret");
      expect(message).toContain("[REDACTED_AUTH_URL]");
      const log = await readFile(join(root, "logs", "provider-errors.jsonl"), "utf8");
      expect(log).not.toContain("access-one");
      expect(log).not.toContain("fakebearer");
      expect(log).not.toContain("callback-secret");
    } finally {
      await service.shutdown();
    }
  });

  it("requires an explicit API-key mode and preserves an inactive key during subscription setup", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-chatgpt-mode-"));
    temporaryPaths.push(root);
    const credentials = new MemoryCredentialStore();
    await credentials.set("model:openai:chatgpt", authState());
    await credentials.set("model:openai", "inactive-api-key");
    const service = new DesktopAppService({
      dataPath: root,
      credentials,
      chatgpt: { fetchImpl: fakeFetch() as unknown as typeof fetch, openExternal: async () => undefined },
    });
    try {
      await expect(service.configureModel({ provider: "openai", apiKey: "new-api-key" }))
        .rejects.toThrow(/choose API key sign-in explicitly/i);
      expect(await credentials.get("model:openai")).toBe("inactive-api-key");

      const result = await service.configureModel({
        provider: "openai",
        authMode: "chatgpt-subscription",
        defaultModelName: "custom-unbundled-a",
      });
      expect(result).toMatchObject({ configured: true, authMode: "chatgpt-subscription", defaultApplied: true });
      expect(await credentials.get("model:openai")).toBe("inactive-api-key");
      expect(service.database.getSettings()).toMatchObject({
        defaultModelProvider: "openai",
        defaultModelName: "custom-unbundled-a",
      });
    } finally {
      await service.shutdown();
    }
  });

  it("retries only exact manual tasks after an explicit user send", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-chatgpt-user-retry-"));
    temporaryPaths.push(root);
    const credentials = new MemoryCredentialStore();
    await credentials.set("model:openai:chatgpt", authState());
    const service = new DesktopAppService({
      dataPath: root,
      credentials,
      chatgpt: { fetchImpl: fakeFetch() as unknown as typeof fetch, openExternal: async () => undefined },
    });
    const coworker = service.database.createCoworker({
      name: "Quota paused coworker",
      role: "Research assistant",
      systemPrompt: "You are helpful.",
      modelProvider: "openai",
      modelName: "custom-unbundled-b",
      enabledTools: [],
    }, join(root, "quota-coworker"));
    const conversation = service.createConversation({ coworkerId: coworker.id, title: "Manual retry" });
    const enqueue = vi.spyOn(service.runtime, "enqueueTask").mockImplementation(() => undefined);
    const resume = vi.spyOn(service.runtime, "resumeAfterUserAction").mockImplementation(() => undefined);

    try {
      const receipt = await service.sendConversationMessageFromUser({
        conversationId: conversation.id,
        clientMessageId: "manual-user-message",
        content: "Please try again.",
        mentionedCoworkerIds: [],
      });
      expect(receipt.runs).toHaveLength(1);
      expect(resume).toHaveBeenCalledExactlyOnceWith(coworker.id, receipt.runs[0]!.taskId);
      expect(service.database.getTask(receipt.runs[0]!.taskId).source).toBe("manual");

      resume.mockClear();
      const createdTask = service.createTask({
        coworkerId: coworker.id,
        title: "Manual task",
        input: "Run this task after the limit notice.",
      });
      expect(resume).toHaveBeenCalledExactlyOnceWith(coworker.id, createdTask.id);

      resume.mockClear();
      const automatedReceipt = await service.sendConversationMessage({
        conversationId: conversation.id,
        clientMessageId: "bridge-message",
        content: "A bridge-delivered message.",
        mentionedCoworkerIds: [],
      });
      expect(automatedReceipt.runs).toHaveLength(1);
      expect(resume).not.toHaveBeenCalled();
      expect(enqueue).toHaveBeenCalled();

      const taggedCoworker = service.database.createCoworker({
        name: "Quinn",
        role: "Research assistant",
        systemPrompt: "You are helpful.",
        modelProvider: "demo",
        modelName: "faux-1",
        enabledTools: [],
      }, join(root, "tagged-coworker"));
      const taggedReceipt = await service.sendConversationMessageFromUser({
        conversationId: conversation.id,
        clientMessageId: "tagged-user-message",
        content: "@Quinn please investigate.",
        mentionedCoworkerIds: [taggedCoworker.id],
      });
      const peerTask = service.database.listTasks(taggedCoworker.id)[0]!;
      expect(taggedReceipt.runs).toEqual([]);
      expect(resume).toHaveBeenCalledExactlyOnceWith(taggedCoworker.id, peerTask.id);
    } finally {
      await service.shutdown();
    }
  });

  it("invalidates an unavailable default on account switch and recovers interrupted OpenAI work", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-chatgpt-switch-"));
    temporaryPaths.push(root);
    const credentials = new MemoryCredentialStore();
    await credentials.set("model:openai:chatgpt", authState());
    const workers: FakeWorker[] = [];
    const service = new DesktopAppService({
      dataPath: root,
      credentials,
      chatgpt: { fetchImpl: fakeFetch() as unknown as typeof fetch, openExternal: async () => undefined },
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    const coworker = service.database.createCoworker({
      name: "OpenAI coworker",
      role: "Research assistant",
      systemPrompt: "You are helpful.",
      modelProvider: "openai",
      modelName: "custom-unbundled-b",
      enabledTools: [],
    }, join(root, "openai-coworker"));
    service.database.updateSettings({ defaultModelProvider: "openai", defaultModelName: "custom-unbundled-a" });
    const task = service.database.createTask({ coworkerId: coworker.id, title: "Research", input: "Keep working" });

    try {
      service.runtime.enqueueTask(coworker.id);
      await waitFor(() => workers[0]?.messages.some((message) => message.type === "run") === true, "first OpenAI task");
      expect(service.database.getTask(task.id).status).toBe("RUNNING");
      expect(workers[0]?.messages.find((message) => message.type === "initialize")?.config.modelApiKey).toBeUndefined();
      expect(workers[0]?.messages.find((message) => message.type === "initialize")?.config.chatgptAccountId).toBe("acct-one");

      await service.chatgptAuth.selectAccount("acct-two");
      await waitFor(() => workers.length === 2, "replacement OpenAI worker");
      await waitFor(() => workers[1]?.messages.some((message) => message.type === "run") === true, "recovered OpenAI task");
      expect(service.database.getTask(task.id).status).toBe("RUNNING");
      expect(workers[1]?.messages.find((message) => message.type === "initialize")?.config.chatgptAccountId).toBe("acct-two");
      expect(service.database.getCoworker(coworker.id).modelName).toBe("custom-unbundled-b");
      expect(service.database.getSettings()).toMatchObject({ defaultModelProvider: null, defaultModelName: null });
      await expect(getRuntimeModelConfiguration(
        "openai",
        "custom-unbundled-a",
        credentials,
        service.chatgptAuth,
        fakeFetch() as unknown as typeof fetch,
      )).rejects.toThrow(/not available to the selected ChatGPT account/i);
    } finally {
      await service.shutdown();
    }
  });

  it("disconnects only the selected ChatGPT subscription credentials and reports revocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-chatgpt-disconnect-"));
    temporaryPaths.push(root);
    const credentials = new MemoryCredentialStore();
    const savedAuth = JSON.parse(authState()) as {
      accounts: Array<Record<string, unknown>>;
    };
    savedAuth.accounts[0]!.refreshToken = "refresh-one";
    await credentials.set("model:openai:chatgpt", JSON.stringify(savedAuth));
    await credentials.set("model:openai", "inactive-api-key");
    const service = new DesktopAppService({
      dataPath: root,
      credentials,
      chatgpt: {
        fetchImpl: vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
        openExternal: async () => undefined,
      },
    });
    const administration = createAdministration({ service, credentials });
    try {
      const result = await service.disconnectModelProvider("openai");
      expect(result).toEqual({ revocationConfirmed: false });
      expect(await credentials.get("model:openai")).toBe("inactive-api-key");
      expect((await service.chatgptAuth.status()).state).toBe("disconnected");
      const savedAuth = await credentials.get("model:openai:chatgpt");
      expect(savedAuth).toContain('"activeAccountId":null');
      expect(savedAuth).toContain('"label":"Personal"');
      expect(savedAuth).not.toContain("access-one");
      expect(await administration.invoke(ipcChannels.integrationsCredentialStatus, ["model:openai"]))
        .toMatchObject({ configured: false, needsReentry: false });
      await administration.invoke(ipcChannels.integrationsRemoveCredential, ["model:openai"]);
      expect(await credentials.get("model:openai")).toBeNull();
      expect(await credentials.get("model:openai:chatgpt")).toContain('"activeAccountId":null');
    } finally {
      await service.shutdown();
    }
  });
});
