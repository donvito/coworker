import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { posix, relative } from "node:path";
import { z } from "zod";
import type {
  Approval,
  Coworker,
  CreateScheduleInput,
  Schedule,
  Task,
  ToolCall,
  ToolPolicy,
} from "@shared/contracts";
import { getToolCatalogEntry } from "@shared/tool-catalog";
import type { CoworkerDatabase } from "@main/db/database";
import {
  createDocument,
  type DocumentFormat,
} from "@main/integrations/documents";
import type { CredentialStore } from "@main/security/credential-store";
import { createEmailDraft, sendEmail, type EmailPayload } from "@main/integrations/email";
import { resolveWorkspacePath } from "./workspace-path";

const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const schemas = {
  "files.list": z.object({ path: z.string().min(1).max(2_000).default(".") }),
  "files.read": z.object({ path: z.string().min(1).max(2_000) }),
  "files.write": z.object({
    path: z.string().min(1).max(2_000),
    content: z.string().max(5_000_000),
  }),
  "invoice.create": z.object({
    client: z.string().trim().min(1).max(240),
    recipientEmail: z.string().email().optional(),
    lineItems: z
      .array(
        z.object({
          description: z.string().trim().min(1).max(500),
          quantity: z.number().positive().max(1_000_000),
          rate: z.number().nonnegative().max(100_000_000),
        }),
      )
      .min(1)
      .max(200),
    dueDays: z.number().int().min(0).max(365).default(14),
    currency: z.string().trim().length(3).default("USD"),
  }),
  "documents.export": z.object({
    sourcePath: z.string().min(1).max(2_000),
    formats: z
      .array(z.enum(["pdf", "docx"]))
      .min(1)
      .max(2)
      .refine((formats) => new Set(formats).size === formats.length, "Formats must be unique"),
  }),
  "email.create_draft": z.object({
    to: z.union([z.string().email(), z.array(z.string().email()).min(1).max(50)]),
    subject: z.string().trim().min(1).max(500),
    body: z.string().max(1_000_000),
    attachments: z.array(z.string().min(1).max(2_000)).max(25).optional(),
  }),
  "schedules.create": z
    .object({
      name: z.string().trim().min(1).max(160),
      scheduleType: z.enum(["cron", "once"]),
      cronExpression: z.string().trim().min(1).max(160).optional(),
      runAt: z.string().datetime({ offset: true }).optional(),
      timezone: z.string().trim().min(1).max(120).default(localTimezone),
      taskTemplate: z.object({
        title: z.string().trim().min(1).max(240),
        input: z.string().trim().min(1).max(100_000),
        priority: z.number().int().min(-100).max(100).optional(),
      }),
      enabled: z.boolean().default(true),
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
    }),
  "email.send": z.object({
    to: z.union([z.string().email(), z.array(z.string().email()).min(1).max(50)]),
    subject: z.string().trim().min(1).max(500),
    body: z.string().max(1_000_000),
    attachments: z.array(z.string().min(1).max(2_000)).max(25).optional(),
  }),
} as const;

export type ToolGatewayResult =
  | { kind: "completed"; toolCall: ToolCall; result: unknown }
  | { kind: "approval"; toolCall: ToolCall; approval: Approval }
  | { kind: "denied"; toolCall: ToolCall; reason: string };

export interface ToolGatewayActions {
  createSchedule?: (input: CreateScheduleInput) => Schedule;
}

function normalizeEmailPayload(input: z.infer<(typeof schemas)["email.send"]>): EmailPayload {
  return {
    to: Array.isArray(input.to) ? input.to : [input.to],
    subject: input.subject,
    body: input.body,
    attachments: input.attachments,
  };
}

function policyFor(coworker: Coworker, toolName: string): ToolPolicy {
  const metadata = getToolCatalogEntry(toolName);
  return coworker.policies[toolName] ?? metadata?.defaultPolicy ?? "denied";
}

function approvalSummary(toolName: string, args: unknown): string {
  if (toolName === "email.send") {
    const parsed = schemas["email.send"].safeParse(args);
    if (parsed.success) {
      const recipients = Array.isArray(parsed.data.to) ? parsed.data.to.join(", ") : parsed.data.to;
      return `Send “${parsed.data.subject}” to ${recipients}`;
    }
  }
  if (toolName === "schedules.create") {
    const parsed = schemas["schedules.create"].safeParse(args);
    if (parsed.success) {
      const timing =
        parsed.data.scheduleType === "cron"
          ? `${parsed.data.cronExpression} (${parsed.data.timezone})`
          : new Date(parsed.data.runAt!).toLocaleString();
      return `Create schedule “${parsed.data.name}” · ${timing}`;
    }
  }
  return `Allow ${toolName}`;
}

