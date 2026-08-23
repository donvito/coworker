import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Integration } from "@shared/contracts";
import type { CredentialStore } from "@main/security/credential-store";
import { resolveWorkspacePath } from "@main/tools/workspace-path";

export interface EmailPayload {
  to: string[];
  subject: string;
  body: string;
  attachments?: string[];
}

export interface EmailSendResult {
  provider: "local-outbox" | "resend";
  messageId: string;
  filePath?: string;
}

function safeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

async function attachmentData(
  workspacePath: string,
  attachments: string[] = [],
): Promise<Array<{ filename: string; content: Buffer }>> {
  return Promise.all(
    attachments.map(async (path) => {
      const resolved = await resolveWorkspacePath(workspacePath, path);
      return { filename: basename(resolved), content: await readFile(resolved) };
    }),
  );
}

async function buildEml(
  from: string,
  payload: EmailPayload,
  workspacePath: string,
  messageId: string,
): Promise<string> {
  const attachments = await attachmentData(workspacePath, payload.attachments);
  const boundary = `coworker-${createHash("sha256").update(messageId).digest("hex").slice(0, 24)}`;
  const headers = [
    `From: ${safeHeader(from)}`,
    `To: ${payload.to.map(safeHeader).join(", ")}`,
    `Subject: ${safeHeader(payload.subject)}`,
    `Message-ID: <${messageId}@local.coworker>`,
    "MIME-Version: 1.0",
  ];
  if (attachments.length === 0) {
    return [
      ...headers,
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      payload.body,
      "",
    ].join("\r\n");
  }

  const parts = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    payload.body,
    "",
  ];
  for (const attachment of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: application/octet-stream; name="${safeHeader(attachment.filename)}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${safeHeader(attachment.filename)}"`,
      "",
      attachment.content.toString("base64").replace(/.{1,76}/g, "$&\r\n").trimEnd(),
      "",
    );
  }
  parts.push(`--${boundary}--`, "");
  return parts.join("\r\n");
}

export async function createEmailDraft(input: {
  payload: EmailPayload;
  workspacePath: string;
  fromAddress: string;
  draftId: string;
}): Promise<{ filePath: string }> {
  const directory = await resolveWorkspacePath(input.workspacePath, "drafts", {
    createParent: true,
  });
  await mkdir(directory, { recursive: true });
  const draftKey = createHash("sha256").update(input.draftId).digest("hex").slice(0, 16);
  const filename = `${draftKey}-${slug(input.payload.subject) || "draft"}.eml`;
  const filePath = join(directory, filename);
  const content = await buildEml(
    input.fromAddress,
    input.payload,
    input.workspacePath,
    input.draftId,
  );
  await writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
  return { filePath };
}

export async function sendEmail(input: {
  integration: Integration;
  credentials: CredentialStore;
  outboxPath: string;
  workspacePath: string;
  payload: EmailPayload;
  idempotencyKey: string;
}): Promise<EmailSendResult> {
  const fromAddress = String(input.integration.config.fromAddress || "coworker@localhost");
  const messageId = createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 32);

  if (input.integration.mode === "local-outbox") {
    await mkdir(input.outboxPath, { recursive: true });
    const filePath = join(input.outboxPath, `${messageId}.eml`);
    const content = await buildEml(
      fromAddress,
      input.payload,
      input.workspacePath,
      messageId,
    );
    try {
      await writeFile(filePath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return { provider: "local-outbox", messageId, filePath };
  }

  if (!input.integration.credentialKey) {
    throw new Error("The Resend integration is missing its credential reference");
  }
  const apiKey = await input.credentials.get(input.integration.credentialKey);
  if (!apiKey) throw new Error("The Resend API key is not configured");
  const attachments = await attachmentData(input.workspacePath, input.payload.attachments);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey,
    },
    body: JSON.stringify({
      from: fromAddress,
      to: input.payload.to,
      subject: input.payload.subject,
      text: input.payload.body,
      attachments: attachments.map((attachment) => ({
        filename: attachment.filename,
        content: attachment.content.toString("base64"),
      })),
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Email provider rejected the request (${response.status}): ${body.slice(0, 300)}`);
  }
  const result = (await response.json()) as { id?: string };
  if (!result.id) throw new Error("Email provider did not return a message id");
  return { provider: "resend", messageId: result.id };
}
