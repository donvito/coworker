import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoworkerDatabase } from "@main/db/database";
import { SchedulerService } from "@main/scheduler/scheduler-service";
import { ToolGateway } from "@main/tools/tool-gateway";
import { getToolCatalogEntry } from "@shared/tool-catalog";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function memoryCredentials() {
  return {
    async set() {},
    async get() {
      return null;
    },
    async has() {
      return false;
    },
    async delete() {},
  };
}

describe("conversational schedule tool", () => {
  it("directs reminder requests to the scheduler instead of file exports", () => {
    const description = getToolCatalogEntry("schedules.create")?.description;
    expect(description).toContain("Use this by default");
    expect(description).toContain("set a reminder");
    expect(description).toContain("Do not create an ICS, Markdown, or other file");
  });

  it("requires approval, creates one durable schedule, and reuses its idempotent result", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-schedule-tool-"));
    temporaryPaths.push(root);
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    try {
      const coworker = database.createCoworker(
        {
          name: "Mia",
          role: "Operations coworker",
          systemPrompt: "Create schedules only through the controlled tool.",
          modelProvider: "demo",
          modelName: "faux-1",
          enabledTools: ["schedules.create"],
          policies: { "schedules.create": "approval" },
        },
        join(root, "workspace"),
      );
      const task = database.createTask({
        coworkerId: coworker.id,
        title: "Schedule Monday report",
        input: "Every Monday at 9 AM, create the weekly operations report.",
      });
      const scheduler = new SchedulerService(database, () => undefined);
      const gateway = new ToolGateway(
        database,
        memoryCredentials(),
        join(root, "outbox"),
        { createSchedule: (input) => scheduler.create(input) },
      );

      const requested = await gateway.request({
        task,
        coworker,
        toolCallId: "schedule-1",
        toolName: "schedules.create",
        arguments: {
          name: "Monday operations report",
          scheduleType: "cron",
          cronExpression: "0 9 * * 1",
          timezone: "UTC",
          taskTemplate: {
            title: "Create operations report",
            input: "Create the weekly operations report from the latest workspace data.",
          },
          enabled: true,
        },
      });

      expect(requested.kind).toBe("approval");
      expect(database.listSchedules()).toHaveLength(0);
      if (requested.kind !== "approval") throw new Error("Expected schedule approval");
      expect(requested.approval.summary).toContain("Monday operations report");

      const approval = database.decideApproval({
        approvalId: requested.approval.id,
        decision: "approve",
      });
      const first = await gateway.executeApproval(approval, coworker);
      const second = await gateway.executeApproval(approval, coworker);

      expect(first).toEqual(second);
      expect(first.result).toMatchObject({
        name: "Monday operations report",
        cronExpression: "0 9 * * 1",
        timezone: "UTC",
      });
      expect(database.listSchedules()).toHaveLength(1);
      expect(database.listSchedules()[0]?.nextRunAt).toBeTruthy();
      // The schedule replies where it was asked for, not in the default thread.
      expect(database.listSchedules()[0]?.conversationId).toBe(task.threadId);
      expect(requested.approval.summary).toContain("Every Monday at 9:00");
    } finally {
      database.close();
    }
  });

  it("denies incomplete recurrence details before creating an approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-schedule-invalid-"));
    temporaryPaths.push(root);
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    try {
      const coworker = database.createCoworker(
        {
          name: "Mia",
          role: "Operations coworker",
          systemPrompt: "Create schedules only through the controlled tool.",
          modelProvider: "demo",
          modelName: "faux-1",
          enabledTools: ["schedules.create"],
          policies: { "schedules.create": "approval" },
        },
        join(root, "workspace"),
      );
      const task = database.createTask({
        coworkerId: coworker.id,
        title: "Invalid schedule",
        input: "Schedule this.",
      });
      const gateway = new ToolGateway(database, memoryCredentials(), join(root, "outbox"));
      const response = await gateway.request({
        task,
        coworker,
        toolCallId: "schedule-invalid",
        toolName: "schedules.create",
        arguments: {
          name: "Missing cron",
          scheduleType: "cron",
          taskTemplate: { title: "Work", input: "Complete the work." },
        },
      });

      expect(response.kind).toBe("denied");
      expect(database.listApprovals("PENDING")).toHaveLength(0);
    } finally {
      database.close();
    }
  });
});
