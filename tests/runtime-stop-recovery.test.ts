import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAppService } from "@main/app/app-service";
import { CoworkerDatabase } from "@main/db/database";
import { CoworkerRuntimeManager } from "@main/runtime/runtime-manager";
import type { MainToWorkerMessage, WorkerToMainMessage } from "@main/runtime/protocol";
import { MemoryCredentialStore } from "@main/security/credential-store";
import { ToolGateway } from "@main/tools/tool-gateway";
import type { DesktopEvent, Task } from "@shared/contracts";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function deferred<T = void>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
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

function createCoworker(database: CoworkerDatabase, root: string, overrides: Record<string, unknown> = {}) {
  return database.createCoworker(
    {
      name: "Ava",
      role: "Operations specialist",
      systemPrompt: "You are Ava.",
      modelProvider: "demo",
      modelName: "faux-1",
      enabledTools: [],
      ...overrides,
    },
    join(root, "ava"),
  );
}

function createTask(database: CoworkerDatabase, coworkerId: string, input = "Keep working") {
  return database.createTask({
    coworkerId,
    title: input,
    input,
    runId: `run-${Math.random().toString(36).slice(2)}`,
  });
}

function managerFor(
  database: CoworkerDatabase,
  root: string,
  workers: FakeWorker[],
  events: DesktopEvent[] = [],
  toolsOverride?: ToolGateway,
  onTaskCompleted?: (task: Task) => void | Promise<void>,
): CoworkerRuntimeManager {
  const credentials = new MemoryCredentialStore();
  const tools = toolsOverride ?? new ToolGateway(database, credentials, join(root, "outbox"));
  return new CoworkerRuntimeManager({
    database,
    credentials,
    tools,
    onTaskCompleted,
    emit: (event) => events.push(event),
    idleTimeoutMs: 60_000,
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
  });
}

function completedToolResult(task: Task, toolName: string) {
  return {
    kind: "completed" as const,
    toolCall: {
      id: "mock-tool-call",
      taskId: task.id,
      coworkerId: task.coworkerId,
      toolName,
      arguments: {},
      result: null,
      status: "COMPLETED" as const,
      idempotencyKey: "mock-tool-call",
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    },
    result: { ok: true },
  };
}

async function startTask(
  manager: CoworkerRuntimeManager,
  database: CoworkerDatabase,
  task: Task,
  workers: FakeWorker[],
): Promise<FakeWorker> {
  manager.enqueueTask(task.coworkerId);
  await waitFor(() => workers.length > 0, "runtime worker");
  const worker = workers.at(-1)!;
  await waitFor(
    () =>
      database.getTask(task.id).status === "RUNNING" &&
      worker.messages.some((message) => message.type === "run"),
    "task dispatch",
  );
  return worker;
}

