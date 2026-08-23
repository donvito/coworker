import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { EventType } from "@ag-ui/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoworkerDatabase } from "@main/db/database";
import { CoworkerRuntimeManager } from "@main/runtime/runtime-manager";
import { ToolGateway } from "@main/tools/tool-gateway";
import type { DesktopEvent } from "@shared/contracts";

const temporaryPaths: string[] = [];

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for runtime failure");
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("runtime startup failures", () => {
  it("emits RUN_ERROR so a chat run closes when its selected model cannot start", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-runtime-error-"));
    temporaryPaths.push(root);
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    const credentials = {
      async set() {},
      async get(key: string) {
        return key === "model:openrouter" ? "test-key" : null;
      },
      async has(key: string) {
        return key === "model:openrouter";
      },
      async delete() {},
    };
    const events: DesktopEvent[] = [];
    const logProviderError = vi.fn().mockResolvedValue(undefined);
    const fakeWorker = Object.assign(new EventEmitter(), {
      postMessage() {},
      async terminate() {
        return 0;
      },
    }) as unknown as Worker;
    const manager = new CoworkerRuntimeManager({
      database,
      credentials,
      tools: new ToolGateway(database, credentials, join(root, "outbox")),
      emit: (event) => events.push(event),
      workerFactory: () => fakeWorker,
      providerErrors: { log: logProviderError },
    });

    try {
      const coworker = database.createCoworker(
        {
          name: "Router tester",
          role: "Test coworker",
          systemPrompt: "Respond clearly.",
          modelProvider: "openrouter",
          modelName: "missing/not-in-runtime-catalog",
          enabledTools: [],
          policies: {},
        },
        join(root, "workspace"),
      );
      const task = database.createTask({
        coworkerId: coworker.id,
        input: "Hello",
        title: "Hello",
        runId: "run-openrouter-start-error",
      });

      manager.enqueueTask(coworker.id);
      await waitFor(() => database.getTask(task.id).status === "FAILED");

      expect(database.getTask(task.id).error).toContain("is not available from OpenRouter");
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "agent.event",
          coworkerId: coworker.id,
          taskId: task.id,
          runId: task.runId,
          event: expect.objectContaining({
            type: EventType.RUN_ERROR,
            code: "RUNTIME_START_ERROR",
          }),
        }),
      );
      expect(logProviderError).toHaveBeenCalledWith(
        {
          phase: "runtime_start",
          provider: "openrouter",
          model: "missing/not-in-runtime-catalog",
          coworkerId: coworker.id,
          taskId: task.id,
          runId: task.runId,
        },
        expect.any(Error),
      );
    } finally {
      await manager.stopAll();
      database.close();
    }
  });
});
