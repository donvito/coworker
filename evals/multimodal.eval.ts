import { expect } from "vitest";
import { createHarness, createJudge, describeEval } from "vitest-evals";
import { parseAgentPrompt } from "@main/integrations/image-attachments";
import { agentRunRequestSchema } from "@shared/validation";

type MultimodalCase = {
  name: string;
  kind: "valid" | "image-only" | "spoofed" | "remote-url" | "too-many";
  expected: {
    accepted: boolean;
    imageCount?: number;
    text?: string;
    errorIncludes?: string;
  };
};

type MultimodalOutput = {
  accepted: boolean;
  imageCount: number;
  text: string;
  error: string | null;
};

const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]).toString("base64");

function runInput(content: unknown) {
  return {
    threadId: "eval-thread",
    runId: "eval-run",
    state: {},
    messages: [{ id: "eval-message", role: "user", content }],
  };
}

const multimodalHarness = createHarness<MultimodalCase, MultimodalOutput>({
  name: "multimodal-input-pipeline",
  run: ({ input }) => {
    let content: unknown;
    if (input.kind === "remote-url") {
      content = [
        {
          type: "image",
          source: {
            type: "url",
            value: "https://example.test/image.png",
            mimeType: "image/png",
          },
        },
      ];
    } else {
      const image = {
        type: "image",
        source: {
          type: "data",
          value:
            input.kind === "spoofed"
              ? Buffer.from("not an image").toString("base64")
              : png,
          mimeType: "image/png",
        },
        metadata: { name: "launch.png" },
      };
      content =
        input.kind === "too-many"
          ? Array.from({ length: 5 }, () => image)
          : input.kind === "image-only"
            ? [image]
            : [{ type: "text", text: "Describe this launch image." }, image];
    }

    let output: MultimodalOutput;
    try {
      const candidate = {
        coworkerId: "eval-coworker",
        input: runInput(content),
      };
      const parsedRequest = agentRunRequestSchema.parse(candidate);
      const parsed = parseAgentPrompt(parsedRequest.input as never);
      output = {
        accepted: true,
        imageCount: parsed.images.length,
        text: parsed.text,
        error: null,
      };
    } catch (error) {
      output = {
        accepted: false,
        imageCount: 0,
        text: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      output,
      events: [
        {
          type: "message",
          role: "user",
          content: `[${input.kind} multimodal payload]`,
        },
      ],
    };
  },
});

const MultimodalContractJudge = createJudge<MultimodalCase, MultimodalOutput>(
  "MultimodalContract",
  ({ input, output }) => {
    const failures: string[] = [];
    if (output.accepted !== input.expected.accepted) {
      failures.push(`accepted=${output.accepted}`);
    }
    if (
      input.expected.imageCount !== undefined &&
      output.imageCount !== input.expected.imageCount
    ) {
      failures.push(`imageCount=${output.imageCount}`);
    }
    if (input.expected.text !== undefined && output.text !== input.expected.text) {
      failures.push(`text=${JSON.stringify(output.text)}`);
    }
    if (
      input.expected.errorIncludes &&
      !output.error?.toLowerCase().includes(input.expected.errorIncludes.toLowerCase())
    ) {
      failures.push(`error=${JSON.stringify(output.error)}`);
    }
    return {
      score: failures.length === 0 ? 1 : 0,
      metadata: {
        rationale: failures.length === 0 ? "Multimodal contract satisfied" : failures.join("; "),
      },
    };
  },
);

const scenarios: MultimodalCase[] = [
  {
    name: "accepts a valid local PNG with text",
    kind: "valid",
    expected: {
      accepted: true,
      imageCount: 1,
      text: "Describe this launch image.",
    },
  },
  {
    name: "adds a safe default prompt for image-only input",
    kind: "image-only",
    expected: {
      accepted: true,
      imageCount: 1,
      text: "Analyze the attached image.",
    },
  },
  {
    name: "rejects MIME-spoofed image bytes",
    kind: "spoofed",
    expected: {
      accepted: false,
      errorIncludes: "does not match its declared image format",
    },
  },
  {
    name: "rejects remote image URLs at the IPC boundary",
    kind: "remote-url",
    expected: {
      accepted: false,
    },
  },
  {
    name: "rejects more than four attached images",
    kind: "too-many",
    expected: {
      accepted: false,
      errorIncludes: "no more than 4 images",
    },
  },
];

describeEval(
  "multimodal safety",
  {
    harness: multimodalHarness,
    judges: [MultimodalContractJudge],
    judgeThreshold: 1,
  },
  (it) => {
    it.for(scenarios)("$name", async (scenario, { run }) => {
      const result = await run(scenario);
      expect(result.output.accepted).toBe(scenario.expected.accepted);
    });
  },
);
