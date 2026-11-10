import {
  maxMessageImages,
  type MessageImage,
  type MessageImageSet,
} from "@shared/message-images";

export interface PlacedMessageImage extends MessageImage {
  setId: string;
  index: number;
}

export interface PlaceableMessage {
  id: string;
  /** Null for a message that cannot be tied to a task yet. */
  taskId: string | null;
  role: string;
  hasText: boolean;
  /** ISO time the message was stored, or first seen while it streams. */
  time: string;
}

/**
 * Decides which reply shows each attached image set. Images belong above the
 * answer written after they were attached. While the task is still running
 * that answer may not exist yet, so an earlier remark such as "Let me look"
 * is not used; once the task has ended, its last reply takes them.
 */
export function placeMessageImages(input: {
  sets: MessageImageSet[];
  /** In display order. */
  messages: PlaceableMessage[];
  runningTaskIds: ReadonlySet<string>;
}): Map<string, PlacedMessageImage[]> {
  const placed = new Map<string, PlacedMessageImage[]>();
  const sets = [...input.sets].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  for (const set of sets) {
    const replies = input.messages.filter(
      (message) => message.role === "assistant" && message.hasText && message.taskId === set.taskId,
    );
    const attachedAt = Date.parse(set.createdAt);
    const target =
      replies.find((message) => Date.parse(message.time) >= attachedAt) ??
      (input.runningTaskIds.has(set.taskId) ? undefined : replies.at(-1));
    if (!target) continue;
    const images = placed.get(target.id) ?? [];
    for (const [index, image] of set.images.entries()) {
      if (images.length >= maxMessageImages) break;
      if (images.some((existing) => existing.url === image.url)) continue;
      images.push({ ...image, setId: set.id, index });
    }
    placed.set(target.id, images);
  }
  return placed;
}
