import { describe, expect, it } from "vitest";
import {
  filterConversations,
  messageDayKey,
  messageDayLabel,
} from "@renderer/lib/conversation-utils";
import type { Conversation, Message, Task } from "@shared/contracts";

const conversations: Conversation[] = [
  {
    id: "first",
    coworkerId: "ava",
    kind: "direct",
    memberIds: ["ava"],
    title: "Quarterly planning",
    createdAt: "2026-08-20T09:00:00.000Z",
    updatedAt: "2026-08-20T09:00:00.000Z",
  },
  {
    id: "second",
    coworkerId: "ava",
    kind: "direct",
    memberIds: ["ava"],
    title: "Customer follow-up",
    createdAt: "2026-08-21T09:00:00.000Z",
    updatedAt: "2026-08-21T09:00:00.000Z",
  },
];

const tasks: Task[] = [
  {
    id: "task-first",
    coworkerId: "ava",
    scheduleId: null,
    runId: "run-first",
    threadId: "first",
    sourceMessageId: null,
    discussionId: null,
    discussionTurn: null,
    title: "Forecast revenue",
    input: "Review the forecast",
    status: "COMPLETED",
    source: "manual",
    priority: 0,
    result: null,
    error: null,
    createdAt: "2026-08-20T09:00:00.000Z",
    startedAt: null,
    completedAt: null,
  },
  {
    id: "task-second",
    coworkerId: "ava",
    scheduleId: null,
    runId: "run-second",
    threadId: "second",
    sourceMessageId: null,
    discussionId: null,
    discussionTurn: null,
    title: "Draft response",
    input: "Reply to Acme",
    status: "COMPLETED",
    source: "manual",
    priority: 0,
    result: null,
    error: null,
    createdAt: "2026-08-21T09:00:00.000Z",
    startedAt: null,
    completedAt: null,
  },
];

const messages: Message[] = [
  {
    id: "message-first",
    conversationId: "first",
    coworkerId: "ava",
    authorName: "Ava",
    taskId: "task-first",
    role: "assistant",
    content: "The subscription forecast increased by twelve percent.",
    mentionedCoworkerIds: [],
    createdAt: "2026-08-20T09:01:00.000Z",
  },
  {
    id: "message-second",
    conversationId: "second",
    coworkerId: "ava",
    authorName: "Ava",
    taskId: "task-second",
    role: "assistant",
    content: "The Acme response is ready.",
    mentionedCoworkerIds: [],
    createdAt: "2026-08-21T09:01:00.000Z",
  },
];

describe("conversation search and date grouping", () => {
  it("searches titles, task text, and message contents", () => {
    expect(filterConversations(conversations, tasks, messages, "planning")).toEqual([
      conversations[0],
    ]);
    expect(filterConversations(conversations, tasks, messages, "subscription forecast")).toEqual([
      conversations[0],
    ]);
    expect(filterConversations(conversations, tasks, messages, "Acme")).toEqual([
      conversations[1],
    ]);
    expect(filterConversations(conversations, tasks, messages, "")).toEqual(conversations);
  });

  it("groups timestamps by local calendar day and labels recent days", () => {
    const now = new Date(2026, 7, 24, 18, 0, 0);
    const today = new Date(2026, 7, 24, 9, 30, 0).toISOString();
    const yesterday = new Date(2026, 7, 23, 23, 30, 0).toISOString();
    const earlier = new Date(2026, 7, 20, 12, 0, 0).toISOString();

    expect(messageDayKey(today, now)).toBe("2026-08-24");
    expect(messageDayLabel(today, now)).toBe("Today");
    expect(messageDayLabel(yesterday, now)).toBe("Yesterday");
    expect(messageDayLabel(earlier, now)).toMatch(/Aug/);
    expect(messageDayLabel(earlier, now)).toMatch(/20/);
  });
});
