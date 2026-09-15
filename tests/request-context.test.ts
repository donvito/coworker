import { describe, expect, it } from "vitest";
import { requestContextForTask } from "@shared/request-context";

describe("request transport context", () => {
  it.each([
    ["discord:123", "manual", "discord"],
    ["telegram:456", "manual", "telegram"],
    ["local-message-id", "manual", "local"],
    [null, "manual", "local"],
    [null, "schedule", null],
    [null, "recovery", null],
    ["discord:123", "recovery", "discord"],
    ["telegram:456", "recovery", "telegram"],
    ["local-message-id", "recovery", "local"],
  ] as const)("resolves %s (%s) as %s", (sourceMessageId, source, channel) => {
    expect(requestContextForTask({ sourceMessageId, source })).toEqual({ channel, source });
  });
});

  it("carries connection identity in new transport IDs without changing legacy IDs", () => {
    expect(requestContextForTask({ sourceMessageId: "telegram:bot-one:123", source: "manual" })).toEqual({ channel: "telegram", source: "manual", originatingIntegrationId: "bot-one" });
    expect(requestContextForTask({ sourceMessageId: "discord:bot-two:123", source: "recovery" })).toEqual({ channel: "discord", source: "recovery", originatingIntegrationId: "bot-two" });
    expect(requestContextForTask({ sourceMessageId: "discord:123", source: "manual" })).not.toHaveProperty("originatingIntegrationId");
  });
