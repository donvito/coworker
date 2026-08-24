import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopAppService } from "@main/app/app-service";
import { MemoryCredentialStore } from "@main/security/credential-store";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("complete data export service", () => {
  it("waits for active work and exports while dispatch and schedules are paused", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-data-service-"));
    temporaryPaths.push(root);
    const service = new DesktopAppService({
      dataPath: root,
      appVersion: "1.2.3",
      credentials: new MemoryCredentialStore(),
    });
    await service.initialize();
    try {
      const coworker = service.database.listCoworkers()[0]!;
      const task = service.database.createTask({
        coworkerId: coworker.id,
        title: "Active work",
        input: "Do not snapshot midway.",
      });
      service.database.claimNextTask(coworker.id);
      await expect(service.exportDataBackup(join(root, "blocked.zip"))).rejects.toThrow(
        /wait for active coworker tasks/i,
      );

      service.database.setTaskStatus(task.id, "COMPLETED");
      const destinationPath = join(root, "complete.zip");
      const finishMutation = service.beginDataMutation();
      const exportPromise = service.exportDataBackup(destinationPath);
      expect(() => service.assertDataMutationAllowed()).toThrow(/temporarily read-only/i);
      await expect(readFile(destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
      finishMutation();
      await expect(exportPromise).resolves.toBe(destinationPath);
      expect(() => service.assertDataMutationAllowed()).not.toThrow();
      const zip = await JSZip.loadAsync(await readFile(destinationPath));
      expect(zip.file("database/coworker.db")).not.toBeNull();
      expect(zip.file("manifest.json")).not.toBeNull();
    } finally {
      await service.shutdown();
    }
  });
});
