import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { coworkerHarness, type CoworkerEvalInput } from "./harness/coworker-harness";
import { hasRecording, liveModel, recordingPath } from "./harness/model-transcript";

const scenarios = [
  { name: "loads Coworker administration guidance for terminal setup",
    prompt: "Explain how I can start Coworker headlessly from my terminal and check its logs. Do not execute anything.", shouldLoad: true },
  { name: "does not load Coworker administration for an unrelated summary",
    prompt: "Summarize this in one sentence: The team completed three reports and will review them tomorrow. Do not execute anything.", shouldLoad: false },
];
const live = liveModel();
const runnable = scenarios.filter((scenario) => live || hasRecording(scenario.name)).map((scenario) => ({
  ...scenario, enabledTools: [], bundledSkillNames: ["coworker-administration"],
  transcriptPath: recordingPath(scenario.name), ...(live ? { model: live } : {}),
  expected: {},
} satisfies CoworkerEvalInput & { shouldLoad: boolean }));

describeEval("administration skill routing", {
  harness: coworkerHarness,
  skipIf: () => runnable.length === 0,
}, (it) => {
  it.for(runnable)("$name", async (scenario, { run }) => {
    const result = await run(scenario);
    expect(result.output.error).toBeNull();
    const reads = result.output.toolCalls.filter((call) => call.name === "skills.read");
    expect(reads.some((call) => JSON.stringify(call.arguments).includes("coworker-administration"))).toBe(scenario.shouldLoad);
    expect(result.output.toolCalls.every((call) => call.name === "skills.read")).toBe(true);
  });
});
