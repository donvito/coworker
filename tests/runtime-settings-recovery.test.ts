import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { DesktopAppService } from "@main/app/app-service";
import { MemoryCredentialStore } from "@main/security/credential-store";
import { modelProviderBaseUrlKey, modelProviderCredentialKey } from "@shared/model-providers";

interface ChatRequest {
  model?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
}

function deferred<T = void>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function waitFor(predicate: () => boolean, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for settings recovery");
    await new Promise((done) => setTimeout(done, 10));
  }
}

function sendCompletion(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({
      id: "settings-recovery",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant", content: "Replacement response." }, finish_reason: null }],
    })}\n\n` +
      `data: ${JSON.stringify({
        id: "settings-recovery",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\ndata: [DONE]\n\n`,
  );
}

describe("real worker settings recovery", () => {
  it("sends the updated profile to a new chat while preserving custom operating instructions", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-profile-refresh-"));
    const requests: ChatRequest[] = [];
    const server = createServer(async (request, response) => {
      if (request.url?.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "profile-model" }] }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest);
      sendCompletion(response);
    });
    const credentials = new MemoryCredentialStore();
    const service = new DesktopAppService({
      dataPath: root,
      credentials,
      workerFactory: () => new Worker(resolve("out/main/runtime/coworker-worker.js")),
    });
    try {
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Server unavailable");
      const provider = "openai-compatible:profile-refresh" as const;
      await credentials.set(modelProviderCredentialKey(provider), "test-local-key");
      await credentials.set(modelProviderBaseUrlKey(provider), `http://127.0.0.1:${address.port}/v1`);
      await service.initialize();
      const instructions = "You are Ava, an accounting coworker. Preserve CUSTOM_WORK_RULE.";
      const coworker = await service.createCoworker({
        name: "Ava", role: "Accountant", description: "OLD_PROFILE_DESCRIPTION",
        systemPrompt: instructions, modelProvider: provider, modelName: "profile-model", enabledTools: [],
      });
      const runNewChat = async () => {
        const conversation = service.database.createConversation({ coworkerId: coworker.id });
        const task = service.createTask({ coworkerId: coworker.id, title: "Hello", input: "Hi", threadId: conversation.id });
        await waitFor(() => ["COMPLETED", "FAILED"].includes(service.database.getTask(task.id).status));
        expect(service.database.getTask(task.id).status).toBe("COMPLETED");
        return requests.at(-1)!.messages!.filter((message) => ["system", "developer"].includes(message.role ?? ""))
          .map((message) => message.content).join("\n");
      };
      expect(await runNewChat()).toContain("OLD_PROFILE_DESCRIPTION");
      await service.updateCoworker(coworker.id, {
        name: "Nova", role: "Generalist", description: "NEW_PROFILE_DESCRIPTION: help across varied tasks.",
      });
      const refreshed = await runNewChat();
      expect(refreshed).toContain("Nova");
      expect(refreshed).toContain("Generalist");
      expect(refreshed).toContain("NEW_PROFILE_DESCRIPTION");
      expect(refreshed).not.toContain("OLD_PROFILE_DESCRIPTION");
      expect(refreshed).toContain(instructions);
      expect(refreshed).toContain("It takes precedence over conflicting or stale identity details");
      expect(refreshed.indexOf("Current coworker profile (authoritative identity)")).toBeGreaterThan(refreshed.indexOf(instructions));
      expect(service.database.getCoworker(coworker.id).systemPrompt).toBe(instructions);
      await service.updateCoworker(coworker.id, { description: null });
      expect(await runNewChat()).not.toContain("NEW_PROFILE_DESCRIPTION");
    } finally {
      await service.shutdown();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("requeues active and queued work after a settings change during inference", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-runtime-settings-recovery-"));
    const requests: ChatRequest[] = [];
    const firstRequestReceived = deferred();
    let firstRequestWasAborted = false;
    let heldResponse: ServerResponse | null = null;
    const server = createServer((request, response) => {
      if (request.url?.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "hold-model" }, { id: "replacement-model" }] }));
        return;
      }

      const chunks: Buffer[] = [];
      const markFirstRequestAborted = () => {
        if (firstRequestWasAborted) return;
        firstRequestWasAborted = true;
        heldResponse = null;
      };
      request.on("aborted", () => {
        markFirstRequestAborted();
        response.destroy();
      });
      request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        let body: ChatRequest;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest;
        } catch {
          response.writeHead(400);
          response.end("invalid request");
          return;
        }
        requests.push(body);
        if (body.model === "hold-model") {
          heldResponse = response;
          response.once("close", markFirstRequestAborted);
          firstRequestReceived.resolve();
          return;
        }
        sendCompletion(response);
      });
    });
    const credentials = new MemoryCredentialStore();
    const workers: Worker[] = [];
    const service = new DesktopAppService({
      dataPath: root,
      credentials,
      workerFactory: () => {
        const worker = new Worker(resolve("out/main/runtime/coworker-worker.js"));
        workers.push(worker);
        return worker;
      },
    });
    try {
      await new Promise<void>((done, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", done);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Server unavailable");
      const provider = "openai-compatible:settings-recovery" as const;
      await credentials.set(modelProviderCredentialKey(provider), "test-local-key");
      await credentials.set(
        modelProviderBaseUrlKey(provider),
        `http://127.0.0.1:${address.port}/v1`,
      );
      await service.initialize();
      const coworker = await service.createCoworker({
        name: "Settings recovery test",
        role: "Tester",
        systemPrompt: "Use the old settings.",
        modelProvider: provider,
        modelName: "hold-model",
        enabledTools: [],
      });

      const first = service.createTask({
        coworkerId: coworker.id,
        title: "First pending task",
        input: "Complete the first pending task.",
      });
      await firstRequestReceived.promise;
      expect(service.database.getTask(first.id).status).toBe("RUNNING");

      const second = service.createTask({
        coworkerId: coworker.id,
        title: "Second queued task",
        input: "Complete the second queued task.",
      });
      await waitFor(() => service.database.getTask(second.id).status === "QUEUED");

      await service.updateCoworker(coworker.id, {
        modelName: "replacement-model",
        systemPrompt: "Use FRESH_SETTINGS_MARKER and finish the task.",
      });
      await waitFor(() => firstRequestWasAborted);

      try {
        await waitFor(
          () =>
            service.database.getTask(first.id).status === "COMPLETED" &&
            service.database.getTask(second.id).status === "COMPLETED",
        );
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; ` +
            `first task=${service.database.getTask(first.id).status}, ` +
            `second task=${service.database.getTask(second.id).status}`,
        );
      }

      expect(service.database.getTask(first.id).error).toBeNull();
      expect(service.database.getTask(second.id).error).toBeNull();
      expect(service.database.getTask(first.id).result).toContain("Replacement response");
      expect(service.database.getTask(second.id).result).toContain("Replacement response");
      const replacementRequests = requests.filter(
        (request) => request.model === "replacement-model",
      );
      expect(replacementRequests.length).toBeGreaterThanOrEqual(2);
      expect(
        replacementRequests.every((request) =>
          request.messages?.some(
            (message) =>
              typeof message.content === "string" &&
              message.content.includes("FRESH_SETTINGS_MARKER"),
          ),
        ),
      ).toBe(true);
      await service.providerErrors.flush();
      expect(await service.providerErrors.list()).toEqual([]);
    } finally {
      (heldResponse as ServerResponse | null)?.destroy();
      await service.shutdown();
      await new Promise<void>((done) => server.close(() => done()));
      await Promise.all(workers.map((worker) => worker.terminate()));
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
