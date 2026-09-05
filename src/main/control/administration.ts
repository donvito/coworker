import * as validation from "@shared/validation";
import { ipcChannels } from "@shared/ipc";
import type { DesktopAppService } from "@main/app/app-service";
import type { CredentialStore } from "@main/security/credential-store";
import { modelProviderDefinitions } from "@shared/model-providers";

const { addModelEndpointSchema, approvalDecisionSchema, approvalStatusSchema, configureModelSchema, createCoworkerSchema, createScheduleSchema, credentialKeySchema, idSchema, installSkillContentSchema, installSkillPackageSchema, installSkillUrlSchema, modelProviderSchema, remoteModelProviderSchema, settingsPatchSchema, updateCoworkerSchema, updateScheduleSchema } = validation;

export function createAdministration(input: { service: DesktopAppService; credentials: CredentialStore }) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>([
    [ipcChannels.conversationsCreate, (value) => input.service.createConversation(validation.createConversationSchema.parse(value))],
    [ipcChannels.conversationsSend, (value) => input.service.sendConversationMessage(validation.sendConversationMessageSchema.parse(value))],
    ["conversations.show", (id) => input.service.database.getConversation(validation.idSchema.parse(id))],
    ["tasks.show", (id) => {
      const task = input.service.database.getTask(validation.idSchema.parse(id));
      return { task, conversationId: task.sourceMessageId ? input.service.database.findMessage(task.sourceMessageId)?.conversationId ?? null : null,
        toolCalls: input.service.database.listToolCalls(task.id).map(({ id, toolName, status }) => ({ id, toolName, status })),
        approvals: input.service.listApprovals("PENDING").filter((item) => item.taskId === task.id) };
    }],
    [ipcChannels.getSettings, () => input.service.database.getSettings()],
    [ipcChannels.updateSettings, (patch) =>
    input.service.updateSettings(settingsPatchSchema.parse(patch))],
    [ipcChannels.coworkersList, () => input.service.database.listCoworkers()],
    [ipcChannels.coworkersCreate, (value) =>
    input.service.createCoworker(createCoworkerSchema.parse(value))],
    [ipcChannels.coworkersUpdate, (id, value) =>
    input.service.updateCoworker(
      idSchema.parse(id),
      updateCoworkerSchema.parse(value),
    )],
    [ipcChannels.coworkersRemove, (id) =>
    input.service.removeCoworker(idSchema.parse(id))],
    [ipcChannels.approvalsList, (status) =>
    input.service.listApprovals(
      status === undefined ? undefined : approvalStatusSchema.parse(status),
    )],
    [ipcChannels.approvalsDecide, (value) =>
    input.service.decideApproval(approvalDecisionSchema.parse(value))],
    [ipcChannels.schedulesList, () => input.service.database.listSchedules()],
    [ipcChannels.schedulesCreate, (value) =>
    input.service.createSchedule(createScheduleSchema.parse(value))],
    [ipcChannels.schedulesUpdate, (id, value) =>
    input.service.updateSchedule(
      idSchema.parse(id),
      updateScheduleSchema.parse(value),
    )],
    [ipcChannels.schedulesRemove, (id) => {
    input.service.removeSchedule(idSchema.parse(id));
  }],
    [ipcChannels.schedulesRunNow, (id) =>
    input.service.runScheduleNow(idSchema.parse(id))],
    [ipcChannels.integrationsConfigureModel, (value) =>
    input.service.configureModel(configureModelSchema.parse(value))],
    [ipcChannels.integrationsAddModelEndpoint, (value) =>
    input.service.addModelEndpoint(addModelEndpointSchema.parse(value))],
    [ipcChannels.integrationsRemoveModelEndpoint, (id) =>
    input.service.removeModelEndpoint(remoteModelProviderSchema.parse(id))],
    [ipcChannels.integrationsListModels, (provider) =>
    input.service.listModels(modelProviderSchema.parse(provider))],
    [ipcChannels.integrationsCredentialStatus, async (key) => {
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
  }],
    [ipcChannels.integrationsRemoveCredential, async (key) => {
    await input.credentials.delete(credentialKeySchema.parse(key));
  }],
    [ipcChannels.skillsList, () => input.service.database.listSkills()],
    [ipcChannels.skillsInstallFromUrl, (value) => {
    const parsed = installSkillUrlSchema.parse(value);
    return input.service.installSkillFromUrl(parsed.url, parsed.coworkerId);
  }],
    [ipcChannels.skillsInstallFromContent, (value) => {
    const parsed = installSkillContentSchema.parse(value);
    return input.service.installSkillFromContent(parsed.content, parsed.coworkerId);
  }],
    [ipcChannels.skillsInstallFromPackage, (value) => {
    const parsed = installSkillPackageSchema.parse(value);
    return input.service.installSkillFromPackage(
      parsed.fileName,
      parsed.dataBase64,
      parsed.coworkerId,
    );
  }],
    [ipcChannels.skillsRemove, (id) =>
    input.service.removeSkill(idSchema.parse(id))],
    ["models.providers", async () => ({
      providers: await Promise.all(modelProviderDefinitions.map(async (provider) => ({
        ...provider,
        credentialStatus: input.credentials.status ? await input.credentials.status(`model:${provider.id}`) :
          await input.credentials.has(`model:${provider.id}`) ? "configured" : "missing",
      }))),
      endpoints: input.service.database.listModelEndpoints(),
      settings: input.service.database.getSettings(),
    })],
    ["telegram.status", () => input.service.telegramStatus()],
    ["telegram.configure", (value) => input.service.configureTelegram(validation.configureTelegramSchema.parse(value))],
    ["telegram.unpair", () => input.service.unpairTelegram()],
    ["telegram.disconnect", () => input.service.disconnectTelegram()],
    ["activity.list", (limit) => input.service.database.listActivity(limit === undefined ? 50 : Number(limit))],
    ["coworkers.show", (id) => input.service.database.getCoworker(validation.idSchema.parse(id))],
    ["skills.show", (id) => input.service.database.getSkill(validation.idSchema.parse(id))],
    ["schedules.show", (id) => input.service.database.getSchedule(validation.idSchema.parse(id))],
    ["approvals.show", (id) => input.service.database.getApproval(validation.idSchema.parse(id))],
    ["skills.assign", async (id, coworkerId, enabled) => {
      const skill = input.service.database.getSkill(validation.idSchema.parse(id));
      const coworker = input.service.database.getCoworker(validation.idSchema.parse(coworkerId));
      if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
      const ids = new Set(coworker.enabledSkillIds);
      if (enabled) ids.add(skill.id); else ids.delete(skill.id);
      return input.service.updateCoworker(coworker.id, { enabledSkillIds: [...ids] });
    }],
  ]);
  const reads = new Set<string>([
    ipcChannels.getSettings, ipcChannels.coworkersList, ipcChannels.approvalsList,
    ipcChannels.schedulesList, ipcChannels.integrationsListModels,
    ipcChannels.integrationsCredentialStatus, ipcChannels.skillsList,
    "models.providers", "coworkers.show", "skills.show", "schedules.show", "approvals.show",
    "conversations.show", "tasks.show",
  ]);
  return {
    channels: [...handlers.keys()].filter((name) => name.startsWith("coworker:")),
    has: (method: string) => handlers.has(method),
    async invoke(method: string, args: unknown[]): Promise<unknown> {
      const handler = handlers.get(method);
      if (!handler) throw new Error("Unknown administration method");
      const finish = reads.has(method) ? undefined : input.service.beginDataMutation();
      try { return (await handler(...args)) ?? null; }
      finally { finish?.(); }
    },
  };
}
