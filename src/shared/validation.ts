import { z } from "zod";
import {
  appThemes,
  approvalStatuses,
  modelProviders,
  remoteModelProviders,
  toolPolicies,
  webSearchProviders,
  type RemoteModelProvider,
  type WebSearchProvider,
} from "./contracts";

const identifier = z.string().min(1).max(128);
const optionalText = z.string().trim().max(10_000).optional();
const policyRecord = z.record(z.string().min(1).max(128), z.enum(toolPolicies));
const maxImageBytes = 8 * 1024 * 1024;
const maxImagesTotalBytes = 20 * 1024 * 1024;
const maxImageBase64Length = Math.ceil(maxImageBytes / 3) * 4;
const maxImagesTotalBase64Length = Math.ceil(maxImagesTotalBytes / 3) * 4;

export const idSchema = identifier;
export const modelProviderSchema = z.enum(modelProviders);
export const sharedFolderPathSchema = z.string().trim().min(1).max(1_000);

export const createCoworkerSchema = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.string().trim().min(1).max(120),
  description: optionalText,
  systemPrompt: z.string().trim().min(1).max(50_000),
  modelProvider: modelProviderSchema,
  modelName: z.string().trim().min(1).max(160),
  enabledTools: z.array(z.string().min(1).max(128)).max(50),
  enabledSkillIds: z.array(identifier).max(100).optional(),
  policies: policyRecord.optional(),
  sharedFolderPaths: z.array(z.string().trim().min(1).max(1_000)).max(20).optional(),
});