describe("runtime stop recovery", () => {
  it("requeues a running task after an intentional stop and ignores stale worker events", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-runtime-stop-"));
    temporaryPaths.push(root);
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    const coworker = createCoworker(database, root);
    const workers: FakeWorker[] = [];
    const manager = managerFor(database, root, workers);
    const task = createTask(database, coworker.id);

    try {
      const firstWorker = await startTask(manager, database, task, workers);
      await manager.stop(coworker.id);
      expect(database.getTask(task.id).status).toBe("QUEUED");

      manager.enqueueTask(coworker.id);
      await waitFor(() => workers.length === 2, "replacement runtime");
      const replacement = workers[1]!;
      await waitFor(
        () => replacement.messages.some((message) => message.type === "run"),
        "requeued task dispatch",
      );
      expect(database.getTask(task.id).status).toBe("RUNNING");

      firstWorker.emitMessage({
        type: "run.completed",
        coworkerId: coworker.id,
        taskId: task.id,
        runId: task.runId,
        result: "stale completion",
        waitingForApproval: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(database.getTask(task.id).status).toBe("RUNNING");
      expect(replacement.messages.filter((message) => message.type === "run")).toHaveLength(1);
    } finally {
      await manager.stopAll();
      database.close();
    }
  });

  it("keeps terminal task states and approvals intact while stopping", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-runtime-stop-states-"));
    temporaryPaths.push(root);
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    const coworker = createCoworker(database, root);
    const workers: FakeWorker[] = [];
    const manager = managerFor(database, root, workers);

    try {
      const completed = createTask(database, coworker.id, "Already complete");
      await startTask(manager, database, completed, workers);
      database.setTaskStatus(completed.id, "COMPLETED", { result: "done" });
      await manager.stop(coworker.id);
      expect(database.getTask(completed.id).status).toBe("COMPLETED");

      const cancelled = createTask(database, coworker.id, "Already cancelled");
      await startTask(manager, database, cancelled, workers);
      database.cancelTask(cancelled.id);
      await manager.stop(coworker.id);
      expect(database.getTask(cancelled.id).status).toBe("CANCELLED");

      const waiting = createTask(database, coworker.id, "Approval is pending");
      await startTask(manager, database, waiting, workers);
      database.setTaskStatus(waiting.id, "WAITING_FOR_APPROVAL");
      await manager.stop(coworker.id);
      expect(database.getTask(waiting.id).status).toBe("WAITING_FOR_APPROVAL");
    } finally {
      await manager.stopAll();
      database.close();
    }
  });

  it("finishes a tool request before requeueing and preserves the approval it creates", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-runtime-stop-approval-"));
    temporaryPaths.push(root);
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    const coworker = createCoworker(database, root, {
      enabledTools: ["email.send"],
      policies: { "email.send": "approval" },
    });
    const workers: FakeWorker[] = [];
    const manager = managerFor(database, root, workers);
    const task = createTask(database, coworker.id, "Request approval");

    try {
      const worker = await startTask(manager, database, task, workers);
      worker.emitMessage({
        type: "tool.request",
        coworkerId: coworker.id,
        taskId: task.id,
        runId: task.runId,
        requestId: "request-1",
        toolCallId: "tool-1",
        toolName: "email.send",
        arguments: { to: "recipient@example.test", subject: "Hello", body: "World" },
      });

      await manager.stop(coworker.id);

      expect(database.getTask(task.id).status).toBe("WAITING_FOR_APPROVAL");
      expect(database.listApprovals("PENDING")).toEqual([
        expect.objectContaining({ taskId: task.id, actionType: "email.send" }),
      ]);
      expect(worker.messages.filter((message) => message.type === "tool.response")).toHaveLength(0);
    } finally {
      await manager.stopAll();
      database.close();
    }
  });

  it("waits for a pending tool operation before requeueing or starting a replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-runtime-stop-pending-tool-"));
    temporaryPaths.push(root);
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    const coworker = createCoworker(database, root, { enabledTools: ["email.send"] });
    const workers: FakeWorker[] = [];
    const tools = new ToolGateway(database, new MemoryCredentialStore(), join(root, "outbox"));
    const manager = managerFor(database, root, workers, [], tools);
    const task = createTask(database, coworker.id, "Wait for the tool");
    const requestStarted = deferred();
    const releaseRequest = deferred();

    vi.spyOn(tools, "request").mockImplementation(async () => {
      requestStarted.resolve();
      await releaseRequest.promise;
      return completedToolResult(task, "email.send");
    });

    try {
      const worker = await startTask(manager, database, task, workers);
      worker.emitMessage({
        type: "tool.request",
        coworkerId: coworker.id,
        taskId: task.id,
        runId: task.runId,
        requestId: "request-pending",
        toolCallId: "tool-pending",
        toolName: "email.send",
        arguments: { to: "recipient@example.test", subject: "Hello", body: "World" },
      });
      await requestStarted.promise;

      let stopFinished = false;
      const stopping = manager.stop(coworker.id).then(() => {
        stopFinished = true;
      });
      manager.enqueueTask(coworker.id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(stopFinished).toBe(false);
      expect(database.getTask(task.id).status).toBe("RUNNING");
      expect(workers).toHaveLength(1);

      releaseRequest.resolve();
      await stopping;
      await waitFor(() => workers.length === 2, "replacement runtime after tool completion");
      await waitFor(
        () => workers[1]!.messages.some((message) => message.type === "run"),
        "requeued task after tool completion",
      );
    } finally {
      releaseRequest.resolve();
      vi.restoreAllMocks();
      await manager.stopAll();
      database.close();
    }
  });

  it.each([false, true])("finishes a self-stopping tool handler (stopAll=%s) without deadlocking", async (stopAll) => {
    const root = await mkdtemp(join(tmpdir(), "coworker-runtime-stop-self-"));
    temporaryPaths.push(root);
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    const coworker = createCoworker(database, root, { enabledTools: ["email.send"] });
    const workers: FakeWorker[] = [];
    const tools = new ToolGateway(database, new MemoryCredentialStore(), join(root, "outbox"));
    const manager = managerFor(database, root, workers, [], tools);
    const task = createTask(database, coworker.id, "Stop from the tool handler");
    const handlerStarted = deferred();
    let handlerFinished = false;
    let stopFinished = false;

    vi.spyOn(tools, "request").mockImplementation(async () => {
      handlerStarted.resolve();
      if (stopAll) await manager.stopAll();
      else await manager.stop(coworker.id);
      stopFinished = true;
      manager.enqueueTask(coworker.id);
      handlerFinished = true;
      return completedToolResult(task, "email.send");
    });

    try {
      const worker = await startTask(manager, database, task, workers);
      worker.emitMessage({
        type: "tool.request",
        coworkerId: coworker.id,
        taskId: task.id,
        runId: task.runId,
        requestId: "request-self-stop",
        toolCallId: "tool-self-stop",
        toolName: "email.send",
        arguments: { to: "recipient@example.test", subject: "Hello", body: "World" },
      });
      await handlerStarted.promise;
      await waitFor(() => handlerFinished, "self-stopping tool handler");
      expect(stopFinished).toBe(true);
      await waitFor(
        () => workers[1]?.messages.some((message) => message.type === "run") === true,
        "redispatch requested by self-stopping handler",
      );
      expect(database.getTask(task.id).status).toBe("RUNNING");
    } finally {
      vi.restoreAllMocks();
      await manager.stopAll();
      database.close();
    }
  }, 8_000);

  it("recovers the task through DesktopAppService.updateCoworker", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-runtime-settings-stop-"));
    temporaryPaths.push(root);
    const workers: FakeWorker[] = [];
    const service = new DesktopAppService({
      dataPath: root,
      credentials: new MemoryCredentialStore(),
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    const coworker = createCoworker(service.database, root);
    const task = createTask(service.database, coworker.id, "Settings update in flight");

    try {
      service.runtime.enqueueTask(coworker.id);
      await waitFor(
        () =>
          workers[0]?.messages.some((message) => message.type === "run") === true &&
          service.database.getTask(task.id).status === "RUNNING",
        "service task dispatch",
      );
      await service.updateCoworker(coworker.id, { systemPrompt: "Updated instructions." });
      await waitFor(() => workers.length === 2, "service replacement runtime");
      await waitFor(
        () => workers[1]!.messages.some((message) => message.type === "run"),
        "service task redispatch",
      );
      expect(service.database.getTask(task.id).status).toBe("RUNNING");
    } finally {
      await service.shutdown();
    }
  });

  it("drains a completion callback and blocks its late enqueue during stopAll", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-stop-completion-"));
    temporaryPaths.push(root);
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    const coworker = createCoworker(database, root);
    const workers: FakeWorker[] = [];
    const entered = deferred();
    const release = deferred();
    let nextTask: Task | undefined;
    const manager = managerFor(database, root, workers, [], undefined, async () => {
      entered.resolve();
      await release.promise;
      nextTask = createTask(database, coworker.id, "Queued by completion callback");
      manager.enqueueTask(coworker.id);
    });
    let stopping: Promise<void> | undefined;
    try {
      const task = createTask(database, coworker.id);
      const worker = await startTask(manager, database, task, workers);
      worker.emitMessage({ type: "run.completed", coworkerId: coworker.id, taskId: task.id, runId: task.runId, result: "Done", waitingForApproval: false });
      await entered.promise;
      let finished = false;
      stopping = manager.stopAll().then(() => { finished = true; });
      await new Promise((done) => setTimeout(done, 20));
      expect(finished).toBe(false);
      release.resolve();
      await stopping;
      expect(database.getTask(nextTask!.id).status).toBe("QUEUED");
      expect(workers).toHaveLength(1);
      // A later explicit enqueue is still allowed after the temporary barrier.
      manager.enqueueTask(coworker.id);
      await waitFor(() => workers[1]?.messages.some((message) => message.type === "run") === true, "explicit enqueue after stopAll");
    } finally {
      release.resolve();
      await stopping;
      await manager.stopAll();
      database.close();
    }
  });

  it("waits for an in-flight dispatch before closing the database", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-runtime-shutdown-dispatch-"));
    temporaryPaths.push(root);
    const workers: FakeWorker[] = [];
    const service = new DesktopAppService({
      dataPath: root,
      credentials: new MemoryCredentialStore(),
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    const coworker = createCoworker(service.database, root);
    createTask(service.database, coworker.id, "Shutdown during startup");
    const startEntered = deferred();
    const releaseStart = deferred();
    const originalStart = service.runtime.start.bind(service.runtime);
    vi.spyOn(service.runtime, "start").mockImplementation(async (coworkerId) => {
      startEntered.resolve();
      await releaseStart.promise;
      await originalStart(coworkerId);
    });
    const close = vi.spyOn(service.database, "close");
    let shutdown: Promise<void> | null = null;

    try {
      service.runtime.enqueueTask(coworker.id);
      await startEntered.promise;

      let finished = false;
      shutdown = service.shutdown().then(() => {
        finished = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(finished).toBe(false);
      expect(close).not.toHaveBeenCalled();

      releaseStart.resolve();
      await shutdown;
      expect(close).toHaveBeenCalledTimes(1);
      expect(workers).toHaveLength(1);
    } finally {
      releaseStart.resolve();
      if (!shutdown) await service.shutdown().catch(() => undefined);
      else await shutdown.catch(() => undefined);
      vi.restoreAllMocks();
    }
  });
});
