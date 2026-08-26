import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAppService } from "@main/app/app-service";
import { CoworkerDatabase } from "@main/db/database";
import {
  resolveSharedFolderGrants,
  resolveSharedFolderPath,
} from "@main/tools/shared-folders";
import { ToolGateway } from "@main/tools/tool-gateway";

const temporaryPaths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  // macOS tmpdir is a symlink (/var -> /private/var); grants store realpaths.
  return realpathSync(path);
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

describe("shared folder grants", () => {
  it("canonicalizes folders, derives aliases, and dedupes", async () => {
    const root = await temporaryDirectory("coworker-grants-");
    const dataPath = join(root, "data");
    await mkdir(join(root, "left", "docs"), { recursive: true });
    await mkdir(join(root, "right", "docs"), { recursive: true });
    await mkdir(dataPath, { recursive: true });

    const folders = await resolveSharedFolderGrants(
      [
        join(root, "left", "docs"),
        join(root, "right", "docs"),
        join(root, "left", "docs"),
      ],
      { dataPath },
    );
    expect(folders).toEqual([
      { path: join(root, "left", "docs"), alias: "docs" },
      { path: join(root, "right", "docs"), alias: "docs-2" },
    ]);
  });

  it("stores the real target of a symlinked grant", async () => {
    const root = await temporaryDirectory("coworker-grants-symlink-");
    const target = join(root, "actual");
    await mkdir(target, { recursive: true });
    await symlink(target, join(root, "linked"));

    const folders = await resolveSharedFolderGrants([join(root, "linked")], {
      dataPath: join(root, "data"),
    });
    expect(folders).toEqual([{ path: target, alias: "actual" }]);
  });

  it("rejects relative paths, missing folders, and plain files", async () => {
    const root = await temporaryDirectory("coworker-grants-invalid-");
    const dataPath = join(root, "data");
    await writeFile(join(root, "notes.txt"), "text");

    await expect(
      resolveSharedFolderGrants(["relative/docs"], { dataPath }),
    ).rejects.toThrow(/absolute paths/i);
    await expect(
      resolveSharedFolderGrants([join(root, "missing")], { dataPath }),
    ).rejects.toThrow(/does not exist/i);
    await expect(
      resolveSharedFolderGrants([join(root, "notes.txt")], { dataPath }),
    ).rejects.toThrow(/not a directory/i);
  });

  it("rejects the app data directory and anything inside it", async () => {
    const root = await temporaryDirectory("coworker-grants-datapath-");
    const dataPath = join(root, "data");
    await mkdir(join(dataPath, "credentials"), { recursive: true });

    await expect(resolveSharedFolderGrants([dataPath], { dataPath })).rejects.toThrow(
      /data directory/i,
    );
    await expect(
      resolveSharedFolderGrants([join(dataPath, "credentials")], { dataPath }),
    ).rejects.toThrow(/data directory/i);
  });
});

