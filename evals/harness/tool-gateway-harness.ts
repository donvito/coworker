import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHarness,
  toJsonValue,
  type JsonValue,
  type TranscriptEvent,
} from "vitest-evals";
import { CoworkerDatabase } from "@main/db/database";
import { MemoryCredentialStore } from "@main/security/credential-store";
import { SchedulerService } from "@main/scheduler/scheduler-service";
import { ToolGateway } from "@main/tools/tool-gateway";
import type { ToolPolicy } from "@shared/contracts";

export interface ToolGatewayEvalInput {
  name: string;
  toolName: string;
  arguments: JsonValue;
  enabledTools?: string[];
  policy?: ToolPolicy;
  decision?: "approve" | "reject" | "none";
  executeRepeats?: number;
  expected: Partial<ToolGatewayEvalOutput> & { errorIncludes?: string };
}

export type ToolGatewayEvalOutput = {
  responseKind: "completed" | "approval" | "denied" | "error";
  error: string | null;
  toolStatus: string;
  approvalStatus: string | null;
  artifactCount: number;
  scheduleCount: number;
  outboxCount: number;
  executionCount: number;
  repeatResultsEqual: boolean;
};

export const toolGatewayHarness = createHarness<
  ToolGatewayEvalInput,
  ToolGatewayEvalOutput
>({
  name: "controlled-tool-gateway",
  run: async ({ input, setArtifact }) => {
    const root = await mkdtemp(join(tmpdir(), "tool-gateway-eval-"));
    const outbox = join(root, "outbox");
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    try {
      const coworker = database.createCoworker(
        {
          name: "Policy Eval",
          role: "Safety evaluator",
          systemPrompt: "Use only controlled tools.",
          modelProvider: "demo",
          modelName: "faux-1",
          enabledTools: input.enabledTools ?? [input.toolName],
          policies: input.policy ? { [input.toolName]: input.policy } : {},
        },
        join(root, "workspace"),
      );
      const task = database.createTask({
        coworkerId: coworker.id,
        title: input.name,
        input: `Evaluate ${input.toolName}`,
      });
      const credentials = new MemoryCredentialStore();
      database.upsertEmailIntegration({
        name: "Eval outbox",
        mode: "local-outbox",
        credentialKey: null,
        fromAddress: "eval@example.test",
      });
      const scheduler = new SchedulerService(database, () => undefined);
      const gateway = new ToolGateway(database, credentials, outbox, {
        createSchedule: (scheduleInput) => scheduler.create(scheduleInput),
      });

      let responseKind: ToolGatewayEvalOutput["responseKind"] = "error";
      let error: string | null = null;
      let executionCount = 0;
      let repeatResultsEqual = true;
      try {
        const response = await gateway.request({
          task,
          coworker,
          toolCallId: "eval-tool-call",
          toolName: input.toolName,
          arguments: input.arguments,
        });
        responseKind = response.kind;
        if (response.kind === "approval" && input.decision && input.decision !== "none") {
          const decided = database.decideApproval({
            approvalId: response.approval.id,
            decision: input.decision,
          });
          const results: JsonValue[] = [];
          const repeats = input.executeRepeats ?? 1;
          for (let index = 0; index < repeats; index += 1) {
            results.push(toJsonValue(await gateway.executeApproval(decided, coworker)) ?? null);
            executionCount += 1;
          }
          repeatResultsEqual = results.every(
            (result) => JSON.stringify(result) === JSON.stringify(results[0]),
          );
        }
      } catch (caught) {
        responseKind = "error";
        error = caught instanceof Error ? caught.message : String(caught);
      }

      const [toolCall] = database.listToolCalls(task.id);
      const [approval] = database
        .listApprovals()
        .filter((candidate) => candidate.taskId === task.id);
      const output: ToolGatewayEvalOutput = {
        responseKind,
        error,
        toolStatus: toolCall?.status ?? "MISSING",
        approvalStatus: approval?.status ?? null,
        artifactCount: database.listArtifacts(coworker.id).length,
        scheduleCount: database.listSchedules().length,
        outboxCount: (await readdir(outbox).catch(() => [])).length,
        executionCount,
        repeatResultsEqual,
      };
      setArtifact("policyOutcome", output);
      const argumentRecord =
        input.arguments &&
        typeof input.arguments === "object" &&
        !Array.isArray(input.arguments)
          ? input.arguments
          : { value: input.arguments };
      const events: TranscriptEvent[] = [
        {
          type: "tool_call",
          id: toolCall?.id ?? "missing",
          name: input.toolName,
          arguments: argumentRecord,
        },
      ];
      if (toolCall?.result !== null && toolCall?.result !== undefined) {
        events.push({
          type: "tool_result",
          toolCallId: toolCall.id,
          name: input.toolName,
          content: toJsonValue(toolCall.result) ?? null,
        });
      }
      return {
        output,
        events,
      };
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  },
});
