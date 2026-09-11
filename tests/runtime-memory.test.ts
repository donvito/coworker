import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { DesktopAppService } from "@main/app/app-service";
import { MemoryCredentialStore } from "@main/security/credential-store";
import { modelProviderBaseUrlKey, modelProviderCredentialKey } from "@shared/model-providers";
import type { MainToWorkerMessage } from "@main/runtime/protocol";

async function waitFor(predicate: () => boolean, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the memory test runtime");
    await new Promise((done) => setTimeout(done, 10));
  }
}

describe("real worker memory context", () => {
  it("refreshes across reused workers, conversations, schedules, approvals, and restarts", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-runtime-memory-"));
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const runs: Array<Extract<MainToWorkerMessage, { type: "run" }>> = [];
    const workers: Worker[] = [];
    // This local provider checks the actual model payload. Its fixed reply is
    // transport plumbing, not an evaluation of a model's memory decisions.
    const server = createServer(async (request, response) => {
      if (request.url?.endsWith("/models")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: [{ id: "memory-test" }] }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Received." }, finish_reason: null }] })}\n\n`);
      response.end(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
    const credentials = new MemoryCredentialStore();
    const service = new DesktopAppService({ dataPath: root, credentials, workerFactory: () => {
      const worker = new Worker(resolve("out/main/runtime/coworker-worker.js"));
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (value: MainToWorkerMessage) => {
        if (value.type === "run") runs.push(value);
        post(value);
      };
      workers.push(worker);
      return worker;
    } });
    try {
      await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Server unavailable");
      const provider = "openai-compatible:memory-test";
      await credentials.set(modelProviderCredentialKey(provider), "test-local-key");
      await credentials.set(modelProviderBaseUrlKey(provider), `http://127.0.0.1:${address.port}/v1`);
      await service.initialize();
      const coworker = await service.createCoworker({ name: "Memory test", role: "Tester", systemPrompt: "Reply briefly.", modelProvider: provider, modelName: "memory-test", enabledTools: [] });
      const other = await service.createCoworker({ name: "Other", role: "Tester", systemPrompt: "Reply briefly.", modelProvider: provider, modelName: "memory-test", enabledTools: [] });
      const store = async (id: string, content: string) => service.updateMemory(id, { content, expectedRevision: (await service.readMemory(id)).revision });
      const run = async (id = coworker.id, threadId?: string) => {
        const task = service.database.createTask({ coworkerId: id, title: "Context check", input: "Say hello", threadId });
        service.runtime.enqueueTask(id);
        await waitFor(() => ["COMPLETED", "FAILED"].includes(service.database.getTask(task.id).status));
        expect(service.database.getTask(task.id).error).toBeNull();
        return task;
      };
      const system = () => requests.at(-1)!.messages.filter((message) => ["system", "developer"].includes(message.role)).map((message) => message.content).join("\n");

      await store(coworker.id, "FIRST_MEMORY_MARKER\n- Default document format: PDF");
      await run();
      expect(system()).toContain("FIRST_MEMORY_MARKER");
      expect(system()).toContain("Default document format: PDF");
      // Format workflow belongs to the selectable authoring skill. A global
      // prohibition on defaults would suppress memory-informed suggestions.
      expect(system()).not.toContain("Never choose Markdown or any other format by default");
      expect(system()).not.toContain("Document format rule:");
      expect(system().match(/Saved context for this coworker/g)).toHaveLength(1);
      const firstWorker = workers[0];
      await store(coworker.id, "UPDATED_MEMORY_MARKER");
      await run();
      expect(workers).toHaveLength(1);
      expect(workers[0]).toBe(firstWorker);
      expect(system()).toContain("UPDATED_MEMORY_MARKER");
      expect(system()).not.toContain("FIRST_MEMORY_MARKER");
      const conversation = service.database.createConversation({ coworkerId: coworker.id });
      await run(coworker.id, conversation.id);
      expect(system()).toContain("UPDATED_MEMORY_MARKER");
      await run(other.id);
      expect(system()).not.toContain("UPDATED_MEMORY_MARKER");
      expect(system()).not.toContain("Saved context for this coworker");

      const schedule = await service.createSchedule({ coworkerId: coworker.id, name: "Memory check", scheduleType: "cron", cronExpression: "0 9 * * *", timezone: "UTC", taskTemplate: { title: "Check", input: "Say hello" } });
      const scheduled = await service.runScheduleNow(schedule.id);
      await waitFor(() => ["COMPLETED", "FAILED"].includes(service.database.getTask(scheduled.id).status));
      expect(service.database.getTask(scheduled.id).status).toBe("COMPLETED");
      expect(system()).toContain("UPDATED_MEMORY_MARKER");

      // Model writes use the same boundary; a resumed approval dispatch must
      // load the result after applying the approved write.
      const task = service.database.createTask({ coworkerId: coworker.id, title: "Approval", input: "Remember approved text" });
      const current = await service.readMemory(coworker.id);
      const approval = await service.tools.request({ task, coworker: { ...coworker, policies: { "files.write": "approval" } }, toolName: "files.write", toolCallId: "approval-write", arguments: { path: "MEMORY.md", content: "APPROVED_MEMORY_MARKER", expectedRevision: current.revision } });
      if (approval.kind !== "approval") throw new Error("Approval unavailable");
      service.database.decideApproval({ approvalId: approval.approval.id, decision: "approve" });
      service.runtime.enqueueTask(coworker.id);
      await waitFor(() => ["COMPLETED", "FAILED"].includes(service.database.getTask(task.id).status));
      expect(service.database.getTask(task.id).error).toBeNull();
      expect(runs.at(-1)?.resume).toMatchObject({ decision: "approved" });
      expect(system()).toContain("APPROVED_MEMORY_MARKER");

      await service.runtime.stop(coworker.id);
      await run();
      expect(system()).toContain("APPROVED_MEMORY_MARKER");
      await store(coworker.id, "");
      await run();
      expect(system()).not.toContain("Saved context for this coworker");
      expect(system()).not.toContain("APPROVED_MEMORY_MARKER");

      // Externally edited Markdown is picked up without an app restart.
      await writeFile(join(coworker.workspacePath, "MEMORY.md"), "EXTERNAL_MEMORY_MARKER");
      await run();
      expect(system()).toContain("EXTERNAL_MEMORY_MARKER");
      const before = requests.length;
      await writeFile(join(coworker.workspacePath, "MEMORY.md"), "x".repeat(8001));
      const failed = service.database.createTask({ coworkerId: coworker.id, title: "Invalid memory", input: "Say hello" });
      service.runtime.enqueueTask(coworker.id);
      await waitFor(() => service.database.getTask(failed.id).status === "FAILED");
      expect(service.database.getTask(failed.id).error).toContain("Could not load MEMORY.md");
      expect(requests).toHaveLength(before);
    } finally {
      await service.shutdown();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
