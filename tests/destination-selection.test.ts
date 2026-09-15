import { describe, expect, it } from "vitest";
import type { Integration } from "@shared/contracts";
import { resolveMessagingIntegration } from "@main/integrations/integration-selection";

function db(rows: Integration[]) {
  return { listIntegrations: () => rows } as any;
}
function telegram(id: string, coworkerId: string, chatId: number | null = 1, status: Integration["status"] = "connected"): Integration {
  return { id, type: "telegram", name: id, mode: "bot", status, credentialKey: `credential:${id}`, config: { coworkerId, chatId, conversationId: `conversation-${id}`, topics: {}, lastThreads: {} }, createdAt: "", updatedAt: "" };
}

describe("messaging destination selection", () => {
  it("selects an explicit connection and rejects another coworker", () => {
    const rows = [telegram("a", "ava"), telegram("b", "bob")];
    expect(resolveMessagingIntegration({ database: db(rows), provider: "telegram", coworkerId: "ava", requestedIntegrationId: "a" }).id).toBe("a");
    expect(() => resolveMessagingIntegration({ database: db(rows), provider: "telegram", coworkerId: "ava", requestedIntegrationId: "b" })).toThrow(/another coworker/);
  });
  it("rejects ambiguous and disconnected origin selections", () => {
    const rows = [telegram("a", "ava"), telegram("b", "ava")];
    expect(() => resolveMessagingIntegration({ database: db(rows), provider: "telegram", coworkerId: "ava" })).toThrow(/multiple/i);
    rows[0]!.status = "disconnected";
    expect(() => resolveMessagingIntegration({ database: db(rows), provider: "telegram", coworkerId: "ava", originatingIntegrationId: "a" })).toThrow(/not connected/i);
  });
  it("infers a bot from its owned conversation", () => {
    const row = telegram("a", "ava");
    expect(resolveMessagingIntegration({ database: db([row]), provider: "telegram", coworkerId: "ava", conversationId: "conversation-a" }).id).toBe("a");
  });
});
