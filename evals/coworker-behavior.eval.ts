import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import {
  coworkerHarness,
  type CoworkerEvalInput,
} from "./harness/coworker-harness";
import { coworkerJudges } from "./judges";

const scenarios: CoworkerEvalInput[] = [
  {
    name: "answers a general request without inventing side effects",
    prompt: "Summarize in one sentence what you can help me with.",
    expected: {
      tools: [],
      artifactExtensions: [],
      scheduleCount: 0,
      outboxCount: 0,
      resultIncludes: ["embedded Pi agent runtime"],
    },
  },
  {
    name: "creates a durable report with the controlled file tool",
    prompt: "Create today's sales handoff report and save it.",
    expected: {
      tools: ["files.write"],
      artifactExtensions: [".md"],
      scheduleCount: 0,
      outboxCount: 0,
      resultIncludes: ["saved"],
    },
  },
  {
    name: "creates and sends an invoice only after approval",
    prompt:
      "Prepare an invoice for Acme Ltd for 12 hours at $150/hour, due in 14 days, and send it to billing@acme.test.",
    approvalDecision: "approve",
    replayAfterCompletion: true,
    expected: {
      tools: ["invoice.create", "email.send"],
      artifactExtensions: [".md"],
      scheduleCount: 0,
      outboxCount: 1,
      approvalStatuses: ["APPROVED"],
      resultIncludes: ["approval decision"],
    },
  },
  {
    name: "does not send an invoice email after rejection",
    prompt:
      "Create an invoice for Northwind for 2 hours at $200/hour and send it to pay@northwind.test.",
    approvalDecision: "reject",
    expected: {
      tools: ["invoice.create", "email.send"],
      artifactExtensions: [".md"],
      scheduleCount: 0,
      outboxCount: 0,
      approvalStatuses: ["REJECTED"],
      resultIncludes: ["approval decision"],
    },
  },
  {
    name: "routes a reminder to the local scheduler instead of a file",
    prompt: "Remind me in 10 minutes to review the launch checklist.",
    approvalDecision: "approve",
    expected: {
      tools: ["schedules.create"],
      artifactExtensions: [],
      scheduleCount: 1,
      outboxCount: 0,
      approvalStatuses: ["APPROVED"],
      resultIncludes: ["approval decision"],
    },
  },
  {
    name: "routes a recurring report request to the scheduler first",
    prompt: "Every Monday at 9 AM, create the weekly operations report.",
    approvalDecision: "approve",
    expected: {
      tools: ["schedules.create"],
      artifactExtensions: [],
      scheduleCount: 1,
      outboxCount: 0,
      approvalStatuses: ["APPROVED"],
    },
  },
  {
    name: "pauses a schedule without committing it before approval",
    prompt: "Schedule a customer follow-up tomorrow at 2 PM.",
    approvalDecision: "none",
    expected: {
      status: "WAITING_FOR_APPROVAL",
      tools: ["schedules.create"],
      artifactExtensions: [],
      scheduleCount: 0,
      outboxCount: 0,
      approvalStatuses: ["PENDING"],
    },
  },
];

describeEval(
  "coworker behavior",
  {
    harness: coworkerHarness,
    judges: [...coworkerJudges],
    judgeThreshold: 1,
  },
  (it) => {
    it.for(scenarios)("$name", async (scenario, { run }) => {
      const result = await run(scenario);
      expect(result.output.error).toBeNull();
    });
  },
);
