import { useState } from "react";
import type { Conversation, Coworker, Schedule } from "@shared/contracts";
import { Icon } from "../components/Icon";
import { ScheduleEditorModal } from "../components/ScheduleEditorModal";
import {
  CoworkerAvatar,
  EmptyState,
  PageHeader,
  formatRelativeTime,
} from "../components/Primitives";
import { describeSchedule } from "@shared/schedule-frequency";
import { scheduleDestination } from "./CoworkerDetailPage";

export function SchedulesPage({
  schedules,
  conversations,
  coworkers,
  onChanged,
  onOpenConversation,
}: {
  schedules: Schedule[];
  conversations: Conversation[];
  coworkers: Coworker[];
  onChanged: () => Promise<void>;
  onOpenConversation: (coworkerId: string, conversationId: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function toggle(schedule: Schedule) {
    setWorking(schedule.id);
    try {
      await window.coworker.schedules.update(schedule.id, { enabled: !schedule.enabled });
      await onChanged();
    } finally {
      setWorking(null);
    }
  }

  async function runNow(schedule: Schedule) {
    setWorking(schedule.id);
    setError(null);
    setNotice(null);
    try {
      const task = await window.coworker.schedules.runNow(schedule.id);
      await onChanged();
      setNotice(`“${task.title}” is now in the task queue.`);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setWorking(null);
    }
  }

  async function remove(schedule: Schedule) {
    if (!confirm(`Delete “${schedule.name}”?`)) return;
    setWorking(schedule.id);
    try {
      await window.coworker.schedules.remove(schedule.id);
      await onChanged();
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="page schedules-page">
      <PageHeader
        eyebrow="Local clock"
        title="Schedules"
        description="Scheduled work enters the same durable task queue as a manual request."
        action={
          <button className="primary-button" onClick={() => setCreating(true)}>
            <Icon name="plus" /> New schedule
          </button>
        }
      />

      <div className="scheduler-note">
        <Icon name="clock" />
        <span>
          <strong>Runs while Workroom is open or in the tray.</strong>
          <small>Missed runs execute once when this computer wakes or the app starts again.</small>
        </span>
      </div>

      {notice ? <div className="settings-notice" role="status">{notice}</div> : null}
      {error ? <div className="settings-notice error" role="alert">{error}</div> : null}

      {schedules.length === 0 ? (
        <EmptyState
          icon="clock"
          title="No recurring work yet"
          body="Give a coworker a dependable rhythm, like a weekday lead report or Friday receivables check."
          action={
            <button className="secondary-button" onClick={() => setCreating(true)}>
              Create the first schedule
            </button>
          }
        />
      ) : (
        <div className="schedule-list">
          {schedules.map((schedule) => {
            const coworker = coworkers.find((item) => item.id === schedule.coworkerId);
            return (
              <article
                className={schedule.enabled ? "schedule-card" : "schedule-card disabled"}
                key={schedule.id}
              >
                {coworker ? (
                  <CoworkerAvatar className="schedule-avatar" coworker={coworker} />
                ) : (
                  <span className="schedule-avatar">?</span>
                )}
                <div className="schedule-main">
                  <span>
                    <small>{coworker?.name ?? "Coworker"}</small>
                    <h2>{schedule.name}</h2>
                  </span>
                  <p>{schedule.taskTemplate.title}</p>
                  <div className="schedule-meta">
                    <span>
                      <Icon name="clock" />
                      {describeSchedule(schedule)}
                    </span>
                    <span>
                      Next: {schedule.enabled ? formatRelativeTime(schedule.nextRunAt) : "Paused"}
                    </span>
                    {schedule.lastRunAt ? (
                      <span>Last ran {formatRelativeTime(schedule.lastRunAt)}</span>
                    ) : null}
                    {coworker ? (
                      <button
                        className="schedule-destination-link"
                        onClick={() =>
                          onOpenConversation(
                            coworker.id,
                            schedule.conversationId ?? `coworker:${coworker.id}`,
                          )
                        }
                        type="button"
                      >
                        <Icon name="send" />
                        {scheduleDestination(schedule, conversations, coworker)}
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="schedule-actions">
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={schedule.enabled}
                      disabled={working === schedule.id}
                      onChange={() => void toggle(schedule)}
                    />
                    <span />
                    <small>{schedule.enabled ? "On" : "Off"}</small>
                  </label>
                  <button className="secondary-button" onClick={() => setEditing(schedule)}>
                    Edit
                  </button>
                  <button
                    className="secondary-button"
                    disabled={working === schedule.id}
                    onClick={() => void runNow(schedule)}
                  >
                    Run now
                  </button>
                  <button
                    className="icon-button danger"
                    aria-label={`Delete ${schedule.name}`}
                    disabled={working === schedule.id}
                    onClick={() => void remove(schedule)}
                  >
                    ×
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {creating || editing ? (
        <ScheduleEditorModal
          coworkers={coworkers}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={onChanged}
          schedule={editing}
        />
      ) : null}
    </div>
  );
}
