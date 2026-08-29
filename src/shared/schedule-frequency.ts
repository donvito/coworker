import { CronExpressionParser } from "cron-parser";
import type { Schedule } from "./contracts";

/**
 * Schedules are stored as cron expressions, but nobody should have to write
 * one. Every screen edits this draft instead — a handful of plain-language
 * choices — and only the "custom" preset falls back to raw cron.
 */
export type FrequencyPreset =
  | "minutes"
  | "hourly"
  | "hours"
  | "daily"
  | "weekdays"
  | "weekly"
  | "monthly"
  | "custom";

export interface FrequencyDraft {
  scheduleType: "cron" | "once";
  preset: FrequencyPreset;
  /** Step size for the "every few minutes/hours" presets. */
  interval: string;
  /** Minute past the hour, used by the hourly and every-few-hours presets. */
  minute: string;
  /** "HH:MM" wall-clock time for the daily/weekly/monthly presets. */
  time: string;
  /** 0 = Sunday, matching cron's day-of-week field. */
  weekday: string;
  dayOfMonth: string;
  cronExpression: string;
  /** `datetime-local` value for one-time schedules. */
  runAt: string;
}

export const frequencyPresetLabels: Record<FrequencyPreset, string> = {
  minutes: "Every few minutes",
  hourly: "Every hour",
  hours: "Every few hours",
  daily: "Every day",
  weekdays: "Every weekday (Mon–Fri)",
  weekly: "Every week",
  monthly: "Every month",
  custom: "Custom schedule (cron)",
};

export const weekdayNames = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const numeric = /^\d+$/;
const stepped = /^\*\/(\d+)$/;

// Reads a cron step field (every-15-minutes style) into its interval, else null.
function step(field: string): string | null {
  const match = stepped.exec(field);
  return match?.[1] ? String(Number(match[1])) : null;
}

export function buildCronExpression(draft: FrequencyDraft): string {
  const [hour, minute] = splitTime(draft.time);
  switch (draft.preset) {
    case "minutes":
      return `*/${Number(draft.interval) || 5} * * * *`;
    case "hourly":
      return `${Number(draft.minute) || 0} * * * *`;
    case "hours":
      return `${Number(draft.minute) || 0} */${Number(draft.interval) || 2} * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${draft.weekday}`;
    case "monthly":
      return `${minute} ${hour} ${draft.dayOfMonth} * *`;
    case "custom":
      return draft.cronExpression.trim();
  }
}

/**
 * Reads a stored cron expression back into the friendly controls. Anything
 * this cannot express — step values, lists, month filters — stays "custom" so
 * an advanced expression is never silently rewritten.
 */
export function draftFromCron(expression: string | null): Partial<FrequencyDraft> {
  const fallback: Partial<FrequencyDraft> = {
    preset: "custom",
    cronExpression: expression ?? "",
  };
  if (!expression) return fallback;
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return fallback;
  const [minute = "", hour = "", dayOfMonth = "", month = "", weekday = ""] = fields;
  if (month !== "*") return fallback;
  if (dayOfMonth === "*" && weekday === "*") {
    // "Every N minutes" and "every N hours" are what the schedule tool writes
    // most often, so they get first-class controls rather than a raw field.
    const minuteStep = step(minute);
    if (minuteStep && hour === "*") return { preset: "minutes", interval: minuteStep };
    const hourStep = step(hour);
    if (hourStep && numeric.test(minute)) {
      return { preset: "hours", interval: hourStep, minute: String(Number(minute)) };
    }
  }
  if (!numeric.test(minute)) return fallback;

  if (hour === "*" && dayOfMonth === "*" && weekday === "*") {
    return { preset: "hourly", minute: String(Number(minute)) };
  }
  if (!numeric.test(hour)) return fallback;
  const time = joinTime(hour, minute);

  if (dayOfMonth === "*" && weekday === "*") return { preset: "daily", time };
  if (dayOfMonth === "*" && weekday === "1-5") return { preset: "weekdays", time };
  if (dayOfMonth === "*" && numeric.test(weekday) && Number(weekday) <= 6) {
    return { preset: "weekly", time, weekday: String(Number(weekday)) };
  }
  if (weekday === "*" && numeric.test(dayOfMonth)) {
    return { preset: "monthly", time, dayOfMonth: String(Number(dayOfMonth)) };
  }
  return fallback;
}

