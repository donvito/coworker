import { useState, type FormEvent } from "react";
import type { Coworker, Schedule } from "@shared/contracts";
import { Icon } from "../components/Icon";
import { ModalPortal } from "../components/ModalPortal";
import {
  CoworkerAvatar,
  EmptyState,
  PageHeader,
  formatRelativeTime,
} from "../components/Primitives";

export function SchedulesPage({
  schedules,
  coworkers,
  onChanged,
}: {
  schedules: Schedule[];
  coworkers: Coworker[];
  onChanged: () => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [scheduleType, setScheduleType] = useState<"cron" | "once">("cron");
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setWorking("create");
    setError(null);
    try {
      await window.coworker.schedules.create({
        coworkerId: String(data.get("coworkerId")),
        name: String(data.get("name")),
        scheduleType,
        cronExpression:
          scheduleType === "cron" ? String(data.get("cronExpression")) : undefined,
        runAt:
          scheduleType === "once"
            ? new Date(String(data.get("runAt"))).toISOString()
            : undefined,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        taskTemplate: {
          title: String(data.get("taskTitle")),
          input: String(data.get("taskInput")),
        },
      });
      setCreating(false);
      await onChanged();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setWorking(null);
    }
  }

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
      {error && !creating ? <div className="settings-notice error" role="alert">{error}</div> : null}

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
                      {humanSchedule(schedule)}
                    </span>
                    <span>
                      Next: {schedule.enabled ? formatRelativeTime(schedule.nextRunAt) : "Paused"}
                    </span>
                    {schedule.lastRunAt ? (
                      <span>Last ran {formatRelativeTime(schedule.lastRunAt)}</span>
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

      {creating ? (
        <ModalPortal>
        <div className="modal-backdrop" onMouseDown={() => setCreating(false)}>
          <section
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-schedule-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <span className="eyebrow">New rhythm</span>
            <h2 id="create-schedule-title">Schedule coworker work</h2>
            <p>The scheduler creates a normal queued task at each due time.</p>
            <form className="form-stack" onSubmit={create}>
              <label>
                <span>Coworker</span>
                <select name="coworkerId" required>
                  {coworkers.map((coworker) => (
                    <option value={coworker.id} key={coworker.id}>
                      {coworker.name} · {coworker.role}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Schedule name</span>
                <input name="name" placeholder="Weekday lead follow-ups" required />
              </label>
              <div className="segmented-control">
                <button
                  type="button"
                  className={scheduleType === "cron" ? "active" : ""}
                  onClick={() => setScheduleType("cron")}
                >
                  Recurring
                </button>
                <button
                  type="button"
                  className={scheduleType === "once" ? "active" : ""}
                  onClick={() => setScheduleType("once")}
                >
                  One time
                </button>
              </div>
              {scheduleType === "cron" ? (
                <label>
                  <span>Cron expression</span>
                  <input name="cronExpression" defaultValue="0 8 * * 1-5" required />
                  <small>Example: 0 8 * * 1-5 means weekdays at 8:00 AM.</small>
                </label>
              ) : (
                <label>
                  <span>Run at</span>
                  <input
                    name="runAt"
                    type="datetime-local"
                    required
                    defaultValue={new Date(Date.now() + 3_600_000).toISOString().slice(0, 16)}
                  />
                </label>
              )}
              <label>
                <span>Task title</span>
                <input name="taskTitle" placeholder="Prepare overdue lead follow-ups" required />
              </label>
              <label>
                <span>Instructions</span>
                <textarea
                  name="taskInput"
                  rows={4}
                  placeholder="Review overdue leads, prepare follow-up notes, and save a report."
                  required
                />
              </label>
              {error ? <div className="inline-error">{error}</div> : null}
              <div className="modal-actions">
                <button type="button" className="secondary-button" onClick={() => setCreating(false)}>
                  Cancel
                </button>
                <button className="primary-button" disabled={working === "create"}>
                  {working === "create" ? "Scheduling…" : "Create schedule"}
                </button>
              </div>
            </form>
          </section>
        </div>
        </ModalPortal>
      ) : null}
    </div>
  );
}

function humanSchedule(schedule: Schedule): string {
  if (schedule.scheduleType === "once") {
    return schedule.runAt ? new Date(schedule.runAt).toLocaleString() : "One time";
  }
  return `${schedule.cronExpression} · ${schedule.timezone}`;
}
