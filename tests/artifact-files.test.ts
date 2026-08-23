import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoworkerDatabase } from "@main/db/database";
import {
  deleteArtifactFile,
  resolveArtifactFile,
} from "@main/integrations/artifact-files";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("artifact file access", () => {
  it("resolves recorded files inside the owning coworker workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-artifacts-"));
    temporaryPaths.push(root);
    const workspace = join(root, "workspace");
    const filePath = join(workspace, "reports", "summary.pdf");
    await mkdir(join(workspace, "reports"), { recursive: true });
    await writeFile(filePath, "pdf");

    const database = new CoworkerDatabase(join(root, "coworker.db"));
    try {
      const coworker = database.createCoworker(
        {
          name: "Ava",
          role: "Accounting Coworker",
          systemPrompt: "Create accurate documents.",
          modelProvider: "demo",
          modelName: "faux-1",
          enabledTools: ["documents.export"],
        },
        workspace,
      );
      const artifact = database.createArtifact({
        taskId: null,
        coworkerId: coworker.id,
        name: "summary.pdf",
        mimeType: "application/pdf",
        filePath,
      });

      await expect(resolveArtifactFile(database, artifact.id)).resolves.toMatchObject({
        artifact: { id: artifact.id },
        path: await realpath(filePath),
      });
    } finally {
      database.close();
    }
  });

  it("resolves files recorded under a differently cased workspace root", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-artifacts-"));
    temporaryPaths.push(root);
    const workspace = join(root, "Workspace");
    const filePath = join(workspace, "seedance_profiles.csv");
    await mkdir(workspace, { recursive: true });
    await writeFile(filePath, "a,b\n1,2\n");

    const database = new CoworkerDatabase(join(root, "coworker.db"));
    try {
      const coworker = database.createCoworker(
        {
          name: "Song",
          role: "Social Media Expert",
          systemPrompt: "Research profiles.",
          modelProvider: "demo",
          modelName: "faux-1",
          enabledTools: ["documents.export"],
        },
        workspace,
      );
      const artifact = database.createArtifact({
        taskId: null,
        coworkerId: coworker.id,
        name: "seedance_profiles.csv",
        mimeType: "text/csv",
        // The same directory, spelled the way the app resolved it when writing.
        filePath: join(root, "workspace", "seedance_profiles.csv"),
      });

      await expect(resolveArtifactFile(database, artifact.id)).resolves.toMatchObject({
        artifact: { id: artifact.id },
      });
    } finally {
      database.close();
    }
  });

  it("rejects artifact records that point outside the coworker workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-artifacts-"));
    temporaryPaths.push(root);
    const workspace = join(root, "workspace");
    const outsidePath = join(root, "outside.pdf");
    await mkdir(workspace, { recursive: true });
    await writeFile(outsidePath, "pdf");

    const database = new CoworkerDatabase(join(root, "coworker.db"));
    try {
      const coworker = database.createCoworker(
        {
          name: "Ava",
          role: "Accounting Coworker",
          systemPrompt: "Create accurate documents.",
          modelProvider: "demo",
          modelName: "faux-1",
          enabledTools: ["documents.export"],
        },
        workspace,
      );
      const artifact = database.createArtifact({
        taskId: null,
        coworkerId: coworker.id,
        name: "outside.pdf",
        mimeType: "application/pdf",
        filePath: outsidePath,
      });

      await expect(resolveArtifactFile(database, artifact.id)).rejects.toThrow(
        /traversal|workspace|relative/i,
      );
      await expect(deleteArtifactFile(database, artifact.id)).rejects.toThrow(
        /traversal|workspace|relative/i,
      );
      await expect(stat(outsidePath)).resolves.toMatchObject({ size: 3 });
      expect(database.getArtifact(artifact.id).id).toBe(artifact.id);
    } finally {
      database.close();
    }
  });

  it("deletes the workspace file and its artifact record", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-artifacts-"));
    temporaryPaths.push(root);
    const workspace = join(root, "workspace");
    const filePath = join(workspace, "report.docx");
    await mkdir(workspace, { recursive: true });
    await writeFile(filePath, "docx");

    const database = new CoworkerDatabase(join(root, "coworker.db"));
    try {
      const coworker = database.createCoworker(
        {
          name: "Ava",
          role: "Accounting Coworker",
          systemPrompt: "Create accurate documents.",
          modelProvider: "demo",
          modelName: "faux-1",
          enabledTools: ["documents.export"],
        },
        workspace,
      );
      const artifact = database.createArtifact({
        taskId: null,
        coworkerId: coworker.id,
        name: "report.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filePath,
      });

      await deleteArtifactFile(database, artifact.id);

      await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(database.listArtifacts(coworker.id)).toEqual([]);
      expect(() => database.getArtifact(artifact.id)).toThrow(/not found/i);
    } finally {
      database.close();
    }
  });

  it("removes a stale artifact record when its file is already gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-artifacts-"));
    temporaryPaths.push(root);
    const workspace = join(root, "workspace");
    const filePath = join(workspace, "missing.pdf");
    await mkdir(workspace, { recursive: true });

    const database = new CoworkerDatabase(join(root, "coworker.db"));
    try {
      const coworker = database.createCoworker(
        {
          name: "Ava",
          role: "Accounting Coworker",
          systemPrompt: "Create accurate documents.",
          modelProvider: "demo",
          modelName: "faux-1",
          enabledTools: ["documents.export"],
        },
        workspace,
      );
      const artifact = database.createArtifact({
        taskId: null,
        coworkerId: coworker.id,
        name: "missing.pdf",
        mimeType: "application/pdf",
        filePath,
      });

      await deleteArtifactFile(database, artifact.id);

      expect(database.listArtifacts(coworker.id)).toEqual([]);
    } finally {
      database.close();
    }
  });
});
