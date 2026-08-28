import { telegramMessageLimit } from "./telegram";

/**
 * Markdown → Telegram HTML. Telegram only accepts a small inline tag set
 * (<b> <i> <s> <u> <code> <pre> <a> <blockquote>), so block structure is
 * flattened: headings become bold lines, list items become "• " lines, and
 * tables become labelled lines (see {@link tableBlocks}).
 * Conversion happens block by block so every emitted chunk has balanced tags.
 */

export function escapeTelegramHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function unescapeTelegramHtml(text: string): string {
  return text
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** Strips tags from converted HTML, used as the delivery fallback. */
export function telegramHtmlToPlainText(html: string): string {
  return unescapeTelegramHtml(html.replace(/<[^>]+>/g, ""));
}

function formatInline(rawText: string): string {
  let text = escapeTelegramHtml(rawText);
  // Shelter inline code spans from the other replacements.
  const codeSpans: string[] = [];
  text = text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    codeSpans.push(code);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });
  text = text.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_match, label: string, href: string) => `<a href="${href}">${label}</a>`,
  );
  text = text.replace(/\*\*([^*\n](?:[^*\n]*[^*\n])?)\*\*/g, "<b>$1</b>");
  text = text.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, "<i>$1</i>");
  text = text.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, "<i>$1</i>");
  text = text.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  text = text.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => {
    return `<code>${codeSpans[Number(index)] ?? ""}</code>`;
  });
  return text;
}

interface Block {
  kind: "code" | "text";
  html: string;
  /** Code blocks carry their pieces so oversize ones can be re-wrapped per chunk. */
  language?: string;
  codeContent?: string;
}

function codeBlockHtml(language: string | undefined, escapedContent: string): string {
  const openTag = language
    ? `<pre><code class="language-${language}">`
    : "<pre><code>";
  return `${openTag}${escapedContent}</code></pre>`;
}

/** Bolds a rendered cell unless inline markdown already put tags in it. */
function boldIfPlain(html: string): string {
  return html.includes("<") ? html : `<b>${html}</b>`;
}

function isTableSeparator(line: string | undefined): boolean {
  if (line === undefined || !line.includes("|")) return false;
  return /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

function splitTableRow(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replaceAll("\\|", "|").trim());
}

/**
 * Telegram has no table markup and a phone has no width to spare, so a table
 * is flattened into text instead of being dumped as raw pipes.
 *
 * Two columns read as "key — value" lines in one block; the header of such a
 * table is almost always a restatement of the surrounding text ("Need |
 * Recommended model"), so it is dropped. Wider tables become one block per
 * row — a title line plus "header: value" lines — which also lets an oversize
 * table split between rows rather than mid-row.
 */
function tableBlocks(headers: string[], rows: string[][]): string[] {
  if (rows.length === 0) {
    const heading = headers.filter(Boolean).map(formatInline).join(" · ");
    return heading ? [boldIfPlain(heading)] : [];
  }

  if (headers.length <= 2) {
    const lines = rows
      .map((cells) => {
        const left = formatInline(cells[0] ?? "");
        const right = formatInline(cells[1] ?? "");
        if (!left) return right;
        if (!right) return left;
        return `${boldIfPlain(left)} — ${right}`;
      })
      .filter(Boolean);
    return lines.length > 0 ? [lines.join("\n")] : [];
  }

  const blocks: string[] = [];
  for (const cells of rows) {
    const lines: string[] = [];
    // A leading rank or index column reads as a title prefix, not a field.
    const index = (cells[0] ?? "").trim();
    const indexed = /^\d{1,3}[.)]?$/.test(index) && Boolean(cells[1]);
    const title = indexed
      ? `${index.replace(/[.)]$/, "")}. ${formatInline(cells[1]!)}`
      : formatInline(cells[0] ?? "");
    if (title) lines.push(boldIfPlain(title));
    for (let column = indexed ? 2 : 1; column < cells.length; column += 1) {
      const value = formatInline(cells[column] ?? "");
      if (!value) continue;
      const label = formatInline(headers[column] ?? "");
      lines.push(label ? `${label}: ${value}` : value);
    }
    if (lines.length > 0) blocks.push(lines.join("\n"));
  }
  return blocks;
}

