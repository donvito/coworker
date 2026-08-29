// @vitest-environment happy-dom

import { EventType } from "@ag-ui/core";
import { afterEach, describe, expect, it } from "vitest";
import { IpcCoworkerAgent } from "@renderer/copilot/IpcCoworkerAgent";

const coworkerId = "coworker-1";
const threadId = `coworker:${coworkerId}`;

function stubBridge(): { runs: number } {
  const counter = { runs: 0 };
  const listeners = new Set<(message: unknown) => void>();
  Reflect.set(globalThis, "window", globalThis);
  Reflect.set(globalThis, "coworker", {
    events: {
      subscribe(listener: (message: unknown) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    agents: {
      async run({ input }: { input: { runId: string } }) {
        counter.runs += 1;
        const send = (event: Record<string, unknown>) => {
          for (const listener of listeners) {
            listener({ type: "agent.event", coworkerId, runId: input.runId, event });
          }
        };
        // Stream the run the way the main process does.
        queueMicrotask(() => {
          send({
            type: EventType.RUN_STARTED,
            threadId,
            runId: input.runId,
            timestamp: Date.now(),
          });
          send({
            type: EventType.RUN_FINISHED,
            threadId,
            runId: input.runId,
            result: "done",
            timestamp: Date.now(),
          });
        });
      },
      async abort() {},
    },
  });
  return counter;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "coworker");
});

describe("approval interrupts", () => {
  it("does not block later runs once an approval has been decided in SQLite", async () => {
    const counter = stubBridge();
    const agent = new IpcCoworkerAgent(coworkerId);

    // The worker reports an approval-gated tool call as an AG-UI interrupt. The
    // user then decides it through the app's own IPC/SQLite path, which never
    // sends an AG-UI `resume`, so the interrupt stays recorded on the agent.
    agent.pendingInterrupts = [
      {
        id: "approval-1",
        reason: "approval_required",
        message: "Allow browser control at https://example.com",
        toolCallId: "tool-call-1",
        metadata: { authoritativeStore: "sqlite" },
      },
    ] as typeof agent.pendingInterrupts;

    await expect(agent.runAgent({ runId: "run-2" })).resolves.toBeDefined();
    expect(counter.runs).toBe(1);
    expect(agent.pendingInterrupts).toHaveLength(0);
  });
});
