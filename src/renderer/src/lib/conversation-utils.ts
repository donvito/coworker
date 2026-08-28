import { EventType, type BaseEvent } from "@ag-ui/core";
import type { Conversation, Message, Task } from "@shared/contracts";

export interface LiveResponse {
  coworkerId: string;
  taskId: string;
  content: string;
  status: "queued" | "running" | "failed";
  error?: string;
}

export function updateLiveResponses(
  current: Record<string, LiveResponse>,
  input: { runId: string; coworkerId: string; taskId: string; event: BaseEvent },
): Record<string, LiveResponse> {
  const existing = current[input.runId] ?? {
    coworkerId: input.coworkerId,
    taskId: input.taskId,
    content: "",
    status: "queued" as const,
  };
  if (input.event.type === EventType.TEXT_MESSAGE_CONTENT && "delta" in input.event) {
    return {
      ...current,
      [input.runId]: {
        ...existing,
        content: existing.content + String(input.event.delta),
        status: "running",
      },
    };
  }
  if (input.event.type === EventType.RUN_STARTED) {
    return {
      ...current,
      [input.runId]: { ...existing, status: "running" },
    };
  }
  if (input.event.type === EventType.RUN_ERROR) {
    return {
      ...current,
      [input.runId]: {
        ...existing,
        status: "failed",
        error:
          "message" in input.event
            ? String(input.event.message)
            : "The coworker could not finish.",
      },
    };
  }
  return current;
}

export function filterConversations(
  conversations: Conversation[],
  tasks: Task[],
  messages: Message[],
  query: string,
): Conversation[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return conversations;

  const searchableByConversation = new Map<string, string[]>();
  for (const task of tasks) {
    const values = searchableByConversation.get(task.threadId) ?? [];
    values.push(task.title, task.input, task.result ?? "", task.error ?? "");
    searchableByConversation.set(task.threadId, values);
  }
  for (const message of messages) {
    const values = searchableByConversation.get(message.conversationId) ?? [];
    values.push(message.content);
    searchableByConversation.set(message.conversationId, values);
  }

  return conversations.filter((conversation) =>
    [conversation.title, ...(searchableByConversation.get(conversation.id) ?? [])]
      .join("\n")
      .toLocaleLowerCase()
      .includes(normalizedQuery),
  );
}

export function messageDayKey(value: string | undefined, fallback = new Date()): string {
  const date = value ? new Date(value) : fallback;
  const valid = Number.isNaN(date.getTime()) ? fallback : date;
  return [
    valid.getFullYear(),
    String(valid.getMonth() + 1).padStart(2, "0"),
    String(valid.getDate()).padStart(2, "0"),
  ].join("-");
}

export function messageDayLabel(value: string | undefined, now = new Date()): string {
  const date = value ? new Date(value) : now;
  const valid = Number.isNaN(date.getTime()) ? now : date;
  const today = messageDayKey(now.toISOString(), now);
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(now.getDate() - 1);
  const key = messageDayKey(valid.toISOString(), now);
  if (key === today) return "Today";
  if (key === messageDayKey(yesterdayDate.toISOString(), now)) return "Yesterday";
  return valid.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: valid.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}
