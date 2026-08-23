import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { EventType } from "@ag-ui/core";
import { afterEach, describe, expect, it } from "vitest";
import { CoworkerDatabase } from "@main/db/database";
import { CoworkerRuntimeManager } from "@main/runtime/runtime-manager";
import { ToolGateway } from "@main/tools/tool-gateway";
import type { DesktopEvent } from "@shared/contracts";

const temporaryPaths: string[] = [];

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("first architecture milestone", () => {
  it(
    "runs Ava and Sarah independently, pauses Ava durably, resumes once, and completes Sarah's work",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "coworker-milestone-"));
      temporaryPaths.push(root);
      const database = new CoworkerDatabase(join(root, "coworker.db"));
      const credentialValues = new Map<string, string>();
      const credentials = {
        async set(key: string, value: string) {
          credentialValues.set(key, value);
        },
        async get(key: string) {
          return credentialValues.get(key) ?? null;
        },
        async has(key: string) {
          return credentialValues.has(key);
        },
        async delete(key: string) {
          credentialValues.delete(key);
        },
      };
      const tools = new ToolGateway(database, credentials, join(root, "outbox"));
      const events: DesktopEvent[] = [];
      const manager = new CoworkerRuntimeManager({
        database,
        credentials,
        tools,
        emit: (event) => events.push(event),
        idleTimeoutMs: 60_000,
        workerFactory: () =>
          new Worker(resolve(process.cwd(), "out/main/runtime/coworker-worker.js")),
      });

      try {
        database.upsertEmailIntegration({
          name: "Local outbox",
          mode: "local-outbox",
          credentialKey: null,
          fromAddress: "ava@example.test",
        });
        const ava = database.createCoworker(
          {
            name: "Ava",
            role: "Accounting Coworker",
            systemPrompt:
              "Prepare accurate invoices and never send externally without the controlled tool.",
            modelProvider: "demo",
            modelName: "faux-1",
            enabledTools: ["invoice.create", "email.send"],
            policies: { "email.send": "approval" },
          },
          join(root, "workspaces", "ava"),
        );
        const salesHandoffSkill = database.upsertSkill({
          name: "sales-handoff",
          description: "Creates structured sales handoff reports for account teams.",
          content:
            "---\nname: sales-handoff\ndescription: Creates structured sales handoff reports for account teams.\n---\n\n# Sales handoff\n\nSummarize the opportunity and next actions.",
        });
        const sarah = database.createCoworker(
          {
            name: "Sarah",
            role: "Sales Coworker",
            systemPrompt: "Prepare concise sales reports using controlled file tools.",
            modelProvider: "demo",
            modelName: "faux-1",
            enabledTools: ["files.write"],
            enabledSkillIds: [salesHandoffSkill.id],
          },
          join(root, "workspaces", "sarah"),
        );
        const avaTask = database.createTask({
          coworkerId: ava.id,
          title: "Prepare the Acme invoice",
          input:
            "Prepare a Markdown invoice for Acme Ltd for 12 hours at $150/hour, due in 14 days, and send it to billing@acme.test.",
        });
        const sarahTask = database.createTask({
          coworkerId: sarah.id,
          title: "Create sales handoff",
          input: "Create today's sales handoff report as Markdown and save it.",
          source: "schedule",
        });

        manager.enqueueTask(ava.id);
        manager.enqueueTask(sarah.id);

        await waitFor(
          () =>
            database.getTask(avaTask.id).status === "WAITING_FOR_APPROVAL" &&
            database.getTask(sarahTask.id).status === "COMPLETED",
          "Ava's approval pause and Sarah's completion",
        );

        const lifecycleEvents = events.filter(
          (event): event is Extract<DesktopEvent, { type: "agent.event" }> =>
            event.type === "agent.event" &&
            [EventType.RUN_STARTED, EventType.RUN_FINISHED].includes(event.event.type),
        );
        const firstFinish = lifecycleEvents.findIndex(
          (event) => event.event.type === EventType.RUN_FINISHED,
        );
        const startsBeforeFinish = lifecycleEvents
          .slice(0, firstFinish)
          .filter((event) => event.event.type === EventType.RUN_STARTED);
        expect(firstFinish).toBeGreaterThan(1);
        expect(new Set(startsBeforeFinish.map((event) => event.coworkerId))).toEqual(
          new Set([ava.id, sarah.id]),
        );

        expect(database.listArtifacts(ava.id).some((artifact) => artifact.name.endsWith(".md"))).toBe(
          true,
        );
        expect(database.listArtifacts(sarah.id)).toHaveLength(1);
        expect(
          database
            .listToolCalls(sarahTask.id)
            .filter((toolCall) => toolCall.toolName === "skills.read"),
        ).toEqual([]);
        const [approval] = database.listApprovals("PENDING");
        expect(approval).toMatchObject({
          coworkerId: ava.id,
          taskId: avaTask.id,
          actionType: "email.send",
        });
        await expect(readdir(join(root, "outbox"))).rejects.toMatchObject({ code: "ENOENT" });

        const decided = database.decideApproval({
          approvalId: approval!.id,
          decision: "approve",
        });
        manager.enqueueTask(ava.id);
        await waitFor(
          () => database.getTask(avaTask.id).status === "COMPLETED",
          "Ava's approved task completion",
        );

        expect(decided.status).toBe("APPROVED");
        expect((await readdir(join(root, "outbox"))).filter((name) => name.endsWith(".eml"))).toHaveLength(
          1,
        );
        manager.enqueueTask(ava.id);
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        expect((await readdir(join(root, "outbox"))).filter((name) => name.endsWith(".eml"))).toHaveLength(
          1,
        );
      } finally {
        await manager.stopAll();
        database.close();
      }
    },
    30_000,
  );
});
