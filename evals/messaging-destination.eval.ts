import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { coworkerHarness, type CoworkerEvalInput } from "./harness/coworker-harness";
import { hasRecording, liveModel, recordingPath } from "./harness/model-transcript";

const fileRequest = "The requested PDF report is already saved as report.pdf in my workspace. Send it to me.";
const scenarios = [
  { name: "Discord incoming file delivery selects Discord", incomingChannel: "discord", prompt: fileRequest, destination: "discord" },
  { name: "Telegram incoming file delivery selects Telegram", incomingChannel: "telegram", prompt: fileRequest, destination: "telegram" },
  { name: "Discord request explicitly selects Telegram", incomingChannel: "discord", prompt: `${fileRequest} Send it to Telegram.`, destination: "telegram" },
  { name: "Telegram request explicitly selects Discord", incomingChannel: "telegram", prompt: `${fileRequest} Send it to Discord.`, destination: "discord" },
  { name: "Local file request does not select a paired messenger", incomingChannel: "local", prompt: fileRequest, destination: null },
  { name: "Ordinary Discord reply does not load delivery skills", incomingChannel: "discord", prompt: "Thanks! Reply with you're welcome.", destination: null },
  { name: "Discord email discussion does not load messaging skills", incomingChannel: "discord", prompt: "Explain what an email subject line is in one sentence.", destination: null },
] as const;
const live = liveModel();
const runnable = scenarios.filter((s) => live || hasRecording(s.name)).map((s) => ({
  ...s, enabledTools: ["discord.send", "telegram.send"],
  bundledSkillNames: ["discord-messaging", "telegram-messaging"],
  policies: { "discord.send": "approval", "telegram.send": "approval" },
  approvalDecision: "none", transcriptPath: recordingPath(s.name),
  ...(live ? { model: live } : {}), expected: {},
} satisfies CoworkerEvalInput & { destination: string | null }));

describeEval("messaging destination and skill discovery", {
  harness: coworkerHarness, skipIf: () => runnable.length === 0,
}, (it) => {
  it.for(runnable)("$name", async (scenario, { run }) => {
    const { output } = await run(scenario);
    expect(output.error).toBeNull();
    const reads = output.toolCalls.filter((call) => call.name === "skills.read");
    const sends = output.toolCalls.filter((call) => call.name.endsWith(".send"));
    if (scenario.destination) {
      expect(reads.some((call) => JSON.stringify(call.arguments).includes(`${scenario.destination}-messaging`))).toBe(true);
      expect(sends.map((call) => call.name)).toEqual([`${scenario.destination}.send`]);
      expect(sends[0]!.arguments).toMatchObject({ attachments: ["report.pdf"] });
      expect(output.status).toBe("WAITING_FOR_APPROVAL");
    } else {
      expect(reads).toHaveLength(0);
      expect(sends).toHaveLength(0);
    }
  });
});
