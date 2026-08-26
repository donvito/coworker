import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AppSnapshot, Coworker } from "@shared/contracts";
import { Icon } from "../components/Icon";
import {
  CoworkerAvatar,
  CoworkerModelBadge,
  EmptyState,
  PageHeader,
  StatusLabel,
} from "../components/Primitives";

const countWords = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
] as const;

export function HomePage({
  snapshot,
  onOpenCoworker,
  onOpenApprovals,
  onManageCoworkers,
  onOpenActivity,
  onChanged,
}: {
  snapshot: AppSnapshot;
  onOpenCoworker: (coworker: Coworker) => void;
  onOpenApprovals: () => void;
  onManageCoworkers: () => void;
  onOpenActivity: () => void;
  onChanged: () => Promise<void>;
}) {
  const pending = snapshot.approvals.filter((approval) => approval.status === "PENDING");
  const running = snapshot.coworkers.filter(
    (coworker) => coworker.runtimeStatus === "WORKING",
  ).length;
  const latestActivity = snapshot.activity[0] ?? null;
  const latestActor = latestActivity?.coworkerId
    ? snapshot.coworkers.find((coworker) => coworker.id === latestActivity.coworkerId)?.name
    : null;
  const availableCoworkers = snapshot.coworkers.filter(
    (coworker) => coworker.status === "active",
  );
  const [draft, setDraft] = useState("");
  const [assigneeId, setAssigneeId] = useState<string | null>(
    availableCoworkers[0]?.id ?? null,
  );
  const [dispatching, setDispatching] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const composerInput = useRef<HTMLInputElement>(null);
  const assignee =
    availableCoworkers.find((coworker) => coworker.id === assigneeId) ??
    availableCoworkers[0] ??
    null;

  useEffect(() => {
    function focusComposer(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        composerInput.current?.focus();
      }
    }
    window.addEventListener("keydown", focusComposer);
    return () => window.removeEventListener("keydown", focusComposer);
  }, []);

  async function putToWork(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !assignee || dispatching) return;
    setDispatching(true);
    setComposerError(null);
    try {
      await window.coworker.tasks.create({
        coworkerId: assignee.id,
        title: composerTaskTitle(text),
        input: text,
      });
      // Refresh before navigating so the task's new conversation is the
      // latest one and gets auto-selected on the coworker page.
      await onChanged();
      setDraft("");
      onOpenCoworker(assignee);
    } catch (dispatchError) {
      setComposerError(
        dispatchError instanceof Error ? dispatchError.message : String(dispatchError),
      );
    } finally {
      setDispatching(false);
    }
  }

  return (
    <div className="page home-page">
      <PageHeader
        eyebrow="Team room"
        title={greeting()}
        action={
          <div className="floor-head-actions">
            <span className="floor-scope">
              <span className="pulse-dot" /> Local · this computer
            </span>
            <button
              className="primary-button"
              onClick={() =>
                availableCoworkers.length > 0
                  ? composerInput.current?.focus()
                  : onManageCoworkers()
              }
              type="button"
            >
              New task
            </button>
          </div>
        }
      />

      <section aria-label="Team status" className="floor-stats">
        <div>
          <small>Coworkers</small>
          <strong>{snapshot.coworkers.length}</strong>
          <span>on the floor</span>
        </div>
        <div>
          <small>Running now</small>
          <strong>{running}</strong>
          <span>of {snapshot.coworkers.length}</span>
        </div>
        <div>
          <small>Waiting on you</small>
          <strong>{pending.length}</strong>
          <span>{pending.length === 1 ? "decision" : "decisions"}</span>
        </div>
        <div>
          <small>Last activity</small>
          <strong>{latestActivity ? compactAge(latestActivity.createdAt) : "—"}</strong>
          <span>{latestActivity ? `ago · ${latestActor ?? "Workroom"}` : "no activity yet"}</span>
        </div>
      </section>

      <div className="floor-grid">
        <div className="floor-main">
          {availableCoworkers.length > 0 ? (
            <form className="floor-composer" onSubmit={putToWork}>
              <div className="floor-composer-head">
                <h2>Put someone to work</h2>
                <kbd>{window.coworker.platform === "darwin" ? "⌘ K" : "Ctrl K"}</kbd>
              </div>
              <input
                aria-label="Describe the task"
                disabled={dispatching}
                maxLength={100_000}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Ask a coworker to…"
                ref={composerInput}
                value={draft}
              />
              <div className="floor-composer-assign">
                <small>Assign to</small>
                {availableCoworkers.map((coworker) => (
                  <button
                    aria-pressed={assignee?.id === coworker.id}
                    className={
                      assignee?.id === coworker.id
                        ? "floor-composer-chip selected"
                        : "floor-composer-chip"
                    }
                    disabled={dispatching}
                    key={coworker.id}
                    onClick={() => setAssigneeId(coworker.id)}
                    type="button"
                  >
                    {coworker.name}
                  </button>
                ))}
                <button
                  className="primary-button floor-composer-send"
                  disabled={dispatching || !draft.trim() || !assignee}
                  type="submit"
                >
                  {dispatching
                    ? "Starting…"
                    : `Start${assignee ? ` ${assignee.name}` : ""}`}
                </button>
              </div>
              {composerError ? (
                <small className="floor-composer-error" role="alert">
                  {composerError}
                </small>
              ) : null}
            </form>
          ) : null}

          <div className="floor-section-head">
            <h2>Your coworkers</h2>
            <button className="text-button" onClick={onManageCoworkers} type="button">
              Manage all {countWords[snapshot.coworkers.length] ?? snapshot.coworkers.length}
              <Icon name="arrow" />
            </button>
          </div>

          {snapshot.coworkers.length === 0 ? (
            <EmptyState
              icon="people"
              title="Your team is empty"
              body="Create a coworker with a focused role and controlled tools."
            />
          ) : (
            <div className="floor-coworkers">
              {snapshot.coworkers.map((coworker) => (
                <button
                  className="floor-card"
                  key={coworker.id}
                  onClick={() => onOpenCoworker(coworker)}
                  type="button"
                >
                  <span className="floor-card-head">
                    <CoworkerAvatar className="floor-card-avatar" coworker={coworker} />
                    <span className="floor-card-id">
                      <strong>{coworker.name}</strong>
                      <small>{coworker.role}</small>
                    </span>
                    <StatusLabel status={coworker.runtimeStatus} />
                  </span>
                  <span className="floor-card-task">{taskLine(snapshot, coworker)}</span>
                  <span className="floor-card-foot">
                    <CoworkerModelBadge
                      compact
                      coworker={coworker}
                      modelEndpoints={snapshot.modelEndpoints}
                    />
                    <span className="floor-card-action">
                      {actionLabel(coworker)}
                      <Icon name="arrow" />
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}

          <div className="floor-approvals">
            <span
              className={
                pending.length === 0
                  ? "floor-approvals-icon"
                  : "floor-approvals-icon attention"
              }
            >
              <Icon name={pending.length === 0 ? "check" : "shield"} />
            </span>
            <span className="floor-approvals-copy">
              <strong>
                {pending.length === 0
                  ? "Nothing is blocked"
                  : `${pending.length} decision${pending.length === 1 ? "" : "s"} waiting on you`}
              </strong>
              <small>
                {pending.length === 0
                  ? "Consequential actions wait here before they run."
                  : pending[0]?.summary}
              </small>
            </span>
            <button className="text-button" onClick={onOpenApprovals} type="button">
              {pending.length === 0 ? "Approval rules" : "Review"}
              {pending.length === 0 ? null : <Icon name="arrow" />}
            </button>
          </div>
        </div>

        <aside aria-label="Recent movement" className="floor-activity">
          <header>
            <h2>Recent movement</h2>
            <span className="eyebrow">Desk log</span>
          </header>
          <div className="floor-activity-list">
            {snapshot.activity.length === 0 ? (
              <p className="floor-activity-empty">
                Quiet so far. Activity shows up here as coworkers work.
              </p>
            ) : (
              snapshot.activity.slice(0, 7).map((item) => {
                const coworker = snapshot.coworkers.find(
                  (candidate) => candidate.id === item.coworkerId,
                );
                return (
                  <div className="floor-activity-row" key={item.id}>
                    <span className="floor-activity-copy">
                      <strong>{item.summary}</strong>
                      <small>
                        {coworker?.name ?? "Workroom"} · {activityKind(item.type)}
                      </small>
                    </span>
                    <time dateTime={item.createdAt}>{compactAge(item.createdAt)}</time>
                  </div>
                );
              })
            )}
          </div>
          <button className="text-button" onClick={onOpenActivity} type="button">
            Open full activity
            <Icon name="arrow" />
          </button>
        </aside>
      </div>
    </div>
  );
}

function composerTaskTitle(text: string): string {
  const firstLine = text.split("\n")[0]?.trim() || "New task";
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning. The room is open.";
  if (hour < 18) return "Good afternoon. Here’s the floor.";
  return "Good evening. Here’s where work stands.";
}

function taskLine(snapshot: AppSnapshot, coworker: Coworker): string {
  const activeTask = snapshot.tasks.find(
    (task) =>
      task.coworkerId === coworker.id &&
      ["RUNNING", "WAITING_FOR_APPROVAL", "QUEUED"].includes(task.status),
  );
  if (activeTask) return activeTask.title;
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const recentlyFinished = snapshot.tasks.filter(
    (task) =>
      task.coworkerId === coworker.id &&
      task.status === "COMPLETED" &&
      task.completedAt !== null &&
      new Date(task.completedAt).getTime() >= hourAgo,
  ).length;
  if (recentlyFinished > 0) {
    return `Finished ${recentlyFinished} task${recentlyFinished === 1 ? "" : "s"} in the last hour`;
  }
  return "Ready for a new task";
}

function actionLabel(coworker: Coworker): string {
  if (["WORKING", "WAITING_FOR_APPROVAL"].includes(coworker.runtimeStatus)) return "Open";
  if (coworker.runtimeStatus === "IDLE") return "Assign";
  return "Start";
}

function activityKind(type: string): string {
  const domain = type.split(".")[0] ?? type;
  if (domain === "tool") return "called a tool";
  if (domain === "task") return "task";
  if (domain === "schedule") return "schedule";
  if (domain === "coworker") return "roster";
  if (domain === "app") return "workroom";
  return domain.replaceAll("-", " ");
}

function compactAge(timestamp: string): string {
  const elapsedMs = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "now";
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
