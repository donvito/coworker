import { copyFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
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
  addModelEndpointSchema,
  agentRunRequestSchema,
  approvalDecisionSchema,
  approvalStatusSchema,
  configureEmailSchema,
  configureModelSchema,
  configureWebSearchSchema,
  credentialKeySchema,
  conversationSearchSchema,
  createCoworkerSchema,
  createScheduleSchema,
  createTaskSchema,
  configureTelegramSchema,
  createConversationSchema,
  idSchema,
  installSkillUrlSchema,
  installSkillContentSchema,
  installSkillPackageSchema,
  listLimitSchema,
  modelProviderSchema,
  remoteModelProviderSchema,
  settingsPatchSchema,
  sendConversationMessageSchema,
  sharedFolderPathSchema,
  updateConversationSchema,
  updateCoworkerSchema,
  updateScheduleSchema,
} from "@shared/validation";
import type { DesktopAppService } from "@main/app/app-service";
import { createSupportBundle } from "@main/integrations/archives";
import { resolveArtifactFile } from "@main/integrations/artifact-files";
import type { ApplicationLogger } from "@main/runtime/application-logger";
import type { CredentialStore } from "@main/security/credential-store";

const mutationChannels = new Set<string>([
  ipcChannels.updateSettings,
  ipcChannels.coworkersCreate,
  ipcChannels.coworkersUpdate,
  ipcChannels.coworkersRemove,
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
  ipcChannels.integrationsConfigureWebSearch,
  ipcChannels.integrationsConfigureTelegram,
  ipcChannels.integrationsUnpairTelegram,
  ipcChannels.integrationsDisconnectTelegram,
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
}): () => void {
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
        if (mutationChannels.has(channel)) {
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

  handle(ipcChannels.bootstrap, () => input.service.snapshot());
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
  handle(ipcChannels.getSettings, () => input.service.database.getSettings());
  handle(ipcChannels.updateSettings, (_event, patch) =>
    input.service.updateSettings(settingsPatchSchema.parse(patch)),
  );

  handle(ipcChannels.coworkersList, () => input.service.database.listCoworkers());
  handle(ipcChannels.coworkersCreate, (_event, value) =>
    input.service.createCoworker(createCoworkerSchema.parse(value)),
  );
  handle(ipcChannels.coworkersUpdate, (_event, id, value) =>
    input.service.updateCoworker(
      idSchema.parse(id),
      updateCoworkerSchema.parse(value),
    ),
  );
  handle(ipcChannels.coworkersRemove, (_event, id) =>
    input.service.removeCoworker(idSchema.parse(id)),
  );
  handle(ipcChannels.foldersPick, async () => {
    const window = input.getMainWindow();
    const options = {
      title: "Grant read-only folder access",
      buttonLabel: "Grant read-only access",
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
  handle(ipcChannels.conversationsCreate, (_event, value) =>
    input.service.createConversation(createConversationSchema.parse(value)),
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
  handle(ipcChannels.conversationsSend, (_event, value) =>
    input.service.sendConversationMessage(sendConversationMessageSchema.parse(value)),
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

  handle(ipcChannels.approvalsList, (_event, status) =>
    input.service.listApprovals(
      status === undefined ? undefined : approvalStatusSchema.parse(status),
    ),
  );
  handle(ipcChannels.approvalsDecide, (_event, value) =>
    input.service.decideApproval(approvalDecisionSchema.parse(value)),
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

  handle(ipcChannels.schedulesList, () => input.service.database.listSchedules());
  handle(ipcChannels.schedulesCreate, (_event, value) =>
    input.service.createSchedule(createScheduleSchema.parse(value)),
  );
  handle(ipcChannels.schedulesUpdate, (_event, id, value) =>
    input.service.updateSchedule(
      idSchema.parse(id),
      updateScheduleSchema.parse(value),
    ),
  );
  handle(ipcChannels.schedulesRemove, (_event, id) => {
    input.service.removeSchedule(idSchema.parse(id));
  });
  handle(ipcChannels.schedulesRunNow, (_event, id) =>
    input.service.runScheduleNow(idSchema.parse(id)),
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
  handle(ipcChannels.integrationsConfigureModel, (_event, value) =>
    input.service.configureModel(configureModelSchema.parse(value)),
  );
  handle(ipcChannels.integrationsAddModelEndpoint, (_event, value) =>
    input.service.addModelEndpoint(addModelEndpointSchema.parse(value)),
  );
  handle(ipcChannels.integrationsRemoveModelEndpoint, (_event, id) =>
    input.service.removeModelEndpoint(remoteModelProviderSchema.parse(id)),
  );
  handle(ipcChannels.integrationsListModels, (_event, provider) =>
    input.service.listModels(modelProviderSchema.parse(provider)),
  );
  handle(ipcChannels.integrationsModelCapabilities, (_event, provider, modelId) =>
    input.service.modelCapabilities(
      modelProviderSchema.parse(provider),
      idSchema.parse(modelId),
    ),
  );
  handle(ipcChannels.integrationsCredentialStatus, async (_event, key) => {
    const credentialKey = credentialKeySchema.parse(key);
    const status = input.credentials.status
      ? await input.credentials.status(credentialKey)
      : (await input.credentials.has(credentialKey))
        ? "configured"
        : "missing";
    return {
      key: credentialKey,
      configured: status === "configured",
      needsReentry: status === "unreadable",
    };
  });
  handle(ipcChannels.integrationsRemoveCredential, async (_event, key) => {
    await input.credentials.delete(credentialKeySchema.parse(key));
  });
  handle(ipcChannels.integrationsConfigureWebSearch, (_event, value) =>
    input.service.configureWebSearch(configureWebSearchSchema.parse(value)),
  );
  handle(ipcChannels.integrationsConfigureTelegram, (_event, value) =>
    input.service.configureTelegram(configureTelegramSchema.parse(value)),
  );
  handle(ipcChannels.integrationsTelegramStatus, () => input.service.telegramStatus());
  handle(ipcChannels.integrationsUnpairTelegram, () => input.service.unpairTelegram());
  handle(ipcChannels.integrationsDisconnectTelegram, () =>
    input.service.disconnectTelegram(),
  );

  handle(ipcChannels.skillsList, () => input.service.database.listSkills());
  handle(ipcChannels.skillsInstallFromUrl, (_event, value) => {
    const parsed = installSkillUrlSchema.parse(value);
    return input.service.installSkillFromUrl(parsed.url, parsed.coworkerId);
  });
  handle(ipcChannels.skillsInstallFromContent, (_event, value) => {
    const parsed = installSkillContentSchema.parse(value);
    return input.service.installSkillFromContent(parsed.content, parsed.coworkerId);
  });
  handle(ipcChannels.skillsInstallFromPackage, (_event, value) => {
    const parsed = installSkillPackageSchema.parse(value);
    return input.service.installSkillFromPackage(
      parsed.fileName,
      parsed.dataBase64,
      parsed.coworkerId,
    );
  });
  handle(ipcChannels.skillsRemove, (_event, id) =>
    input.service.removeSkill(idSchema.parse(id)),
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

  return () => {
    unsubscribe();
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
