import type { Conversation, Message, Task } from "@shared/contracts";

export function filterConversations(
  conversations: Conversation[],
  tasks: Task[],
  messages: Message[],
  query: string,
): Conversation[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return conversations;

  const taskConversationIds = new Map(
    tasks.map((task) => [task.id, task.threadId] as const),
  );
  const searchableByConversation = new Map<string, string[]>();
  for (const task of tasks) {
    const values = searchableByConversation.get(task.threadId) ?? [];
    values.push(task.title, task.input, task.result ?? "", task.error ?? "");
    searchableByConversation.set(task.threadId, values);
  }
  for (const message of messages) {
    if (!message.taskId) continue;
    const conversationId = taskConversationIds.get(message.taskId);
    if (!conversationId) continue;
    const values = searchableByConversation.get(conversationId) ?? [];
    values.push(message.content);
    searchableByConversation.set(conversationId, values);
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
