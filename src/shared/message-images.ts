import type { ToolCall } from "./contracts";

/** An image a controlled tool found and reported to the model, for example a web search hit. */
export interface ImageReference {
  url: string;
  title: string;
  /** Page the image came from, when the provider reports one. */
  sourceUrl: string | null;
  width?: number;
  height?: number;
}

/** An image the model attached to its chat reply. */
export interface MessageImage {
  url: string;
  alt: string;
  sourceUrl: string | null;
  width?: number;
  height?: number;
  /**
   * Short handle, unique within the task, that the reply can write as
   * `![caption](image:1)` to show the photo at that spot instead of above it.
   */
  ref?: string;
}

/** The images one completed attachment call added to a task's reply. */
export interface MessageImageSet {
  id: string;
  taskId: string;
  coworkerId: string;
  createdAt: string;
  images: MessageImage[];
}

export const attachImagesToolName = "chat.attach_images";
/** Photos one reply can carry, enough for a few photos of each of several items. */
export const maxMessageImages = 20;
/** Unplaced photos shown in the collage above a reply; the rest open in its viewer. */
export const maxCollageImages = 6;
export const maxImageReferences = 12;

const maxUrlLength = 2_000;
const imageRefPattern = /^image:([1-9]\d{0,2})$/;

export function messageImageRef(number: number): string {
  return `image:${number}`;
}

function validImageRef(value: unknown): string | undefined {
  return typeof value === "string" && imageRefPattern.test(value) ? value : undefined;
}

/**
 * The image refs a reply places inline, in the order it writes them. Only the
 * `![caption](image:N)` form counts, so a ref mentioned in prose is ignored.
 */
export function inlineImageRefs(markdown: string): string[] {
  const refs: string[] = [];
  for (const match of markdown.matchAll(/!\[[^\]\n]*\]\(\s*<?(image:[1-9]\d{0,2})>?\s*\)/g)) {
    const ref = match[1];
    if (ref && !refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

/** Ref from an inline Markdown image source, or null for any other address. */
export function imageRefFromSource(source: string | undefined): string | null {
  return validImageRef(source?.trim()) ?? null;
}
const internalHostSuffixes = [".localhost", ".local", ".internal", ".lan", ".home", ".corp"];

/**
 * The only image locations the app will fetch or show: HTTPS, no embedded
 * credentials, and a public DNS name. IP literals and internal names are
 * refused so a model-supplied or page-supplied URL cannot point the app at
 * this computer or its network. Returns the normalized URL, or null.
 */
export function publicHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxUrlLength) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname.includes(".") || hostname.startsWith("[") || hostname.includes(":")) return null;
  if (/^[\d.]+$/.test(hostname) || /^0x/i.test(hostname)) return null;
  if (hostname === "localhost" || internalHostSuffixes.some((suffix) => hostname.endsWith(suffix))) {
    return null;
  }
  const normalized = url.toString();
  return normalized.length > maxUrlLength ? null : normalized;
}

function dimension(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 100_000
    ? value
    : undefined;
}

function shortText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

