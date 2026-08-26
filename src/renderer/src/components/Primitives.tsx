import type { ReactNode } from "react";
import type { Coworker, RuntimeStatus, TaskStatus } from "@shared/contracts";
import { modelProviderName } from "@shared/model-providers";
import avatar1 from "../assets/coworker-avatars/avatar-1.png";
import avatar2 from "../assets/coworker-avatars/avatar-2.png";
import avatar3 from "../assets/coworker-avatars/avatar-3.png";
import avatar4 from "../assets/coworker-avatars/avatar-4.png";
import avatar5 from "../assets/coworker-avatars/avatar-5.png";
import avatar6 from "../assets/coworker-avatars/avatar-6.png";
import avatar7 from "../assets/coworker-avatars/avatar-7.png";
import avatar8 from "../assets/coworker-avatars/avatar-8.png";
import avatar9 from "../assets/coworker-avatars/avatar-9.png";
import { Icon, type IconName } from "./Icon";

const coworkerAvatars = [
  avatar1,
  avatar2,
  avatar3,
  avatar4,
  avatar5,
  avatar6,
  avatar7,
  avatar8,
  avatar9,
] as const;

const coworkerAvatarColors = [
  "#315e4e",
  "#4962a9",
  "#a85e43",
  "#8a6a2f",
  "#5e568f",
  "#39727a",
] as const;

function avatarIndex(id: string): number {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash;
}

export function CoworkerAvatar({
  coworker,
  className = "",
}: {
  coworker: Pick<Coworker, "id" | "name">;
  className?: string;
}) {
  const index = avatarIndex(coworker.id);
  return (
    <span
      aria-label={`${coworker.name} avatar`}
      className={`coworker-avatar ${className}`.trim()}
      role="img"
      style={{ backgroundColor: coworkerAvatarColors[index % coworkerAvatarColors.length] }}
    >
      <img alt="" src={coworkerAvatars[index % coworkerAvatars.length]} />
    </span>
  );
}

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
  // OpenRouter ids are "org/model"; the segment after the slash is the model.
  const displayName = coworker.modelName.split("/").at(-1) || coworker.modelName;
  return (
    <span
      aria-label={`Configured model: ${label}`}
      className={compact ? "coworker-model-badge compact" : "coworker-model-badge"}
      title={`Configured model: ${label}`}
    >
      <code>{displayName}</code>
      <span>{provider}</span>
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
