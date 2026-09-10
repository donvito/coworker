#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

function fail(message) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) fail(`Unexpected argument: ${key}`);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) fail(`Missing value for ${key}`);
    args[key.slice(2)] = value;
    i += 1;
  }
  return args;
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    fail(`${label} contains invalid JSON`);
  }
}

function entryId(seed) {
  return createHash("sha256").update(seed).digest("hex").slice(0, 8);
}

function timestampMs(value, fallbackMs) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallbackMs;
}

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function fallbackMessage(row, assistantDefaults) {
  const timestamp = timestampMs(row.createdAt, Date.now());
  if (row.role === "user") return { role: "user", content: row.content, timestamp };
  if (row.role === "assistant") {
    return {
      role: "assistant",
      content: [{ type: "text", text: row.content }],
      api: assistantDefaults.api,
      provider: assistantDefaults.provider,
      model: assistantDefaults.model,
      usage: zeroUsage(),
      stopReason: "stop",
      timestamp,
    };
  }
  return {
    role: "custom",
    customType: `coworker-${row.role}`,
    content: row.content,
    display: true,
    timestamp,
  };
}

const args = parseArgs(process.argv.slice(2));
if (!args.db) fail("--db is required");
if (!args.output) fail("--output is required");
if (Boolean(args["task-id"]) === Boolean(args["conversation-id"])) {
  fail("Provide exactly one of --task-id or --conversation-id");
}

const dbPath = resolve(args.db);
const outputPath = resolve(args.output);
if (!existsSync(dbPath)) fail(`Database not found: ${dbPath}`);

const db = new DatabaseSync(dbPath, { readOnly: true });
const taskSelect = `
  SELECT t.id AS taskId, t.thread_id AS conversationId, t.source_message_id AS sourceMessageId,
         t.input AS input, t.created_at AS createdAt, tc.messages_json AS messagesJson,
         tc.updated_at AS checkpointUpdatedAt, c.title AS conversationTitle,
         cw.workspace_path AS cwd, cw.model_provider AS modelProvider, cw.model_name AS modelName
  FROM tasks t
  JOIN conversations c ON c.id = t.thread_id
  JOIN coworkers cw ON cw.id = t.coworker_id
  LEFT JOIN task_checkpoints tc ON tc.task_id = t.id
`;

const selected = args["task-id"]
  ? db.prepare(`${taskSelect} WHERE t.id = ?`).get(args["task-id"])
  : db
      .prepare(
        `${taskSelect} WHERE t.thread_id = ? AND tc.messages_json IS NOT NULL ` +
          `ORDER BY tc.updated_at DESC LIMIT 1`,
      )
      .get(args["conversation-id"]);
if (!selected) {
  db.close();
  fail("No matching task checkpoint was found");
}
if (!selected.messagesJson) {
  db.close();
  fail(`Task ${selected.taskId} has no checkpoint`);
}

const tasks = db
  .prepare(
    `${taskSelect} WHERE t.thread_id = ? AND t.created_at <= ? ORDER BY t.created_at, t.id`,
  )
  .all(selected.conversationId, selected.createdAt);
const rows = db
  .prepare(
    `SELECT id, task_id AS taskId, role, content, created_at AS createdAt
     FROM messages
     WHERE conversation_id = ? AND created_at <= ?
     ORDER BY created_at, id`,
  )
  .all(selected.conversationId, selected.checkpointUpdatedAt);
db.close();

const checkpointMessages = new Map();
let assistantDefaults = {
  api: "openai-completions",
  provider: selected.modelProvider,
  model: selected.modelName,
};
for (const task of tasks) {
  if (!task.messagesJson) continue;
  const messages = parseJson(task.messagesJson, `Checkpoint ${task.taskId}`);
  if (!Array.isArray(messages)) fail(`Checkpoint ${task.taskId} is not a message array`);
  checkpointMessages.set(task.taskId, messages);
  for (const message of messages) {
    if (message?.role !== "assistant") continue;
    assistantDefaults = {
      api: message.api ?? assistantDefaults.api,
      provider: message.provider ?? assistantDefaults.provider,
      model: message.model ?? assistantDefaults.model,
    };
    break;
  }
}

const events = [];
const representedUsers = new Set();
for (const row of rows) {
  const taskHasCheckpoint = row.taskId && checkpointMessages.has(row.taskId);
  if (taskHasCheckpoint && row.role !== "user") continue;
  const message = fallbackMessage(row, assistantDefaults);
  events.push({
    key: `db:${row.id}`,
    timestamp: message.timestamp,
    order: 0,
    message,
  });
  if (row.role === "user") {
    if (row.taskId) representedUsers.add(row.taskId);
    for (const task of tasks) {
      if (task.sourceMessageId === row.id) representedUsers.add(task.taskId);
    }
  }
}

for (const [taskIndex, task] of tasks.entries()) {
  const messages = checkpointMessages.get(task.taskId);
  if (!messages) continue;
  if (!representedUsers.has(task.taskId)) {
    const timestamp = timestampMs(task.createdAt, Date.now());
    events.push({
      key: `task-user:${task.taskId}`,
      timestamp,
      order: taskIndex,
      message: { role: "user", content: task.input, timestamp },
    });
  }
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    // Coworker creates one synthetic user prompt containing durable history and
    // the current request. Real authored user messages come from `messages`.
    if (!message || message.role === "user") continue;
    const fallback = timestampMs(task.createdAt, Date.now()) + messageIndex + 1;
    const timestamp = timestampMs(message.timestamp, fallback);
    events.push({
      key: `checkpoint:${task.taskId}:${messageIndex}`,
      timestamp,
      order: taskIndex * 10_000 + messageIndex + 1,
      message: { ...message, timestamp },
    });
  }
}

events.sort((left, right) =>
  left.timestamp - right.timestamp || left.order - right.order || left.key.localeCompare(right.key),
);
if (events.length === 0) fail("No session events were reconstructed");

const header = {
  type: "session",
  version: 3,
  id: selected.taskId,
  timestamp: new Date(events[0].timestamp).toISOString(),
  cwd: selected.cwd,
};
const entries = [];
let parentId = null;
const infoId = entryId(`${selected.taskId}\0session_info`);
entries.push({
  type: "session_info",
  id: infoId,
  parentId,
  timestamp: header.timestamp,
  name: selected.conversationTitle,
});
parentId = infoId;
for (const event of events) {
  const id = entryId(`${selected.taskId}\0${event.key}`);
  entries.push({
    type: "message",
    id,
    parentId,
    timestamp: new Date(event.timestamp).toISOString(),
    message: event.message,
  });
  parentId = id;
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  { encoding: "utf8", mode: 0o600 },
);

const messages = events.map((event) => event.message);
const thinkingBlocks = messages.reduce(
  (count, message) =>
    count +
    (Array.isArray(message.content)
      ? message.content.filter((block) => block?.type === "thinking").length
      : 0),
  0,
);
const toolCalls = messages.reduce(
  (count, message) =>
    count +
    (Array.isArray(message.content)
      ? message.content.filter((block) => block?.type === "toolCall").length
      : 0),
  0,
);

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    output: outputPath,
    taskId: selected.taskId,
    conversationId: selected.conversationId,
    entries: entries.length,
    messages: messages.length,
    userMessages: messages.filter((message) => message.role === "user").length,
    assistantMessages: messages.filter((message) => message.role === "assistant").length,
    thinkingBlocks,
    toolCalls,
    toolResults: messages.filter((message) => message.role === "toolResult").length,
  })}\n`,
);
