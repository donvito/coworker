import { Worker } from "node:worker_threads";
import { AsyncLocalStorage } from "node:async_hooks";
import type { BaseEvent } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import type { DesktopEvent, RuntimeStatus, Task } from "@shared/contracts";
import type { CoworkerDatabase } from "@main/db/database";
import type { CredentialStore } from "@main/security/credential-store";
import { loadImageAttachments } from "@main/integrations/image-attachments";
import { getRuntimeModelConfiguration } from "@main/integrations/model-catalog";
import type { ToolGateway } from "@main/tools/tool-gateway";
import type {
  MainToWorkerMessage,
  WorkerCoworkerConfig,
  WorkerToMainMessage,
} from "./protocol";
import type { ProviderErrorSink } from "./provider-error-logger";
import { loadWorkspaceContext } from "@main/tools/workspace-text";
import { requestContextForTask } from "@shared/request-context";

interface RuntimeRecord {
  coworkerId: string;
  worker: Worker;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  readyResolved: boolean;
  exitHandled: Promise<void>;
  resolveExitHandled: () => void;
  rejectExitHandled: (error: unknown) => void;
  physicalExit: Promise<void>;
  resolvePhysicalExit: () => void;
  exitObserved: boolean;
  currentTaskId: string | null;
  currentRunId: string | null;
  stopping: boolean;
  idleTimer: NodeJS.Timeout | null;
  pendingOperations: Set<Promise<unknown>>;
  coworkerName: string;
  modelProvider: WorkerCoworkerConfig["coworker"]["modelProvider"];
  modelName: string;
}

export interface CoworkerRuntimeManagerOptions {
  database: CoworkerDatabase;
  tools: ToolGateway;
  credentials: CredentialStore;
  emit: (event: DesktopEvent) => void;
  idleTimeoutMs?: number;
  workerFactory?: () => Worker;
  providerErrors?: ProviderErrorSink;
  applicationErrors?: {
    error(
      category: string,
      error: unknown,
      details?: Record<string, string | number | boolean | null>,
    ): Promise<void>;
  };
  onTaskCompleted?: (task: Task) => void | Promise<void>;
  onTaskFailed?: (task: Task, error: string) => void | Promise<void>;
}

export class CoworkerRuntimeManager {
  private readonly runtimes = new Map<string, RuntimeRecord>();
  private readonly dispatching = new Set<string>();
  private readonly pendingDispatches = new Map<Promise<void>, string>();
  private readonly enqueueRequests = new Set<string>();
  private readonly stopGenerations = new Map<string, number>();
  private readonly operationContext = new AsyncLocalStorage<RuntimeRecord>();
  private readonly messageBuffers = new Map<string, { id: string; content: string }>();
  private dispatchPaused = false;
  private stoppingAll = 0;
  private readonly idleTimeoutMs: number;
  private readonly workerFactory: () => Worker;

