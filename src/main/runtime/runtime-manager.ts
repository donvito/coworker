import { Worker } from "node:worker_threads";
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

interface RuntimeRecord {
  worker: Worker;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  readyResolved: boolean;
  currentTaskId: string | null;
  currentRunId: string | null;
  stopping: boolean;
  idleTimer: NodeJS.Timeout | null;
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
}

export class CoworkerRuntimeManager {
  private readonly runtimes = new Map<string, RuntimeRecord>();
  private readonly dispatching = new Set<string>();
  private readonly messageBuffers = new Map<string, { id: string; content: string }>();
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
    const record: RuntimeRecord = {
      worker,
      ready,
      resolveReady,
      rejectReady,
      readyResolved: false,
      currentTaskId: null,
      currentRunId: null,
      stopping: false,
      idleTimer: null,
      modelProvider: coworker.modelProvider,
      modelName: coworker.modelName,
    };
    this.runtimes.set(coworkerId, record);
    worker.on("message", (message: WorkerToMainMessage) => {
      void this.handleWorkerMessage(record, message);
    });
    worker.on("error", (error: Error) => {
      if (!record.readyResolved) record.stopping = true;
      record.rejectReady(error);
      this.options.database.addActivity({
        coworkerId,
        taskId: record.currentTaskId,
        type: "runtime.error",
        summary: error.message,
      });
    });
    worker.on("exit", (code) => {
      if (!record.readyResolved) record.stopping = true;
      record.rejectReady(new Error(`${coworker.name}'s runtime exited during startup (${code})`));
      void this.handleWorkerExit(coworkerId, record, code);
    });