function formatMoney(value: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export class ToolGateway {
  constructor(
    private readonly database: CoworkerDatabase,
    private readonly credentials: CredentialStore,
    private readonly outboxPath: string,
    private readonly actions: ToolGatewayActions = {},
  ) {}

  validateArguments(toolName: string, argumentsValue: unknown): unknown {
    const schema = schemas[toolName as keyof typeof schemas];
    if (!schema) throw new Error(`Unknown or uncontrolled tool: ${toolName}`);
    return schema.parse(argumentsValue);
  }

  async request(input: {
    task: Task;
    coworker: Coworker;
    toolCallId: string;
    toolName: string;
    arguments: unknown;
  }): Promise<ToolGatewayResult> {
    const metadata = getToolCatalogEntry(input.toolName);
    const operationHash = createHash("sha256")
      .update(`${input.toolName}\0${stableJson(input.arguments)}`)
      .digest("hex")
      .slice(0, 24);
    const idempotencyKey = `${input.task.id}:${operationHash}`;
    const storedToolCallId = createHash("sha256")
      .update(`${input.task.id}\0${input.toolCallId}`)
      .digest("hex");
    const toolCall = this.database.createToolCall({
      id: storedToolCallId,
      taskId: input.task.id,
      coworkerId: input.coworker.id,
      toolName: input.toolName,
      arguments: input.arguments,
      idempotencyKey,
    });

    if (!metadata || !input.coworker.enabledTools.includes(input.toolName)) {
      const reason = `${input.toolName} is not enabled for ${input.coworker.name}`;
      return {
        kind: "denied",
        toolCall: this.database.updateToolCall(toolCall.id, "DENIED", { error: reason }),
        reason,
      };
    }

    const schema = schemas[input.toolName as keyof typeof schemas];
    const parsed = schema?.safeParse(input.arguments);
    if (!parsed?.success) {
      const reason = parsed
        ? `Invalid ${input.toolName} arguments: ${parsed.error.issues[0]?.message ?? "validation failed"}`
        : `Unknown or uncontrolled tool: ${input.toolName}`;
      return {
        kind: "denied",
        toolCall: this.database.updateToolCall(toolCall.id, "DENIED", { error: reason }),
        reason,
      };
    }
    const validatedArguments = parsed.data;

    const policy = policyFor(input.coworker, input.toolName);
    if (policy === "denied") {
      const reason = `${input.toolName} is denied by policy`;
      return {
        kind: "denied",
        toolCall: this.database.updateToolCall(toolCall.id, "DENIED", { error: reason }),
        reason,
      };
    }
    if (policy === "approval") {
      const approval = this.database.createApproval({
        taskId: input.task.id,
        coworkerId: input.coworker.id,
        toolCallId: toolCall.id,
        actionType: input.toolName,
        summary: approvalSummary(input.toolName, validatedArguments),
        proposedPayload: validatedArguments,
        riskLevel: metadata.risk,
      });
      return {
        kind: "approval",
        toolCall: this.database.getToolCall(toolCall.id),
        approval,
      };
    }

    const result = await this.execute(toolCall, input.coworker, validatedArguments);
    return { kind: "completed", toolCall: this.database.getToolCall(toolCall.id), result };
  }

  async executeApproval(
    approval: Approval,
    coworker: Coworker,
  ): Promise<{ approved: boolean; result: unknown }> {
    if (approval.status === "REJECTED") {
      return { approved: false, result: { rejected: true, reason: "The user rejected this action" } };
    }
    if (!["APPROVED", "EDITED"].includes(approval.status)) {
      throw new Error("The approval is not ready to execute");
    }
    const toolCall = this.database.getToolCall(approval.toolCallId);
    const args =
      approval.status === "EDITED" && approval.decidedPayload !== null
        ? approval.decidedPayload
        : approval.proposedPayload;
    const result = await this.execute(toolCall, coworker, args);
    return { approved: true, result };
  }

  private async execute(toolCall: ToolCall, coworker: Coworker, args: unknown): Promise<unknown> {
    const cached = this.database.getSideEffect(toolCall.idempotencyKey);
    if (cached?.status === "COMPLETED") {
      this.database.updateToolCall(toolCall.id, "COMPLETED", cached.result);
      return cached.result;
    }

    this.database.updateToolCall(toolCall.id, "RUNNING");
    this.database.startSideEffect(toolCall.idempotencyKey, toolCall.id);
    try {
      const result = await this.executeUnchecked(toolCall, coworker, args);
      this.database.finishSideEffect(toolCall.idempotencyKey, "COMPLETED", result);
      this.database.updateToolCall(toolCall.id, "COMPLETED", result);
      this.database.addActivity({
        coworkerId: coworker.id,
        taskId: toolCall.taskId,
        type: "tool.completed",
        summary: `${coworker.name} used ${toolCall.toolName}`,
        metadata: { toolCallId: toolCall.id },
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.database.finishSideEffect(toolCall.idempotencyKey, "FAILED", { error: message });
      this.database.updateToolCall(toolCall.id, "FAILED", { error: message });
      throw error;
    }
  }

  private async executeUnchecked(
    toolCall: ToolCall,
    coworker: Coworker,
    rawArgs: unknown,
  ): Promise<unknown> {
    switch (toolCall.toolName) {
      case "files.list": {
        const args = schemas["files.list"].parse(rawArgs);
        const path = await resolveWorkspacePath(coworker.workspacePath, args.path);
        const entries = await readdir(path, { withFileTypes: true });
        return {
          path: args.path,
          entries: entries.map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? "directory" : "file",
          })),
        };
      }
      case "files.read": {
        const args = schemas["files.read"].parse(rawArgs);
        const path = await resolveWorkspacePath(coworker.workspacePath, args.path);
        return { path: args.path, content: await readFile(path, "utf8") };
      }
      case "files.write": {
        const args = schemas["files.write"].parse(rawArgs);
        const path = await resolveWorkspacePath(coworker.workspacePath, args.path, {
          createParent: true,
        });
        await writeFile(path, args.content, { encoding: "utf8", mode: 0o600 });
        const artifact = this.database.createArtifact({
          taskId: toolCall.taskId,
          coworkerId: coworker.id,
          name: args.path.split("/").at(-1) ?? args.path,
          mimeType: "text/plain",
          filePath: path,
        });
        return { path: args.path, bytes: Buffer.byteLength(args.content), artifactId: artifact.id };
      }
      case "invoice.create": {
        const args = schemas["invoice.create"].parse(rawArgs);
        const invoiceNumber = `INV-${createHash("sha256")
          .update(toolCall.id)
          .digest("hex")
          .slice(0, 8)
          .toUpperCase()}`;
        const issuedAt = new Date();
        const dueAt = new Date(issuedAt);
        dueAt.setUTCDate(dueAt.getUTCDate() + args.dueDays);
        const total = args.lineItems.reduce((sum, item) => sum + item.quantity * item.rate, 0);
        const lines = [
          `# Invoice ${invoiceNumber}`,
          "",
          `**Bill to:** ${args.client}`,
          args.recipientEmail ? `**Email:** ${args.recipientEmail}` : "",
          `**Issued:** ${issuedAt.toISOString().slice(0, 10)}`,
          `**Due:** ${dueAt.toISOString().slice(0, 10)}`,
          "",
          "| Description | Quantity | Rate | Amount |",
          "| --- | ---: | ---: | ---: |",
          ...args.lineItems.map(
            (item) =>
              `| ${item.description.replaceAll("|", "\\|")} | ${item.quantity} | ${formatMoney(item.rate, args.currency)} | ${formatMoney(item.quantity * item.rate, args.currency)} |`,
          ),
          "",
          `## Total: ${formatMoney(total, args.currency)}`,
          "",
        ].filter(Boolean);
        const relativePath = `invoices/${invoiceNumber}.md`;
        const path = await resolveWorkspacePath(coworker.workspacePath, relativePath, {
          createParent: true,
        });
        await writeFile(path, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
        const artifact = this.database.createArtifact({
          taskId: toolCall.taskId,
          coworkerId: coworker.id,
          name: `${invoiceNumber}.md`,
          mimeType: "text/markdown",
          filePath: path,
        });
        return {
          invoiceNumber,
          client: args.client,
          total,
          currency: args.currency,
          dueAt: dueAt.toISOString(),
          path: relativePath,
          artifactId: artifact.id,
        };
      }
      case "documents.export": {
        const args = schemas["documents.export"].parse(rawArgs);
        const sourcePath = args.sourcePath.replaceAll("\\", "/");
        const sourceExtension = posix.extname(sourcePath).toLowerCase();
        if (![".md", ".markdown", ".txt"].includes(sourceExtension)) {
          throw new Error("Document export supports Markdown and plain-text source files");
        }
        const absoluteSourcePath = await resolveWorkspacePath(
          coworker.workspacePath,
          sourcePath,
        );
        const sourceStats = await stat(absoluteSourcePath);
        if (!sourceStats.isFile()) throw new Error("Document export source must be a file");
        if (sourceStats.size > 5_000_000) {
          throw new Error("Document export source is larger than 5 MB");
        }
        const content = await readFile(absoluteSourcePath, "utf8");
        const parsedSource = posix.parse(sourcePath);
        const files = [];

        for (const format of args.formats) {
          const relativePath = posix.join(
            parsedSource.dir,
            `${parsedSource.name}.${format}`,
          );
          const absolutePath = await resolveWorkspacePath(
            coworker.workspacePath,
            relativePath,
            { createParent: true },
          );
          const bytes = await createDocument(
            format as DocumentFormat,
            content,
            parsedSource.name,
          );
          await writeFile(absolutePath, bytes, { mode: 0o600 });
          const artifact = this.database.createArtifact({
            taskId: toolCall.taskId,
            coworkerId: coworker.id,
            name: posix.basename(relativePath),
            mimeType:
              format === "pdf"
                ? "application/pdf"
                : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            filePath: absolutePath,
          });
          files.push({
            format,
            path: relativePath,
            bytes: bytes.byteLength,
            artifactId: artifact.id,
          });
        }

        return { sourcePath, files };
      }
      case "email.create_draft": {
        const args = schemas["email.create_draft"].parse(rawArgs);
        const integration = this.database.getEmailIntegration();
        const fromAddress = String(integration?.config.fromAddress || "coworker@localhost");
        const draft = await createEmailDraft({
          payload: normalizeEmailPayload(args),
          workspacePath: coworker.workspacePath,
          fromAddress,
          draftId: toolCall.idempotencyKey,
        });
        const artifact = this.database.createArtifact({
          taskId: toolCall.taskId,
          coworkerId: coworker.id,
          name: draft.filePath.split("/").at(-1) ?? "draft.eml",
          mimeType: "message/rfc822",
          filePath: draft.filePath,
        });
        return {
          path: relative(coworker.workspacePath, draft.filePath),
          artifactId: artifact.id,
          recipients: normalizeEmailPayload(args).to,
        };
      }
      case "schedules.create": {
        const args = schemas["schedules.create"].parse(rawArgs);
        if (!this.actions.createSchedule) {
          throw new Error("The local scheduler is unavailable");
        }
        if (
          args.scheduleType === "once" &&
          args.runAt &&
          new Date(args.runAt).getTime() <= Date.now()
        ) {
          throw new Error("A one-time schedule must run in the future");
        }
        const schedule = this.actions.createSchedule({
          coworkerId: coworker.id,
          name: args.name,
          scheduleType: args.scheduleType,
          cronExpression: args.cronExpression,
          runAt: args.runAt,
          timezone: args.timezone,
          taskTemplate: args.taskTemplate,
          enabled: args.enabled,
        });
        return {
          scheduleId: schedule.id,
          name: schedule.name,
          scheduleType: schedule.scheduleType,
          cronExpression: schedule.cronExpression,
          runAt: schedule.runAt,
          timezone: schedule.timezone,
          nextRunAt: schedule.nextRunAt,
          taskTemplate: schedule.taskTemplate,
          enabled: schedule.enabled,
        };
      }
      case "email.send": {
        const args = schemas["email.send"].parse(rawArgs);
        const integration =
          this.database.getEmailIntegration() ??
          this.database.upsertEmailIntegration({
            name: "Local outbox",
            mode: "local-outbox",
            credentialKey: null,
          });
        return sendEmail({
          integration,
          credentials: this.credentials,
          outboxPath: this.outboxPath,
          workspacePath: coworker.workspacePath,
          payload: normalizeEmailPayload(args),
          idempotencyKey: toolCall.idempotencyKey,
        });
      }
      default:
        throw new Error(`Unknown or uncontrolled tool: ${toolCall.toolName}`);
    }
  }
}