  constructor(private readonly options: CoworkerRuntimeManagerOptions) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? 15 * 60_000;
    this.workerFactory =
      options.workerFactory ??
      (() => new Worker(new URL("./runtime/coworker-worker.js", import.meta.url)));
  }

  async start(coworkerId: string): Promise<void> {
    const existing = this.runtimes.get(coworkerId);
    if (existing) {
      await existing.ready;
      return;
    }
    const coworker = this.options.database.getCoworker(coworkerId);
    if (coworker.status !== "active") throw new Error(`${coworker.name} is paused`);
    this.setStatus(coworkerId, "STARTING");

    const worker = this.workerFactory();
    let resolveReady: () => void = () => undefined;
    let rejectReady: (error: Error) => void = () => undefined;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = () => resolve();
      rejectReady = reject;
    });
    // A stop can reject readiness while model configuration is still loading.
    void ready.catch(() => undefined);
    let resolveExitHandled: () => void = () => undefined;
    let rejectExitHandled: (error: unknown) => void = () => undefined;
    const exitHandled = new Promise<void>((resolve, reject) => {
      resolveExitHandled = resolve;
      rejectExitHandled = reject;
    });
    void exitHandled.catch(() => undefined);
    let resolvePhysicalExit: () => void = () => undefined;
    const physicalExit = new Promise<void>((resolve) => {
      resolvePhysicalExit = resolve;
    });
    const record: RuntimeRecord = {
      coworkerId,
      worker,
      ready,
      resolveReady,
      rejectReady,
      readyResolved: false,
      exitHandled,
      resolveExitHandled,
      rejectExitHandled,
      physicalExit,
      resolvePhysicalExit,
      exitObserved: false,
      currentTaskId: null,
      currentRunId: null,
      stopping: false,
      idleTimer: null,
      pendingOperations: new Set(),
      coworkerName: coworker.name,
      modelProvider: coworker.modelProvider,
      modelName: coworker.modelName,
    };
    this.runtimes.set(coworkerId, record);
    worker.on("message", (message: WorkerToMainMessage) => {
      if (record.exitObserved) return;
      const handling = this.trackOperation(record, () => this.handleWorkerMessage(record, message));
      void handling
        .catch((error) => {
          void this.options.applicationErrors?.error("runtime.message", error, {
            coworkerId,
            taskId: record.currentTaskId,
            runId: record.currentRunId,
          });
        });
    });
    worker.on("error", (error: Error) => {
      void this.options.applicationErrors?.error("runtime.worker", error, {
        coworkerId,
        taskId: record.currentTaskId,
        runId: record.currentRunId,
      });
      if (!record.readyResolved) record.stopping = true;
      record.rejectReady(error);
      this.options.database.addActivity({
        coworkerId,
        taskId: record.currentTaskId,
        type: "runtime.error",
        summary: error.message,
      });
    });
    worker.on("exit", (code) => this.observeWorkerExit(coworkerId, record, code));

    try {
      const modelConfiguration = await getRuntimeModelConfiguration(
        coworker.modelProvider,
        coworker.modelName,
        this.options.credentials,
      );
      if (!this.isLiveRuntime(coworkerId, record)) return;
      const config: WorkerCoworkerConfig = {
        coworker,
        globalOperatingInstructions:
          this.options.database.getSettings().globalOperatingInstructions,
        modelApiKey: modelConfiguration.apiKey,
        modelBaseUrl: modelConfiguration.baseUrl,
        modelSupportsImages: modelConfiguration.supportsImages,
        modelContextWindow: modelConfiguration.contextWindow,
        skills: this.options.database.listCoworkerSkills(coworkerId).map((skill) => ({
          name: skill.name,
          description: skill.description,
        })),
        recentSkillUses: this.options.database
          .listToolCalls()
          .filter(
            (toolCall) =>
              toolCall.coworkerId === coworkerId &&
              toolCall.toolName === "skills.read" &&
              toolCall.status === "COMPLETED",
          )
          .slice(-20)
          .flatMap((toolCall) => {
            const args = toolCall.arguments as { name?: unknown };
            return typeof args?.name === "string" ? [args.name] : [];
          }),
      };
      this.send(record, { type: "initialize", config });
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`Timed out starting ${coworker.name}`)), 15_000).unref();
        }),
      ]);
    } catch (error) {
      if (record.stopping || this.runtimes.get(coworkerId) !== record) throw error;
      record.stopping = true;
      if (this.runtimes.get(coworkerId) === record) {
        this.runtimes.delete(coworkerId);
        await worker.terminate().catch(() => undefined);
      }
      this.setStatus(coworkerId, "ERROR");
      throw error;
    }
  }

  async stop(coworkerId: string): Promise<void> {
    this.stopGenerations.set(coworkerId, this.currentStopGeneration(coworkerId) + 1);
    this.enqueueRequests.delete(coworkerId);
    const runtime = this.runtimes.get(coworkerId);
    if (!runtime) {
      this.setStatus(coworkerId, "STOPPED");
      return;
    }
    runtime.stopping = true;
    if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
    if (!runtime.exitObserved) this.send(runtime, { type: "shutdown" });
    await Promise.race([
      runtime.physicalExit,
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (!runtime.exitObserved) {
      const code = await runtime.worker.terminate();
      this.observeWorkerExit(coworkerId, runtime, code);
    }
    // A tool can update its own coworker. It must return before cleanup can
    // drain that operation; the retiring record keeps dispatch blocked meanwhile.
    if (this.operationContext.getStore() !== runtime) await runtime.exitHandled;
  }

  async stopAll(): Promise<void> {
    this.stoppingAll += 1;
    try {
      // Invalidate claimed dispatches as well as workers. A dispatch can be
      // waiting for startup before its worker has entered the runtime map.
      const ids = new Set([...this.runtimes.keys(), ...this.dispatching]);
      await Promise.all([...ids].map((id) => this.stop(id)));
      await this.waitForDispatches();
      const selfCoworkerId = this.operationContext.getStore()?.coworkerId;
      await Promise.all(
        [...this.runtimes.keys()]
          .filter((id) => id !== selfCoworkerId)
          .map((id) => this.stop(id)),
      );
      await this.waitForDispatches();
    } finally {
      this.stoppingAll -= 1;
    }
  }

  enqueueTask(coworkerId: string): void {
    if (this.dispatchPaused || this.stoppingAll > 0) return;
    this.enqueueRequests.add(coworkerId);
    queueMicrotask(() => this.scheduleDispatch(coworkerId));
  }

  pauseDispatch(): void {
    this.dispatchPaused = true;
  }

  resumeDispatch(): void {
    this.dispatchPaused = false;
    for (const coworker of this.options.database.listCoworkers()) {
      if (this.options.database.listTasks(coworker.id).some((task) => task.status === "QUEUED")) {
        this.enqueueTask(coworker.id);
      }
    }
  }

  private scheduleDispatch(coworkerId: string): void {
    const pending = this.dispatch(coworkerId);
    this.pendingDispatches.set(pending, coworkerId);
    void pending.then(
      () => this.pendingDispatches.delete(pending),
      () => this.pendingDispatches.delete(pending),
    );
  }

  private async waitForDispatches(): Promise<void> {
    const selfCoworkerId = this.operationContext.getStore()?.coworkerId;
    while (true) {
      const pending = [...this.pendingDispatches.entries()]
        .filter(([, coworkerId]) => coworkerId !== selfCoworkerId)
        .map(([promise]) => promise);
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  async abort(coworkerId: string, runId: string): Promise<void> {
    const runtime = this.runtimes.get(coworkerId);
    if (!runtime || runtime.currentRunId !== runId) return;
    this.send(runtime, { type: "abort", runId });
  }

  async restart(coworkerId: string): Promise<void> {
    await this.stop(coworkerId);
    await this.start(coworkerId);
    this.enqueueTask(coworkerId);
  }

  private async dispatch(coworkerId: string): Promise<void> {
    if (this.dispatchPaused || this.stoppingAll > 0) return;
    if (this.dispatching.has(coworkerId)) return;
    const retiring = this.runtimes.get(coworkerId);
    if (retiring?.stopping || retiring?.exitObserved) return;
    const generation = this.currentStopGeneration(coworkerId);
    this.enqueueRequests.delete(coworkerId);
    this.dispatching.add(coworkerId);
    let claimedTask: Task | null = null;
    try {
      const coworker = this.options.database.getCoworker(coworkerId);
      if (coworker.status !== "active") {
        this.setStatus(coworkerId, "STOPPED");
        return;
      }
      const current = this.runtimes.get(coworkerId);
      if (current?.stopping || current?.currentTaskId) return;
      if (!this.isCurrentGeneration(coworkerId, generation)) return;
      const task = this.options.database.claimNextTask(coworkerId);
      if (!task) {
        if (current) {
          this.setStatus(coworkerId, "IDLE");
          this.scheduleIdleShutdown(coworkerId, current);
        }
        return;
      }
      claimedTask = task;
      if (!this.isCurrentGeneration(coworkerId, generation)) {
        this.requeueInterruptedTask(task.id);
        return;
      }
      await this.start(coworkerId);
      const runtime = this.runtimes.get(coworkerId);
      if (
        !runtime ||
        runtime.stopping ||
        !this.isCurrentGeneration(coworkerId, generation)
      ) {
        this.requeueInterruptedTask(task.id);
        return;
      }
      if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
      runtime.idleTimer = null;
      runtime.currentTaskId = task.id;
      runtime.currentRunId = task.runId;
      this.setStatus(coworkerId, "WORKING", task.id);

      const approval = this.options.database.getApprovalForTask(task.id);
      let resume: Extract<MainToWorkerMessage, { type: "run" }>["resume"];
      if (approval && approval.status !== "PENDING") {
        if (!this.isCurrentDispatch(coworkerId, runtime, generation)) {
          this.requeueInterruptedTask(task.id);
          return;
        }
        const coworker = this.options.database.getCoworker(coworkerId);
        const execution = await this.trackOperation(runtime, () =>
          this.options.tools.executeApproval(approval, coworker),
        );
        if (!this.isCurrentDispatch(coworkerId, runtime, generation)) {
          this.requeueInterruptedTask(task.id);
          return;
        }
        resume = {
          decision:
            approval.status === "REJECTED"
              ? "rejected"
              : approval.status === "EDITED"
                ? "edited"
                : "approved",
          toolName: approval.actionType,
          result: execution.result,
        };
        this.options.emit({ type: "entity.changed", entity: "approvals", id: approval.id });
      }
      const checkpoint = this.options.database.getCheckpoint(task.id);
      const sourceMessage = task.sourceMessageId
        ? this.options.database.getMessage(task.sourceMessageId)
        : null;
      const threadMessages = resume
        ? undefined
        : this.options.database
            .listConversationMessages(task.threadId)
            .filter(
              (message) =>
                message.taskId !== task.id &&
                message.id !== task.sourceMessageId &&
                (task.discussionId !== null ||
                  !sourceMessage ||
                  message.createdAt < sourceMessage.createdAt ||
                  (message.createdAt === sourceMessage.createdAt &&
                    message.id < sourceMessage.id)),
            )
            .slice(-100);
      const images = resume
        ? undefined
        : await loadImageAttachments(
            coworker.workspacePath,
            this.options.database.listTaskImageAttachments(task.id),
          );
      const workspaceContext = await loadWorkspaceContext(coworker.workspacePath);
      if (!this.isCurrentDispatch(coworkerId, runtime, generation)) {
        this.requeueInterruptedTask(task.id);
        return;
      }
      this.send(runtime, {
        type: "run",
        taskId: task.id,
        runId: task.runId,
        threadId: task.threadId,
        input: task.input,
        requestContext: requestContextForTask(task),
        workspaceContext,
        images,
        threadMessages,
        checkpoint: checkpoint?.messages,
        resume,
      });
    } catch (error) {
      const runtime = this.runtimes.get(coworkerId);
      const taskId = runtime?.currentTaskId ?? claimedTask?.id;
      const message = error instanceof Error ? error.message : String(error);
      if (
        claimedTask &&
        (!this.isCurrentGeneration(coworkerId, generation) || runtime?.stopping)
      ) {
        this.options.tools.releaseBrowserTask(claimedTask.id);
        this.requeueInterruptedTask(claimedTask.id);
        if (runtime && this.runtimes.get(coworkerId) === runtime) {
          runtime.currentTaskId = null;
          runtime.currentRunId = null;
        }
        return;
      }
      if (taskId) {
        this.options.tools.releaseBrowserTask(taskId);
        this.options.database.setTaskStatus(taskId, "FAILED", { error: message });
        const failedTask = this.options.database.getTask(taskId);
        await this.options.onTaskFailed?.(failedTask, message);
        if (runtime) {
          runtime.currentTaskId = null;
          runtime.currentRunId = null;
        }
        this.options.emit({ type: "entity.changed", entity: "tasks", id: taskId });
      }
      // Startup failures happen before the worker can emit AG-UI events. Close the
      // renderer's active run explicitly so it never remains on "is working".
      if (claimedTask) {
        this.options.emit({
          type: "agent.event",
          coworkerId,
          conversationId: claimedTask.threadId,
          taskId: claimedTask.id,
          runId: claimedTask.runId,
          event: {
            type: EventType.RUN_ERROR,
            message,
            code: "RUNTIME_START_ERROR",
            timestamp: Date.now(),
          },
        });
      }
      const failedCoworker = this.options.database.getCoworker(coworkerId);
      await this.options.providerErrors?.log(
        {
          phase: "runtime_start",
          provider: failedCoworker.modelProvider,
          model: failedCoworker.modelName,
          coworkerId,
          taskId: claimedTask?.id,
          runId: claimedTask?.runId,
        },
        error,
      );
      this.setStatus(coworkerId, "ERROR", taskId ?? undefined);
    } finally {
      this.dispatching.delete(coworkerId);
      if (this.enqueueRequests.has(coworkerId) && !this.dispatchPaused) {
        queueMicrotask(() => this.scheduleDispatch(coworkerId));
      }
    }
  }

  private async handleWorkerMessage(
    runtime: RuntimeRecord,
    message: WorkerToMainMessage,
  ): Promise<void> {
    if (this.runtimes.get(message.coworkerId) !== runtime) return;
    if (message.type !== "ready") {
      if (runtime.currentTaskId !== message.taskId) return;
      if ("runId" in message && runtime.currentRunId !== message.runId) return;
    }
    if (
      runtime.stopping &&
      message.type !== "ready" &&
      message.type !== "tool.request" &&
      message.type !== "checkpoint"
    ) {
      return;
    }
    if (message.type === "ready") {
      runtime.readyResolved = true;
      runtime.resolveReady();
      if (!runtime.stopping) this.setStatus(message.coworkerId, "IDLE");
      return;
    }
    if (message.type === "agui.event") {
      this.persistAgentEvent(message.coworkerId, message.taskId, message.runId, message.event);
      const task = this.options.database.getTask(message.taskId);
      this.options.emit({
        type: "agent.event",
        coworkerId: message.coworkerId,
        conversationId: task.threadId,
        taskId: message.taskId,
        runId: message.runId,
        event: message.event,
      });
      return;
    }
    if (message.type === "tool.request") {
      try {
        const result = await this.options.tools.request({
          task: this.options.database.getTask(message.taskId),
          coworker: this.options.database.getCoworker(message.coworkerId),
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          arguments: message.arguments,
        });
        const canReply =
          this.runtimes.get(message.coworkerId) === runtime && !runtime.stopping;
        if (result.kind === "approval") {
          if (canReply) {
            this.send(runtime, {
              type: "tool.response",
              requestId: message.requestId,
              response: {
                kind: "approval",
                approvalId: result.approval.id,
                summary: result.approval.summary,
                toolCallId: message.toolCallId,
              },
            });
            this.setStatus(message.coworkerId, "WAITING_FOR_APPROVAL", message.taskId);
          }
          this.options.emit({
            type: "entity.changed",
            entity: "approvals",
            id: result.approval.id,
          });
          this.options.emit({ type: "entity.changed", entity: "tasks", id: message.taskId });
        } else if (result.kind === "denied") {
          if (canReply) {
            this.send(runtime, {
              type: "tool.response",
              requestId: message.requestId,
              response: { kind: "denied", reason: result.reason },
            });
          }
        } else {
          if (canReply) {
            this.send(runtime, {
              type: "tool.response",
              requestId: message.requestId,
              response: { kind: "completed", result: result.result },
            });
          }
          this.options.emit({ type: "entity.changed", entity: "artifacts" });
        }
        this.options.emit({ type: "entity.changed", entity: "activity" });
      } catch (error) {
        if (this.runtimes.get(message.coworkerId) === runtime && !runtime.stopping) {
          this.send(runtime, {
            type: "tool.response",
            requestId: message.requestId,
            response: {
              kind: "denied",
              reason: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
      return;
    }
    if (message.type === "checkpoint") {
      this.options.database.saveCheckpoint(
        message.taskId,
        message.messages,
        message.pendingTool,
      );
      return;
    }
    if (message.type === "run.completed") {
      if (!message.waitingForApproval) this.options.tools.releaseBrowserTask(message.taskId);
      runtime.currentTaskId = null;
      runtime.currentRunId = null;
      const task = this.options.database.getTask(message.taskId);
      if (message.waitingForApproval || task.status === "WAITING_FOR_APPROVAL") {
        this.setStatus(message.coworkerId, "WAITING_FOR_APPROVAL", message.taskId);
      } else if (task.status !== "CANCELLED") {
        this.options.database.setTaskStatus(message.taskId, "COMPLETED", {
          result: message.result || "Completed",
        });
        await this.options.onTaskCompleted?.(
          this.options.database.getTask(message.taskId),
        );
        if (!this.isLiveRuntime(message.coworkerId, runtime)) {
          this.options.emit({ type: "entity.changed", entity: "tasks", id: message.taskId });
          this.options.emit({ type: "entity.changed", entity: "activity" });
          return;
        }
        this.setStatus(message.coworkerId, "IDLE");
      } else {
        this.setStatus(message.coworkerId, "IDLE");
      }
      this.options.emit({ type: "entity.changed", entity: "tasks", id: message.taskId });
      this.options.emit({ type: "entity.changed", entity: "activity" });
      this.scheduleIdleShutdown(message.coworkerId, runtime);
      this.enqueueTask(message.coworkerId);
      return;
    }
    if (message.type === "run.failed") {
      this.options.tools.releaseBrowserTask(message.taskId);
      runtime.currentTaskId = null;
      runtime.currentRunId = null;
      const task = this.options.database.getTask(message.taskId);
      if (task.status !== "CANCELLED" && task.status !== "WAITING_FOR_APPROVAL") {
        this.options.database.setTaskStatus(message.taskId, "FAILED", { error: message.error });
        await this.options.onTaskFailed?.(
          this.options.database.getTask(message.taskId),
          message.error,
        );
        if (this.isLiveRuntime(message.coworkerId, runtime)) {
          this.setStatus(message.coworkerId, "ERROR", message.taskId);
        }
      } else if (task.status === "CANCELLED") {
        this.setStatus(message.coworkerId, "IDLE");
      }
      await this.options.providerErrors?.log(
        {
          phase: "inference",
          provider: runtime.modelProvider,
          model: runtime.modelName,
          coworkerId: message.coworkerId,
          taskId: message.taskId,
          runId: message.runId,
        },
        message.error,
      );
      this.options.emit({ type: "entity.changed", entity: "tasks", id: message.taskId });
      if (this.isLiveRuntime(message.coworkerId, runtime)) this.enqueueTask(message.coworkerId);
    }
  }

  private persistAgentEvent(
    coworkerId: string,
    taskId: string,
    runId: string,
    event: BaseEvent,
  ): void {
    if (event.type === EventType.TEXT_MESSAGE_START && "messageId" in event) {
      this.messageBuffers.set(runId, { id: String(event.messageId), content: "" });
      return;
    }
    if (event.type === EventType.TEXT_MESSAGE_CONTENT && "delta" in event) {
      const buffer = this.messageBuffers.get(runId);
      if (buffer) buffer.content += String(event.delta);
      return;
    }
    if (event.type === EventType.TEXT_MESSAGE_END) {
      const buffer = this.messageBuffers.get(runId);
      if (buffer && buffer.content) {
        this.options.database.addMessage({
          coworkerId,
          taskId,
          role: "assistant",
          content: buffer.content,
        });
      }
      this.messageBuffers.delete(runId);
      this.options.emit({ type: "entity.changed", entity: "activity" });
    }
  }

  private async handleWorkerExit(
    coworkerId: string,
    runtime: RuntimeRecord,
    code: number,
  ): Promise<void> {
    if (this.runtimes.get(coworkerId) !== runtime) return;
    if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
    if (runtime.currentRunId) this.messageBuffers.delete(runtime.currentRunId);
    while (runtime.pendingOperations.size > 0) {
      await Promise.allSettled([...runtime.pendingOperations]);
    }
    if (this.runtimes.get(coworkerId) !== runtime) return;
    this.runtimes.delete(coworkerId);

    const taskId = runtime.currentTaskId;
    const runId = runtime.currentRunId;
    if (taskId) {
      this.options.tools.releaseBrowserTask(taskId);
      const task = this.options.database.getTask(taskId);
      if (task.status === "RUNNING") {
        this.options.database.setTaskStatus(task.id, "QUEUED");
        this.options.emit({ type: "entity.changed", entity: "tasks", id: task.id });
        this.options.emit({ type: "entity.changed", entity: "activity" });
      }
    }
    runtime.currentTaskId = null;
    runtime.currentRunId = null;
    if (runtime.stopping) {
      this.setStatus(coworkerId, "STOPPED");
      if (this.enqueueRequests.has(coworkerId) && !this.dispatchPaused) {
        queueMicrotask(() => this.scheduleDispatch(coworkerId));
      }
      return;
    }

    const generation = this.currentStopGeneration(coworkerId);
    this.options.database.addActivity({
      coworkerId,
      taskId,
      type: "runtime.crashed",
      summary: `Coworker runtime exited unexpectedly (code ${code})`,
    });
    await this.options.providerErrors?.log(
      {
        phase: "runtime_exit",
        provider: runtime.modelProvider,
        model: runtime.modelName,
        coworkerId,
        taskId: taskId ?? undefined,
        runId: runId ?? undefined,
      },
      new Error(`Coworker runtime exited unexpectedly (code ${code})`),
    );
    if (!this.isCurrentGeneration(coworkerId, generation) || this.runtimes.has(coworkerId)) return;
    this.setStatus(coworkerId, "ERROR", taskId ?? undefined);
    setTimeout(() => {
      if (this.isCurrentGeneration(coworkerId, generation)) this.enqueueTask(coworkerId);
    }, 1_000).unref();
  }

  private observeWorkerExit(coworkerId: string, runtime: RuntimeRecord, code: number): void {
    if (runtime.exitObserved) return;
    runtime.exitObserved = true;
    runtime.resolvePhysicalExit();
    if (code !== 0 && !runtime.stopping) {
      void this.options.applicationErrors?.error(
        "runtime.worker_exit",
        new Error(`${runtime.coworkerName}'s runtime exited with code ${code}`),
        { coworkerId, taskId: runtime.currentTaskId, runId: runtime.currentRunId },
      );
    }
    if (!runtime.readyResolved) runtime.stopping = true;
    runtime.rejectReady(new Error(`${runtime.coworkerName}'s runtime exited during startup (${code})`));
    void this.handleWorkerExit(coworkerId, runtime, code)
      .then(() => runtime.resolveExitHandled(), (error) => {
        runtime.rejectExitHandled(error);
        void this.options.applicationErrors?.error("runtime.cleanup", error, { coworkerId });
      });
  }

  private trackOperation<T>(runtime: RuntimeRecord, operation: () => Promise<T>): Promise<T> {
    // Register before invoking: an operation may synchronously initiate stop.
    // Invoke synchronously so completion/checkpoint messages retain their
    // existing ordering relative to a stop called immediately afterwards.
    let resolvePending!: (value: T | PromiseLike<T>) => void;
    let rejectPending!: (error: unknown) => void;
    const pending = new Promise<T>((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });
    runtime.pendingOperations.add(pending);
    try {
      const result = this.operationContext.run(runtime, operation);
      Promise.resolve(result).then(resolvePending, rejectPending);
    } catch (error) {
      rejectPending(error);
    }
    void pending.then(
      () => runtime.pendingOperations.delete(pending),
      () => runtime.pendingOperations.delete(pending),
    );
    return pending;
  }

  private currentStopGeneration(coworkerId: string): number {
    return this.stopGenerations.get(coworkerId) ?? 0;
  }

  private isCurrentGeneration(coworkerId: string, generation: number): boolean {
    return this.currentStopGeneration(coworkerId) === generation;
  }

  private isCurrentDispatch(
    coworkerId: string,
    runtime: RuntimeRecord,
    generation: number,
  ): boolean {
    return (
      this.isCurrentGeneration(coworkerId, generation) &&
      !runtime.stopping &&
      !runtime.exitObserved &&
      this.runtimes.get(coworkerId) === runtime
    );
  }

  private isLiveRuntime(coworkerId: string, runtime: RuntimeRecord): boolean {
    return this.runtimes.get(coworkerId) === runtime && !runtime.stopping && !runtime.exitObserved;
  }

  private requeueInterruptedTask(taskId: string): void {
    const task = this.options.database.getTask(taskId);
    if (task.status !== "RUNNING") return;
    this.options.database.setTaskStatus(taskId, "QUEUED");
    this.options.emit({ type: "entity.changed", entity: "tasks", id: taskId });
    this.options.emit({ type: "entity.changed", entity: "activity" });
  }

  private scheduleIdleShutdown(coworkerId: string, runtime: RuntimeRecord): void {
    if (runtime.currentTaskId || this.idleTimeoutMs <= 0) return;
    if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
    runtime.idleTimer = setTimeout(() => {
      void this.stop(coworkerId);
    }, this.idleTimeoutMs);
    runtime.idleTimer.unref?.();
  }

  private setStatus(
    coworkerId: string,
    status: RuntimeStatus,
    taskId?: string,
  ): void {
    this.options.database.setRuntimeStatus(coworkerId, status);
    this.options.emit({ type: "runtime.status", coworkerId, status, taskId });
    this.options.emit({ type: "entity.changed", entity: "coworkers", id: coworkerId });
  }

  private send(runtime: RuntimeRecord, message: MainToWorkerMessage): void {
    runtime.worker.postMessage(message);
  }
}
