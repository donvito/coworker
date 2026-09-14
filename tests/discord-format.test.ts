import { describe, expect, it } from "vitest";
import {
  markdownToDiscordChunks,
  markdownToDiscordMarkdown,
  plainTextChunks,
} from "@main/integrations/discord-format";

describe("markdown → Discord markdown", () => {
  it("keeps inline formatting", () => {
    expect(markdownToDiscordMarkdown("**bold** and *italic* and `code`")).toBe(
      "**bold** and *italic* and `code`",
    );
  });

  it("turns headings into bold lines", () => {
    expect(markdownToDiscordMarkdown("# Title\n\nnext")).toBe("**Title**\n\nnext");
  });

  it("flattens a wide table into labelled rows", () => {
    const converted = markdownToDiscordMarkdown(
      [
        "| Rank | Model | Provider | Context window |",
        "|---|---|---|---|",
        "| 1 | Claude Opus 5 | Anthropic | ~1M tokens |",
        "| 2 | GPT-5.6 Sol | OpenAI | ~1.1M tokens |",
      ].join("\n"),
    );
    expect(converted).toBe(
      [
        "**1. Claude Opus 5**",
        "Provider: Anthropic",
        "Context window: ~1M tokens",
        "",
        "**2. GPT-5.6 Sol**",
        "Provider: OpenAI",
        "Context window: ~1.1M tokens",
      ].join("\n"),
    );
    expect(converted).not.toContain("|");
  });

  it("reads a two-column table as key — value lines", () => {
    expect(
      markdownToDiscordMarkdown(
        [
          "| Need | Recommended model |",
          "|---|---|",
          "| Best overall | Claude Opus 5 |",
          "| Best for coding | Opus |",
        ].join("\n"),
      ),
    ).toBe("**Best overall** — Claude Opus 5\n**Best for coding** — Opus");
  });

  it("chunks long content on block boundaries with balanced fences", () => {
    const paragraphs = Array.from(
      { length: 40 },
      (_, index) => `Paragraph ${index} ${"word ".repeat(20)}**bold${index}**`,
    ).join("\n\n");
    const chunks = markdownToDiscordChunks(paragraphs, 400);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(400);
    }
    expect(chunks.join("\n\n")).toContain("Paragraph 39");
  });

  it("splits an oversize code block into balanced fences", () => {
    const code = Array.from({ length: 80 }, (_, index) => `line_${index}`).join("\n");
    const chunks = markdownToDiscordChunks(`\`\`\`js\n${code}\n\`\`\``, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(200);
      expect(chunk.startsWith("```js\n")).toBe(true);
      expect(chunk.endsWith("\n```")).toBe(true);
    }
  });

  it("chunks at Discord's 2000-character limit by default", () => {
    const chunks = markdownToDiscordChunks("x".repeat(2500));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
  });

  it("preserves all proposed text and Unicode across plain-text chunks", () => {
    const text = `\n\n${"a".repeat(7)}😀${"🧠".repeat(12)}\n\n- Keep blank lines.\n`;
    const chunks = plainTextChunks(text, 8);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(8);
    }
  });
});
