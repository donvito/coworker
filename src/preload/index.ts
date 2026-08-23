import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, DesktopEvent } from "@shared/contracts";
import { ipcChannels } from "@shared/ipc";

const api: DesktopApi = {
  app: {
    bootstrap: () => ipcRenderer.invoke(ipcChannels.bootstrap),
    openDataFolder: () => ipcRenderer.invoke(ipcChannels.openDataFolder),
    backup: () => ipcRenderer.invoke(ipcChannels.backup),
    getSettings: () => ipcRenderer.invoke(ipcChannels.getSettings),
    updateSettings: (settings) => ipcRenderer.invoke(ipcChannels.updateSettings, settings),
  },
  coworkers: {
    list: () => ipcRenderer.invoke(ipcChannels.coworkersList),
    create: (input) => ipcRenderer.invoke(ipcChannels.coworkersCreate, input),
    update: (id, input) => ipcRenderer.invoke(ipcChannels.coworkersUpdate, id, input),
    remove: (id) => ipcRenderer.invoke(ipcChannels.coworkersRemove, id),
  },
  conversations: {
    list: (coworkerId) => ipcRenderer.invoke(ipcChannels.conversationsList, coworkerId),
    create: (input) => ipcRenderer.invoke(ipcChannels.conversationsCreate, input),
  },
  tasks: {
    list: (coworkerId) => ipcRenderer.invoke(ipcChannels.tasksList, coworkerId),
    create: (input) => ipcRenderer.invoke(ipcChannels.tasksCreate, input),
    cancel: (id) => ipcRenderer.invoke(ipcChannels.tasksCancel, id),
  },
  messages: {
    list: (coworkerId, taskId) =>
      ipcRenderer.invoke(ipcChannels.messagesList, coworkerId, taskId),
  },
  approvals: {
    list: (status) => ipcRenderer.invoke(ipcChannels.approvalsList, status),
    decide: (input) => ipcRenderer.invoke(ipcChannels.approvalsDecide, input),
  },
  artifacts: {
    open: (id) => ipcRenderer.invoke(ipcChannels.artifactsOpen, id),
    download: (id) => ipcRenderer.invoke(ipcChannels.artifactsDownload, id),
    remove: (id) => ipcRenderer.invoke(ipcChannels.artifactsRemove, id),
  },
  imageAttachments: {
    read: (id) => ipcRenderer.invoke(ipcChannels.imageAttachmentsRead, id),
  },
  schedules: {
    list: () => ipcRenderer.invoke(ipcChannels.schedulesList),
    create: (input) => ipcRenderer.invoke(ipcChannels.schedulesCreate, input),
    update: (id, input) => ipcRenderer.invoke(ipcChannels.schedulesUpdate, id, input),
    remove: (id) => ipcRenderer.invoke(ipcChannels.schedulesRemove, id),
    runNow: (id) => ipcRenderer.invoke(ipcChannels.schedulesRunNow, id),
  },
  activity: {
    list: (limit) => ipcRenderer.invoke(ipcChannels.activityList, limit),
  },
  diagnostics: {
    listProviderErrors: (limit) =>
      ipcRenderer.invoke(ipcChannels.diagnosticsProviderErrorsList, limit),
    copyProviderReport: () => ipcRenderer.invoke(ipcChannels.diagnosticsProviderReportCopy),
    exportProviderReport: () => ipcRenderer.invoke(ipcChannels.diagnosticsProviderReportExport),
  },
  integrations: {
    list: () => ipcRenderer.invoke(ipcChannels.integrationsList),
    configureEmail: (input) =>
      ipcRenderer.invoke(ipcChannels.integrationsConfigureEmail, input),
    configureModel: (input) =>
      ipcRenderer.invoke(ipcChannels.integrationsConfigureModel, input),
    listModels: (provider) =>
      ipcRenderer.invoke(ipcChannels.integrationsListModels, provider),
    modelCapabilities: (provider, modelId) =>
      ipcRenderer.invoke(ipcChannels.integrationsModelCapabilities, provider, modelId),
    credentialStatus: (key) =>
      ipcRenderer.invoke(ipcChannels.integrationsCredentialStatus, key),
    removeCredential: (key) =>
      ipcRenderer.invoke(ipcChannels.integrationsRemoveCredential, key),
    configureWebSearch: (input) =>
      ipcRenderer.invoke(ipcChannels.integrationsConfigureWebSearch, input),
  },
  skills: {
    list: () => ipcRenderer.invoke(ipcChannels.skillsList),
    installFromUrl: (url, coworkerId) =>
      ipcRenderer.invoke(ipcChannels.skillsInstallFromUrl, { url, coworkerId }),
    installFromContent: (content, coworkerId) =>
      ipcRenderer.invoke(ipcChannels.skillsInstallFromContent, { content, coworkerId }),
    installFromPackage: (fileName, dataBase64, coworkerId) =>
      ipcRenderer.invoke(ipcChannels.skillsInstallFromPackage, {
        fileName,
        dataBase64,
        coworkerId,
      }),
    remove: (id) => ipcRenderer.invoke(ipcChannels.skillsRemove, id),
  },
  agents: {
    run: (request) => ipcRenderer.invoke(ipcChannels.agentsRun, request),
    abort: (coworkerId, runId) =>
      ipcRenderer.invoke(ipcChannels.agentsAbort, coworkerId, runId),
  },
  events: {
    subscribe: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: DesktopEvent) => listener(payload);
      ipcRenderer.on(ipcChannels.event, wrapped);
      return () => ipcRenderer.removeListener(ipcChannels.event, wrapped);
    },
  },
};

contextBridge.exposeInMainWorld("coworker", api);
