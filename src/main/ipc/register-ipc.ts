import { z } from "zod";
import { stat } from "node:fs/promises";
import { writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { runSkillScript } from "@main/integrations/skill-script-runner";
import { FileDeleteConfirmations } from "@main/integrations/file-delete-confirmations";
import { fileRefSchema } from "@shared/files";
import { fileRoots, listFiles, previewFile, resolveFile } from "@main/tools/file-access";
import { createAdministration } from "@main/control/administration";
import { copyFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
  BrowserWindow,
  app,
  clipboard,
  dialog,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import { ipcChannels } from "@shared/ipc";
import type { AgentRunRequest } from "@shared/contracts";
import {
  agentRunRequestSchema,
  configureEmailSchema,
  configureWebSearchSchema,
  conversationSearchSchema,
  createTaskSchema,
  configureTelegramSchema,
  configureDiscordSchema,
  createConversationSchema,
  idSchema,
  listLimitSchema,
  modelProviderSchema,
  sendConversationMessageSchema,
  sharedFolderPathSchema,
  updateConversationSchema,
} from "@shared/validation";
import type { DesktopAppService } from "@main/app/app-service";
import { createSupportBundle } from "@main/integrations/archives";
import { artifactFileStatus, resolveArtifactFile } from "@main/integrations/artifact-files";
import type { ApplicationLogger } from "@main/runtime/application-logger";
import type { CredentialStore } from "@main/security/credential-store";
import type { LoginStartup } from "@main/app/login-startup";
import type { AppUpdateChecker } from "@main/app/update-checker";

const mutationChannels = new Set<string>([
  ipcChannels.filesDelete,
  ipcChannels.filesZip,
  ipcChannels.updateSettings,
  ipcChannels.coworkersCreate,
  ipcChannels.coworkersUpdate,
  ipcChannels.coworkersRemove,
  ipcChannels.browserClearProfile,
  ipcChannels.conversationsCreate,
  ipcChannels.conversationsUpdate,
  ipcChannels.conversationsRemove,
  ipcChannels.conversationsArchive,
  ipcChannels.conversationsRestore,
  ipcChannels.conversationsSend,
  ipcChannels.conversationsContinueDiscussion,
  ipcChannels.conversationsStopDiscussion,
  ipcChannels.tasksCreate,
  ipcChannels.tasksCancel,
  ipcChannels.approvalsDecide,
  ipcChannels.artifactsRemove,
  ipcChannels.schedulesCreate,
  ipcChannels.schedulesUpdate,
  ipcChannels.schedulesRemove,
  ipcChannels.schedulesRunNow,
  ipcChannels.integrationsConfigureEmail,
  ipcChannels.integrationsConfigureModel,
  ipcChannels.integrationsAddModelEndpoint,
  ipcChannels.integrationsRemoveModelEndpoint,
  ipcChannels.integrationsRemoveCredential,
  ipcChannels.integrationsDisconnectModel,
  ipcChannels.integrationsConfigureWebSearch,
  ipcChannels.integrationsDisconnectWebSearch,
  ipcChannels.integrationsConfigureTelegram,
  ipcChannels.integrationsUnpairTelegram,
  ipcChannels.integrationsDisconnectTelegram,
  ipcChannels.integrationsConfigureDiscord,
  ipcChannels.integrationsUnpairDiscord,
  ipcChannels.integrationsDisconnectDiscord,
  ipcChannels.skillsInstallFromUrl,
  ipcChannels.skillsInstallFromContent,
  ipcChannels.skillsInstallFromPackage,
  ipcChannels.skillsRemove,
  ipcChannels.agentsRun,
  ipcChannels.agentsAbort,
]);

export function registerIpc(input: {
  service: DesktopAppService;
  credentials: CredentialStore;
  getMainWindow: () => BrowserWindow | null;
  logger?: ApplicationLogger;
  startup?: Pick<LoginStartup, "status" | "enable" | "disable">;
  updates: AppUpdateChecker;
}): () => void {
  const administration = createAdministration(input);
  const channels: string[] = [];
  const handle = (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ) => {
    channels.push(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      assertTrustedSender(event, input.getMainWindow());
      let finishMutation: (() => void) | null = null;
      try {
        if (mutationChannels.has(channel) && !administration.has(channel)) {
          finishMutation = input.service.beginDataMutation();
        }
        return await listener(event, ...args);
      } catch (error) {
        await input.logger?.error("ipc", error, { channel });
        throw error;
      } finally {
        finishMutation?.();
      }
    });
  };

  for (const channel of administration.channels) {
    handle(channel, (_event, ...args) => administration.invoke(channel, args));
  }

  handle(ipcChannels.agentsSnapshot, () => input.service.liveEvents.snapshot());
  handle(ipcChannels.bootstrap, () => input.service.snapshot());
  handle(ipcChannels.getUpdateState, () => input.updates.getState());
  handle(ipcChannels.checkForUpdates, () => input.updates.check(true));
  handle(ipcChannels.dismissUpdateNotice, () => input.updates.dismiss());
  // The renderer supplies no URL; only the verified release can be opened.
  handle(ipcChannels.openUpdateRelease, () => input.updates.openRelease());
  handle(ipcChannels.openDataFolder, async () => {
    await shell.openPath(input.service.snapshot().dataPath);
  });
  handle(ipcChannels.backup, async () => {
    const window = input.getMainWindow();
    const options = {
      title: "Back up Coworker",
      defaultPath: `Coworker-Backup-${new Date().toISOString().slice(0, 10)}.db`,
      filters: [{ name: "SQLite database", extensions: ["db"] }],
    };
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled) return null;
    return input.service.backup(result.filePath);
  });
  handle(ipcChannels.exportDataBackup, async () => {
    const window = input.getMainWindow();
    const options = {
      title: "Export all Coworker data",
      defaultPath: `Coworker-All-Data-${new Date().toISOString().slice(0, 10)}.zip`,
      filters: [{ name: "ZIP archive", extensions: ["zip"] }],
    };
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    return input.service.exportDataBackup(result.filePath);
  });
  handle(ipcChannels.copyText, (_event, text) => {
    if (typeof text !== "string" || text.length > 1_000_000) {
      throw new Error("Only text up to 1 MB can be copied");
    }
    clipboard.writeText(text);
  });

  handle(ipcChannels.browserClearProfile, (_event, id) =>
    input.service.clearCoworkerBrowserProfile(idSchema.parse(id)),
  );
  const dataPath = () => input.service.snapshot().dataPath;
  const fileOwner = (id: unknown) => input.service.database.getCoworker(idSchema.parse(id));
  handle(ipcChannels.filesRoots, (_event, id) => fileRoots(fileOwner(id)));
  handle(ipcChannels.filesList, (_event, id, ref) => listFiles(fileOwner(id), fileRefSchema.parse(ref), dataPath()));
  handle(ipcChannels.filesPreview, (_event, id, ref) => previewFile(fileOwner(id), fileRefSchema.parse(ref), dataPath()));
  handle(ipcChannels.filesOpen, async (_event, id, ref) => {
    const path = await resolveFile(fileOwner(id), fileRefSchema.parse(ref), dataPath());
    const error = await shell.openPath(path); if (error) throw new Error(error);
  });
  handle(ipcChannels.filesReveal, async (_event, id, ref) => shell.showItemInFolder(await resolveFile(fileOwner(id), fileRefSchema.parse(ref), dataPath())));
  async function saveDialog(name: string) {
    const options = { title: `Download ${name}`, defaultPath: basename(name), buttonLabel: 'Download' };
    const window = input.getMainWindow();
    return window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options);
  }
  handle(ipcChannels.filesDownload, async (_event, id, value) => {
    const ref = fileRefSchema.parse(value);
    const path = await resolveFile(fileOwner(id), ref, dataPath());
    if (!(await stat(path)).isFile()) throw new Error('Use Download ZIP to download folders');
    const result = await saveDialog(basename(path));
    if (result.canceled || !result.filePath) return null;
    const current = await resolveFile(fileOwner(id), ref, dataPath());
    if (resolve(result.filePath) !== current) await copyFile(current, result.filePath);
    return result.filePath;
  });
  handle(ipcChannels.filesZip, async (_event, id, value) => {
    const owner = fileOwner(id);
    const refs = z.array(fileRefSchema).min(1).max(100).parse(value);
    const result = await saveDialog('bundle.zip');
    if (result.canceled || !result.filePath) return null;
    const destination = result.filePath;
    await runSkillScript(input.service.database, dataPath(), owner.id,
      { skill: 'file-archiving', script: 'scripts/zip.js', inputs: refs, destination: { root: 'workspace', path: 'bundle.zip' }, options: {} },
      null, undefined, async files => {
        if (files.length !== 1) throw new Error('ZIP export must produce one file');
        const temporary = join(dirname(destination), `.coworker-download-${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, Buffer.from(files[0]!.data, 'base64'), { flag: 'wx', mode: 0o600 });
          await rename(temporary, destination);
        } finally { await unlink(temporary).catch(() => undefined); }
      });
    return result.filePath;
  });
  const deleteConfirmations = new FileDeleteConfirmations();
  const deletionOwners = new Set<string>();
  const watchedSenders = new Set<number>();
  handle(ipcChannels.filesPrepareDelete, async (event, id, value) => {
    const owner = fileOwner(id);
    const refs = z.array(fileRefSchema).min(1).max(100).parse(value);
    const key = `${event.sender.id}:${owner.id}`;
    deletionOwners.add(key);
    if (!watchedSenders.has(event.sender.id)) {
      const senderId = event.sender.id;
      watchedSenders.add(senderId);
      event.sender.once('destroyed', () => {
        for (const owner of deletionOwners) if (owner.startsWith(`${senderId}:`)) {
          deleteConfirmations.cancelOwner(owner); deletionOwners.delete(owner);
        }
        watchedSenders.delete(senderId);
      });
    }
    return deleteConfirmations.prepare(key, confirm => input.service.deleteFiles(owner.id, refs, confirm, path => shell.trashItem(path)));
  });
  handle(ipcChannels.filesDelete, async (event, id, token, confirmed) => {
    const owner = fileOwner(id);
    return deleteConfirmations.finish(`${event.sender.id}:${owner.id}`, z.string().uuid().parse(token), z.boolean().parse(confirmed));
  });

  handle(ipcChannels.foldersPick, async () => {
    const window = input.getMainWindow();
    const options = {
      title: "Choose folders to share",
      buttonLabel: "Choose folders",
      properties: ["openDirectory", "multiSelections", "dontAddToRecent"],
    } satisfies Electron.OpenDialogOptions;
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  });
  handle(ipcChannels.foldersReveal, async (_event, coworkerId, path) => {
    const coworker = input.service.database.getCoworker(idSchema.parse(coworkerId));
    const requestedPath = sharedFolderPathSchema.parse(path);
    const folder = coworker.sharedFolders.find((candidate) => candidate.path === requestedPath);
    if (!folder) {
      throw new Error("Only folders granted to this coworker can be opened from here");
    }
    const error = await shell.openPath(folder.path);
    if (error) throw new Error(`Could not open ${folder.path}: ${error}`);
  });

  handle(ipcChannels.conversationsList, (_event, coworkerId) =>
    input.service.database.listConversations(
      coworkerId === undefined ? undefined : idSchema.parse(coworkerId),
    ),
  );
  handle(ipcChannels.conversationsSearch, (_event, coworkerId, query) =>
    input.service.database.searchConversations(
      idSchema.parse(coworkerId),
      conversationSearchSchema.parse(query),
    ),
  );
  handle(ipcChannels.conversationsUpdate, (_event, id, value) =>
    input.service.updateConversation(
      idSchema.parse(id),
      updateConversationSchema.parse(value),
    ),
  );
  handle(ipcChannels.conversationsRemove, (_event, id) =>
    input.service.removeConversation(idSchema.parse(id)),
  );
  handle(ipcChannels.conversationsArchive, (_event, id) =>
    input.service.archiveConversation(idSchema.parse(id)),
  );
  handle(ipcChannels.conversationsRestore, (_event, id) =>
    input.service.restoreConversation(idSchema.parse(id)),
  );
  handle(ipcChannels.conversationsContinueDiscussion, (_event, id) =>
    input.service.continueDiscussion(idSchema.parse(id)),
  );
  handle(ipcChannels.conversationsStopDiscussion, (_event, id) =>
    input.service.stopDiscussion(idSchema.parse(id)),
  );

  handle(ipcChannels.tasksList, (_event, coworkerId) =>
    input.service.database.listTasks(
      coworkerId === undefined ? undefined : idSchema.parse(coworkerId),
    ),
  );
  handle(ipcChannels.tasksCreate, (_event, value) =>
    input.service.createTask(createTaskSchema.parse(value)),
  );
  handle(ipcChannels.tasksCancel, (_event, id) =>
    input.service.cancelTask(idSchema.parse(id)),
  );
  handle(ipcChannels.messagesList, (_event, coworkerId, taskId) =>
    input.service.database.listMessages(
      idSchema.parse(coworkerId),
      taskId === undefined ? undefined : idSchema.parse(taskId),
    ),
  );
  handle(ipcChannels.messagesListConversation, (_event, conversationId) =>
    input.service.database.listConversationMessages(
      idSchema.parse(conversationId),
      Number.MAX_SAFE_INTEGER,
    ),
  );

  handle(ipcChannels.artifactsStatus, (_event, id) =>
    artifactFileStatus(input.service.database, idSchema.parse(id)),
  );
  handle(ipcChannels.artifactsOpen, async (_event, id) => {
    const { artifact, path } = await resolveArtifactFile(
      input.service.database,
      idSchema.parse(id),
    );
    const error = await shell.openPath(path);
    if (error) throw new Error(`Could not open ${artifact.name}: ${error}`);
  });
  handle(ipcChannels.artifactsDownload, async (_event, id) => {
    const { artifact, path } = await resolveArtifactFile(
      input.service.database,
      idSchema.parse(id),
    );
    const extension = extname(artifact.name).slice(1);
    const options = {
      title: `Download ${artifact.name}`,
      defaultPath: basename(artifact.name),
      buttonLabel: "Download",
      filters: /^[a-z0-9]{1,12}$/i.test(extension)
        ? [{ name: `${extension.toUpperCase()} file`, extensions: [extension] }]
        : undefined,
    };
    const window = input.getMainWindow();
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    if (resolve(result.filePath) !== resolve(path)) {
      await copyFile(path, result.filePath);
    }
    return result.filePath;
  });
  handle(ipcChannels.artifactsRemove, (_event, id) =>
    input.service.deleteArtifact(idSchema.parse(id)),
  );
  handle(ipcChannels.imageAttachmentsRead, (_event, id) =>
    input.service.readImageAttachment(idSchema.parse(id)),
  );

  handle(ipcChannels.activityList, (_event, limit) =>
    input.service.database.listActivity(
      limit === undefined ? undefined : listLimitSchema.parse(limit),
    ),
  );
  handle(ipcChannels.diagnosticsProviderErrorsList, (_event, limit) =>
    input.service.providerErrors.list(
      limit === undefined ? undefined : listLimitSchema.parse(limit),
    ),
  );
  handle(ipcChannels.diagnosticsProviderReportCopy, async () => {
    const report = await input.service.providerErrors.report({
      "App version": app.getVersion(),
      Platform: `${process.platform} ${process.arch}`,
      Electron: process.versions.electron,
    });
    clipboard.writeText(report.text);
    return { count: report.count };
  });
  handle(ipcChannels.diagnosticsSupportBundleExport, async () => {
    const options = {
      title: "Download Coworker diagnostics",
      defaultPath: `Coworker-Diagnostics-${new Date().toISOString().slice(0, 10)}.zip`,
      filters: [{ name: "ZIP archive", extensions: ["zip"] }],
    };
    const window = input.getMainWindow();
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    if (!input.logger) {
      throw new Error("Application diagnostics are not available");
    }
    return createSupportBundle({
      destinationPath: result.filePath,
      logger: input.logger,
      providerLogger: input.service.providerErrors,
      metadata: {
        "App version": app.getVersion(),
        Platform: `${process.platform} ${process.arch}`,
        Electron: process.versions.electron,
        Node: process.versions.node,
      },
    });
  });
  handle(ipcChannels.integrationsList, () => input.service.database.listIntegrations());
  handle(ipcChannels.integrationsConfigureEmail, (_event, value) =>
    input.service.configureEmail(configureEmailSchema.parse(value)),
  );

  handle(ipcChannels.integrationsModelCapabilities, (_event, provider, modelId) =>
    input.service.modelCapabilities(
      modelProviderSchema.parse(provider),
      idSchema.parse(modelId),
    ),
  );

  handle(ipcChannels.integrationsConfigureWebSearch, (_event, value) =>
    input.service.configureWebSearch(configureWebSearchSchema.parse(value)),
  );
  handle(ipcChannels.integrationsConfigureTelegram, (_event, value) =>
    input.service.configureTelegram(configureTelegramSchema.parse(value)),
  );
  handle(ipcChannels.integrationsTelegramStatus, () => input.service.telegramStatus());
  handle(ipcChannels.integrationsUnpairTelegram, (_event, integrationId) => input.service.unpairTelegram(idSchema.parse(integrationId)));
  handle(ipcChannels.integrationsDisconnectTelegram, (_event, integrationId) =>
    input.service.disconnectTelegram(idSchema.parse(integrationId)),
  );
  handle(ipcChannels.integrationsConfigureDiscord, (_event, value) =>
    input.service.configureDiscord(configureDiscordSchema.parse(value)),
  );
  handle(ipcChannels.integrationsDiscordStatus, () => input.service.discordStatus());
  handle(ipcChannels.integrationsUnpairDiscord, (_event, integrationId) => input.service.unpairDiscord(idSchema.parse(integrationId)));
  handle(ipcChannels.integrationsDisconnectDiscord, (_event, integrationId) =>
    input.service.disconnectDiscord(idSchema.parse(integrationId)),
  );

  handle(ipcChannels.agentsRun, (_event, value) =>
    input.service.runAgent(agentRunRequestSchema.parse(value) as unknown as AgentRunRequest),
  );
  handle(ipcChannels.agentsAbort, async (_event, coworkerId, runId) => {
    await input.service.runtime.abort(idSchema.parse(coworkerId), idSchema.parse(runId));
  });

  const unsubscribe = input.service.subscribe((event) => {
    const window = input.getMainWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.send(ipcChannels.event, event);
    }
  });
  const unsubscribeUpdates = input.updates.subscribe((state) => {
    const window = input.getMainWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.send(ipcChannels.event, { type: "app.update", state });
    }
  });

  return () => {
    deleteConfirmations.dispose();
    unsubscribe();
    unsubscribeUpdates();
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}

function assertTrustedSender(
  event: IpcMainInvokeEvent,
  window: BrowserWindow | null,
): void {
  if (!window || window.isDestroyed() || event.sender.id !== window.webContents.id) {
    throw new Error("Rejected IPC from an unknown renderer");
  }
  if (event.senderFrame !== event.sender.mainFrame) {
    throw new Error("Rejected IPC from a child frame");
  }
  const url = new URL(event.senderFrame.url);
  const devServer = process.env.ELECTRON_RENDERER_URL;
  const allowed =
    (url.protocol === "file:" && !devServer) ||
    (devServer !== undefined && url.origin === new URL(devServer).origin);
  if (!allowed) throw new Error(`Rejected IPC from untrusted origin: ${url.origin}`);
}
