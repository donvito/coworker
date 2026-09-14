import { discordMessageLimit } from "./discord";

/**
 * Markdown → Discord markdown. Discord already accepts most CommonMark, so
 * this mainly flattens tables (Discord has no table markup) and chunks at
 * 2,000 characters with balanced code fences.
 */

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

function tableBlocks(headers: string[], rows: string[][]): string[] {
  if (rows.length === 0) {
    const heading = headers.filter(Boolean).join(" · ");
    return heading ? [`**${heading}**`] : [];
  }

  if (headers.length <= 2) {
    const lines = rows
      .map((cells) => {
        const left = cells[0] ?? "";
        const right = cells[1] ?? "";
        if (!left) return right;
        if (!right) return left;
        return `**${left}** — ${right}`;
      })
      .filter(Boolean);
    return lines.length > 0 ? [lines.join("\n")] : [];
  }

  const blocks: string[] = [];
  for (const cells of rows) {
    const lines: string[] = [];
    const index = (cells[0] ?? "").trim();
    const indexed = /^\d{1,3}[.)]?$/.test(index) && Boolean(cells[1]);
    const title = indexed ? `${index.replace(/[.)]$/, "")}. ${cells[1]!}` : (cells[0] ?? "");
    if (title) lines.push(`**${title}**`);
    for (let column = indexed ? 2 : 1; column < cells.length; column += 1) {
      const value = cells[column] ?? "";
      if (!value) continue;
      const label = headers[column] ?? "";
      lines.push(label ? `${label}: ${value}` : value);
    }
    if (lines.length > 0) blocks.push(lines.join("\n"));
  }
  return blocks;
}

interface Block {
  kind: "code" | "text";
  text: string;
  language?: string;
  codeContent?: string;
}

function codeFence(language: string | undefined, content: string): string {
  const tag = language ? `\`\`\`${language}` : "```";
  return `${tag}\n${content}\n\`\`\``;
}

function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  let index = 0;

  const pushText = (text: string) => {
    if (text.trim()) blocks.push({ kind: "text", text });
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
      index += 1;
      const joined = content.join("\n");
      blocks.push({
        kind: "code",
        text: codeFence(language, joined),
        language,
        codeContent: joined,
      });
      continue;
    }

    const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (heading) {
      pushText(`**${heading[1]!.trim()}**`);
      index += 1;
      continue;
    }

    if (line.includes("|") && isTableSeparator(lines[index + 1])) {
      const headers = splitTableRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index]!.trim() && lines[index]!.includes("|")) {
        rows.push(splitTableRow(lines[index]!));
        index += 1;
      }
      for (const text of tableBlocks(headers, rows)) pushText(text);
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index]!.trim() &&
      !/^\s*```/.test(lines[index]!) &&
      !/^\s*#{1,6}\s+/.test(lines[index]!) &&
      !(lines[index]!.includes("|") && isTableSeparator(lines[index + 1]))
    ) {
      paragraph.push(lines[index]!);
      index += 1;
    }
    pushText(paragraph.join("\n"));
  }

  return blocks;
}

function splitOversizeBlock(block: Block, limit: number): string[] {
  if (block.kind === "code") {
    const wrapper = codeFence(block.language, "").length;
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
    return pieces.map((piece) => codeFence(block.language, piece));
  }
  return plainTextChunks(block.text, limit);
}

/** Converts markdown into Discord-markdown chunks, each within the message limit. */
export function markdownToDiscordChunks(
  markdown: string,
  limit = discordMessageLimit,
): string[] {
  const rendered: string[] = [];
  for (const block of parseBlocks(markdown)) {
    if (block.text.length > limit) rendered.push(...splitOversizeBlock(block, limit));
    else rendered.push(block.text);
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
export function markdownToDiscordMarkdown(markdown: string): string {
  return markdownToDiscordChunks(markdown, Number.MAX_SAFE_INTEGER).join("\n\n");
}

/** Splits already-plain text into chunks within the Discord message limit. */
export function plainTextChunks(text: string, limit = discordMessageLimit): string[] {
  if (!Number.isInteger(limit) || limit < 2) {
    throw new Error("Text chunk limit must be an integer of at least 2.");
  }
  if (text.length <= limit) return text ? [text] : [];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const newline = remaining.lastIndexOf("\n", limit - 1);
    let end = newline > 0 ? newline + 1 : limit;
    const last = remaining.charCodeAt(end - 1);
    const next = remaining.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
