import { describe, expect, it } from "vitest";
import type { ToolCall } from "@shared/contracts";
import {
  assistantMessageId,
  imageReferencesFromToolResult,
  maxImageReferences,
  maxMessageImages,
  messageImageSetFromToolCall,
  normalizeImageReferences,
  publicHttpsUrl,
  resolveMessageImages,
  runIdFromAssistantMessageId,
  type MessageImageSet,
} from "@shared/message-images";
import { placeMessageImages, type PlaceableMessage } from "../src/renderer/src/lib/message-image-placement";

describe("public image URLs", () => {
  it("accepts only public HTTPS addresses", () => {
    expect(publicHttpsUrl(" https://images.example.com/a b.jpg?w=720 ")).toBe(
      "https://images.example.com/a%20b.jpg?w=720",
    );
    for (const value of [
      "http://images.example.com/a.jpg",
      "data:image/png;base64,AAAA",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://user:secret@images.example.com/a.jpg",
      "https://localhost/a.jpg",
      "https://intranet/a.jpg",
      "https://printer.local/a.jpg",
      "https://metadata.internal/a.jpg",
      "https://127.0.0.1/a.jpg",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/a.jpg",
      "https://0x7f.0.0.1/a.jpg",
      `https://images.example.com/${"a".repeat(2_100)}`,
      "not a url",
      42,
      null,
    ]) {
      expect(publicHttpsUrl(value), String(value)).toBeNull();
    }
  });
});

describe("image references from tool results", () => {
  it("normalizes, de-duplicates, and caps untrusted provider data", () => {
    const references = normalizeImageReferences([
      {
        url: "https://cdn.example.com/villa.jpg",
        title: "  Villa   with\npool ",
        sourceUrl: "https://stays.example.com/rooms/1",
        width: 1200,
        height: 800,
      },
      { url: "https://cdn.example.com/villa.jpg", title: "Duplicate" },
      { url: "http://cdn.example.com/insecure.jpg", title: "Insecure" },
      { url: "https://cdn.example.com/half.jpg", sourceUrl: "http://plain.example.com", width: 640 },
      "https://cdn.example.com/string.jpg",
      null,
    ]);
    expect(references).toEqual([
      {
        url: "https://cdn.example.com/villa.jpg",
        title: "Villa with pool",
        sourceUrl: "https://stays.example.com/rooms/1",
        width: 1200,
        height: 800,
      },
      { url: "https://cdn.example.com/half.jpg", title: "", sourceUrl: null },
    ]);

    const many = Array.from({ length: 40 }, (_, index) => ({
      url: `https://cdn.example.com/${index}.jpg`,
    }));
    expect(normalizeImageReferences(many)).toHaveLength(maxImageReferences);
  });

  it("reads references only from an images array on a tool result", () => {
    expect(
      imageReferencesFromToolResult({ images: [{ url: "https://cdn.example.com/a.jpg" }] }),
    ).toHaveLength(1);
    expect(imageReferencesFromToolResult({ results: [{ url: "https://cdn.example.com/a.jpg" }] })).toEqual([]);
    expect(imageReferencesFromToolResult({ images: "https://cdn.example.com/a.jpg" })).toEqual([]);
    expect(imageReferencesFromToolResult(["https://cdn.example.com/a.jpg"])).toEqual([]);
    expect(imageReferencesFromToolResult(null)).toEqual([]);
  });
});

describe("resolving attached images against returned references", () => {
  const references = normalizeImageReferences([
    {
      url: "https://cdn.example.com/villa.jpg",
      title: "Villa with pool",
      sourceUrl: "https://stays.example.com/rooms/1",
      width: 1200,
      height: 800,
    },
    { url: "https://cdn.example.com/loft.jpg", title: "City loft" },
  ]);

  it("attaches known images with metadata from the reference, not the model", () => {
    const { images, rejected } = resolveMessageImages(
      [
        { url: "https://cdn.example.com/villa.jpg", alt: "  Beachfront villa  " },
        { url: "https://cdn.example.com/villa.jpg", alt: "Same again" },
      ],
      references,
    );
    expect(rejected).toEqual([]);
    expect(images).toEqual([
      {
        url: "https://cdn.example.com/villa.jpg",
        alt: "Beachfront villa",
        sourceUrl: "https://stays.example.com/rooms/1",
        width: 1200,
        height: 800,
      },
    ]);
  });

  it("rejects URLs no tool returned, including look-alikes and unsafe schemes", () => {
    const { images, rejected } = resolveMessageImages(
      [
        { url: "https://cdn.example.com/villa.jpg?session=secret", alt: "Edited" },
        { url: "https://attacker.example.net/collect?data=notes", alt: "Invented" },
        { url: "http://cdn.example.com/villa.jpg", alt: "Downgraded" },
        { url: "https://cdn.example.com/loft.jpg", alt: "City loft" },
      ],
      references,
    );
    expect(images.map((image) => image.url)).toEqual(["https://cdn.example.com/loft.jpg"]);
    expect(rejected.map((item) => item.reason)).toEqual([
      expect.stringContaining("Not an image returned by a tool"),
      expect.stringContaining("Not an image returned by a tool"),
      "Not a public HTTPS image URL.",
    ]);
  });

  it("never attaches more than the per-reply limit", () => {
    const many = normalizeImageReferences(
      Array.from({ length: 10 }, (_, index) => ({ url: `https://cdn.example.com/${index}.jpg` })),
    );
    const { images, rejected } = resolveMessageImages(
      many.map((reference) => ({ url: reference.url, alt: "Photo" })),
      many,
    );
    expect(images).toHaveLength(maxMessageImages);
    expect(rejected).toHaveLength(10 - maxMessageImages);
  });
});

