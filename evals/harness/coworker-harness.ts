import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { createHarness, toJsonValue, type JsonValue, type TranscriptEvent } from "vitest-evals";
import { CoworkerDatabase } from "@main/db/database";
import { MemoryCredentialStore } from "@main/security/credential-store";
import { CoworkerRuntimeManager } from "@main/runtime/runtime-manager";
import { SchedulerService } from "@main/scheduler/scheduler-service";
import { ToolGateway } from "@main/tools/tool-gateway";
import type {
  ModelProvider,
  RemoteModelProvider,
  TaskStatus,
  ToolPolicy,
} from "@shared/contracts";
import {
  localModelCredentialMarker,
} from "@main/integrations/model-catalog";
import {
  modelProviderBaseUrlKey,
  modelProviderCredentialKey,
} from "@shared/model-providers";

export interface CoworkerEvalExpectation {
  status?: TaskStatus;
  tools?: string[];
  artifactExtensions?: string[];
  scheduleCount?: number;
  outboxCount?: number;
  approvalStatuses?: string[];
  resultIncludes?: string[];
}

export interface CoworkerEvalInput {
  name: string;
  prompt: string;
  enabledTools?: string[];
  policies?: Record<string, ToolPolicy>;
  approvalDecision?: "approve" | "reject" | "none";
  replayAfterCompletion?: boolean;
  /**
   * Model transcript for this scenario. A real provider records its turns
   * here; the demo provider replays them, so the eval grades the recorded
   * model decisions rather than a scripted stand-in.
   */
  transcriptPath?: string;
  model?: {
    provider: ModelProvider;
    id: string;
    apiKey?: string;
    baseUrl?: string;
  };
  expected: CoworkerEvalExpectation;
}

export type CoworkerEvalOutput = {
  status: TaskStatus;
  result: string;
  error: string | null;
  toolCalls: Array<{
    id: string;
    name: string;
    status: string;
    arguments: JsonValue | null;
    result: JsonValue | null;
  }>;
  approvals: Array<{
    actionType: string;
    status: string;
  }>;
  artifacts: Array<{
    name: string;
    mimeType: string;
  }>;
  schedules: Array<{
    name: string;
    scheduleType: string;
    enabled: boolean;
  }>;
  outboxFiles: string[];
  messages: Array<{
    role: string;
    content: string;
  }>;
};

const terminalStatuses = new Set<TaskStatus>(["COMPLETED", "FAILED", "CANCELLED"]);

