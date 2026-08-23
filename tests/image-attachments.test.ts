import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunAgentInput } from "@ag-ui/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadImageAttachments,
  parseAgentPrompt,
  persistImageAttachments,
  removePersistedImageAttachments,
} from "@main/integrations/image-attachments";
import { CoworkerDatabase } from "@main/db/database";
import { agentRunRequestSchema } from "@shared/validation";

const temporaryPaths: string[] = [];
const pngFixture = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("fixture"),
]);

function runInput(content: unknown): RunAgentInput {
  return {
    threadId: "thread-1",
    runId: "run-1",
    state: {},
    messages: [{ id: "message-1", role: "user", content }],
    tools: [],
    context: [],
  } as RunAgentInput;
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("image attachments", () => {
  it("extracts text and validated image data from an AG-UI user message", () => {
    const image = pngFixture;
    const parsed = parseAgentPrompt(
      runInput([
        { type: "text", text: "Read this receipt" },
        {
          type: "image",
          source: { type: "data", value: image.toString("base64"), mimeType: "image/png" },
          metadata: { name: "receipt.png" },
        },
      ]),
    );

    expect(parsed.text).toBe("Read this receipt");
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]).toMatchObject({
      mimeType: "image/png",
      name: "receipt.png",
    });
    expect(parsed.images[0]?.data).toEqual(image);
  });

  it("rejects invalid image types and base64", () => {
    expect(() =>
      parseAgentPrompt(
        runInput([
          {
            type: "image",
            source: { type: "data", value: "not base64", mimeType: "image/png" },
          },
        ]),
      ),
    ).toThrow("invalid base64");
    expect(() =>
      parseAgentPrompt(
        runInput([
          {
            type: "image",
            source: {
              type: "data",
              value: Buffer.from("svg").toString("base64"),
              mimeType: "image/svg+xml",
            },
          },
        ]),
      ),
    ).toThrow("JPEG, PNG, WebP, or GIF");
    expect(() =>
      parseAgentPrompt(
        runInput([
          {
            type: "image",
            source: {
              type: "data",
              value: Buffer.from("not really a png").toString("base64"),
              mimeType: "image/png",
            },
            metadata: { name: "fake.png" },
          },
        ]),
      ),
    ).toThrow("does not match its declared image format");
  });

  it("rejects remote and excessive image payloads at the IPC boundary", () => {
    const remote = agentRunRequestSchema.safeParse({
      coworkerId: "coworker-1",
      input: runInput([
        {
          type: "image",
          source: { type: "url", value: "https://example.test/image.png" },
        },
      ]),
    });
    expect(remote.success).toBe(false);

    const imagePart = {
      type: "image",
      source: {
        type: "data",
        value: pngFixture.toString("base64"),
        mimeType: "image/png",
      },
    };
    const excessive = agentRunRequestSchema.safeParse({
      coworkerId: "coworker-1",
      input: runInput(Array.from({ length: 5 }, () => imagePart)),
    });
    expect(excessive.success).toBe(false);
  });

  it("stores image context in the coworker workspace and reloads it for Pi", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-images-"));
    temporaryPaths.push(root);
    const image = Buffer.from("durable image context");
    const [saved] = await persistImageAttachments(root, "task-1", [
      { data: image, mimeType: "image/jpeg", name: "photo.jpg" },
    ]);

    const loaded = await loadImageAttachments(root, [
      {
        ...saved!,
        taskId: "task-1",
        coworkerId: "coworker-1",
        createdAt: new Date().toISOString(),
      },
    ]);
    expect(loaded).toEqual([
      {
        type: "image",
        data: image.toString("base64"),
        mimeType: "image/jpeg",
      },
    ]);

    await removePersistedImageAttachments(root, "task-1");
    await expect(loadImageAttachments(root, [
      {
        ...saved!,
        taskId: "task-1",
        coworkerId: "coworker-1",
        createdAt: new Date().toISOString(),
      },
    ])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records attachment metadata against its task", () => {
    const database = new CoworkerDatabase(":memory:");
    try {
      const coworker = database.createCoworker(
        {
          name: "Vision",
          role: "Image reviewer",
          systemPrompt: "Review attached images.",
          modelProvider: "openai",
          modelName: "gpt-4.1-mini",
          enabledTools: [],
        },
        "/tmp/vision",
      );
      const task = database.createTask({
        coworkerId: coworker.id,
        title: "Review image",
        input: "Review this image.",
      });
      database.addTaskImageAttachment({
        id: "image-1",
        taskId: task.id,
        coworkerId: coworker.id,
        name: "screen.png",
        mimeType: "image/png",
        relativePath: ".coworker/image-context/task/screen.png",
        size: 128,
      });

      expect(database.listTaskImageAttachments(task.id)).toEqual([
        expect.objectContaining({
          id: "image-1",
          name: "screen.png",
          size: 128,
        }),
      ]);
    } finally {
      database.close();
    }
  });
});
