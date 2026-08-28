import { useState, type ReactNode } from "react";
import type {
  Coworker,
  Integration,
  ModelEndpoint,
  RuntimeStatus,
  TaskStatus,
} from "@shared/contracts";
import { modelProviderDisplayName } from "@shared/model-providers";
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

export const coworkerAvatarCount = coworkerAvatars.length;

export function coworkerAvatarVisual(index: number): { image: string; color: string } {
  const safe = Math.abs(Math.trunc(index));
  return {
    image: coworkerAvatars[safe % coworkerAvatars.length]!,
    color: coworkerAvatarColors[safe % coworkerAvatarColors.length]!,
  };
}

export function CoworkerAvatar({
  coworker,
  className = "",
}: {
  coworker: Pick<Coworker, "id" | "name"> & { avatarIndex?: number | null };
  className?: string;
}) {
  const visual = coworkerAvatarVisual(coworker.avatarIndex ?? avatarIndex(coworker.id));
  return (
    <span
      aria-label={`${coworker.name} avatar`}
      className={`coworker-avatar ${className}`.trim()}
      role="img"
      style={{ backgroundColor: visual.color }}
    >
      <img alt="" src={visual.image} />
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
  modelEndpoints = [],
}: {
  coworker: Pick<Coworker, "modelProvider" | "modelName">;
  compact?: boolean;
  modelEndpoints?: ModelEndpoint[];
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
  const provider = modelProviderDisplayName(coworker.modelProvider, modelEndpoints);
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

/** The coworker linked to the connected Telegram bot, if any. */
export function telegramLinkedCoworkerId(integrations: Integration[]): string | null {
  const integration = integrations.find(
    (candidate) => candidate.type === "telegram" && candidate.status === "connected",
  );
  const coworkerId = (integration?.config as { coworkerId?: string } | undefined)?.coworkerId;
  return typeof coworkerId === "string" && coworkerId ? coworkerId : null;
}

export function TelegramLinkBadge({ compact = false }: { compact?: boolean }) {
  return (
    <span
      aria-label="Connected to the Telegram bot"
      className={
        compact
          ? "coworker-model-badge compact telegram-link-badge"
          : "coworker-model-badge telegram-link-badge"
      }
      title="Connected to the Telegram bot"
    >
      <span>Telegram</span>
    </span>
  );
}

/** A quiet hover-revealed button that copies text and confirms briefly. */
export function CopyTextButton({
  text,
  label = "Copy message",
}: {
  text: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      aria-label={copied ? "Copied" : label}
      className={copied ? "copy-text-button copied" : "copy-text-button"}
      onClick={(event) => {
        event.stopPropagation();
        const confirm = () => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        };
        // The main-process clipboard is the dependable path in a sandboxed
        // renderer; the web API stays as the fallback.
        void window.coworker.app
          .copyText(text)
          .then(confirm)
          .catch(() => navigator.clipboard.writeText(text).then(confirm));
      }}
      title={copied ? "Copied" : label}
      type="button"
    >
      <Icon name={copied ? "check" : "copy"} />
      {copied ? <span>Copied</span> : null}
    </button>
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
