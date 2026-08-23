import { copyFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import {
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import { ipcChannels } from "@shared/ipc";
import type { AgentRunRequest } from "@shared/contracts";
import {
  agentRunRequestSchema,
  approvalDecisionSchema,
  approvalStatusSchema,
  configureEmailSchema,
  configureModelSchema,
  credentialKeySchema,
  createCoworkerSchema,
  createScheduleSchema,
  createTaskSchema,
  idSchema,
  listLimitSchema,
  modelProviderSchema,
  settingsPatchSchema,
  updateCoworkerSchema,
  updateScheduleSchema,
} from "@shared/validation";
import type { DesktopAppService } from "@main/app/app-service";
import { resolveArtifactFile } from "@main/integrations/artifact-files";
import type { CredentialStore } from "@main/security/credential-store";

export function registerIpc(input: {
  service: DesktopAppService;
  credentials: CredentialStore;
  getMainWindow: () => BrowserWindow | null;
}): () => void {
  const channels: string[] = [];
  const handle = (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ) => {
    channels.push(channel);
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedSender(event, input.getMainWindow());
      return listener(event, ...args);
    });
  };

  handle(ipcChannels.bootstrap, () => input.service.snapshot());
  handle(ipcChannels.openDataFolder, async () => {
    await shell.openPath(input.service.snapshot().dataPath);
  });
  handle(ipcChannels.backup, async () => {
    const window = input.getMainWindow();
    const options = {
      title: "Back up AI Coworker",
      defaultPath: `AI-Coworker-Backup-${new Date().toISOString().slice(0, 10)}.db`,
      filters: [{ name: "SQLite database", extensions: ["db"] }],
    };
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled) return null;
    return input.service.backup(result.filePath);
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
  handle(ipcChannels.integrationsList, () => input.service.database.listIntegrations());
  handle(ipcChannels.integrationsConfigureEmail, (_event, value) =>
    input.service.configureEmail(configureEmailSchema.parse(value)),
  );
  handle(ipcChannels.integrationsConfigureModel, (_event, value) =>
    input.service.configureModel(configureModelSchema.parse(value)),
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
    return { key: credentialKey, configured: await input.credentials.has(credentialKey) };
  });
  handle(ipcChannels.integrationsRemoveCredential, async (_event, key) => {
    await input.credentials.delete(credentialKeySchema.parse(key));
  });

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
