import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { DesktopAppService } from "@main/app/app-service";
import { MemoryCredentialStore } from "@main/security/credential-store";
import { modelProviderBaseUrlKey, modelProviderCredentialKey } from "@shared/model-providers";
import type { Task } from "@shared/contracts";

it("delivers per-request channel metadata to a reused real worker and preserves it on approval/restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "coworker-request-context-"));
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  // Inspect actual model inputs without sending anything to Discord or Telegram.
  const server = createServer(async (request, response) => {
    if (request.url?.endsWith("/models")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "context-test" }] }));
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
  const service = new DesktopAppService({ dataPath: root, credentials,
    workerFactory: () => new Worker(resolve("out/main/runtime/coworker-worker.js")),
  });
  const waitForTask = async (task: Task) => {
    const deadline = Date.now() + 10_000;
    while (!["COMPLETED", "FAILED"].includes(service.database.getTask(task.id).status)) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for request context test");
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(service.database.getTask(task.id).error).toBeNull();
  };
  const context = () => {
    const system = requests.at(-1)!.messages.filter((m) => ["system", "developer"].includes(m.role)).map((m) => m.content).join("\n");
    const marker = "Current request context (transport metadata):\n";
    expect(system.split(marker)).toHaveLength(2);
    return JSON.parse(system.split(marker)[1]!);
  };
  try {
    await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server unavailable");
    const provider = "openai-compatible:context-test";
    await credentials.set(modelProviderCredentialKey(provider), "local-test");
    await credentials.set(modelProviderBaseUrlKey(provider), `http://127.0.0.1:${address.port}/v1`);
    await service.initialize();
    const coworker = await service.createCoworker({ name: "Channel test", role: "Tester", systemPrompt: "Reply briefly.", modelProvider: provider, modelName: "context-test", enabledTools: ["discord.send", "telegram.send", "files.write"] });
    const conversation = service.database.createConversation({ coworkerId: coworker.id });
    const approvalMessage = service.database.addMessage({ conversationId: conversation.id, coworkerId: null, authorName: "You", taskId: null, role: "user", content: "send it to me", mentionedCoworkerIds: [] }, "discord:approval");
    for (const [id, channel, text] of [
      ["discord:100", "discord", "send it to me"],
      ["telegram:101", "telegram", "send it here"],
      ["desktop-102", "local", "Send it to Discord"],
      ["discord:103", "discord", "Send it to Telegram"],
    ]) {
      const receipt = await service.sendConversationMessage({ conversationId: conversation.id, clientMessageId: id!, content: text!, mentionedCoworkerIds: [] });
      const task = service.database.getTask(receipt.runs[0]!.taskId);
      await waitForTask(task);
      expect(context()).toEqual({ channel, source: "manual" });
      expect(task.input).toBe(text);
    }
    await service.runtime.stop(coworker.id);
    // Resume a task tied to the original Discord message after other channels
    // have used the same conversation. The latest thread activity is irrelevant.
    const task = service.database.createTask({ coworkerId: coworker.id, title: "Approval", input: "send it to me", threadId: conversation.id, sourceMessageId: approvalMessage.id, persistUserMessage: false });
    const approval = await service.tools.request({ task, coworker: { ...coworker, policies: { ...coworker.policies, "files.write": "approval" } }, toolName: "files.write", toolCallId: "context-approval", arguments: { path: "approved.txt", content: "test" } });
    if (approval.kind !== "approval") throw new Error("Expected approval");
    service.database.decideApproval({ approvalId: approval.approval.id, decision: "approve" });
    service.runtime.enqueueTask(coworker.id);
    await waitForTask(task);
    expect(context()).toEqual({ channel: "discord", source: "manual" });
    const scheduled = service.database.createTask({ coworkerId: coworker.id, title: "Schedule", input: "Say hello", source: "schedule", threadId: conversation.id });
    service.runtime.enqueueTask(coworker.id);
    await waitForTask(scheduled);
    expect(context()).toEqual({ channel: null, source: "schedule" });
    // Application recovery mutates task.source. The saved message identity
    // still identifies the incoming channel for the recovered dispatch.
    for (const channel of ["discord", "telegram", "local"] as const) {
      await service.runtime.stop(coworker.id);
      const message = service.database.addMessage({ conversationId: conversation.id, coworkerId: null, authorName: "You", taskId: null, role: "user", content: "send it here", mentionedCoworkerIds: [] }, `${channel}:recovery`);
      const interrupted = service.database.createTask({ coworkerId: coworker.id, title: "Recovered request", input: message.content, threadId: conversation.id, sourceMessageId: message.id, persistUserMessage: false });
      service.database.setTaskStatus(interrupted.id, "RUNNING");
      expect(service.database.recoverInterruptedTasks()).toBe(1);
      service.runtime.enqueueTask(coworker.id);
      await waitForTask(interrupted);
      expect(context()).toEqual({ channel, source: "recovery" });
    }
  } finally {
    await service.shutdown();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