function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  let index = 0;

  const pushText = (html: string) => {
    if (html.trim()) blocks.push({ kind: "text", html });
  };

  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*```([\w+-]*)\s*$/);
    if (fence) {
      const language = fence[1] || undefined;
      const content: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index]!)) {
        content.push(lines[index]!);
        index += 1;
      }
      index += 1; // Skip the closing fence (or run past a dangling one).
      const escaped = escapeTelegramHtml(content.join("\n"));
      blocks.push({
        kind: "code",
        html: codeBlockHtml(language, escaped),
        language,
        codeContent: escaped,
      });
      continue;
    }

    const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (heading) {
      pushText(`<b>${formatInline(heading[1]!.trim())}</b>`);
      index += 1;
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      pushText("———");
      index += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index]!)) {
        quoted.push(formatInline(lines[index]!.replace(/^\s*>\s?/, "")));
        index += 1;
      }
      pushText(`<blockquote>${quoted.join("\n")}</blockquote>`);
      continue;
    }

    if (/^\s*(?:[-*+]|\d{1,3}[.)])\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*(?:[-*+]|\d{1,3}[.)])\s+/.test(lines[index]!)) {
        const item = lines[index]!;
        const indent = item.match(/^(\s*)/)?.[1] ?? "";
        const ordered = item.match(/^\s*(\d{1,3})[.)]\s+(.*)$/);
        if (ordered) {
          items.push(`${indent}${ordered[1]}. ${formatInline(ordered[2]!)}`);
        } else {
          items.push(`${indent}• ${formatInline(item.replace(/^\s*[-*+]\s+/, ""))}`);
        }
        index += 1;
      }
      pushText(items.join("\n"));
      continue;
    }

    if (line.includes("|") && isTableSeparator(lines[index + 1])) {
      const headers = splitTableRow(line);
      index += 2; // The header row and its separator.
      const rows: string[][] = [];
      while (index < lines.length && lines[index]!.trim() && lines[index]!.includes("|")) {
        rows.push(splitTableRow(lines[index]!));
        index += 1;
      }
      for (const html of tableBlocks(headers, rows)) pushText(html);
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index]!.trim() &&
      !/^\s*```/.test(lines[index]!) &&
      !/^\s*#{1,6}\s+/.test(lines[index]!) &&
      !/^\s*>/.test(lines[index]!) &&
      !/^\s*(?:[-*+]|\d{1,3}[.)])\s+/.test(lines[index]!) &&
      !(lines[index]!.includes("|") && isTableSeparator(lines[index + 1]))
    ) {
      paragraph.push(formatInline(lines[index]!));
      index += 1;
    }
    pushText(paragraph.join("\n"));
  }

  return blocks;
}

function splitOversizeBlock(block: Block, limit: number): string[] {
  if (block.kind === "code") {
    const wrapper = codeBlockHtml(block.language, "").length;
    const budget = Math.max(limit - wrapper, 64);
    const pieces: string[] = [];
    let current = "";
    for (const line of (block.codeContent ?? "").split("\n")) {
      const candidate = current ? `${current}\n${line}` : line;
      if (candidate.length > budget && current) {
        pieces.push(current);
        current = line.length > budget ? "" : line;
        if (line.length > budget) {
          for (let start = 0; start < line.length; start += budget) {
            pieces.push(line.slice(start, start + budget));
          }
        }
      } else if (candidate.length > budget) {
        for (let start = 0; start < candidate.length; start += budget) {
          pieces.push(candidate.slice(start, start + budget));
        }
        current = "";
      } else {
        current = candidate;
      }
    }
    if (current) pieces.push(current);
    return pieces.map((piece) => codeBlockHtml(block.language, piece));
  }
  // Oversize prose: give up on inline tags for this block so character splits
  // can never break tag balance.
  const plain = escapeTelegramHtml(telegramHtmlToPlainText(block.html));
  const pieces: string[] = [];
  for (let start = 0; start < plain.length; start += limit) {
    pieces.push(plain.slice(start, start + limit));
  }
  return pieces;
}

/** Converts markdown into Telegram-HTML chunks, each within the message limit. */
export function markdownToTelegramChunks(
  markdown: string,
  limit = telegramMessageLimit,
): string[] {
  const rendered: string[] = [];
  for (const block of parseBlocks(markdown)) {
    if (block.html.length > limit) rendered.push(...splitOversizeBlock(block, limit));
    else rendered.push(block.html);
  }
  const chunks: string[] = [];
  let current = "";
  for (const piece of rendered) {
    const candidate = current ? `${current}\n\n${piece}` : piece;
    if (candidate.length > limit && current) {
      chunks.push(current);
      current = piece;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Whole-document conversion, mainly for tests and short strings. */
export function markdownToTelegramHtml(markdown: string): string {
  return markdownToTelegramChunks(markdown, Number.MAX_SAFE_INTEGER).join("\n\n");
}

/** Splits already-plain text into chunks within the Telegram message limit. */
export function plainTextChunks(text: string, limit = telegramMessageLimit): string[] {
  if (text.length <= limit) return text ? [text] : [];
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit && current) {
      chunks.push(current);
      current = "";
    }
    if (line.length > limit) {
      for (let start = 0; start < line.length; start += limit) {
        chunks.push(line.slice(start, start + limit));
      }
      current = "";
    } else if (!current) {
      current = line;
    } else {
      current = `${current}\n${line}`;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
