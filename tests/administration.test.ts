import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdministration } from "@main/control/administration";
import { DesktopAppService } from "@main/app/app-service";
import { MemoryCredentialStore } from "@main/security/credential-store";
import { ipcChannels as ipc } from "@shared/ipc";
import { formatModelSelectableSkills } from "@shared/pi-skill-prompt";
import type { StartupStatus } from "@shared/startup";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cw-admin-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const credentials = new MemoryCredentialStore();
  const service = new DesktopAppService({ dataPath: root, credentials });
  cleanups.push(() => service.shutdown());
  await service.initialize();
  const admin = createAdministration({ service, credentials });
  return { root, service, admin, credentials };
}

describe("shared desktop and terminal administration", () => {
  it("shares login registration between CLI and desktop and leaves unrelated settings independent", async () => {
    const { service, credentials, root } = await fixture();
    let state: StartupStatus = { supported: true, scope: "user-login", registered: false, enabled: false,
      state: "disabled", mode: "desktop", dataPath: root, executable: process.execPath, selectedProfile: true };
    const startup = {
      status: vi.fn(() => state),
      enable: vi.fn(async (mode?: "headless" | "desktop") => {
        state = { ...state, mode: mode ?? state.mode, registered: true, enabled: true, state: "enabled" };
        return state;
      }),
      disable: vi.fn(async () => {
        state = { ...state, registered: false, enabled: false, state: "disabled" };
        return state;
      }),
    };
    const admin = createAdministration({ service, credentials, startup });
    await expect(admin.invoke("startup.enable", [{}])).resolves.toMatchObject({ mode: "headless", enabled: true });
    expect(service.database.getSettings().launchAtLogin).toBe(true);
    await admin.invoke(ipc.updateSettings, [{ launchAtLogin: false }]);
    expect(service.database.getSettings().launchAtLogin).toBe(false);
    await admin.invoke(ipc.updateSettings, [{ launchAtLogin: true }]);
    expect(startup.enable).toHaveBeenLastCalledWith();
    expect(state.mode).toBe("headless");
    startup.enable.mockClear();
    startup.disable.mockClear();
    await admin.invoke(ipc.updateSettings, [{ runInBackground: true }]);
    expect(startup.enable).not.toHaveBeenCalled();
    expect(startup.disable).not.toHaveBeenCalled();
    await expect(admin.invoke("startup.enable", [{ mode: "invalid" }])).rejects.toThrow();
    expect(startup.enable).not.toHaveBeenCalled();
    startup.disable.mockRejectedValueOnce(new Error("OS refused"));
    await expect(admin.invoke("startup.disable", [])).rejects.toThrow("OS refused");
    expect(service.database.getSettings().launchAtLogin).toBe(true);
    vi.spyOn(service, "beginDataMutation").mockImplementation(() => { throw new Error("read-only"); });
    await expect(admin.invoke("startup.enable", [{}])).rejects.toThrow("read-only");
    expect(startup.enable).not.toHaveBeenCalled();
    await expect(admin.invoke("startup.status", [])).resolves.toMatchObject({ mode: "headless" });
  });

  it("validates activity limits at the boundary and defaults to 50", async () => {
    const { service, admin } = await fixture();
    const list = vi.spyOn(service.database, "listActivity");
    await admin.invoke("activity.list", []);
    expect(list).toHaveBeenLastCalledWith(50);
    for (const limit of [1, 1000]) {
      await admin.invoke("activity.list", [limit]);
      expect(list).toHaveBeenLastCalledWith(limit);
    }
    list.mockClear();
    for (const limit of [0, -1, 1.5, 1001, "1", "many", null, NaN, Infinity]) {
      await expect(admin.invoke("activity.list", [limit])).rejects.toThrow();
    }
    expect(list).not.toHaveBeenCalled();
  });

  it("makes changes visible through the same service and enforces its mutation guard", async () => {
    const { service, admin } = await fixture();
    const coworker = service.database.listCoworkers()[0]!;
    const events: string[] = [];
    service.subscribe((event) => events.push(event.type));
    await admin.invoke(ipc.coworkersUpdate, [coworker.id, { name: "Terminal configured" }]);
    expect(service.snapshot().coworkers.find((item) => item.id === coworker.id)?.name).toBe("Terminal configured");
    expect(events).toContain("entity.changed");
    const guard = vi.spyOn(service, "beginDataMutation").mockImplementation(() => { throw new Error("temporarily read-only"); });
    await expect(admin.invoke(ipc.coworkersUpdate, [coworker.id, { name: "Blocked" }])).rejects.toThrow("read-only");
    await expect(admin.invoke(ipc.coworkersList, [])).resolves.toBeDefined();
    guard.mockRestore();
    await expect(admin.invoke(ipc.coworkersUpdate, [coworker.id, { name: "" }])).rejects.toThrow();
    await expect(admin.invoke("database.query", ["SELECT *"])).rejects.toThrow("Unknown administration method");
  });

  it("shares credentials with the service and never returns saved values", async () => {
    const { admin, credentials } = await fixture();
    await credentials.set("model:openai", "test-private-key");
    const result = await admin.invoke(ipc.integrationsCredentialStatus, ["model:openai"]);
    expect(result).toEqual({ key: "model:openai", configured: true, needsReentry: false });
    expect(JSON.stringify(await admin.invoke("models.providers", []))).not.toContain("test-private-key");
    await admin.invoke(ipc.integrationsRemoveCredential, ["model:openai"]);
    expect(await credentials.get("model:openai")).toBeNull();
  });

  it("installs and assigns skills through existing package and coworker operations", async () => {
    const { service, admin } = await fixture();
    const coworker = service.database.listCoworkers()[0]!;
    await admin.invoke(ipc.skillsInstallFromContent, [{ content: "---\nname: test-report\ndescription: Test report generation\n---\nProduce the requested report." }]);
    const skill = service.database.getSkillByName("test-report")!;
    await admin.invoke("skills.assign", [skill.id, coworker.id, true]);
    expect(service.database.getCoworker(coworker.id).enabledSkillIds).toContain(skill.id);
    await admin.invoke("skills.assign", [skill.id, coworker.id, false]);
    expect(service.database.getCoworker(coworker.id).enabledSkillIds).not.toContain(skill.id);
    await expect(admin.invoke("skills.assign", ["missing", coworker.id, true])).rejects.toThrow();
  });

  it("exposes administration guidance through native skill discovery without additional tool authority", async () => {
    const { service } = await fixture();
    const skill = service.database.getSkillByName("coworker-administration")!;
    const coworker = service.database.listCoworkers()[0]!;
    expect(coworker.enabledSkillIds).toContain(skill.id);
    const prompt = formatModelSelectableSkills([skill]);
    expect(prompt).toContain("skill://coworker-administration/SKILL.md");
    expect(skill.description).toContain("administering Coworker itself");
    expect(skill.description).toContain("not for performing a coworker's assigned work");
    expect(coworker.enabledTools).not.toContain("administration");
  });

  it("persists a terminal approval decision and requests worker resumption once", async () => {
    const { service, admin } = await fixture();
    const coworker = service.database.listCoworkers()[0]!;
    const task = service.database.createTask({ coworkerId: coworker.id, title: "Approval", input: "Prepare a draft" });
    const toolCall = service.database.createToolCall({ taskId: task.id, coworkerId: coworker.id,
      toolName: "email.send", arguments: {}, idempotencyKey: "terminal-approval-test" });
    const approval = service.database.createApproval({ taskId: task.id, coworkerId: coworker.id,
      toolCallId: toolCall.id, actionType: "email.send", summary: "Send the prepared message", proposedPayload: {}, riskLevel: "high" });
    const enqueue = vi.spyOn(service.runtime, "enqueueTask").mockImplementation(() => {});
    expect(await admin.invoke("approvals.show", [approval.id])).toMatchObject({ status: "PENDING" });
    await admin.invoke(ipc.approvalsDecide, [{ approvalId: approval.id, decision: "approve" }]);
    expect(service.database.getApproval(approval.id).status).toBe("APPROVED");
    expect(enqueue).toHaveBeenCalledWith(coworker.id);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("validates scheduled work and handles approvals through existing services", async () => {
    const { service, admin } = await fixture();
    const coworker = service.database.listCoworkers()[0]!;
    const created = await admin.invoke(ipc.schedulesCreate, [{ coworkerId: coworker.id, name: "Morning report",
      scheduleType: "cron", cronExpression: "0 9 * * *", timezone: "Asia/Singapore",
      taskTemplate: { title: "Report", input: "Prepare a report" } }]) as { id: string };
    await admin.invoke(ipc.schedulesUpdate, [created.id, { enabled: false }]);
    expect(service.database.getSchedule(created.id).enabled).toBe(false);
    await expect(admin.invoke(ipc.schedulesCreate, [{ coworkerId: coworker.id }])).rejects.toThrow();
    const decide = vi.spyOn(service, "decideApproval");
    await expect(admin.invoke(ipc.approvalsDecide, [{ approvalId: "missing", decision: "approve" }])).rejects.toThrow();
    expect(decide).toHaveBeenCalledWith({ approvalId: "missing", decision: "approve" });
    await expect(admin.invoke(ipc.approvalsDecide, [{ approvalId: "missing", decision: "skip" }])).rejects.toThrow();
    expect(decide).toHaveBeenCalledTimes(1);
  });
});