describe("shared folder read resolution", () => {
  it("resolves files and the folder root while blocking traversal", async () => {
    const root = await temporaryDirectory("coworker-read-");
    const shared = join(root, "shared");
    await mkdir(join(shared, "reports"), { recursive: true });
    await writeFile(join(shared, "reports", "q3.txt"), "quarterly");
    await writeFile(join(root, "outside.txt"), "secret");
    const folders = [{ path: shared, alias: "shared" }];

    await expect(resolveSharedFolderPath(folders, "shared", ".")).resolves.toBe(shared);
    await expect(
      resolveSharedFolderPath(folders, "shared", "reports/q3.txt"),
    ).resolves.toBe(join(shared, "reports", "q3.txt"));
    await expect(
      resolveSharedFolderPath(folders, "shared", "../outside.txt"),
    ).rejects.toThrow(/traversal/i);
    await expect(
      resolveSharedFolderPath(folders, "shared", join(root, "outside.txt")),
    ).rejects.toThrow(/relative path/i);
    await expect(resolveSharedFolderPath(folders, "shared", "missing.txt")).rejects.toThrow(
      /was not found/i,
    );
    await expect(resolveSharedFolderPath(folders, "elsewhere", ".")).rejects.toThrow(
      /Unknown shared folder "elsewhere"\. Available folders: shared/,
    );
  });

  it("blocks symlinks that escape the granted folder but follows internal ones", async () => {
    const root = await temporaryDirectory("coworker-read-symlink-");
    const shared = join(root, "shared");
    await mkdir(shared, { recursive: true });
    await writeFile(join(root, "outside.txt"), "secret");
    await writeFile(join(shared, "inside.txt"), "fine");
    await symlink(join(root, "outside.txt"), join(shared, "escape.txt"));
    await symlink(join(shared, "inside.txt"), join(shared, "internal-link.txt"));
    const folders = [{ path: shared, alias: "shared" }];

    await expect(
      resolveSharedFolderPath(folders, "shared", "escape.txt"),
    ).rejects.toThrow(/may not escape/i);
    await expect(
      resolveSharedFolderPath(folders, "shared", "internal-link.txt"),
    ).resolves.toBe(join(shared, "inside.txt"));
  });

  it("never exposes the app data directory through a grant that contains it", async () => {
    const root = await temporaryDirectory("coworker-read-datapath-");
    const dataPath = join(root, "data");
    await mkdir(dataPath, { recursive: true });
    await writeFile(join(dataPath, "coworker.db"), "database");
    await writeFile(join(root, "harmless.txt"), "fine");
    const folders = [{ path: root, alias: "home" }];

    await expect(
      resolveSharedFolderPath(folders, "home", "data/coworker.db", { dataPath }),
    ).rejects.toThrow(/data directory/i);
    await expect(
      resolveSharedFolderPath(folders, "home", "harmless.txt", { dataPath }),
    ).resolves.toBe(join(root, "harmless.txt"));
  });

  it("reports a granted folder that no longer exists", async () => {
    const root = await temporaryDirectory("coworker-read-gone-");
    const shared = join(root, "shared");
    await mkdir(shared, { recursive: true });
    const folders = [{ path: shared, alias: "shared" }];
    await rm(shared, { recursive: true });

    await expect(resolveSharedFolderPath(folders, "shared", ".")).rejects.toThrow(
      /no longer available/i,
    );
  });
});