export const updateCoworkerSchema = createCoworkerSchema
  .partial()
  .extend({
    description: z.string().trim().max(10_000).nullable().optional(),
    status: z.enum(["active", "paused"]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const createTaskSchema = z.object({
  coworkerId: identifier,
  title: z.string().trim().min(1).max(240),
  input: z.string().trim().min(1).max(100_000),
  priority: z.number().int().min(-100).max(100).optional(),
  source: z.enum(["manual", "schedule", "recovery"]).optional(),
  scheduleId: identifier.optional(),
  runId: identifier.optional(),
  threadId: identifier.optional(),
});

export const createConversationSchema = z
  .object({
    coworkerId: identifier.optional(),
    kind: z.enum(["direct", "group"]).optional(),
    memberIds: z.array(identifier).min(1).max(50).optional(),
    title: z.string().trim().min(1).max(160).optional(),
  })
  .superRefine((value, context) => {
    const members = [...new Set([...(value.memberIds ?? []), ...(value.coworkerId ? [value.coworkerId] : [])])];
    const kind = value.kind ?? (members.length > 1 ? "group" : "direct");
    if (kind === "direct" && members.length !== 1) {
      context.addIssue({
        code: "custom",
        message: "A direct conversation must have exactly one coworker",
        path: ["memberIds"],
      });
    }
    if (kind === "group" && members.length < 2) {
      context.addIssue({
        code: "custom",
        message: "A group conversation must have at least two coworkers",
        path: ["memberIds"],
      });
    }
  });

export const updateConversationSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    memberIds: z.array(identifier).min(1).max(50).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

const conversationImageSchema = z.object({
  data: z.string().min(4).max(maxImageBase64Length),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
  name: z.string().trim().min(1).max(180),
  size: z.number().int().positive().max(maxImageBytes),
});

export const sendConversationMessageSchema = z
  .object({
    conversationId: identifier,
    clientMessageId: identifier,
    content: z.string().trim().max(100_000),
    mentionedCoworkerIds: z.array(identifier).max(50),
    images: z.array(conversationImageSchema).max(4).optional(),
  })
  .superRefine((value, context) => {
    if (!value.content && !value.images?.length) {
      context.addIssue({ code: "custom", message: "A message or image is required" });
    }
    if (new Set(value.mentionedCoworkerIds).size !== value.mentionedCoworkerIds.length) {
      context.addIssue({
        code: "custom",
        message: "Mentioned coworkers must be unique",
        path: ["mentionedCoworkerIds"],
      });
    }
    const totalLength = (value.images ?? []).reduce((sum, image) => sum + image.data.length, 0);
    if (totalLength > maxImagesTotalBase64Length) {
      context.addIssue({ code: "custom", message: "Attached images must be 20 MB or smaller in total" });
    }
  });

export const conversationSearchSchema = z.string().trim().min(1).max(500);

export const approvalDecisionSchema = z.object({
  approvalId: identifier,
  decision: z.enum(["approve", "reject", "edit"]),
  payload: z.unknown().optional(),
});

const taskTemplateSchema = z.object({
  title: z.string().trim().min(1).max(240),
  input: z.string().trim().min(1).max(100_000),
  priority: z.number().int().min(-100).max(100).optional(),
});

export const createScheduleSchema = z
  .object({
    coworkerId: identifier,
    name: z.string().trim().min(1).max(160),
    scheduleType: z.enum(["cron", "once"]),
    cronExpression: z.string().trim().min(1).max(160).optional(),
    runAt: z.string().datetime({ offset: true }).optional(),
    timezone: z.string().trim().min(1).max(120),
    taskTemplate: taskTemplateSchema,
    enabled: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    if (value.scheduleType === "cron" && !value.cronExpression) {
      context.addIssue({
        code: "custom",
        message: "A cron expression is required for recurring schedules",
        path: ["cronExpression"],
      });
    }
    if (value.scheduleType === "once" && !value.runAt) {
      context.addIssue({
        code: "custom",
        message: "A run time is required for one-time schedules",
        path: ["runAt"],
      });
    }
  });

export const updateScheduleSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    scheduleType: z.enum(["cron", "once"]).optional(),
    cronExpression: z.string().trim().min(1).max(160).nullable().optional(),
    runAt: z.string().datetime({ offset: true }).nullable().optional(),
    timezone: z.string().trim().min(1).max(120).optional(),
    taskTemplate: taskTemplateSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

const aguiImageContentSchema = z.object({
  type: z.literal("image"),
  source: z.object({
    type: z.literal("data"),
    value: z.string().min(4).max(maxImageBase64Length),
    mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
  }),
  metadata: z
    .object({
      name: z.string().trim().min(1).max(180).optional(),
      size: z.number().int().positive().max(maxImageBytes).optional(),
    })
    .optional(),
});

const aguiUserContentSchema = z
  .union([
    z.string().max(100_000),
    z
      .array(
        z.discriminatedUnion("type", [
          z.object({ type: z.literal("text"), text: z.string().max(100_000) }),
          aguiImageContentSchema,
        ]),
      )
      .min(1)
      .max(8),
  ])
  .superRefine((content, context) => {
    if (!Array.isArray(content)) return;
    const images = content.filter((part) => part.type === "image");
    if (images.length > 4) {
      context.addIssue({
        code: "custom",
        message: "Attach no more than 4 images at a time",
      });
    }
    const totalLength = images.reduce((sum, image) => sum + image.source.value.length, 0);
    if (totalLength > maxImagesTotalBase64Length) {
      context.addIssue({
        code: "custom",
        message: "Attached images must be 20 MB or smaller in total",
      });
    }
  });

const aguiUserMessageSchema = z
  .object({
    id: identifier,
    role: z.literal("user"),
    content: aguiUserContentSchema,
  })
  .passthrough();

const aguiOtherMessageSchema = z
  .object({
    id: identifier,
    role: z.enum(["developer", "system", "assistant", "tool", "activity", "reasoning"]),
    content: z.unknown().optional(),
  })
  .passthrough();

export const agentRunRequestSchema = z.object({
  coworkerId: identifier,
  input: z
    .object({
      threadId: identifier,
      runId: identifier,
      parentRunId: identifier.optional(),
      state: z.unknown(),
      messages: z.array(z.union([aguiUserMessageSchema, aguiOtherMessageSchema])).max(500),
      tools: z.array(z.unknown()).max(100).optional(),
      context: z.array(z.unknown()).max(100).optional(),
      forwardedProps: z.unknown().optional(),
      resume: z.array(z.unknown()).max(20).optional(),
    })
    .passthrough(),
});

export const settingsPatchSchema = z
  .object({
    runInBackground: z.boolean().optional(),
    launchAtLogin: z.boolean().optional(),
    demoMode: z.boolean().optional(),
    theme: z.enum(appThemes).optional(),
    showReasoning: z.boolean().optional(),
    globalOperatingInstructions: z.string().trim().max(50_000).optional(),
    defaultModelProvider: z.enum(remoteModelProviders).nullable().optional(),
    defaultModelName: z.string().trim().min(1).max(160).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one setting is required");

export const configureEmailSchema = z.object({
  name: z.string().trim().min(1).max(120),
  mode: z.enum(["local-outbox", "resend"]),
  apiKey: z.string().trim().min(1).max(1_000).optional(),
  fromAddress: z.string().email().optional(),
});

const modelBaseUrlSchema = z
  .string()
  .trim()
  .max(2_048)
  .url()
  .superRefine((value, context) => {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
      context.addIssue({ code: "custom", message: "Model URL must use HTTP or HTTPS" });
    }
    if (url.username || url.password) {
      context.addIssue({
        code: "custom",
        message: "Put credentials in the API key field, not in the model URL",
      });
    }
  });

export const configureModelSchema = z
  .object({
    provider: z.enum(remoteModelProviders),
    apiKey: z.string().trim().max(2_000).optional(),
    baseUrl: modelBaseUrlSchema.optional(),
    defaultModelName: z.string().trim().min(1).max(160).optional(),
  })
  .superRefine((value, context) => {
    if (value.provider === "openai-compatible" && !value.baseUrl) {
      context.addIssue({
        code: "custom",
        message: "A base URL is required for an OpenAI-compatible provider",
        path: ["baseUrl"],
      });
    }
  });

export const configureWebSearchSchema = z.object({
  provider: z.enum(webSearchProviders),
  apiKey: z.string().trim().min(1).max(2_000),
});

export const installSkillUrlSchema = z.object({
  url: z.string().trim().url().max(2_048),
  coworkerId: identifier.optional(),
});

export const installSkillContentSchema = z.object({
  content: z.string().min(1).max(1_000_000),
  coworkerId: identifier.optional(),
});

export const installSkillPackageSchema = z.object({
  fileName: z.string().trim().min(1).max(240).regex(/\.(?:skill|zip)$/i),
  dataBase64: z.string().min(4).max(14_000_000).regex(/^[A-Za-z0-9+/]*={0,2}$/),
  coworkerId: identifier.optional(),
});

// Derived from the provider constants so a new provider cannot be added without
// its credential keys becoming valid at the IPC boundary.
type CredentialKey =
  | `model:${RemoteModelProvider}`
  | `model:${RemoteModelProvider}:base-url`
  | "integration:email:resend"
  | `web-search:${WebSearchProvider}`;

export const credentialKeySchema = z.enum([
  ...remoteModelProviders.flatMap(
    (provider) =>
      [`model:${provider}`, `model:${provider}:base-url`] as const satisfies readonly CredentialKey[],
  ),
  "integration:email:resend",
  ...webSearchProviders.map((provider) => `web-search:${provider}` as const),
] as [CredentialKey, ...CredentialKey[]]);

export const approvalStatusSchema = z.enum(approvalStatuses);
export const listLimitSchema = z.number().int().min(1).max(1_000);
