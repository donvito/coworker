import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { RunAgentInput } from "@ag-ui/core";
import type { TaskImageAttachment } from "@shared/contracts";
import { resolveWorkspacePath } from "@main/tools/workspace-path";

export const supportedImageMimeTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export const maxAttachedImages = 4;
export const maxAttachedImageBytes = 8 * 1024 * 1024;
export const maxAttachedImagesTotalBytes = 20 * 1024 * 1024;

type SupportedImageMimeType = (typeof supportedImageMimeTypes)[number];

export interface IncomingImageAttachment {
  data: Buffer;
  mimeType: SupportedImageMimeType;
  name: string;
}

export interface ParsedAgentPrompt {
  images: IncomingImageAttachment[];
  text: string;
}

export interface PersistedImageAttachment {
  id: string;
  mimeType: SupportedImageMimeType;
  name: string;
  relativePath: string;
  size: number;
}

const extensions: Record<SupportedImageMimeType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

function attachmentName(metadata: unknown, index: number, mimeType: SupportedImageMimeType): string {
  if (metadata && typeof metadata === "object" && "name" in metadata) {
    const candidate = metadata.name;
    if (typeof candidate === "string" && candidate.trim()) {
      return posix.basename(candidate.replaceAll("\\", "/")).slice(0, 180);
    }
  }
  return `image-${index + 1}.${extensions[mimeType]}`;
}

function decodeBase64Image(value: string): Buffer {
  const maxEncodedLength = Math.ceil(maxAttachedImageBytes / 3) * 4;
  if (
    value.length === 0 ||
    value.length > maxEncodedLength ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw new Error("An attached image contains invalid base64 data");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== value) {
    throw new Error("An attached image contains invalid base64 data");
  }
  if (decoded.length > maxAttachedImageBytes) {
    throw new Error("Each attached image must be 8 MB or smaller");
  }
  return decoded;
}

function hasImageSignature(data: Buffer, mimeType: SupportedImageMimeType): boolean {
  if (mimeType === "image/jpeg") {
    return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  }
  if (mimeType === "image/png") {
    return (
      data.length >= 8 &&
      data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    );
  }
  if (mimeType === "image/gif") {
    const signature = data.subarray(0, 6).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  }
  return (
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

export function parseAgentPrompt(input: RunAgentInput): ParsedAgentPrompt {
  const latest = [...input.messages].reverse().find((message) => message.role === "user");
  if (!latest) return { images: [], text: "Continue the current task" };
  if (typeof latest.content === "string") {
    return { images: [], text: latest.content.trim() || "Continue the current task" };
  }
  if (!Array.isArray(latest.content)) {
    return { images: [], text: "Continue the current task" };
  }

  const textParts: string[] = [];
  const images: IncomingImageAttachment[] = [];
  let totalBytes = 0;

  for (const part of latest.content) {
    if (part.type === "text") {
      if (part.text.trim()) textParts.push(part.text.trim());
      continue;
    }
    if (part.type !== "image") continue;
    if (images.length >= maxAttachedImages) {
      throw new Error(`Attach no more than ${maxAttachedImages} images at a time`);
    }
    if (part.source.type !== "data") {
      throw new Error("Only images selected from this device can be attached");
    }
    const mimeType = part.source.mimeType.toLowerCase();
    if (!supportedImageMimeTypes.includes(mimeType as SupportedImageMimeType)) {
      throw new Error("Attach a JPEG, PNG, WebP, or GIF image");
    }
    const data = decodeBase64Image(part.source.value);
    if (!hasImageSignature(data, mimeType as SupportedImageMimeType)) {
      throw new Error(`${attachmentName(part.metadata, images.length, mimeType as SupportedImageMimeType)} does not match its declared image format`);
    }
    totalBytes += data.length;
    if (totalBytes > maxAttachedImagesTotalBytes) {
      throw new Error("Attached images must be 20 MB or smaller in total");
    }
    images.push({
      data,
      mimeType: mimeType as SupportedImageMimeType,
      name: attachmentName(part.metadata, images.length, mimeType as SupportedImageMimeType),
    });
  }

  const enteredText = textParts.join("\n").trim();
  const text =
    enteredText || (images.length > 0 ? "Analyze the attached image." : "Continue the current task");
  return { images, text };
}

export async function persistImageAttachments(
  workspacePath: string,
  taskId: string,
  images: IncomingImageAttachment[],
): Promise<PersistedImageAttachment[]> {
  const persisted: PersistedImageAttachment[] = [];
  for (const [index, image] of images.entries()) {
    const id = randomUUID();
    const relativePath = posix.join(
      ".coworker",
      "image-context",
      taskId,
      `${String(index + 1).padStart(2, "0")}-${id}.${extensions[image.mimeType]}`,
    );
    const filePath = await resolveWorkspacePath(workspacePath, relativePath, {
      createParent: true,
    });
    await writeFile(filePath, image.data, { flag: "wx", mode: 0o600 });
    persisted.push({
      id,
      mimeType: image.mimeType,
      name: image.name,
      relativePath,
      size: image.data.length,
    });
  }
  return persisted;
}

export async function removePersistedImageAttachments(
  workspacePath: string,
  taskId: string,
): Promise<void> {
  const relativePath = posix.join(".coworker", "image-context", taskId);
  try {
    const directory = await resolveWorkspacePath(workspacePath, relativePath);
    await rm(directory, { force: true, recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function loadImageAttachments(
  workspacePath: string,
  attachments: TaskImageAttachment[],
): Promise<ImageContent[]> {
  return Promise.all(
    attachments.map(async (attachment) => {
      const filePath = await resolveWorkspacePath(workspacePath, attachment.relativePath);
      const data = await readFile(filePath);
      if (data.length !== attachment.size || data.length > maxAttachedImageBytes) {
        throw new Error(`Attached image ${attachment.name} is missing or has changed`);
      }
      return {
        type: "image",
        data: data.toString("base64"),
        mimeType: attachment.mimeType,
      };
    }),
  );
}
