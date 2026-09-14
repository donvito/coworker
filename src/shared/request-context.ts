import type { Task } from "./contracts";

export interface RequestContext {
  channel: "discord" | "telegram" | "local" | null;
  source: Task["source"];
}

/** Decode persisted transport identity, never message text or paired accounts.
 * Local covers desktop and CLI. This is context, not an authorization signal.
 */
export function requestContextForTask(
  task: Pick<Task, "sourceMessageId" | "source">,
): RequestContext {
  const namespace = task.sourceMessageId?.split(":", 1)[0];
  const channel = namespace === "discord" || namespace === "telegram"
    ? namespace
    : task.sourceMessageId || task.source === "manual" ? "local" : null;
  return { channel, source: task.source };
}

export function formatRequestContext(context?: RequestContext): string {
  return context
    ? `Current request context (transport metadata):\n${JSON.stringify(context)}`
    : "";
}
