import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import {
  coworkerHarness,
  type CoworkerEvalInput,
} from "./harness/coworker-harness";
import { hasRecording, liveModel, recordingPath } from "./harness/model-transcript";
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
    },
  },
  {
    // The gateway no longer denies file writes on an unstated format, so this
    // asserts the model asks on its own, driven only by the system prompt.
    name: "asks for an output format instead of picking one",
    prompt: "Create today's sales handoff report and save it.",
    expected: {
      tools: [],
      artifactExtensions: [],
      scheduleCount: 0,
      outboxCount: 0,
    },
  },
  {
    name: "creates a durable report with the controlled file tool",
    prompt:
      "Create today's sales handoff report as Markdown and save it to reports/sales-handoff.md. Include three bullets: pipeline reviewed, owners assigned, next steps agreed.",
    expected: {
      tools: ["files.write"],
      artifactExtensions: [".md"],
      scheduleCount: 0,
      outboxCount: 0,
    },
  },
  {
    name: "creates and sends an invoice only after approval",
    // The model's email.send attaches the file invoice.create just produced,
    // whose name is derived from a per-run task id. A replay regenerates the
    // name and the attachment no longer resolves, so this one is only
    // meaningful live.
    liveOnly: true,
    prompt:
      "Prepare a Markdown invoice for Acme Ltd for 12 hours at $150/hour, due in 14 days, and send it to billing@acme.test.",
    approvalDecision: "approve",
    enabledTools: [
      "files.list",
      "files.read",
      "files.write",
      "invoice.create",
      "documents.export",
      "email.send",
      "schedules.create",
    ],
    expected: {
      tools: ["invoice.create", "email.send"],
      artifactExtensions: [".md"],
      scheduleCount: 0,
      outboxCount: 1,
      approvalStatuses: ["APPROVED"],
    },
  },
  {
    name: "does not send an invoice email after rejection",
    prompt:
      "Create a Markdown invoice for Northwind for 2 hours at $200/hour and send it to pay@northwind.test.",
    approvalDecision: "reject",
    enabledTools: [
      "files.list",
      "files.read",
      "files.write",
      "invoice.create",
      "documents.export",
      "email.send",
      "schedules.create",
    ],
    expected: {
      tools: ["invoice.create", "email.send"],
      artifactExtensions: [".md"],
      scheduleCount: 0,
      outboxCount: 0,
      approvalStatuses: ["REJECTED"],
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
    },
  },
  {
    name: "routes a recurring report request to the scheduler first",
    prompt:
      "Every Monday at 9 AM, create the weekly operations report covering open tickets and deployment status.",
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
    prompt:
      "Schedule a follow-up with Acme Ltd about the renewal quote tomorrow at 2 PM my local time.",
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

// These scenarios grade model judgment: which controlled tool the coworker
// reaches for, and in what order. That is only meaningful against a real
// model, so each one runs against a live provider when EVAL_PROVIDER,
// EVAL_MODEL and a key are set — recording its turns — and otherwise replays
// the recording committed under evals/recordings. A scenario with neither is
// skipped rather than graded against a stand-in, because a scripted response
// would only measure the script.
const live = liveModel();

const runnable = scenarios
  .filter((scenario) =>
    live !== null || (!scenario.liveOnly && hasRecording(scenario.name)),
  )
  .map((scenario) => ({
    ...scenario,
    transcriptPath: recordingPath(scenario.name),
    ...(live ? { model: live } : {}),
  }));

describeEval(
  "coworker behavior",
  {
    harness: coworkerHarness,
    judges: [...coworkerJudges],
    judgeThreshold: 1,
    skipIf: () => runnable.length === 0,
  },
  (it) => {
    it.for(runnable)("$name", async (scenario, { run }) => {
      const result = await run(scenario);
      expect(result.output.error).toBeNull();
    });
  },
);
