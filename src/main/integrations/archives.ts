import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { ZipArchive, type Archiver } from "archiver";
import type { Coworker } from "@shared/contracts";
import type { ApplicationLogger } from "@main/runtime/application-logger";
import type { ProviderErrorLogger } from "@main/runtime/provider-error-logger";

interface SupportBundleInput {
  destinationPath: string;
  logger: ApplicationLogger;
  providerLogger: Pick<ProviderErrorLogger, "path" | "flush">;
  metadata: Record<string, string>;
}

interface DataBackupInput {
  destinationPath: string;
  dataPath: string;
  coworkers: Coworker[];
  createDatabaseSnapshot: (destinationPath: string) => string;
  appVersion: string;
}

interface WorkspaceManifest {
  coworkerId: string;
  coworkerName: string;
  archivePath: string;
  available: boolean;
}

export async function createSupportBundle(input: SupportBundleInput): Promise<string> {
  const generatedAt = new Date().toISOString();
  await input.providerLogger.flush();
  return writeZip(input.destinationPath, async (archive) => {
    archive.append(
      JSON.stringify(
        {
          generatedAt,
          ...input.metadata,
          privacy:
            "Credentials and user-account names are redacted where recognized. Logs can still contain file names and technical error context; review the ZIP before sending it.",
        },
        null,
        2,
      ),
      { name: "system-info.json" },
    );
    for (const file of await input.logger.readFiles()) {
      archive.append(file.content, { name: `logs/${file.name}` });
    }
    for (const candidate of [
      { name: "provider-errors.jsonl.1", path: `${input.providerLogger.path}.1` },
      { name: "provider-errors.jsonl", path: input.providerLogger.path },
    ]) {
      if (existsSync(candidate.path)) {
        archive.file(candidate.path, { name: `logs/${candidate.name}` });
      }
    }
  });
}

export async function createDataBackup(input: DataBackupInput): Promise<string> {
  const stagingPath = await mkdtemp(join(tmpdir(), "coworker-data-backup-"));
  try {
    const workspaces: WorkspaceManifest[] = input.coworkers.map((coworker) => ({
      coworkerId: coworker.id,
      coworkerName: coworker.name,
      archivePath: `workspaces/${safeArchiveSegment(coworker.id)}`,
      available: false,
    }));
    for (const [index, coworker] of input.coworkers.entries()) {
      const workspace = workspaces[index]!;
      await assertDestinationOutside(input.destinationPath, coworker.workspacePath);
      workspace.available = await stageDirectory(
        coworker.workspacePath,
        join(stagingPath, workspace.archivePath),
      );
      if (!workspace.available) {
        throw new Error(`Could not include ${coworker.name}'s workspace in the data backup`);
      }
    }
    const outboxPath = join(input.dataPath, "outbox");
    await assertDestinationOutside(input.destinationPath, outboxPath);
    const stagedOutboxPath = join(stagingPath, "outbox");
    const outboxAvailable = await stageDirectory(outboxPath, stagedOutboxPath);

    const databasePath = join(stagingPath, "coworker.db");
    input.createDatabaseSnapshot(databasePath);

    return await writeZip(input.destinationPath, async (archive) => {
      archive.file(databasePath, { name: "database/coworker.db" });
      for (const workspace of workspaces) {
        await addDirectoryToArchive(
          archive,
          join(stagingPath, workspace.archivePath),
          workspace.archivePath,
        );
      }
      if (outboxAvailable) {
        await addDirectoryToArchive(archive, stagedOutboxPath, "outbox");
      }
      archive.append(
        JSON.stringify(
          {
            format: "coworker-data-backup",
            formatVersion: 1,
            appVersion: input.appVersion,
            createdAt: new Date().toISOString(),
            contents: {
              database: "database/coworker.db",
              conversations: "Stored in the SQLite database",
              coworkerFiles: workspaces,
              outbox: "outbox",
            },
            excluded: [
              "OS-encrypted credentials, which are machine-bound",
              "diagnostic logs",
              "previous backups",
            ],
          },
          null,
          2,
        ),
        { name: "manifest.json" },
      );
    });
  } finally {
    await rm(stagingPath, { recursive: true, force: true });
  }
}

async function stageDirectory(sourcePath: string, destinationPath: string): Promise<boolean> {
  const root = await realpath(sourcePath).catch(() => null);
  if (!root) return false;
  if (!(await lstat(root)).isDirectory()) return false;
  await mkdir(dirname(destinationPath), { recursive: true });
  await cp(root, destinationPath, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    errorOnExist: true,
    force: false,
  });
  return true;
}

async function assertDestinationOutside(
  destinationPath: string,
  sourceDirectory: string,
): Promise<void> {
  const root = await realpath(sourceDirectory).catch(() => null);
  if (!root) return;
  const destinationDirectory =
    (await realpath(dirname(destinationPath)).catch(() => null)) ??
    resolve(dirname(destinationPath));
  const canonicalDestination = join(destinationDirectory, basename(destinationPath));
  if (isInside(root, canonicalDestination)) {
    throw new Error("Save the data backup outside coworker workspaces and the email outbox");
  }
}

async function addDirectoryToArchive(
  archive: Archiver,
  directoryPath: string,
  archiveRoot: string,
): Promise<void> {
  const root = await realpath(directoryPath);
  await visitDirectory(archive, root, root, archiveRoot);
}

async function visitDirectory(
  archive: Archiver,
  root: string,
  current: string,
  archiveRoot: string,
): Promise<void> {
  const resolvedCurrent = await realpath(current);
  if (!isInside(root, resolvedCurrent)) {
    throw new Error("A workspace path escaped while creating the data backup");
  }
  const directory = await opendir(resolvedCurrent);
  for await (const entry of directory) {
    const path = join(resolvedCurrent, entry.name);
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      throw new Error(`Could not include symbolic link ${entry.name} in the data backup`);
    }
    const resolved = await realpath(path);
    if (!isInside(root, resolved)) {
      throw new Error("A workspace path escaped while creating the data backup");
    }
    const relativePath = relative(root, resolved);
    const archivePath = `${archiveRoot}/${relativePath.split(sep).join("/")}`;
    if (stats.isDirectory()) {
      await visitDirectory(archive, root, resolved, archiveRoot);
    } else if (stats.isFile()) {
      archive.file(resolved, { name: archivePath });
    }
  }
}

async function writeZip(
  destinationPath: string,
  populate: (archive: Archiver) => Promise<void>,
): Promise<string> {
  const destinationDirectory = dirname(destinationPath);
  await mkdir(destinationDirectory, { recursive: true });
  const temporaryPath = join(
    destinationDirectory,
    `.${basename(destinationPath)}.${randomUUID()}.tmp`,
  );
  const output = createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 });
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const completed = new Promise<void>((resolveCompletion, rejectCompletion) => {
    output.once("close", resolveCompletion);
    output.once("error", rejectCompletion);
    archive.once("error", rejectCompletion);
    archive.on("warning", rejectCompletion);
  });
  archive.pipe(output);
  try {
    await populate(archive);
    await archive.finalize();
    await completed;
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, destinationPath);
    return destinationPath;
  } catch (error) {
    archive.abort();
    output.destroy();
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}

function safeArchiveSegment(value: string): string {
  const segment = basename(value).replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  return segment || "item";
}
