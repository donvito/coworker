import { describe, expect, it } from "vitest";
import type { Schedule } from "@shared/contracts";
import {
  buildCronExpression,
  checkDraft,
  describeSchedule,
  draftFromCron,
  draftFromSchedule,
  emptyDraft,
} from "@shared/schedule-frequency";

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "schedule-1",
    coworkerId: "coworker-1",
    conversationId: null,
    name: "Weekday digest",
    scheduleType: "cron",
    cronExpression: "30 9 * * 1-5",
    runAt: null,
    timezone: "UTC",
    taskTemplate: { title: "Digest", input: "Write the digest." },
    enabled: true,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    ...overrides,
  };
}

describe("schedule frequency drafts", () => {
  it("builds cron expressions from plain-language choices", () => {
    const base = emptyDraft();
    expect(buildCronExpression({ ...base, preset: "minutes", interval: "10" })).toBe(
      "*/10 * * * *",
    );
    expect(buildCronExpression({ ...base, preset: "hourly", minute: "15" })).toBe(
      "15 * * * *",
    );
    expect(
      buildCronExpression({ ...base, preset: "hours", interval: "6", minute: "30" }),
    ).toBe("30 */6 * * *");
    expect(buildCronExpression({ ...base, preset: "daily", time: "07:05" })).toBe(
      "5 7 * * *",
    );
    expect(buildCronExpression({ ...base, preset: "weekdays", time: "08:00" })).toBe(
      "0 8 * * 1-5",
    );
    expect(
      buildCronExpression({ ...base, preset: "weekly", time: "16:30", weekday: "5" }),
    ).toBe("30 16 * * 5");
    expect(
      buildCronExpression({ ...base, preset: "monthly", time: "09:00", dayOfMonth: "3" }),
    ).toBe("0 9 3 * *");
  });

  it("round-trips a stored cron expression back into the friendly controls", () => {
    const expressions = [
      "*/2 * * * *",
      "*/15 * * * *",
      "30 */6 * * *",
      "15 * * * *",
      "5 7 * * *",
      "0 8 * * 1-5",
      "30 16 * * 5",
      "0 9 3 * *",
    ];
    for (const expression of expressions) {
      const draft = { ...emptyDraft(), ...draftFromCron(expression) };
      expect(buildCronExpression(draft)).toBe(expression);
      expect(draft.preset).not.toBe("custom");
    }
  });

  it("keeps expressions the friendly controls cannot express as custom", () => {
    for (const expression of ["0 8 1 6 *", "0 8 * * 1,3", "0 8 * *", "*/10 9 * * *"]) {
      const draft = { ...emptyDraft(), ...draftFromCron(expression) };
      expect(draft.preset).toBe("custom");
      expect(buildCronExpression(draft)).toBe(expression);
    }
  });

  it("describes saved schedules without showing cron syntax", () => {
    // The time half comes from the host locale, so match it case-insensitively.
    expect(describeSchedule(schedule())).toMatch(/^Every weekday at 9:30\s?[AP]M$/i);
    expect(describeSchedule(schedule({ cronExpression: "0 * * * *" }))).toBe(
      "Every hour, on the hour",
    );
    // The schedule tool writes step expressions; they must read as plain text too.
    expect(describeSchedule(schedule({ cronExpression: "*/2 * * * *" }))).toBe(
      "Every 2 minutes",
    );
    expect(describeSchedule(schedule({ cronExpression: "0 */6 * * *" }))).toBe(
      "Every 6 hours",
    );
    expect(describeSchedule(schedule({ cronExpression: "0 9 3 * *" }))).toMatch(
      /^Monthly on the 3rd at 9:00\s?[AP]M$/i,
    );
    expect(describeSchedule(schedule({ cronExpression: "0 8 * * 1,3" }))).toBe(
      "0 8 * * 1,3",
    );
  });

  it("reads a one-time schedule into the draft", () => {
    const draft = draftFromSchedule(
      schedule({
        scheduleType: "once",
        cronExpression: null,
        runAt: "2026-09-04T09:00:00.000Z",
      }),
    );
    expect(draft.scheduleType).toBe("once");
    expect(new Date(draft.runAt).getTime()).toBe(
      new Date("2026-09-04T09:00:00.000Z").getTime(),
    );
  });

  it("previews the next run and rejects invalid input", () => {
    const valid = checkDraft({ ...emptyDraft(), preset: "daily", time: "08:00" }, "UTC");
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(valid.nextRun).toBeInstanceOf(Date);

    const broken = checkDraft(
      { ...emptyDraft(), preset: "custom", cronExpression: "not a cron" },
      "UTC",
    );
    expect(broken.ok).toBe(false);

    const past = checkDraft(
      { ...emptyDraft(), scheduleType: "once", runAt: "2020-01-01T00:00" },
      "UTC",
    );
    expect(past.ok).toBe(false);
  });
});
