import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Approval, Conversation, Coworker, Task, ToolCall } from "@shared/contracts";
import { ipcChannels } from "@shared/ipc";
import { requestControl } from "@main/control/transport";
import type { CliCommand } from "./commands";

type Request = (method: string, args: unknown[]) => Promise<unknown>;
export type ChatToolProgress = Pick<ToolCall, "id" | "toolName" | "status">;
export function formatToolProgress(tool: ChatToolProgress): string {
  return `Tool: ${tool.toolName.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")} — ${tool.status.toLowerCase().replaceAll("_", " ")}`;
}
export interface ChatResult {
  conversationId: string | null;
  taskId: string;
  status: Task["status"];
  reply: string | null;
  error: string | null;
  approvals: Array<Pick<Approval, "id" | "summary">>;
  timedOut: boolean;
}

export function resolveChatCoworker(coworkers: Coworker[], target: string): Coworker {
  const exactId = coworkers.find((coworker) => coworker.id === target);
  if (exactId) return exactId;
  const matches = coworkers.filter((coworker) => coworker.name.toLowerCase() === target.toLowerCase());
  if (matches.length !== 1) throw new Error(matches.length
    ? `Several coworkers are named ${target}. Use an ID from coworkers list.`
    : `No coworker named ${target}. Use coworkers list to find a name or ID.`);
  return matches[0]!;
}

export async function runChat(command: CliCommand, dataPath: string, options: {
  request?: Request;
  onQueued?: (taskId: string, conversationId: string) => void;
  onToolCall?: (tool: ChatToolProgress) => void;
  signal?: AbortSignal;
  pollMs?: number;
} = {}): Promise<ChatResult> {
  const request = options.request ?? ((method, args) => requestControl(dataPath, method, args));
  const timeout = command.values.timeout === undefined ? 120 : Number(command.values.timeout);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) throw new Error("--timeout must be 1 to 3600 seconds");
  let taskId = command.args[0]!;
  if (command.name === "chat") {
    const message = command.args[1]!.trim();
    if (!message || message.length > 100_000) throw new Error("Chat message must contain 1 to 100000 characters");
    const coworkers = await request(ipcChannels.coworkersList, []) as Coworker[];
    const coworker = resolveChatCoworker(coworkers, command.args[0]!);
    if (coworker.status !== "active") throw new Error(`${coworker.name} is paused`);
    const conversation = command.values.conversation
      ? await request("conversations.show", [command.values.conversation]) as Conversation
      : await request(ipcChannels.conversationsCreate, [{ coworkerId: coworker.id, title: "Terminal chat" }]) as Conversation;
    if (conversation.kind !== "direct" || conversation.memberIds.length !== 1 || conversation.memberIds[0] !== coworker.id) {
      throw new Error("Choose a direct conversation belonging to this coworker");
    }
    const receipt = await request(ipcChannels.conversationsSend, [{
      conversationId: conversation.id, clientMessageId: randomUUID(), content: message, mentionedCoworkerIds: [],
    }]) as { runs: Array<{ taskId: string }> };
    taskId = receipt.runs[0]?.taskId ?? "";
    if (!taskId) throw new Error("The message was accepted but no task was returned. Check the conversation in Coworker.");
    options.onQueued?.(taskId, conversation.id);
  }
  const deadline = Date.now() + timeout * 1000;
  const toolStates = new Map<string, string>();
  for (;;) {
    options.signal?.throwIfAborted();
    const { task, approvals, conversationId, toolCalls = [] } = await request("tasks.show", [taskId]) as { task: Task; approvals: Approval[]; conversationId: string | null; toolCalls?: ChatToolProgress[] };
    for (const tool of toolCalls) {
      if (toolStates.get(tool.id) === tool.status) continue;
      toolStates.set(tool.id, tool.status);
      options.onToolCall?.(tool);
    }
    const finished = ["COMPLETED", "FAILED", "CANCELLED", "WAITING_FOR_APPROVAL"].includes(task.status);
    if (finished || Date.now() >= deadline) return {
      conversationId, taskId, status: task.status, reply: task.result,
      error: task.error, approvals: approvals.map(({ id, summary }) => ({ id, summary })), timedOut: !finished,
    };
    await delay(Math.min(options.pollMs ?? 500, Math.max(1, deadline - Date.now())), undefined, { signal: options.signal });
  }
}

export function formatChatResult(result: ChatResult): string {
  const lines = [result.status === "COMPLETED" ? result.reply || "Completed without a text reply."
    : result.status === "WAITING_FOR_APPROVAL" ? "Waiting for your approval."
      : result.timedOut ? "Still working. The task continues in Coworker."
        : `Chat ${result.status.toLowerCase()}: ${result.error ?? "No further details available."}`];
  if (result.conversationId) lines.push(`\nConversation: ${result.conversationId}`);
  lines.push(`Task: ${result.taskId}`);
  for (const approval of result.approvals) lines.push(`${approval.summary}\ncoworker approvals show ${approval.id}`);
  if (result.status !== "COMPLETED") lines.push(`Check the reply: coworker chat result ${result.taskId}`);
  return lines.join("\n");
}
