import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopAppService } from "@main/app/app-service";
import { CoworkerDatabase } from "@main/db/database";
import { createEmailDraft } from "@main/integrations/email";
import { ToolGateway } from "@main/tools/tool-gateway";
import { resolveWorkspacePath } from "@main/tools/workspace-path";
import type { Coworker, CreateCoworkerInput } from "@shared/contracts";

const temporaryPaths: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

function coworkerInput(name: string, tools: string[] = ["files.read", "files.write"]): CreateCoworkerInput {
  return {
    name,
    role: `${name} specialist`,
    systemPrompt: `You are ${name}.`,
    modelProvider: "demo",
    modelName: "faux-1",
    enabledTools: tools,
    policies: { "email.send": "approval" },
  };
}

function memoryCredentials() {
  const values = new Map<string, string>();
  return {
    async set(key: string, value: string) {
      values.set(key, value);
    },
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async has(key: string) {
      return values.has(key);
    },
    async delete(key: string) {
      values.delete(key);
    },
  };
}

async function createCoworker(
  database: CoworkerDatabase,
  root: string,
  name: string,
  tools?: string[],
): Promise<Coworker> {
  const workspace = join(root, name.toLowerCase());
  return database.createCoworker(coworkerInput(name, tools), workspace);
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("durable state and queue invariants", () => {
  it("persists the global default model without coercing string settings", async () => {
    const root = await temporaryDirectory("coworker-settings-");
    const path = join(root, "coworker.db");
    const first = new CoworkerDatabase(path);
    expect(first.getSettings()).toMatchObject({
      defaultModelProvider: null,
      defaultModelName: null,
    });
    first.updateSettings({
      defaultModelProvider: "openrouter",
      defaultModelName: "google/gemini-flash",
    });
    first.close();

    const reopened = new CoworkerDatabase(path);
    try {
      expect(reopened.getSettings()).toMatchObject({
        runInBackground: true,
        launchAtLogin: false,
        defaultModelProvider: "openrouter",
        defaultModelName: "google/gemini-flash",
      });
    } finally {
      reopened.close();
    }
  });

  it("seeds demo coworkers only once and preserves intentional deletion across restarts", async () => {
    const root = await temporaryDirectory("coworker-service-");
    const credentials = memoryCredentials();
    const first = new DesktopAppService({ dataPath: root, credentials });
    await first.initialize();
    const seeded = first.database.listCoworkers();
    expect(seeded.map((coworker) => coworker.name).sort()).toEqual(["Ava", "Sarah"]);
    for (const coworker of seeded) {
      expect(coworker.enabledTools).toContain("schedules.create");
      expect(coworker.policies["schedules.create"]).toBe("approval");
    }
    for (const coworker of seeded) await first.removeCoworker(coworker.id);
    await first.shutdown();

    const restarted = new DesktopAppService({ dataPath: root, credentials });
    try {
      await restarted.initialize();
      expect(restarted.database.listCoworkers()).toEqual([]);
    } finally {
      await restarted.shutdown();
    }
  });

  it("allows one active task per coworker while different coworkers claim work independently", async () => {
    const root = await temporaryDirectory("coworker-db-");
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    try {
      const ava = await createCoworker(database, root, "Ava");
      const sarah = await createCoworker(database, root, "Sarah");
      const first = database.createTask({ coworkerId: ava.id, title: "First", input: "One" });
      const second = database.createTask({ coworkerId: ava.id, title: "Second", input: "Two" });
      const parallel = database.createTask({
        coworkerId: sarah.id,
        title: "Parallel",
        input: "Three",
      });

      expect(database.claimNextTask(ava.id)?.id).toBe(first.id);
      expect(database.claimNextTask(ava.id)).toBeNull();
      expect(database.claimNextTask(sarah.id)?.id).toBe(parallel.id);

      database.setTaskStatus(first.id, "COMPLETED");
      expect(database.claimNextTask(ava.id)?.id).toBe(second.id);
    } finally {
      database.close();
    }
  });

  it("recovers interrupted runs but preserves approval waits", async () => {
    const root = await temporaryDirectory("coworker-recovery-");
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    try {
      const ava = await createCoworker(database, root, "Ava", ["email.send"]);
      const interrupted = database.createTask({
        coworkerId: ava.id,
        title: "Interrupted",
        input: "Recover me",
      });
      database.claimNextTask(ava.id);
      database.setTaskStatus(interrupted.id, "RUNNING");

      const waiting = database.createTask({
        coworkerId: ava.id,
        title: "Approval",
        input: "Wait for a decision",
      });
      const toolCall = database.createToolCall({
        taskId: waiting.id,
        coworkerId: ava.id,
        toolName: "email.send",
        arguments: { to: "billing@example.test", subject: "Invoice", body: "Attached" },
        idempotencyKey: `${waiting.id}:send`,
      });
      database.createApproval({
        taskId: waiting.id,
        coworkerId: ava.id,
        toolCallId: toolCall.id,
        actionType: "email.send",
        summary: "Send invoice",
        proposedPayload: toolCall.arguments,
        riskLevel: "high",
      });

      expect(database.recoverInterruptedTasks()).toBe(1);
      expect(database.getTask(interrupted.id).status).toBe("QUEUED");
      expect(database.getTask(interrupted.id).source).toBe("recovery");
      expect(database.getTask(waiting.id).status).toBe("WAITING_FOR_APPROVAL");
    } finally {
      database.close();
    }
  });
});

describe("approval and side-effect safety", () => {
  it("expires a pending approval when its task is cancelled", async () => {
    const root = await temporaryDirectory("coworker-cancel-");
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    try {
      const ava = await createCoworker(database, root, "Ava", ["email.send"]);
      const task = database.createTask({ coworkerId: ava.id, title: "Cancel", input: "Send later" });
      const toolCall = database.createToolCall({
        taskId: task.id,
        coworkerId: ava.id,
        toolName: "email.send",
        arguments: { to: "person@example.test", subject: "Hello", body: "Body" },
        idempotencyKey: `${task.id}:cancel`,
      });
      const approval = database.createApproval({
        taskId: task.id,
        coworkerId: ava.id,
        toolCallId: toolCall.id,
        actionType: "email.send",
        summary: "Send email",
        proposedPayload: toolCall.arguments,
        riskLevel: "high",
      });

      database.cancelTask(task.id);

      expect(database.getTask(task.id).status).toBe("CANCELLED");
      expect(database.getApproval(approval.id).status).toBe("EXPIRED");
      expect(database.getToolCall(toolCall.id).status).toBe("DENIED");
    } finally {
      database.close();
    }
  });

  it("persists approval before sending and reuses the completed idempotent result", async () => {
    const root = await temporaryDirectory("coworker-approval-");
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    try {
      const ava = await createCoworker(database, root, "Ava", ["email.send"]);
      database.upsertEmailIntegration({
        name: "Local outbox",
        mode: "local-outbox",
        credentialKey: null,
        fromAddress: "ava@example.test",
      });
      const outbox = join(root, "outbox");
      const gateway = new ToolGateway(database, memoryCredentials(), outbox);
      const task = database.createTask({
        coworkerId: ava.id,
        title: "Send invoice",
        input: "Send the invoice",
      });
      const requested = await gateway.request({
        task,
        coworker: ava,
        toolCallId: "send-1",
        toolName: "email.send",
        arguments: {
          to: "billing@example.test",
          subject: "INV-100",
          body: "Please find the invoice attached.",
        },
      });

      expect(requested.kind).toBe("approval");
      expect(database.getTask(task.id).status).toBe("WAITING_FOR_APPROVAL");
      await expect(readdir(outbox)).rejects.toMatchObject({ code: "ENOENT" });
      if (requested.kind !== "approval") throw new Error("Expected an approval");
      const retried = await gateway.request({
        task: database.getTask(task.id),
        coworker: ava,
        toolCallId: "send-after-restart",
        toolName: "email.send",
        arguments: {
          body: "Please find the invoice attached.",
          subject: "INV-100",
          to: "billing@example.test",
        },
      });
      expect(retried.kind).toBe("approval");
      if (retried.kind !== "approval") throw new Error("Expected the same approval on retry");
      expect(retried.approval.id).toBe(requested.approval.id);
      expect(retried.toolCall.id).toBe(requested.toolCall.id);

      const approval = database.decideApproval({
        approvalId: requested.approval.id,
        decision: "approve",
      });
      const first = await gateway.executeApproval(approval, ava);
      const second = await gateway.executeApproval(approval, ava);

      expect(first).toEqual(second);
      expect((await readdir(outbox)).filter((name) => name.endsWith(".eml"))).toHaveLength(1);
      expect(database.getToolCall(requested.toolCall.id).status).toBe("COMPLETED");
    } finally {
      database.close();
    }
  });
});

describe("workspace confinement", () => {
  it("blocks traversal while allowing normal nested files", async () => {
    const root = await temporaryDirectory("coworker-workspace-");
    await expect(resolveWorkspacePath(root, "../outside.txt", { createParent: true })).rejects.toThrow(
      /traversal|relative/i,
    );
    await expect(resolveWorkspacePath(root, "/tmp/outside.txt", { createParent: true })).rejects.toThrow(
      /relative/i,
    );

    const nested = await resolveWorkspacePath(root, "reports/today.md", { createParent: true });
    await writeFile(nested, "safe");
    expect(await readFile(nested, "utf8")).toBe("safe");
  });

  it.skipIf(process.platform === "win32")(
    "blocks escaping symlinks for files and email drafts",
    async () => {
      const root = await temporaryDirectory("coworker-symlink-");
      const outside = await temporaryDirectory("coworker-outside-");
      await symlink(outside, join(root, "escape"));
      await symlink(outside, join(root, "drafts"));

      await expect(
        resolveWorkspacePath(root, "escape/new/report.md", { createParent: true }),
      ).rejects.toThrow(/symlink/i);
      await expect(
        createEmailDraft({
          payload: { to: ["person@example.test"], subject: "Draft", body: "Hello" },
          workspacePath: root,
          fromAddress: "coworker@example.test",
          draftId: "draft-1",
        }),
      ).rejects.toThrow(/symlink/i);
      expect(await readdir(outside)).toEqual([]);
    },
  );
});