describe("shared folder tools through the gateway", () => {
  async function gatewayHarness(sharedFolders: Array<{ path: string; alias: string }>) {
    const root = await temporaryDirectory("coworker-folder-tools-");
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    const workspace = join(root, "workspaces", "ava");
    await mkdir(workspace, { recursive: true });
    const coworker = database.createCoworker(
      {
        name: "Ava",
        role: "Analyst",
        systemPrompt: "Help.",
        modelProvider: "demo",
        modelName: "faux-1",
        enabledTools: ["files.write"],
        sharedFolders,
      },
      workspace,
    );
    const task = database.createTask({
      coworkerId: coworker.id,
      title: "Read shared documents",
      input: "Summarize the shared folder.",
    });
    const gateway = new ToolGateway(
      database,
      memoryCredentials(),
      join(root, "outbox"),
      {},
      { dataPath: root },
    );
    return { root, database, coworker, task, gateway };
  }

  it("denies folder tools when the coworker has no granted folders", async () => {
    const { database, coworker, task, gateway } = await gatewayHarness([]);
    try {
      const response = await gateway.request({
        task,
        coworker,
        toolCallId: "folders-denied",
        toolName: "folders.list",
        arguments: {},
      });
      expect(response.kind).toBe("denied");
      if (response.kind === "denied") {
        expect(response.reason).toContain("not enabled");
      }
    } finally {
      database.close();
    }
  });

  it("lists grants, browses, and reads documents without any enabled tool toggle", async () => {
    const shared = await temporaryDirectory("coworker-shared-docs-");
    await mkdir(join(shared, "reports"), { recursive: true });
    await writeFile(join(shared, "reports", "q3.md"), "# Q3\nRevenue grew.");
    const { database, coworker, task, gateway } = await gatewayHarness([
      { path: shared, alias: "docs" },
    ]);
    try {
      const listAll = await gateway.request({
        task,
        coworker,
        toolCallId: "folders-list-all",
        toolName: "folders.list",
        arguments: {},
      });
      expect(listAll.kind).toBe("completed");
      if (listAll.kind === "completed") {
        expect(listAll.result).toEqual({
          readOnly: true,
          folders: [{ folder: "docs", path: shared }],
        });
      }

      const browse = await gateway.request({
        task,
        coworker,
        toolCallId: "folders-browse",
        toolName: "folders.list",
        arguments: { folder: "docs", path: "reports" },
      });
      expect(browse.kind).toBe("completed");
      if (browse.kind === "completed") {
        expect(browse.result).toMatchObject({
          folder: "docs",
          readOnly: true,
          entries: [{ name: "q3.md", type: "file" }],
        });
      }

      const read = await gateway.request({
        task,
        coworker,
        toolCallId: "folders-read",
        toolName: "folders.read",
        arguments: { folder: "docs", path: "reports/q3.md" },
      });
      expect(read.kind).toBe("completed");
      if (read.kind === "completed") {
        expect(read.result).toMatchObject({
          folder: "docs",
          path: "reports/q3.md",
          readOnly: true,
          kind: "text",
          content: "# Q3\nRevenue grew.",
        });
      }
    } finally {
      database.close();
    }
  });

  it("gives write tools no route into a granted folder", async () => {
    const shared = await temporaryDirectory("coworker-shared-write-");
    const { database, coworker, task, gateway } = await gatewayHarness([
      { path: shared, alias: "docs" },
    ]);
    try {
      await expect(
        gateway.request({
          task,
          coworker,
          toolCallId: "write-absolute",
          toolName: "files.write",
          arguments: { path: join(shared, "hack.txt"), content: "overwrite" },
        }),
      ).rejects.toThrow(/relative workspace path/i);
      await expect(
        gateway.request({
          task,
          coworker,
          toolCallId: "write-traversal",
          toolName: "files.write",
          arguments: { path: "../../../docs/hack.txt", content: "overwrite" },
        }),
      ).rejects.toThrow(/traversal/i);
      await expect(readdir(shared)).resolves.toEqual([]);

      // folders.* has no write semantics: extra content arguments are ignored
      // and nothing is ever created in the granted folder.
      await expect(
        gateway.request({
          task,
          coworker,
          toolCallId: "folders-write-attempt",
          toolName: "folders.read",
          arguments: { folder: "docs", path: "new.txt", content: "data" },
        }),
      ).rejects.toThrow(/was not found/i);
      await expect(readdir(shared)).resolves.toEqual([]);
    } finally {
      database.close();
    }
  });
});

describe("shared folder configuration through the service", () => {
  it("resolves grants on coworker creation and rejects the data directory", async () => {
    const root = await temporaryDirectory("coworker-folder-service-");
    const dataPath = join(root, "data");
    const database = new CoworkerDatabase(join(dataPath, "coworker.db"));
    const shared = join(root, "Documents");
    await mkdir(shared, { recursive: true });
    await mkdir(join(dataPath, "credentials"), { recursive: true });
    const service = new DesktopAppService({
      dataPath,
      database,
      credentials: memoryCredentials(),
    });
    vi.spyOn(service.runtime, "enqueueTask").mockImplementation(() => undefined);
    try {
      const coworker = await service.createCoworker({
        name: "Ava",
        role: "Analyst",
        systemPrompt: "Help.",
        modelProvider: "demo",
        modelName: "faux-1",
        enabledTools: [],
        sharedFolderPaths: [shared, shared],
      });
      expect(coworker.sharedFolders).toEqual([{ path: shared, alias: "Documents" }]);
      expect(database.getCoworker(coworker.id).sharedFolders).toEqual([
        { path: shared, alias: "Documents" },
      ]);

      const updated = await service.updateCoworker(coworker.id, {
        status: "paused",
        sharedFolderPaths: [],
      });
      expect(updated.sharedFolders).toEqual([]);

      await expect(
        service.updateCoworker(coworker.id, {
          sharedFolderPaths: [join(dataPath, "credentials")],
        }),
      ).rejects.toThrow(/data directory/i);
    } finally {
      database.close();
    }
  });
});
