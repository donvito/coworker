import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { EventType } from "@ag-ui/core";
import { describe, expect, it } from "vitest";
import { DesktopAppService } from "@main/app/app-service";
import { MemoryCredentialStore } from "@main/security/credential-store";
import { modelProviderBaseUrlKey, modelProviderCredentialKey } from "@shared/model-providers";
import type { DesktopEvent } from "@shared/contracts";

interface ChatRequest {
  model?: string;
  messages?: Array<{ role?: string; content?: unknown; tool_call_id?: string }>;
}

async function waitFor(predicate: () => boolean, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the real worker tool-error test");
    }
    await new Promise((done) => setTimeout(done, 10));
  }
}

function sendStream(
  response: import("node:http").ServerResponse,
  chunks: unknown[],
): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      "data: [DONE]\n\n",
  );
}

function completionChunk(
  id: string,
  delta: Record<string, unknown>,
  finishReason: string | null,
) {
  return {
    id,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

describe("real worker tool errors", () => {
  it("surfaces unknown, invalid, and policy-denied tool calls as useful error results", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-runtime-tool-errors-"));
    const requests: ChatRequest[] = [];
    const events: DesktopEvent[] = [];
    const workers: Worker[] = [];
    const server = createServer(async (request, response) => {
      if (request.url?.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "tool-error-model" }] }));
        return;
      }
      if (!request.url?.endsWith("/chat/completions")) {
        response.writeHead(404);
        response.end("not found");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest);
      const turn = requests.length;
      if (turn === 1) {
        sendStream(response, [
          completionChunk(
            "tool-error-unknown",
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "unknown-tool-call",
                  type: "function",
                  function: {
                    name: "document_authoring",
                    arguments: JSON.stringify({ name: "failed-document" }),
                  },
                },
              ],
            },
            null,
          ),
          completionChunk("tool-error-unknown", {}, "tool_calls"),
        ]);
        return;
      }
      if (turn === 2) {
        sendStream(response, [
          completionChunk(
            "tool-error-invalid-format",
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "invalid-format-call",
                  type: "function",
                  function: {
                    name: "documents_export",
                    arguments: JSON.stringify({
                      name: "failed-document",
                      content: "# Failed document",
                      formats: ["EPUB"],
                    }),
                  },
                },
              ],
            },
            null,
          ),
          completionChunk("tool-error-invalid-format", {}, "tool_calls"),
        ]);
        return;
      }
      if (turn === 3) {
        sendStream(response, [
          completionChunk(
            "tool-error-denied",
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "denied-export-call",
                  type: "function",
                  function: {
                    name: "documents_export",
                    arguments: JSON.stringify({
                      name: "failed-document",
                      content: "# Failed document",
                      formats: ["pdf"],
                    }),
                  },
                },
              ],
            },
            null,
          ),
          completionChunk("tool-error-denied", {}, "tool_calls"),
        ]);
        return;
      }
      sendStream(response, [
        completionChunk(
          "tool-error-final",
          {
            role: "assistant",
            content:
              "I could not create the document: the requested tool was unknown, EPUB is unsupported, and document export is denied by policy.",
          },
          null,
        ),
        completionChunk("tool-error-final", {}, "stop"),
      ]);
    });
    const credentials = new MemoryCredentialStore();
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
      const provider = "openai-compatible:tool-errors" as const;
      await credentials.set(modelProviderCredentialKey(provider), "test-local-key");
      await credentials.set(
        modelProviderBaseUrlKey(provider),
        `http://127.0.0.1:${address.port}/v1`,
      );
      await service.initialize();
      const coworker = await service.createCoworker({
        name: "Tool error tester",
        role: "Test worker",
        systemPrompt: "Report tool failures clearly.",
        modelProvider: provider,
        modelName: "tool-error-model",
        enabledTools: ["documents.export"],
        policies: { "documents.export": "denied" },
      });
      const unsubscribe = service.subscribe((event) => events.push(event));
      const task = service.createTask({
        coworkerId: coworker.id,
        title: "Exercise tool errors",
        input: "Create the failed document as a PDF.",
      });

      await waitFor(() => ["COMPLETED", "FAILED"].includes(service.database.getTask(task.id).status));
      expect(service.database.getTask(task.id).status).toBe("COMPLETED");
      expect(service.database.getTask(task.id).result).toContain("could not create the document");
      expect(requests).toHaveLength(4);

      const toolResults = events
        .filter(
          (event): event is Extract<DesktopEvent, { type: "agent.event" }> =>
            event.type === "agent.event" &&
            event.taskId === task.id &&
            event.event.type === EventType.TOOL_CALL_RESULT,
        )
        .map((event) => {
          if (typeof event.event.content !== "string") {
            throw new Error("Tool result event content was not serialized text");
          }
          return {
            toolCallId: event.event.toolCallId,
            toolName:
              event.event.toolCallId === "unknown-tool-call"
                ? "document_authoring"
                : "documents.export",
            payload: JSON.parse(event.event.content) as { isError?: boolean; error?: string },
          };
        });
      expect(toolResults).toHaveLength(3);
      expect(toolResults[0]).toMatchObject({
        toolCallId: "unknown-tool-call",
        toolName: "document_authoring",
        payload: { isError: true, error: expect.stringContaining("not found") },
      });
      expect(toolResults[1]).toMatchObject({
        toolCallId: "invalid-format-call",
        toolName: "documents.export",
        payload: {
          isError: true,
          error: expect.stringContaining("Validation failed"),
        },
      });
      expect(toolResults[1]?.payload.error).toContain("formats.0");
      expect(toolResults[1]?.payload.error).toContain("EPUB");
      expect(toolResults[2]).toMatchObject({
        toolCallId: "denied-export-call",
        toolName: "documents.export",
        payload: {
          isError: true,
          error: expect.stringContaining("denied by policy"),
        },
      });
      expect(service.database.listArtifacts(coworker.id)).toEqual([]);
      expect(service.database.listToolCalls(task.id)).toEqual([
        expect.objectContaining({
          toolName: "documents.export",
          status: "DENIED",
        }),
      ]);
      unsubscribe();
    } finally {
      await service.shutdown();
      await new Promise<void>((done) => server.close(() => done()));
      await Promise.all(workers.map((worker) => worker.terminate()));
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("accepts uppercase PDF from the real provider and records a successful artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-runtime-tool-success-"));
    const requests: ChatRequest[] = [];
    const events: DesktopEvent[] = [];
    const workers: Worker[] = [];
    const server = createServer(async (request, response) => {
      if (request.url?.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "tool-success-model" }] }));
        return;
      }
      if (!request.url?.endsWith("/chat/completions")) {
        response.writeHead(404);
        response.end("not found");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest);
      if (requests.length === 1) {
        sendStream(response, [
          completionChunk(
            "tool-success-export",
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "uppercase-pdf-call",
                  type: "function",
                  function: {
                    name: "documents_export",
                    arguments: JSON.stringify({
                      name: "uppercase-document",
                      content: "# Uppercase PDF\n\nCreated by the real worker test.",
                      formats: ["PDF"],
                    }),
                  },
                },
              ],
            },
            null,
          ),
          completionChunk("tool-success-export", {}, "tool_calls"),
        ]);
        return;
      }
      sendStream(response, [
        completionChunk(
          "tool-success-final",
          { role: "assistant", content: "Created the PDF successfully." },
          null,
        ),
        completionChunk("tool-success-final", {}, "stop"),
      ]);
    });
    const credentials = new MemoryCredentialStore();
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
      const provider = "openai-compatible:tool-success" as const;
      await credentials.set(modelProviderCredentialKey(provider), "test-local-key");
      await credentials.set(
        modelProviderBaseUrlKey(provider),
        `http://127.0.0.1:${address.port}/v1`,
      );
      await service.initialize();
      const coworker = await service.createCoworker({
        name: "Tool success tester",
        role: "Test worker",
        systemPrompt: "Create the requested document.",
        modelProvider: provider,
        modelName: "tool-success-model",
        enabledTools: ["documents.export"],
      });
      const unsubscribe = service.subscribe((event) => events.push(event));
      const task = service.createTask({
        coworkerId: coworker.id,
        title: "Create uppercase PDF",
        input: "Create the document as a PDF.",
      });

      await waitFor(() => ["COMPLETED", "FAILED"].includes(service.database.getTask(task.id).status));
      expect(service.database.getTask(task.id).status).toBe("COMPLETED");
      expect(service.database.getTask(task.id).result).toContain("Created the PDF successfully");
      expect(requests).toHaveLength(2);
      const toolResultRequest = requests[1]?.messages?.find((message) => message.role === "tool");
      expect(String(toolResultRequest?.content)).toContain("uppercase-document.pdf");

      const resultEvent = events.find(
        (event): event is Extract<DesktopEvent, { type: "agent.event" }> =>
          event.type === "agent.event" &&
          event.taskId === task.id &&
          event.event.type === EventType.TOOL_CALL_RESULT,
      );
      if (!resultEvent || typeof resultEvent.event.content !== "string") {
        throw new Error("Successful export did not emit a tool result event");
      }
      const result = JSON.parse(resultEvent.event.content) as {
        isError?: boolean;
        files?: Array<{ format?: string; path?: string }>;
      };
      expect(result).not.toHaveProperty("isError");
      expect(result.files).toEqual([
        expect.objectContaining({ format: "pdf", path: "uppercase-document.pdf" }),
      ]);

      const artifacts = service.database.listArtifacts(coworker.id);
      expect(artifacts).toEqual([
        expect.objectContaining({
          name: "uppercase-document.pdf",
          mimeType: "application/pdf",
        }),
      ]);
      const artifactPath = artifacts[0]?.filePath;
      if (!artifactPath) throw new Error("Successful export artifact has no file path");
      expect((await readFile(artifactPath)).subarray(0, 5).toString()).toBe("%PDF-");
      expect(service.database.listToolCalls(task.id)).toEqual([
        expect.objectContaining({
          toolName: "documents.export",
          status: "COMPLETED",
        }),
      ]);
      unsubscribe();
    } finally {
      await service.shutdown();
      await new Promise<void>((done) => server.close(() => done()));
      await Promise.all(workers.map((worker) => worker.terminate()));
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