/** Keeps only displayable, de-duplicated references from untrusted provider data. */
export function normalizeImageReferences(candidates: unknown[]): ImageReference[] {
  const seen = new Set<string>();
  const references: ImageReference[] = [];
  for (const candidate of candidates) {
    if (references.length >= maxImageReferences) break;
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    const url = publicHttpsUrl(record.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const width = dimension(record.width);
    const height = dimension(record.height);
    references.push({
      url,
      title: shortText(record.title, 300),
      sourceUrl: publicHttpsUrl(record.sourceUrl),
      ...(width && height ? { width, height } : {}),
    });
  }
  return references;
}

/** Image references a completed tool result reported under its `images` key. */
export function imageReferencesFromToolResult(result: unknown): ImageReference[] {
  if (!result || typeof result !== "object" || Array.isArray(result)) return [];
  const images = (result as { images?: unknown }).images;
  return Array.isArray(images) ? normalizeImageReferences(images) : [];
}

export interface ResolvedMessageImages {
  images: MessageImage[];
  rejected: Array<{ url: string; reason: string }>;
}

/**
 * Matches the images a model asked to attach against the references tools
 * actually returned in the same task. The model contributes only the choice
 * and the caption; location, source page, and size come from the reference,
 * so a reply can never display a URL the model composed itself.
 */
export function resolveMessageImages(
  requested: Array<{ url: string; alt: string }>,
  references: ImageReference[],
  /** Images earlier attachment calls in the task already numbered. */
  previouslyAttached = 0,
): ResolvedMessageImages {
  const known = new Map(references.map((reference) => [reference.url, reference]));
  const images: MessageImage[] = [];
  const rejected: ResolvedMessageImages["rejected"] = [];
  const attached = new Set<string>();
  for (const item of requested) {
    const url = publicHttpsUrl(item.url);
    const reference = url ? known.get(url) : undefined;
    if (!url || !reference) {
      rejected.push({
        url: item.url.slice(0, 300),
        reason: url
          ? "Not an image returned by a tool in this task. Copy a url value from a tool result's images list exactly; links to pages are not images."
          : "Not a public HTTPS image URL.",
      });
      continue;
    }
    if (attached.has(url)) continue;
    if (images.length >= maxMessageImages) {
      rejected.push({ url, reason: `Only ${maxMessageImages} images can be attached to a reply.` });
      continue;
    }
    attached.add(url);
    images.push({
      url,
      alt: shortText(item.alt, 200) || reference.title || "Image",
      sourceUrl: reference.sourceUrl,
      ...(reference.width && reference.height
        ? { width: reference.width, height: reference.height }
        : {}),
      ref: messageImageRef(previouslyAttached + images.length + 1),
    });
  }
  return { images, rejected };
}

/** Reads back the validated images a completed attachment call recorded. */
export function messageImagesFromToolResult(result: unknown): MessageImage[] {
  if (!result || typeof result !== "object" || Array.isArray(result)) return [];
  const images = (result as { images?: unknown }).images;
  if (!Array.isArray(images)) return [];
  return images
    .flatMap((candidate): MessageImage[] => {
      if (!candidate || typeof candidate !== "object") return [];
      const record = candidate as Record<string, unknown>;
      const url = publicHttpsUrl(record.url);
      if (!url) return [];
      const width = dimension(record.width);
      const height = dimension(record.height);
      const ref = validImageRef(record.ref);
      return [{
        url,
        alt: shortText(record.alt, 200) || "Image",
        sourceUrl: publicHttpsUrl(record.sourceUrl),
        ...(width && height ? { width, height } : {}),
        ...(ref ? { ref } : {}),
      }];
    })
    .slice(0, maxMessageImages);
}

/** The durable record of a reply's images is the audited attachment call itself. */
export function messageImageSetFromToolCall(toolCall: ToolCall): MessageImageSet | null {
  if (toolCall.toolName !== attachImagesToolName || toolCall.status !== "COMPLETED") return null;
  const images = messageImagesFromToolResult(toolCall.result);
  if (images.length === 0) return null;
  return {
    id: toolCall.id,
    taskId: toolCall.taskId,
    coworkerId: toolCall.coworkerId,
    createdAt: toolCall.completedAt ?? toolCall.createdAt,
    images,
  };
}

const assistantMessageMarker = ":assistant:";

/** Id of the assistant message a run streams; it carries the run so a live message can be tied to its task. */
export function assistantMessageId(runId: string, timestamp: number | string): string {
  return `${runId}${assistantMessageMarker}${timestamp}`;
}

export function runIdFromAssistantMessageId(messageId: string): string | null {
  const index = messageId.lastIndexOf(assistantMessageMarker);
  return index > 0 ? messageId.slice(0, index) : null;
}