async function waitForOutcome(
  database: CoworkerDatabase,
  manager: CoworkerRuntimeManager,
  coworkerId: string,
  taskId: string,
  decision: CoworkerEvalInput["approvalDecision"],
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + 45_000;
  const decided = new Set<string>();
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Eval run was aborted");
    const task = database.getTask(taskId);
    if (terminalStatuses.has(task.status)) return;
    if (task.status === "WAITING_FOR_APPROVAL") {
      const approval = database
        .listApprovals()
        .find((candidate) => candidate.taskId === taskId && candidate.status === "PENDING");
      if (approval && !decided.has(approval.id)) {
        if (!decision || decision === "none") return;
        decided.add(approval.id);
        database.decideApproval({
          approvalId: approval.id,
          decision,
        });
        manager.enqueueTask(coworkerId);
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for eval task ${taskId}`);
}

function transcriptEvents(
  input: CoworkerEvalInput,
  output: CoworkerEvalOutput,
): TranscriptEvent[] {
  const events: TranscriptEvent[] = [
    { type: "message", role: "user", content: input.prompt },
  ];
  for (const call of output.toolCalls) {
    const argumentsValue =
      call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
        ? call.arguments
        : { value: call.arguments };
    events.push({
      type: "tool_call",
      id: call.id,
      name: call.name,
      arguments: argumentsValue,
    });
    if (call.result !== null) {
      events.push({
        type: "tool_result",
        toolCallId: call.id,
        name: call.name,
        content: call.result,
      });
    }
  }
  for (const message of output.messages.filter((candidate) => candidate.role === "assistant")) {
    events.push({ type: "message", role: "assistant", content: message.content });
  }
  return events;
}

export const coworkerHarness = createHarness<CoworkerEvalInput, CoworkerEvalOutput>({
  name: "desktop-coworker",
  run: async ({ input, signal, setArtifact }) => {
    const previousTranscript = process.env.COWORKER_MODEL_TRANSCRIPT;
    if (input.transcriptPath) process.env.COWORKER_MODEL_TRANSCRIPT = input.transcriptPath;
    const root = await mkdtemp(join(tmpdir(), "coworker-eval-"));
    const workspace = join(root, "workspace");
    const outbox = join(root, "outbox");
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    const credentials = new MemoryCredentialStore();
    let manager: CoworkerRuntimeManager | undefined;
    try {
      const selectedModel = input.model ?? {
        provider: "demo" as const,
        id: "faux-1",
      };
      if (selectedModel.provider !== "demo") {
        const provider = selectedModel.provider as RemoteModelProvider;
        await credentials.set(
          modelProviderCredentialKey(provider),
          selectedModel.apiKey || localModelCredentialMarker,
        );
        if (selectedModel.baseUrl) {
          await credentials.set(modelProviderBaseUrlKey(provider), selectedModel.baseUrl);
        }
      }
      database.upsertEmailIntegration({
        name: "Eval outbox",
        mode: "local-outbox",
        credentialKey: null,
        fromAddress: "eval@example.test",
      });
      const coworker = database.createCoworker(
        {
          name: "Eval Coworker",
          role: "Evaluation specialist",
          systemPrompt:
            "Complete the user's request accurately. Use controlled tools for files, email, and schedules.",
          modelProvider: selectedModel.provider,
          modelName: selectedModel.id,
          enabledTools:
            input.enabledTools ??
            [
              "files.list",
              "files.read",
              "files.write",
              "invoice.create",
              "documents.export",
              "email.create_draft",
              "email.send",
              "schedules.create",
            ],
          policies: {
            "email.send": "approval",
            "schedules.create": "approval",
            ...input.policies,
          },
        },
        workspace,
      );
      let scheduler: SchedulerService;
      const tools = new ToolGateway(database, credentials, outbox, {
        createSchedule: (scheduleInput) => scheduler.create(scheduleInput),
      });
      manager = new CoworkerRuntimeManager({
        database,
        credentials,
        tools,
        emit: () => undefined,
        idleTimeoutMs: 60_000,
        workerFactory: () =>
          new Worker(resolve(process.cwd(), "out/main/runtime/coworker-worker.js")),
      });
      scheduler = new SchedulerService(database, (task) => {
        manager?.enqueueTask(task.coworkerId);
      });
      const task = database.createTask({
        coworkerId: coworker.id,
        title: input.name,
        input: input.prompt,
      });
      manager.enqueueTask(coworker.id);
      await waitForOutcome(
        database,
        manager,
        coworker.id,
        task.id,
        input.approvalDecision ?? "approve",
        signal,
      );
      if (input.replayAfterCompletion && database.getTask(task.id).status === "COMPLETED") {
        manager.enqueueTask(coworker.id);
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }

      const finalTask = database.getTask(task.id);
      const calls = database.listToolCalls(task.id);
      const messages = database.listMessages(coworker.id, task.id);
      const output: CoworkerEvalOutput = {
        status: finalTask.status,
        result: finalTask.result ?? "",
        error: finalTask.error,
        toolCalls: calls.map((call) => ({
          id: call.id,
          name: call.toolName,
          status: call.status,
          arguments: toJsonValue(call.arguments) ?? null,
          result: toJsonValue(call.result) ?? null,
        })),
        approvals: database
          .listApprovals()
          .filter((approval) => approval.taskId === task.id)
          .map((approval) => ({
            actionType: approval.actionType,
            status: approval.status,
          })),
        artifacts: database.listArtifacts(coworker.id).map((artifact) => ({
          name: artifact.name,
          mimeType: artifact.mimeType,
        })),
        schedules: database.listSchedules().map((schedule) => ({
          name: schedule.name,
          scheduleType: schedule.scheduleType,
          enabled: schedule.enabled,
        })),
        outboxFiles: await readdir(outbox).catch(() => []),
        messages: messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      };
      setArtifact("task", {
        status: output.status,
        error: output.error,
      });
      setArtifact("sideEffects", {
        artifacts: output.artifacts,
        schedules: output.schedules,
        outboxFiles: output.outboxFiles,
      });
      return {
        output,
        events: transcriptEvents(input, output),
        usage: {
          provider: selectedModel.provider,
          model: selectedModel.id,
        },
      };
    } finally {
      await manager?.stopAll().catch(() => undefined);
      database.close();
      await rm(root, { recursive: true, force: true });
      if (previousTranscript === undefined) delete process.env.COWORKER_MODEL_TRANSCRIPT;
      else process.env.COWORKER_MODEL_TRANSCRIPT = previousTranscript;
    }
  },
});
