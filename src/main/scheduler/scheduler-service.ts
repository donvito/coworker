import { CronExpressionParser } from "cron-parser";
import type {
  CreateScheduleInput,
  Schedule,
  Task,
  UpdateScheduleInput,
} from "@shared/contracts";
import type { CoworkerDatabase } from "@main/db/database";

const MAX_TIMER_DELAY = 2_147_000_000;

export function calculateNextRun(
  schedule: Pick<
    Schedule,
    "scheduleType" | "cronExpression" | "runAt" | "timezone" | "enabled"
  >,
  from = new Date(),
): string | null {
  if (!schedule.enabled) return null;
  if (schedule.scheduleType === "once") {
    return schedule.runAt;
  }
  if (!schedule.cronExpression) throw new Error("Recurring schedules require a cron expression");
  return CronExpressionParser.parse(schedule.cronExpression, {
    currentDate: from,
    tz: schedule.timezone,
  })
    .next()
    .toDate()
    .toISOString();
}

export class SchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private processing = false;

  constructor(
    private readonly database: CoworkerDatabase,
    private readonly onTaskCreated: (task: Task) => void | Promise<void>,
    private readonly onError?: (error: unknown) => void | Promise<void>,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.processDueSchedules();
    this.arm();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async wake(): Promise<void> {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.processDueSchedules();
    this.arm();
  }

  create(input: CreateScheduleInput): Schedule {
    const enabled = input.enabled !== false;
    const nextRunAt = calculateNextRun(
      {
        scheduleType: input.scheduleType,
        cronExpression: input.cronExpression ?? null,
        runAt: input.runAt ?? null,
        timezone: input.timezone,
        enabled,
      },
      new Date(),
    );
    const schedule = this.database.createSchedule(input, nextRunAt);
    this.arm();
    return schedule;
  }

  update(id: string, patch: UpdateScheduleInput): Schedule {
    const current = this.database.getSchedule(id);
    const merged = {
      scheduleType: patch.scheduleType ?? current.scheduleType,
      cronExpression:
        patch.cronExpression === undefined ? current.cronExpression : patch.cronExpression,
      runAt: patch.runAt === undefined ? current.runAt : patch.runAt,
      timezone: patch.timezone ?? current.timezone,
      enabled: patch.enabled ?? current.enabled,
    };
    const nextRunAt = calculateNextRun(merged, new Date());
    const schedule = this.database.updateSchedule(id, patch, nextRunAt);
    this.arm();
    return schedule;
  }

  remove(id: string): void {
    this.database.deleteSchedule(id);
    this.arm();
  }

  async runNow(id: string): Promise<Task> {
    const schedule = this.database.getSchedule(id);
    const coworker = this.database.getCoworker(schedule.coworkerId);
    if (coworker.status !== "active") {
      throw new Error(`${coworker.name} is paused. Resume the coworker before running this schedule.`);
    }
    const task = this.database.createTask({
      coworkerId: schedule.coworkerId,
      scheduleId: schedule.id,
      title: schedule.taskTemplate.title,
      input: schedule.taskTemplate.input,
      priority: schedule.taskTemplate.priority,
      source: "schedule",
    });
    this.database.addActivity({
      coworkerId: schedule.coworkerId,
      taskId: task.id,
      type: "schedule.run-now",
      summary: `${schedule.name} was run manually`,
      metadata: { scheduleId: schedule.id },
    });
    await this.onTaskCreated(task);
    return task;
  }

  private arm(): void {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const nextRunAt = this.database.getEarliestNextRun();
    if (!nextRunAt) return;
    const delay = Math.max(0, new Date(nextRunAt).getTime() - Date.now());
    this.timer = setTimeout(() => {
      void this.processDueSchedules()
        .catch((error) => {
          void this.onError?.(error);
          this.database.addActivity({
            type: "scheduler.error",
            summary: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => this.arm());
    }, Math.min(delay, MAX_TIMER_DELAY));
    this.timer.unref?.();
  }

  private async processDueSchedules(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      const due = this.database.listDueSchedules();
      const ranAt = new Date();
      for (const schedule of due) {
        const nextRunAt =
          schedule.scheduleType === "once"
            ? null
            : calculateNextRun(schedule, new Date(ranAt.getTime() + 1_000));
        const task = this.database.transaction(() => {
          const created = this.database.createTask({
            coworkerId: schedule.coworkerId,
            scheduleId: schedule.id,
            title: schedule.taskTemplate.title,
            input: schedule.taskTemplate.input,
            priority: schedule.taskTemplate.priority,
            source: "schedule",
          });
          this.database.markScheduleRun(schedule.id, ranAt.toISOString(), nextRunAt);
          return created;
        });
        await this.onTaskCreated(task);
      }
    } finally {
      this.processing = false;
    }
  }
}