    try {
      const modelConfiguration = await getRuntimeModelConfiguration(
        coworker.modelProvider,
        coworker.modelName,
        this.options.credentials,
      );
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
    const runtime = this.runtimes.get(coworkerId);
    if (!runtime) {
      this.setStatus(coworkerId, "STOPPED");
      return;
    }
    runtime.stopping = true;
    if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
    this.send(runtime, { type: "shutdown" });
    await Promise.race([
      new Promise<void>((resolve) => runtime.worker.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (this.runtimes.get(coworkerId) === runtime) {
      await runtime.worker.terminate();
      this.runtimes.delete(coworkerId);
    }
    this.setStatus(coworkerId, "STOPPED");
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.runtimes.keys()].map((id) => this.stop(id)));
  }

  enqueueTask(coworkerId: string): void {
    queueMicrotask(() => void this.dispatch(coworkerId));
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
    if (this.dispatching.has(coworkerId)) return;
    this.dispatching.add(coworkerId);
    let claimedTask: Task | null = null;
    try {
      const coworker = this.options.database.getCoworker(coworkerId);
      if (coworker.status !== "active") {
        this.setStatus(coworkerId, "STOPPED");
        return;
      }
      const current = this.runtimes.get(coworkerId);
      if (current?.currentTaskId) return;
      const task = this.options.database.claimNextTask(coworkerId);
      if (!task) {
        if (current) {
          this.setStatus(coworkerId, "IDLE");
          this.scheduleIdleShutdown(coworkerId, current);
        }
        return;
      }
      claimedTask = task;
      await this.start(coworkerId);
      const runtime = this.runtimes.get(coworkerId);
      if (!runtime) throw new Error("Coworker runtime disappeared during startup");
      if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
      runtime.idleTimer = null;
      runtime.currentTaskId = task.id;
      runtime.currentRunId = task.runId;
      this.setStatus(coworkerId, "WORKING", task.id);

      const approval = this.options.database.getApprovalForTask(task.id);
      let resume: Extract<MainToWorkerMessage, { type: "run" }>["resume"];
      if (approval && approval.status !== "PENDING") {
        const coworker = this.options.database.getCoworker(coworkerId);
        const execution = await this.options.tools.executeApproval(approval, coworker);
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
      const threadMessages = resume
        ? undefined
        : this.options.database
            .listConversationMessages(coworker.id, task.threadId)
            .filter((message) => message.taskId !== task.id)
            .slice(-100);
      const images = resume
        ? undefined
        : await loadImageAttachments(
            coworker.workspacePath,
            this.options.database.listTaskImageAttachments(task.id),
          );
      this.send(runtime, {
        type: "run",
        taskId: task.id,
        runId: task.runId,
        threadId: task.threadId,
        input: task.input,
        images,
        threadMessages,
        checkpoint: checkpoint?.messages,
        resume,
      });
    } catch (error) {
      const runtime = this.runtimes.get(coworkerId);
      const taskId = runtime?.currentTaskId ?? claimedTask?.id;
      const message = error instanceof Error ? error.message : String(error);
      if (taskId) {
        this.options.database.setTaskStatus(taskId, "FAILED", { error: message });
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
    }
  }

  private async handleWorkerMessage(
    runtime: RuntimeRecord,
    message: WorkerToMainMessage,
  ): Promise<void> {
    if (message.type === "ready") {
      runtime.readyResolved = true;
      runtime.resolveReady();
      this.setStatus(message.coworkerId, "IDLE");
      return;
    }
    if (message.type === "agui.event") {
      this.persistAgentEvent(message.coworkerId, message.taskId, message.runId, message.event);
      this.options.emit({
        type: "agent.event",
        coworkerId: message.coworkerId,
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
        if (result.kind === "approval") {
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
          this.options.emit({
            type: "entity.changed",
            entity: "approvals",
            id: result.approval.id,
          });
          this.options.emit({ type: "entity.changed", entity: "tasks", id: message.taskId });
        } else if (result.kind === "denied") {
          this.send(runtime, {
            type: "tool.response",
            requestId: message.requestId,
            response: { kind: "denied", reason: result.reason },
          });
        } else {
          this.send(runtime, {
            type: "tool.response",
            requestId: message.requestId,
            response: { kind: "completed", result: result.result },
          });
          this.options.emit({ type: "entity.changed", entity: "artifacts" });
        }
        this.options.emit({ type: "entity.changed", entity: "activity" });
      } catch (error) {
        this.send(runtime, {
          type: "tool.response",
          requestId: message.requestId,
          response: {
            kind: "denied",
            reason: error instanceof Error ? error.message : String(error),
          },
        });
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
      runtime.currentTaskId = null;
      runtime.currentRunId = null;
      const task = this.options.database.getTask(message.taskId);
      if (message.waitingForApproval || task.status === "WAITING_FOR_APPROVAL") {
        this.setStatus(message.coworkerId, "WAITING_FOR_APPROVAL", message.taskId);
      } else if (task.status !== "CANCELLED") {
        this.options.database.setTaskStatus(message.taskId, "COMPLETED", {
          result: message.result || "Completed",
        });
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
      runtime.currentTaskId = null;
      runtime.currentRunId = null;
      const task = this.options.database.getTask(message.taskId);
      if (task.status !== "CANCELLED" && task.status !== "WAITING_FOR_APPROVAL") {
        this.options.database.setTaskStatus(message.taskId, "FAILED", { error: message.error });
        this.setStatus(message.coworkerId, "ERROR", message.taskId);
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
      this.enqueueTask(message.coworkerId);
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
    this.runtimes.delete(coworkerId);
    if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
    if (runtime.stopping) return;

    if (runtime.currentTaskId) {
      const task = this.options.database.getTask(runtime.currentTaskId);
      if (task.status === "RUNNING") {
        this.options.database.setTaskStatus(task.id, "QUEUED");
      }
    }
    this.options.database.addActivity({
      coworkerId,
      taskId: runtime.currentTaskId,
      type: "runtime.crashed",
      summary: `Coworker runtime exited unexpectedly (code ${code})`,
    });
    await this.options.providerErrors?.log(
      {
        phase: "runtime_exit",
        provider: runtime.modelProvider,
        model: runtime.modelName,
        coworkerId,
        taskId: runtime.currentTaskId ?? undefined,
        runId: runtime.currentRunId ?? undefined,
      },
      new Error(`Coworker runtime exited unexpectedly (code ${code})`),
    );
    this.setStatus(coworkerId, "ERROR", runtime.currentTaskId ?? undefined);
    setTimeout(() => this.enqueueTask(coworkerId), 1_000).unref();
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
