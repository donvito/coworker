import type { ReactNode } from "react";
import type { Coworker, RuntimeStatus, TaskStatus } from "@shared/contracts";
import { modelProviderName } from "@shared/model-providers";
import { Icon, type IconName } from "./Icon";

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {action ? <div className="page-header-action">{action}</div> : null}
    </header>
  );
}

export function StatusLabel({
  status,
}: {
  status: RuntimeStatus | TaskStatus | "PENDING" | "APPROVED" | "REJECTED";
}) {
  const label = status
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/^\w/, (value) => value.toUpperCase());
  return (
    <span className={`status-label status-${status.toLowerCase().replaceAll("_", "-")}`}>
      <span className="status-dot" />
      {label}
    </span>
  );
}

export function CoworkerModelBadge({
  coworker,
  compact = false,
}: {
  coworker: Pick<Coworker, "modelProvider" | "modelName">;
  compact?: boolean;
}) {
  if (coworker.modelProvider === "demo") {
    return (
      <span
        aria-label="No model configured"
        className={compact ? "coworker-model-badge compact" : "coworker-model-badge"}
        title="No model configured"
      >
        <span>No model configured</span>
      </span>
    );
  }
  const provider = modelProviderName(coworker.modelProvider);
  const label = `${provider} · ${coworker.modelName}`;
  return (
    <span
      aria-label={`Configured model: ${label}`}
      className={compact ? "coworker-model-badge compact" : "coworker-model-badge"}
      title={`Configured model: ${label}`}
    >
      <span>{provider}</span>
      <code>{coworker.modelName}</code>
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: IconName;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} />
      </span>
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}

export function formatRelativeTime(value: string | null): string {
  if (!value) return "Not yet";
  const difference = new Date(value).getTime() - Date.now();
  const minutes = Math.round(Math.abs(difference) / 60_000);
  if (minutes < 1) return difference < 0 ? "Just now" : "In a moment";
  if (minutes < 60) return difference < 0 ? `${minutes}m ago` : `In ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return difference < 0 ? `${hours}h ago` : `In ${hours}h`;
  const days = Math.round(hours / 24);
  return difference < 0 ? `${days}d ago` : `In ${days}d`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}
