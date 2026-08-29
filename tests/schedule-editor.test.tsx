// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduleEditorModal } from "@renderer/components/ScheduleEditorModal";
import { approvalPreviewRows } from "@renderer/pages/CoworkerDetailPage";
import type { Coworker, Schedule } from "@shared/contracts";

const coworker: Coworker = {
  id: "coworker-1",
  name: "Ava",
  role: "Accounting",
  description: null,
  systemPrompt: "Work carefully.",
  modelProvider: "openrouter",
  modelName: "vendor/model",
  status: "active",
  runtimeStatus: "IDLE",
  workspacePath: "/tmp/ava",
  enabledTools: [],
  enabledSkillIds: [],
  policies: {},
  sharedFolders: [],
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
};

const schedule: Schedule = {
  id: "schedule-1",
  coworkerId: coworker.id,
  conversationId: null,
  name: "Weekday digest",
  scheduleType: "cron",
  cronExpression: "0 8 * * 1-5",
  runAt: null,
  timezone: "UTC",
  taskTemplate: { title: "Digest", input: "Write the digest." },
  enabled: true,
  lastRunAt: null,
  nextRunAt: null,
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
};

function stubSchedulesApi() {
  const update = vi.fn(async () => schedule);
  const create = vi.fn(async () => schedule);
  Object.assign(window, {
    coworker: { schedules: { update, create } },
  });
  return { update, create };
}

afterEach(() => cleanup());

describe("schedule editor", () => {
  it("changes an existing schedule's frequency without typing cron", async () => {
    const { update } = stubSchedulesApi();
    render(
      <ScheduleEditorModal
        coworkers={[coworker]}
        onClose={() => {}}
        onSaved={async () => {}}
        schedule={schedule}
      />,
    );

    // The saved expression is shown as a plain-language choice, not "0 8 * * 1-5".
    const frequency = screen.getByLabelText("How often") as HTMLSelectElement;
    expect(frequency.value).toBe("weekdays");
    expect(screen.getByText(/Every weekday at 8:00\s?[AP]M/i)).toBeTruthy();

    fireEvent.change(frequency, { target: { value: "weekly" } });
    fireEvent.change(screen.getByLabelText("On"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("At"), { target: { value: "16:30" } });
    expect(screen.getByText(/Every Friday at 4:30\s?PM/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith("schedule-1", {
      name: "Weekday digest",
      scheduleType: "cron",
      cronExpression: "30 16 * * 5",
      runAt: null,
      taskTemplate: { title: "Digest", input: "Write the digest." },
    });
  });

  it("blocks saving an invalid custom expression", async () => {
    const { update } = stubSchedulesApi();
    render(
      <ScheduleEditorModal
        coworkers={[coworker]}
        onClose={() => {}}
        onSaved={async () => {}}
        schedule={schedule}
      />,
    );

    fireEvent.change(screen.getByLabelText("How often"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText(/Cron expression/), {
      target: { value: "not a cron" },
    });

    const save = screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(update).not.toHaveBeenCalled();
  });

  it("creates a schedule for the coworker the rail was opened from", async () => {
    const { create } = stubSchedulesApi();
    render(
      <ScheduleEditorModal
        coworkers={[coworker]}
        defaultCoworkerId={coworker.id}
        lockCoworker
        onClose={() => {}}
        onSaved={async () => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText("Schedule name"), {
      target: { value: "Morning check" },
    });
    fireEvent.change(screen.getByLabelText("How often"), { target: { value: "daily" } });
    fireEvent.change(screen.getByLabelText("At"), { target: { value: "07:15" } });
    fireEvent.change(screen.getByLabelText("Task title"), {
      target: { value: "Check the inbox" },
    });
    fireEvent.change(screen.getByLabelText("Instructions"), {
      target: { value: "Summarise anything new." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create schedule" }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        coworkerId: "coworker-1",
        name: "Morning check",
        scheduleType: "cron",
        cronExpression: "15 7 * * *",
        taskTemplate: { title: "Check the inbox", input: "Summarise anything new." },
      }),
    );
  });
});

describe("approval preview rows", () => {
  it("describes a schedule approval without cron syntax", () => {
    const rows = approvalPreviewRows({
      id: "approval-1",
      taskId: "task-1",
      coworkerId: coworker.id,
      toolCallId: "tool-1",
      actionType: "schedules.create",
      summary: "Create schedule “Haiku break”",
      proposedPayload: {
        name: "Haiku break",
        scheduleType: "cron",
        cronExpression: "*/15 * * * *",
        timezone: "UTC",
        taskTemplate: { title: "Write a haiku", input: "Write a short haiku." },
      },
      decidedPayload: null,
      riskLevel: "medium",
      status: "PENDING",
      createdAt: "2026-08-29T05:19:00.000Z",
      decidedAt: null,
    });

    expect(rows).toEqual([
      ["Name", "Haiku break"],
      ["Runs", "Every 15 minutes"],
      ["Task", "Write a haiku"],
    ]);
  });
});