export function draftFromSchedule(schedule: Schedule): FrequencyDraft {
  return {
    ...emptyDraft(),
    scheduleType: schedule.scheduleType,
    runAt: schedule.runAt ? toLocalInputValue(schedule.runAt) : emptyDraft().runAt,
    ...(schedule.scheduleType === "cron" ? draftFromCron(schedule.cronExpression) : {}),
  };
}

export function emptyDraft(): FrequencyDraft {
  return {
    scheduleType: "cron",
    preset: "weekdays",
    interval: "15",
    minute: "0",
    time: "08:00",
    weekday: "1",
    dayOfMonth: "1",
    cronExpression: "0 8 * * 1-5",
    runAt: toLocalInputValue(new Date(Date.now() + 3_600_000).toISOString()),
  };
}

/** Plain-language rendering of a draft, e.g. "Every weekday at 8:00 AM". */
export function describeDraft(draft: FrequencyDraft): string {
  if (draft.scheduleType === "once") {
    const at = new Date(draft.runAt);
    return Number.isNaN(at.getTime()) ? "One time" : `Once on ${formatDateTime(at)}`;
  }
  switch (draft.preset) {
    case "minutes":
      return `Every ${Number(draft.interval) || 5} minutes`;
    case "hours": {
      const every = `Every ${Number(draft.interval) || 2} hours`;
      const minute = Number(draft.minute) || 0;
      return minute === 0 ? every : `${every}, at ${minute} minutes past`;
    }
    case "hourly": {
      const minute = Number(draft.minute) || 0;
      return minute === 0
        ? "Every hour, on the hour"
        : `Every hour at ${minute} minutes past`;
    }
    case "daily":
      return `Every day at ${formatTime(draft.time)}`;
    case "weekdays":
      return `Every weekday at ${formatTime(draft.time)}`;
    case "weekly":
      return `Every ${weekdayNames[Number(draft.weekday) || 0]} at ${formatTime(draft.time)}`;
    case "monthly":
      return `Monthly on the ${ordinal(Number(draft.dayOfMonth) || 1)} at ${formatTime(draft.time)}`;
    case "custom":
      return draft.cronExpression.trim() || "Custom schedule";
  }
}

/** Plain-language rendering of a cron expression, e.g. "Every 2 minutes". */
export function describeCronExpression(expression: string | null): string {
  const draft = { ...emptyDraft(), ...draftFromCron(expression) };
  return describeDraft({ ...draft, scheduleType: "cron" });
}

/** Plain-language rendering of a saved schedule, for cards and lists. */
export function describeSchedule(schedule: Schedule): string {
  if (schedule.scheduleType === "once") {
    return schedule.runAt ? `Once on ${formatDateTime(new Date(schedule.runAt))}` : "One time";
  }
  return describeCronExpression(schedule.cronExpression);
}

export type FrequencyCheck =
  | { ok: true; nextRun: Date | null }
  | { ok: false; message: string };

/** Validates a draft and previews when it would next fire. */
export function checkDraft(draft: FrequencyDraft, timezone: string): FrequencyCheck {
  if (draft.scheduleType === "once") {
    const at = new Date(draft.runAt);
    if (Number.isNaN(at.getTime())) return { ok: false, message: "Pick a date and time." };
    if (at.getTime() <= Date.now()) {
      return { ok: false, message: "Pick a time in the future." };
    }
    return { ok: true, nextRun: at };
  }
  const expression = buildCronExpression(draft);
  if (!expression) return { ok: false, message: "Enter a schedule expression." };
  try {
    const next = CronExpressionParser.parse(expression, {
      currentDate: new Date(),
      tz: timezone,
    })
      .next()
      .toDate();
    return { ok: true, nextRun: next };
  } catch {
    return {
      ok: false,
      message: "That schedule expression isn’t valid. Use five fields, like 0 8 * * 1-5.",
    };
  }
}

export function toLocalInputValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function formatDateTime(date: Date): string {
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatTime(time: string): string {
  const [hour, minute] = splitTime(time);
  const date = new Date();
  date.setHours(Number(hour), Number(minute), 0, 0);
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function splitTime(time: string): [string, string] {
  const [hour = "0", minute = "0"] = time.split(":");
  return [String(Number(hour) || 0), String(Number(minute) || 0)];
}

function joinTime(hour: string, minute: string): string {
  return `${String(Number(hour)).padStart(2, "0")}:${String(Number(minute)).padStart(2, "0")}`;
}

function ordinal(value: number): string {
  const rest = value % 100;
  if (rest >= 11 && rest <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}
