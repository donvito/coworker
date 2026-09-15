import type { Task } from "./contracts";

export interface RequestContext {
  channel: "discord" | "telegram" | "local" | null;
  source: Task["source"];
  originatingIntegrationId?: string;
  eligibleConnections?: Array<{ id: string; name: string; destination: string }>;
}

/** Decode persisted transport identity, never message text or paired accounts.
 * Local covers desktop and CLI. This is context, not an authorization signal.
 */
export function requestContextForTask(
  task: Pick<Task, "sourceMessageId" | "source">,
): RequestContext {
  const parts = task.sourceMessageId?.split(":") ?? [];
  const namespace = parts[0];
  const channel = namespace === "discord" || namespace === "telegram"
    ? namespace
    : task.sourceMessageId || task.source === "manual" ? "local" : null;
  return {
    channel,
    source: task.source,
    ...(parts.length >= 3 && (namespace === "telegram" || namespace === "discord") ? { originatingIntegrationId: parts[1] } : {}),
  };
}

export function formatRequestContext(context?: RequestContext): string {
  return context
    ? `Current request context (transport metadata):\n${JSON.stringify(context)}`
    : "";
}
