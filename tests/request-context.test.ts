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
