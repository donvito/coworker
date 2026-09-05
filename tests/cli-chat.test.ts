import { describe, expect, it, vi } from "vitest";
import { parseCommand } from "../src/cli/commands";
import { formatChatResult, formatToolProgress, runChat } from "../src/cli/chat";
import { ipcChannels as ipc } from "@shared/ipc";

function fixture(status = "COMPLETED") {
  const request = vi.fn(async (method: string, _args: unknown[]): Promise<unknown> => {
    if (method === ipc.coworkersList) return [{ id: "ava-id", name: "Ava", status: "active" }];
    if (method === ipc.conversationsCreate || method === "conversations.show") return { id: "conversation-1", kind: "direct", memberIds: ["ava-id"] };
    if (method === ipc.conversationsSend) return { runs: [{ taskId: "task-1" }] };
    if (method === "tasks.show") return { task: { status, result: "Hello from Ava", error: status === "FAILED" ? "Provider unavailable" : null },
      conversationId: "conversation-1", approvals: status === "WAITING_FOR_APPROVAL" ? [{ id: "approval-1", summary: "Send email" }] : [] };
    throw new Error(`Unexpected method ${method}`);
  });
  return request;
}

describe("terminal chat", () => {
  it("reports tool state changes once, including fast calls in the final poll", async () => {
    let poll = 0;
    const request = vi.fn(async () => {
      poll++;
      return { task: { status: poll < 3 ? "RUNNING" : "COMPLETED", result: "Done", error: null },
        approvals: [], conversationId: "conversation-1", toolCalls: [
          { id: "first", toolName: "files.read", status: poll < 3 ? "RUNNING" : "COMPLETED" },
          ...(poll === 3 ? [{ id: "second", toolName: "files.read", status: "FAILED" }] : []),
        ] };
    });
    const onToolCall = vi.fn();
    await runChat(parseCommand(["chat", "result", "task-1"]), "/unused", { request, onToolCall, pollMs: 1 });
    expect(onToolCall.mock.calls.map(([tool]) => [tool.id, tool.status])).toEqual([
      ["first", "RUNNING"], ["first", "COMPLETED"], ["second", "FAILED"],
    ]);
    expect(formatToolProgress({ id: "1", toolName: "files.read\n", status: "WAITING_FOR_APPROVAL" }))
      .toBe("Tool: files.read  — waiting for approval");
  });

  it("sends one message with a unique ID and prints the correlated reply", async () => {
    const request = fixture();
    const result = await runChat(parseCommand(["chat", "ava", "Hello"]), "/unused", { request });
    expect(result).toMatchObject({ taskId: "task-1", conversationId: "conversation-1", reply: "Hello from Ava", status: "COMPLETED" });
    expect(request).toHaveBeenCalledWith(ipc.conversationsSend, [expect.objectContaining({
      conversationId: "conversation-1", content: "Hello", clientMessageId: expect.any(String), mentionedCoworkerIds: [],
    })]);
    expect(formatChatResult(result)).toContain("Hello from Ava");
  });

  it("reuses a supplied direct conversation without creating another", async () => {
    const request = fixture();
    await runChat(parseCommand(["chat", "Ava", "Next message", "--conversation", "conversation-1"]), "/unused", { request });
    expect(request).not.toHaveBeenCalledWith(ipc.conversationsCreate, expect.anything());
  });

  it("rejects ambiguous coworkers and wrong conversations before sending", async () => {
    const ambiguous = fixture();
    ambiguous.mockResolvedValueOnce([{ id: "1", name: "Ava" }, { id: "2", name: "Ava" }]);
    await expect(runChat(parseCommand(["chat", "Ava", "Hi"]), "/unused", { request: ambiguous })).rejects.toThrow("Several coworkers");
    expect(ambiguous).toHaveBeenCalledTimes(1);
    const wrong = fixture();
    wrong.mockResolvedValueOnce([{ id: "ava-id", name: "Ava", status: "active" }]);
    wrong.mockResolvedValueOnce({ id: "other", kind: "direct", memberIds: ["someone-else"] });
    await expect(runChat(parseCommand(["chat", "Ava", "Hi", "--conversation", "other"]), "/unused", { request: wrong })).rejects.toThrow("belonging");
    expect(wrong).toHaveBeenCalledTimes(2);
  });

  it("reports pending approvals without deciding them and resumes by task ID", async () => {
    const request = fixture("WAITING_FOR_APPROVAL");
    const result = await runChat(parseCommand(["chat", "result", "task-1"]), "/unused", { request });
    expect(formatChatResult(result)).toContain("coworker approvals show approval-1");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["tasks.show"]);
  });

  it("preserves provider failures and validates timeouts before any requests", async () => {
    const request = fixture("FAILED");
    const result = await runChat(parseCommand(["chat", "result", "task-1"]), "/unused", { request });
    expect(formatChatResult(result)).toContain("Provider unavailable");
    request.mockClear();
    await expect(runChat(parseCommand(["chat", "Ava", "Hi", "--timeout", "0"]), "/unused", { request })).rejects.toThrow("--timeout");
    expect(request).not.toHaveBeenCalled();
  });
});
