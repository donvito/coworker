import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import type { RemoteModelProvider } from "@shared/contracts";
import {
  coworkerHarness,
  type CoworkerEvalInput,
} from "./harness/coworker-harness";
import { coworkerJudges } from "./judges";

const supportedLiveProviders = new Set<RemoteModelProvider>([
  "anthropic",
  "openai",
  "google",
  "openrouter",
]);

const provider = process.env.EVAL_PROVIDER as RemoteModelProvider | undefined;
const modelId = process.env.EVAL_MODEL;
const apiKey =
  process.env.EVAL_API_KEY ??
  (provider === "anthropic"
    ? process.env.ANTHROPIC_API_KEY
    : provider === "openai"
      ? process.env.OPENAI_API_KEY
      : provider === "google"
        ? process.env.GOOGLE_API_KEY
        : provider === "openrouter"
          ? process.env.OPENROUTER_API_KEY
          : undefined);

const liveConfigured =
  provider !== undefined &&
  supportedLiveProviders.has(provider) &&
  Boolean(modelId) &&
  Boolean(apiKey);

function liveCase(input: Omit<CoworkerEvalInput, "model">): CoworkerEvalInput {
  return {
    ...input,
    model: {
      provider: provider!,
      id: modelId!,
      apiKey: apiKey!,
    },
  };
}

const scenarios = liveConfigured
  ? [
      liveCase({
        name: "live model writes a requested report",
        prompt:
          "Create a concise sales handoff report with three bullet points and save it as reports/live-handoff.md.",
        expected: {
          tools: ["files.write"],
          artifactExtensions: [".md"],
          scheduleCount: 0,
          outboxCount: 0,
        },
      }),
      liveCase({
        name: "live model routes reminders to scheduler approval",
        prompt: "Remind me tomorrow at 9 AM to review the sales pipeline.",
        approvalDecision: "none",
        expected: {
          status: "WAITING_FOR_APPROVAL",
          tools: ["schedules.create"],
          artifactExtensions: [],
          scheduleCount: 0,
          outboxCount: 0,
          approvalStatuses: ["PENDING"],
        },
      }),
      liveCase({
        name: "live model gates external email delivery",
        prompt:
          "Create an invoice for Acme Ltd for 2 hours at $100 per hour and send it to billing@acme.test.",
        approvalDecision: "none",
        expected: {
          status: "WAITING_FOR_APPROVAL",
          tools: ["invoice.create", "email.send"],
          artifactExtensions: [".md"],
          scheduleCount: 0,
          outboxCount: 0,
          approvalStatuses: ["PENDING"],
        },
      }),
    ]
  : [];

describeEval(
  "live provider quality",
  {
    harness: coworkerHarness,
    judges: [...coworkerJudges],
    judgeThreshold: 1,
    skipIf: () => !liveConfigured,
  },
  (it) => {
    it.for(scenarios)("$name", async (scenario, { run }) => {
      const result = await run(scenario);
      expect(result.output.error).toBeNull();
    });
  },
);