function toolCall(overrides: Partial<ToolCall>): ToolCall {
  return {
    id: "call-1",
    taskId: "task-1",
    coworkerId: "coworker-1",
    toolName: "chat.attach_images",
    arguments: {},
    status: "COMPLETED",
    risk: "low",
    approvalRequired: false,
    idempotencyKey: "key",
    result: { images: [{ url: "https://cdn.example.com/villa.jpg", alt: "Villa", sourceUrl: null }] },
    error: null,
    createdAt: "2026-01-01T10:00:00.000Z",
    completedAt: "2026-01-01T10:00:01.000Z",
    ...overrides,
  } as ToolCall;
}

describe("image sets recorded by attachment calls", () => {
  it("come only from completed attachment calls that kept an image", () => {
    expect(messageImageSetFromToolCall(toolCall({}))).toEqual({
      id: "call-1",
      taskId: "task-1",
      coworkerId: "coworker-1",
      createdAt: "2026-01-01T10:00:01.000Z",
      images: [{ url: "https://cdn.example.com/villa.jpg", alt: "Villa", sourceUrl: null }],
    });
    expect(messageImageSetFromToolCall(toolCall({ status: "FAILED" }))).toBeNull();
    expect(messageImageSetFromToolCall(toolCall({ toolName: "web.search" }))).toBeNull();
    expect(
      messageImageSetFromToolCall(
        toolCall({ result: { images: [{ url: "http://127.0.0.1/a.png", alt: "Local" }] } }),
      ),
    ).toBeNull();
  });

  it("ties a streamed assistant message back to its run", () => {
    const id = assistantMessageId("run:with:colons", 1_767_261_600_000);
    expect(runIdFromAssistantMessageId(id)).toBe("run:with:colons");
    expect(runIdFromAssistantMessageId("some-user-message")).toBeNull();
  });
});

describe("placing image sets above replies", () => {
  const set: MessageImageSet = {
    id: "set-1",
    taskId: "task-1",
    coworkerId: "coworker-1",
    createdAt: "2026-01-01T10:00:10.000Z",
    images: [
      { url: "https://cdn.example.com/a.jpg", alt: "A", sourceUrl: null },
      { url: "https://cdn.example.com/b.jpg", alt: "B", sourceUrl: null },
    ],
  };
  const message = (overrides: Partial<PlaceableMessage>): PlaceableMessage => ({
    id: "m",
    taskId: "task-1",
    role: "assistant",
    hasText: true,
    time: "2026-01-01T10:00:00.000Z",
    ...overrides,
  });
  const preface = message({ id: "preface", time: "2026-01-01T10:00:02.000Z" });
  const answer = message({ id: "answer", time: "2026-01-01T10:00:20.000Z" });

  it("shows images above the reply written after they were attached", () => {
    const placed = placeMessageImages({
      sets: [set],
      messages: [
        message({ id: "user", role: "user", time: "2026-01-01T10:00:00.000Z" }),
        preface,
        message({ id: "tool-only", hasText: false, time: "2026-01-01T10:00:05.000Z" }),
        answer,
        message({ id: "other-task", taskId: "task-2", time: "2026-01-01T10:00:30.000Z" }),
      ],
      runningTaskIds: new Set(),
    });
    expect([...placed.keys()]).toEqual(["answer"]);
    expect(placed.get("answer")).toEqual([
      { ...set.images[0], setId: "set-1", index: 0 },
      { ...set.images[1], setId: "set-1", index: 1 },
    ]);
  });

  it("waits for the answer while the task is running, then falls back to the last reply", () => {
    const running = placeMessageImages({
      sets: [set],
      messages: [preface],
      runningTaskIds: new Set(["task-1"]),
    });
    expect(running.size).toBe(0);

    const finished = placeMessageImages({ sets: [set], messages: [preface], runningTaskIds: new Set() });
    expect([...finished.keys()]).toEqual(["preface"]);
  });

  it("merges several sets on one reply without repeats and within the limit", () => {
    const second: MessageImageSet = {
      ...set,
      id: "set-2",
      createdAt: "2026-01-01T10:00:12.000Z",
      images: [
        set.images[1]!,
        ...Array.from({ length: 6 }, (_, index) => ({
          url: `https://cdn.example.com/extra-${index}.jpg`,
          alt: `Extra ${index}`,
          sourceUrl: null,
        })),
      ],
    };
    const placed = placeMessageImages({
      sets: [second, set],
      messages: [answer],
      runningTaskIds: new Set(),
    });
    const images = placed.get("answer") ?? [];
    expect(images).toHaveLength(maxMessageImages);
    expect(images.slice(0, 3).map((image) => `${image.setId}:${image.index}`)).toEqual([
      "set-1:0",
      "set-1:1",
      "set-2:1",
    ]);
  });

  it("shows nothing when the task has no reply text", () => {
    const placed = placeMessageImages({
      sets: [set],
      messages: [message({ id: "tool-only", hasText: false })],
      runningTaskIds: new Set(),
    });
    expect(placed.size).toBe(0);
  });
});
