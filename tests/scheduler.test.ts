import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoworkerDatabase } from "@main/db/database";
import { SchedulerService } from "@main/scheduler/scheduler-service";

const temporaryPaths: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "coworker-scheduler-"));
  temporaryPaths.push(root);
  const database = new CoworkerDatabase(join(root, "coworker.db"));
  const coworker = database.createCoworker(
    {
      name: "Sarah",
      role: "Sales Coworker",
      systemPrompt: "Prepare useful reports.",
      modelProvider: "demo",
      modelName: "faux-1",
      enabledTools: ["files.write"],
    },
    join(root, "sarah"),
  );
  return { root, database, coworker };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("local scheduler", () => {
  it("commits task creation with schedule advancement before dispatch callbacks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T04:00:00.000Z"));
    const { database, coworker } = await fixture();
    const failing = new SchedulerService(database, () => {
      throw new Error("simulated process interruption");
    });
    const schedule = failing.create({
      coworkerId: coworker.id,
      name: "Due now",
      scheduleType: "once",
      runAt: "2026-08-23T03:59:00.000Z",
      timezone: "UTC",
      taskTemplate: { title: "Durable task", input: "Create a report." },
    });
    await expect(failing.start()).rejects.toThrow("simulated process interruption");
    failing.stop();

    const dispatched: string[] = [];
    const restarted = new SchedulerService(database, (task) => {
      dispatched.push(task.id);
    });
    try {
      await restarted.start();
      expect(database.listTasks(coworker.id)).toHaveLength(1);
      expect(database.getSchedule(schedule.id)).toMatchObject({ enabled: false, nextRunAt: null });
      expect(dispatched).toEqual([]);
    } finally {
      restarted.stop();
      database.close();
    }
  });

  it("fires a future one-time task automatically and disables the completed schedule", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T04:00:00.000Z"));
    const { database, coworker } = await fixture();
    const createdTasks: string[] = [];
    const scheduler = new SchedulerService(database, (task) => {
      createdTasks.push(task.id);
    });
    try {
      const schedule = scheduler.create({
        coworkerId: coworker.id,
        name: "Later follow-up",
        scheduleType: "once",
        runAt: "2026-08-23T04:00:02.000Z",
        timezone: "UTC",
        taskTemplate: {
          title: "Prepare follow-ups",
          input: "Prepare follow-ups and save a report.",
        },
      });
      await scheduler.start();
      expect(createdTasks).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(2_100);

      expect(createdTasks).toHaveLength(1);
      const task = database.getTask(createdTasks[0]!);
      expect(task.source).toBe("schedule");
      expect(task.scheduleId).toBe(schedule.id);
      expect(database.getSchedule(schedule.id)).toMatchObject({
        enabled: false,
        nextRunAt: null,
      });
    } finally {
      scheduler.stop();
      database.close();
    }
  });

  it("recovers many missed recurring intervals as one run, then advances normally", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T04:00:00.000Z"));
    const { database, coworker } = await fixture();
    const createdTasks: string[] = [];
    const scheduler = new SchedulerService(database, (task) => {
      createdTasks.push(task.id);
    });
    try {
      const schedule = scheduler.create({
        coworkerId: coworker.id,
        name: "Minute report",
        scheduleType: "cron",
        cronExpression: "* * * * *",
        timezone: "UTC",
        taskTemplate: {
          title: "Sales handoff",
          input: "Create the sales handoff report.",
        },
      });

      vi.setSystemTime(new Date("2026-08-23T04:05:30.000Z"));
      await scheduler.start();

      expect(createdTasks).toHaveLength(1);
      expect(database.getSchedule(schedule.id).nextRunAt).toBe("2026-08-23T04:06:00.000Z");

      await scheduler.wake();
      expect(createdTasks).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(30_100);
      expect(createdTasks).toHaveLength(2);
      expect(database.listTasks(coworker.id).every((task) => task.source === "schedule")).toBe(true);
    } finally {
      scheduler.stop();
      database.close();
    }
  });
});
