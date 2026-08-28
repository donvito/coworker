import { describe, expect, it } from "vitest";
import {
  escapeTelegramHtml,
  markdownToTelegramChunks,
  markdownToTelegramHtml,
  plainTextChunks,
  telegramHtmlToPlainText,
} from "@main/integrations/telegram-format";

describe("markdown → Telegram HTML", () => {
  it("converts inline formatting", () => {
    expect(markdownToTelegramHtml("**bold** and *italic* and _also italic_")).toBe(
      "<b>bold</b> and <i>italic</i> and <i>also italic</i>",
    );
    expect(markdownToTelegramHtml("~~gone~~ and `code_span`")).toBe(
      "<s>gone</s> and <code>code_span</code>",
    );
    expect(markdownToTelegramHtml("see [the docs](https://example.test/a_b)")).toBe(
      'see <a href="https://example.test/a_b">the docs</a>',
    );
  });

  it("keeps markdown syntax inside inline code literal", () => {
    expect(markdownToTelegramHtml("run `pnpm **not bold**` now")).toBe(
      "run <code>pnpm **not bold**</code> now",
    );
  });

  it("escapes HTML-sensitive characters everywhere", () => {
    expect(markdownToTelegramHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
    expect(markdownToTelegramHtml("```\n<script>alert(1)</script>\n```")).toBe(
      "<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>",
    );
  });

  it("flattens block structure to Telegram's tag set", () => {
    const converted = markdownToTelegramHtml(
      "# Title\n\n- first\n- second\n\n1. one\n2. two\n\n> quoted line",
    );
    expect(converted).toBe(
      "<b>Title</b>\n\n• first\n• second\n\n1. one\n2. two\n\n<blockquote>quoted line</blockquote>",
    );
  });

  it("flattens a wide table into labelled rows", () => {
    // Telegram has no table markup, so raw pipes used to reach the chat.
    const converted = markdownToTelegramHtml(
      [
        "| Rank | Model | Provider | Context window |",
        "|---|---|---|---|",
        "| 1 | **Claude Opus 5** | Anthropic | ~1M tokens |",
        "| 2 | **GPT-5.6 Sol** | OpenAI | ~1.1M tokens |",
      ].join("\n"),
    );
    expect(converted).toBe(
      [
        "1. <b>Claude Opus 5</b>",
        "Provider: Anthropic",
        "Context window: ~1M tokens",
        "",
        "2. <b>GPT-5.6 Sol</b>",
        "Provider: OpenAI",
        "Context window: ~1.1M tokens",
      ].join("\n"),
    );
    expect(converted).not.toContain("|");
  });

  it("reads a two-column table as key — value lines", () => {
    expect(
      markdownToTelegramHtml(
        [
          "| Need | Recommended model |",
          "|---|---|",
          "| Best overall | Claude Opus 5 |",
          "| Best for coding | [Opus](https://example.test) |",
        ].join("\n"),
      ),
    ).toBe(
      [
        "<b>Best overall</b> — Claude Opus 5",
        '<b>Best for coding</b> — <a href="https://example.test">Opus</a>',
      ].join("\n"),
    );
  });

  it("leaves pipe characters alone outside tables", () => {
    expect(markdownToTelegramHtml("run `a | b` or a | b")).toBe(
      "run <code>a | b</code> or a | b",
    );
  });

  it("splits an oversize table between rows, never mid-row", () => {
    const rows = Array.from(
      { length: 40 },
      (_, index) => `| ${index + 1} | Model ${index} | Provider ${index} | ${index} tokens |`,
    );
    const chunks = markdownToTelegramChunks(
      ["| Rank | Model | Provider | Context |", "|---|---|---|---|", ...rows].join("\n"),
      600,
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(600);
      // Every row that appears is whole: a title always keeps its fields.
      for (const title of chunk.match(/^\d+\. <b>Model \d+<\/b>$/gm) ?? []) {
        const index = Number(title.match(/Model (\d+)/)![1]);
        expect(chunk).toContain(`Provider: Provider ${index}`);
        expect(chunk).toContain(`Context: ${index} tokens`);
      }
    }
  });

  it("renders fenced code blocks with their language", () => {
    expect(markdownToTelegramHtml("```ts\nconst a = 1;\n```")).toBe(
      '<pre><code class="language-ts">const a = 1;</code></pre>',
    );
  });

  it("chunks long content on block boundaries with balanced tags", () => {
    const paragraphs = Array.from({ length: 40 }, (_, index) =>
      `Paragraph ${index} ${"word ".repeat(30)}**bold${index}**`,
    ).join("\n\n");
    const chunks = markdownToTelegramChunks(paragraphs, 600);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(600);
      expect((chunk.match(/<b>/g) ?? []).length).toBe((chunk.match(/<\/b>/g) ?? []).length);
    }
    expect(telegramHtmlToPlainText(chunks.join("\n\n"))).toContain("Paragraph 39");
  });

  it("splits an oversize code block into balanced pre blocks", () => {
    const code = Array.from({ length: 200 }, (_, index) => `line_${index}`).join("\n");
    const chunks = markdownToTelegramChunks(`\`\`\`js\n${code}\n\`\`\``, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(500);
      expect(chunk.startsWith('<pre><code class="language-js">')).toBe(true);
      expect(chunk.endsWith("</code></pre>")).toBe(true);
    }
  });

  it("drops tags but keeps text in the plain-text fallback", () => {
    expect(telegramHtmlToPlainText('<b>bold</b> &amp; <a href="https://x.test">link</a>')).toBe(
      "bold & link",
    );
  });

  it("chunks plain text within the limit", () => {
    const chunks = plainTextChunks(`${"a".repeat(120)}\n${"b".repeat(120)}`, 130);
    expect(chunks).toEqual(["a".repeat(120), "b".repeat(120)]);
    expect(plainTextChunks("short")).toEqual(["short"]);
  });

  it("escapes quotes for attribute safety", () => {
    expect(escapeTelegramHtml('say "hi"')).toBe("say &quot;hi&quot;");
  });
});
