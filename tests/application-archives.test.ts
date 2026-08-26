import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { CoworkerDatabase } from "@main/db/database";
import { createDataBackup, createSupportBundle } from "@main/integrations/archives";
import { ApplicationLogger } from "@main/runtime/application-logger";
import { ProviderErrorLogger } from "@main/runtime/provider-error-logger";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

describe("application diagnostics and archives", () => {
  it("writes redacted application logs into a support ZIP without user data", async () => {
    const root = await temporaryDirectory("coworker-support-");
    const logger = new ApplicationLogger(join(root, "logs", "app.jsonl"));
    await logger.error(
      "ipc",
      new Error("Request failed with api_key=super-secret-value"),
      { channel: "coworker:test", path: "/Users/melvin/private/file.txt" },
    );
    logger.emergency("main.uncaught_exception", new Error("Fatal token=another-secret-value"));
    const providerLogger = new ProviderErrorLogger(join(root, "logs", "provider-errors.jsonl"));
    const pendingProviderWrite = providerLogger.log(
      { phase: "inference", provider: "demo" },
      new Error("redacted provider failure"),
    );

    const destinationPath = join(root, "Coworker-Support.zip");
    await createSupportBundle({
      destinationPath,
      logger,
      providerLogger,
      metadata: { "App version": "1.2.3", Platform: "test arm64" },
    });
    await pendingProviderWrite;

    const zip = await JSZip.loadAsync(await readFile(destinationPath));
    expect(Object.keys(zip.files).sort()).toEqual([
      "logs/app.jsonl",
      "logs/provider-errors.jsonl",
      "report.txt",
      "system-info.json",
    ]);
    const appLog = await zip.file("logs/app.jsonl")!.async("string");
    expect(appLog).toContain("[REDACTED]");
    expect(appLog).toContain("main.uncaught_exception");
    expect(appLog).toContain("/Users/[USER]/");
    expect(appLog).not.toContain("super-secret-value");
    expect(await zip.file("logs/provider-errors.jsonl")!.async("string")).toContain(
      "redacted provider failure",
    );
    const report = await zip.file("report.txt")!.async("string");
    expect(report).toContain("Coworker provider error report");
    expect(report).toContain("App version: 1.2.3");
    expect(zip.file("database/coworker.db")).toBeNull();
    expect(await zip.file("system-info.json")!.async("string")).toContain('"App version": "1.2.3"');
  });

  it("exports a complete data ZIP with a consistent database snapshot and coworker files", async () => {
    const root = await temporaryDirectory("coworker-data-export-");
    const workspace = join(root, "workspaces", "ava");
    const outbox = join(root, "outbox");
    await mkdir(join(workspace, "reports"), { recursive: true });
    await mkdir(outbox, { recursive: true });
    await writeFile(join(workspace, "reports", "summary.txt"), "workspace report");
    await writeFile(join(outbox, "draft.eml"), "email draft");
    await mkdir(join(root, "credentials"), { recursive: true });
    await writeFile(join(root, "credentials", "secret.bin"), "machine-bound");

    const database = new CoworkerDatabase(join(root, "coworker.db"));
    const coworker = database.createCoworker(
      {
        name: "Ava",
        role: "Accountant",
        systemPrompt: "Help.",
        modelProvider: "demo",
        modelName: "faux-1",
        enabledTools: [],
      },
      workspace,
      randomUUID(),
    );
    const task = database.createTask(
      {
        coworkerId: coworker.id,
        title: "Archive this conversation",
        input: "Keep this request in the backup.",
      },
      randomUUID(),
    );
    database.addMessage({
      coworkerId: coworker.id,
      taskId: task.id,
      role: "assistant",
      content: "This response is stored in the backup.",
    });
    await expect(
      createDataBackup({
        destinationPath: join(workspace, "recursive-backup.zip"),
        dataPath: root,
        coworkers: [coworker],
        createDatabaseSnapshot: (path) => database.backup(path),
        appVersion: "1.2.3",
      }),
    ).rejects.toThrow(/outside coworker workspaces/i);

    const destinationPath = join(root, "Coworker-All-Data.zip");
    try {
      await createDataBackup({
        destinationPath,
        dataPath: root,
        coworkers: [coworker],
        createDatabaseSnapshot: (path) => database.backup(path),
        appVersion: "1.2.3",
      });
    } finally {
      database.close();
    }

    const zip = await JSZip.loadAsync(await readFile(destinationPath));
    const archivedDatabasePath = join(root, "archived-coworker.db");
    await writeFile(
      archivedDatabasePath,
      await zip.file("database/coworker.db")!.async("nodebuffer"),
    );
    const archivedDatabase = new DatabaseSync(archivedDatabasePath, { readOnly: true });
    try {
      expect(
        archivedDatabase
          .prepare("SELECT content FROM messages WHERE task_id = ? ORDER BY created_at ASC")
          .all(task.id),
      ).toEqual([
        { content: "Keep this request in the backup." },
        { content: "This response is stored in the backup." },
      ]);
    } finally {
      archivedDatabase.close();
    }
    expect(
      await zip.file(`workspaces/${coworker.id}/reports/summary.txt`)!.async("string"),
    ).toBe(
      "workspace report",
    );
    expect(await zip.file("outbox/draft.eml")!.async("string")).toBe("email draft");
    expect(zip.file("credentials/secret.bin")).toBeNull();
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string")) as {
      appVersion: string;
      contents: { coworkerFiles: Array<{ available: boolean }> };
    };
    expect(manifest.appVersion).toBe("1.2.3");
    expect(manifest.contents.coworkerFiles[0]?.available).toBe(true);
  });

  it("fails rather than silently creating an incomplete backup", async () => {
    const root = await temporaryDirectory("coworker-data-incomplete-");
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    const coworker = database.createCoworker(
      {
        name: "Missing",
        role: "Specialist",
        systemPrompt: "Help.",
        modelProvider: "demo",
        modelName: "faux-1",
        enabledTools: [],
      },
      join(root, "missing-workspace"),
      randomUUID(),
    );
    const destinationPath = join(root, "incomplete.zip");
    await writeFile(destinationPath, "previous backup");
    try {
      await expect(
        createDataBackup({
          destinationPath,
          dataPath: root,
          coworkers: [coworker],
          createDatabaseSnapshot: (path) => database.backup(path),
          appVersion: "1.2.3",
        }),
      ).rejects.toThrow(/could not include missing's workspace/i);
      expect(await readFile(destinationPath, "utf8")).toBe("previous backup");
    } finally {
      database.close();
    }
  });
});
