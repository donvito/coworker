import { createJudge } from "vitest-evals";
import type {
  CoworkerEvalInput,
  CoworkerEvalOutput,
} from "./harness/coworker-harness";

function rationale(label: string, expected: unknown, actual: unknown): string {
  return `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`;
}

export const TaskOutcomeJudge = createJudge<CoworkerEvalInput, CoworkerEvalOutput>(
  "TaskOutcome",
  ({ input, output }) => {
    const expected = input.expected.status ?? "COMPLETED";
    return {
      score: output.status === expected ? 1 : 0,
      metadata: { rationale: rationale("Task status", expected, output.status) },
    };
  },
);

export const ToolSelectionJudge = createJudge<CoworkerEvalInput, CoworkerEvalOutput>(
  "ToolSelection",
  ({ input, output }) => {
    const expected = input.expected.tools ?? [];
    const actual = output.toolCalls.map((call) => call.name);
    return {
      score:
        expected.length === actual.length &&
        expected.every((toolName, index) => actual[index] === toolName)
          ? 1
          : 0,
      metadata: { rationale: rationale("Tool sequence", expected, actual) },
    };
  },
);

export const SideEffectJudge = createJudge<CoworkerEvalInput, CoworkerEvalOutput>(
  "SideEffects",
  ({ input, output }) => {
    const checks: Array<{ label: string; expected: unknown; actual: unknown }> = [];
    if (input.expected.artifactExtensions) {
      checks.push({
        label: "Artifact extensions",
        expected: [...input.expected.artifactExtensions].sort(),
        actual: output.artifacts
          .map((artifact) => artifact.name.match(/(\.[^.]+)$/)?.[1] ?? "")
          .sort(),
      });
    }
    if (input.expected.scheduleCount !== undefined) {
      checks.push({
        label: "Schedule count",
        expected: input.expected.scheduleCount,
        actual: output.schedules.length,
      });
    }
    if (input.expected.outboxCount !== undefined) {
      checks.push({
        label: "Outbox count",
        expected: input.expected.outboxCount,
        actual: output.outboxFiles.length,
      });
    }
    if (input.expected.approvalStatuses) {
      checks.push({
        label: "Approval statuses",
        expected: input.expected.approvalStatuses,
        actual: output.approvals.map((approval) => approval.status),
      });
    }
    const failed = checks.find(
      (check) => JSON.stringify(check.expected) !== JSON.stringify(check.actual),
    );
    return {
      score: failed ? 0 : 1,
      metadata: {
        rationale: failed
          ? rationale(failed.label, failed.expected, failed.actual)
          : `${checks.length} side-effect contract${checks.length === 1 ? "" : "s"} satisfied`,
      },
    };
  },
);

export const ResponseContractJudge = createJudge<CoworkerEvalInput, CoworkerEvalOutput>(
  "ResponseContract",
  ({ input, output }) => {
    const expected = input.expected.resultIncludes ?? [];
    const response = output.result.toLowerCase();
    const missing = expected.filter((phrase) => !response.includes(phrase.toLowerCase()));
    return {
      score: missing.length === 0 ? 1 : 0,
      metadata: {
        rationale:
          missing.length === 0
            ? "Required response content is present"
            : `Missing response content: ${missing.join(", ")}`,
      },
    };
  },
);

export const coworkerJudges = [
  TaskOutcomeJudge,
  ToolSelectionJudge,
  SideEffectJudge,
  ResponseContractJudge,
] as const;
