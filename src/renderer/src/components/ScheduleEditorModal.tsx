import { useMemo, useState, type FormEvent } from "react";
import type { Coworker, Schedule } from "@shared/contracts";
import { Icon } from "./Icon";
import { ModalPortal } from "./ModalPortal";
import {
  buildCronExpression,
  checkDraft,
  describeDraft,
  draftFromSchedule,
  emptyDraft,
  formatDateTime,
  frequencyPresetLabels,
  weekdayNames,
  type FrequencyDraft,
  type FrequencyPreset,
} from "@shared/schedule-frequency";

const presetOrder: FrequencyPreset[] = [
  "minutes",
  "hourly",
  "hours",
  "daily",
  "weekdays",
  "weekly",
  "monthly",
  "custom",
];

/**
 * One editor for both creating a schedule and changing an existing one, so a
 * frequency is picked the same friendly way in the Schedules page and in a
 * coworker's side rail.
 */
export function ScheduleEditorModal({
  conversationId,
  conversationTitle,
  coworkers,
  defaultCoworkerId,
  lockCoworker = false,
  onClose,
  onSaved,
  schedule = null,
}: {
  /** Conversation a newly created schedule should reply into. */
  conversationId?: string;
  conversationTitle?: string;
  coworkers: Coworker[];
  defaultCoworkerId?: string;
  lockCoworker?: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
  schedule?: Schedule | null;
}) {
  const editing = schedule !== null;
  const timezone = schedule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [coworkerId, setCoworkerId] = useState(
    schedule?.coworkerId ?? defaultCoworkerId ?? coworkers[0]?.id ?? "",
  );
  const [name, setName] = useState(schedule?.name ?? "");
  const [taskTitle, setTaskTitle] = useState(schedule?.taskTemplate.title ?? "");
  const [taskInput, setTaskInput] = useState(schedule?.taskTemplate.input ?? "");
  const [draft, setDraft] = useState<FrequencyDraft>(() =>
    schedule ? draftFromSchedule(schedule) : emptyDraft(),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useMemo(() => checkDraft(draft, timezone), [draft, timezone]);
  const patch = (change: Partial<FrequencyDraft>) =>
    setDraft((current) => ({ ...current, ...change }));

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!check.ok) {
      setError(check.message);
      return;
    }
    setSaving(true);
    setError(null);
    const recurring = draft.scheduleType === "cron";
    try {
      if (schedule) {
        await window.coworker.schedules.update(schedule.id, {
          name: name.trim(),
          scheduleType: draft.scheduleType,
          cronExpression: recurring ? buildCronExpression(draft) : null,
          runAt: recurring ? null : new Date(draft.runAt).toISOString(),
          taskTemplate: { title: taskTitle.trim(), input: taskInput.trim() },
        });
      } else {
        await window.coworker.schedules.create({
          coworkerId,
          conversationId: conversationId ?? null,
          name: name.trim(),
          scheduleType: draft.scheduleType,
          cronExpression: recurring ? buildCronExpression(draft) : undefined,
          runAt: recurring ? undefined : new Date(draft.runAt).toISOString(),
          timezone,
          taskTemplate: { title: taskTitle.trim(), input: taskInput.trim() },
        });
      }
      await onSaved();
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalPortal>
      <div className="modal-backdrop" onMouseDown={onClose} role="presentation">
        <section
          aria-labelledby="schedule-editor-title"
          aria-modal="true"
          className="modal-card schedule-editor-modal"
          onMouseDown={(event) => event.stopPropagation()}
          role="dialog"
        >
          <span className="eyebrow">{editing ? "Edit schedule" : "New rhythm"}</span>
          <h2 id="schedule-editor-title">
            {editing ? `Change how often “${schedule.name}” runs` : "Schedule coworker work"}
          </h2>
          <p>The scheduler creates a normal queued task at each due time.</p>
          <form className="form-stack" onSubmit={save}>
            {coworkers.length > 1 && !editing && !lockCoworker ? (
              <label>
                <span>Coworker</span>
                <select
                  name="coworkerId"
                  onChange={(event) => setCoworkerId(event.target.value)}
                  required
                  value={coworkerId}
                >
                  {coworkers.map((coworker) => (
                    <option key={coworker.id} value={coworker.id}>
                      {coworker.name} · {coworker.role}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label>
              <span>Schedule name</span>
              <input
                name="name"
                onChange={(event) => setName(event.target.value)}
                placeholder="Weekday lead follow-ups"
                required
                value={name}
              />
            </label>

            <div className="segmented-control">
              <button
                className={draft.scheduleType === "cron" ? "active" : ""}
                onClick={() => patch({ scheduleType: "cron" })}
                type="button"
              >
                Repeats
              </button>
              <button
                className={draft.scheduleType === "once" ? "active" : ""}
                onClick={() => patch({ scheduleType: "once" })}
                type="button"
              >
                One time
              </button>
            </div>

            {draft.scheduleType === "cron" ? (
              <div className="frequency-fields">
                <label>
                  <span>How often</span>
                  <select
                    onChange={(event) =>
                      patch({ preset: event.target.value as FrequencyPreset })
                    }
                    value={draft.preset}
                  >
                    {presetOrder.map((preset) => (
                      <option key={preset} value={preset}>
                        {frequencyPresetLabels[preset]}
                      </option>
                    ))}
                  </select>
                </label>

                {draft.preset === "weekly" ? (
                  <label>
                    <span>On</span>
                    <select
                      onChange={(event) => patch({ weekday: event.target.value })}
                      value={draft.weekday}
                    >
                      {weekdayNames.map((day, index) => (
                        <option key={day} value={String(index)}>
                          {day}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                {draft.preset === "monthly" ? (
                  <label>
                    <span>Day of month</span>
                    <select
                      onChange={(event) => patch({ dayOfMonth: event.target.value })}
                      value={draft.dayOfMonth}
                    >
                      {Array.from({ length: 28 }, (_, index) => String(index + 1)).map(
                        (day) => (
                          <option key={day} value={day}>
                            {day}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                ) : null}

                {draft.preset === "minutes" ? (
                  <label>
                    <span>Run every</span>
                    <select
                      onChange={(event) => patch({ interval: event.target.value })}
                      value={draft.interval}
                    >
                      {["2", "5", "10", "15", "20", "30"].map((minutes) => (
                        <option key={minutes} value={minutes}>
                          {minutes} minutes
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                {draft.preset === "hours" ? (
                  <label>
                    <span>Run every</span>
                    <select
                      onChange={(event) => patch({ interval: event.target.value })}
                      value={draft.interval}
                    >
                      {["2", "3", "4", "6", "8", "12"].map((hours) => (
                        <option key={hours} value={hours}>
                          {hours} hours
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                {draft.preset === "hourly" || draft.preset === "hours" ? (
                  <label>
                    <span>Minutes past the hour</span>
                    <select
                      onChange={(event) => patch({ minute: event.target.value })}
                      value={draft.minute}
                    >
                      {["0", "15", "30", "45"].map((minute) => (
                        <option key={minute} value={minute}>
                          :{minute.padStart(2, "0")}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                {draft.preset !== "minutes" &&
                draft.preset !== "hourly" &&
                draft.preset !== "hours" &&
                draft.preset !== "custom" ? (
                  <label>
                    <span>At</span>
                    <input
                      onChange={(event) => patch({ time: event.target.value })}
                      type="time"
                      value={draft.time}
                    />
                  </label>
                ) : null}

                {draft.preset === "custom" ? (
                  <label className="frequency-custom">
                    <span>Cron expression</span>
                    <input
                      onChange={(event) => patch({ cronExpression: event.target.value })}
                      placeholder="0 8 * * 1-5"
                      value={draft.cronExpression}
                    />
                    <small>Five fields: minute hour day-of-month month day-of-week.</small>
                  </label>
                ) : null}
              </div>
            ) : (
              <label>
                <span>Run at</span>
                <input
                  onChange={(event) => patch({ runAt: event.target.value })}
                  type="datetime-local"
                  value={draft.runAt}
                />
              </label>
            )}

            <div className={check.ok ? "frequency-preview" : "frequency-preview invalid"}>
              <Icon name="clock" />
              <span>
                <strong>{describeDraft(draft)}</strong>
                <small>
                  {check.ok
                    ? check.nextRun
                      ? `Next run ${formatDateTime(check.nextRun)} · ${timezone}`
                      : timezone
                    : check.message}
                </small>
              </span>
            </div>

            {conversationTitle && !editing ? (
              <p className="schedule-destination-note">
                <Icon name="send" />
                Replies in <strong>{conversationTitle}</strong>
              </p>
            ) : null}

            <label>
              <span>Task title</span>
              <input
                onChange={(event) => setTaskTitle(event.target.value)}
                placeholder="Prepare overdue lead follow-ups"
                required
                value={taskTitle}
              />
            </label>
            <label>
              <span>Instructions</span>
              <textarea
                onChange={(event) => setTaskInput(event.target.value)}
                placeholder="Review overdue leads, prepare follow-up notes, and save a report."
                required
                rows={4}
                value={taskInput}
              />
            </label>

            {error ? <div className="inline-error">{error}</div> : null}
            <div className="modal-actions">
              <button className="secondary-button" onClick={onClose} type="button">
                Cancel
              </button>
              <button className="primary-button" disabled={saving || !check.ok}>
                {saving
                  ? editing
                    ? "Saving…"
                    : "Scheduling…"
                  : editing
                    ? "Save changes"
                    : "Create schedule"}
              </button>
            </div>
          </form>
        </section>
      </div>
    </ModalPortal>
  );
}
