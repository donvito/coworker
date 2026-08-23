import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  convertInchesToTwip,
  type FileChild,
} from "docx";
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";

export type DocumentFormat = "pdf" | "docx";

type DocumentBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; rows: string[][] }
  | { type: "rule" };

const a4 = { width: 595.28, height: 841.89 };
const pdfMargin = 54;
const pdfBottom = 48;

function plainText(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\\([\\`*{}[\]()#+\-.!_|>])/g, "$1")
    .trim();
}

function pdfText(value: string): string {
  return plainText(value)
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/€/g, "EUR ")
    .replace(/£/g, "GBP ")
    .replace(/[^\x20-\x7e]/g, "?");
}

function tableCells(line: string): string[] {
  const escapedPipe = "\u0000";
  const normalized = line.trim().replaceAll("\\|", escapedPipe);
  const withoutEdges = normalized.replace(/^\|/, "").replace(/\|$/, "");
  return withoutEdges
    .split("|")
    .map((cell) => plainText(cell.replaceAll(escapedPipe, "|")));
}

function isTableSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")));
}

export function parseDocumentMarkdown(content: string): DocumentBlock[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: DocumentBlock[] = [];

  for (let index = 0; index < lines.length; ) {
    const line = lines[index]!.trim();
    if (!line) {
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1]!.length,
        text: plainText(heading[2]!),
      });
      index += 1;
      continue;
    }

    const nextLine = lines[index + 1]?.trim();
    if (line.includes("|") && nextLine?.includes("|")) {
      const header = tableCells(line);
      const separator = tableCells(nextLine);
      if (header.length === separator.length && isTableSeparator(separator)) {
        const rows = [header];
        index += 2;
        while (index < lines.length) {
          const rowLine = lines[index]!.trim();
          if (!rowLine || !rowLine.includes("|")) break;
          const row = tableCells(rowLine);
          if (row.length !== header.length) break;
          rows.push(row);
          index += 1;
        }
        blocks.push({ type: "table", rows });
        continue;
      }
    }

    const listMatch = /^([-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[1]!);
      const items: string[] = [];
      while (index < lines.length) {
        const candidate = /^([-*+]|\d+[.)])\s+(.+)$/.exec(lines[index]!.trim());
        if (!candidate || /^\d/.test(candidate[1]!) !== ordered) break;
        items.push(plainText(candidate[2]!));
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    if (/^([-*_])(?:\s*\1){2,}$/.test(line)) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }

    blocks.push({ type: "paragraph", text: plainText(line) });
    index += 1;
  }

  return blocks;
}

function titleFromBlocks(blocks: DocumentBlock[], fallback: string): string {
  return blocks.find((block) => block.type === "heading")?.text || fallback;
}

function splitLongWord(word: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const character of word) {
    const candidate = current + character;
    if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      chunks.push(current);
      current = character;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function wrapPdfText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = pdfText(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";

  for (const rawWord of words) {
    const pieces =
      font.widthOfTextAtSize(rawWord, size) > maxWidth
        ? splitLongWord(rawWord, font, size, maxWidth)
        : [rawWord];
    for (const word of pieces) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
  }
  if (current) lines.push(current);
  return lines;
}

interface PdfCursor {
  document: PDFDocument;
  page: PDFPage;
  regular: PDFFont;
  bold: PDFFont;
  y: number;
}

function addPdfPage(cursor: PdfCursor): void {
  cursor.page = cursor.document.addPage([a4.width, a4.height]);
  cursor.y = a4.height - pdfMargin;
}

function ensurePdfSpace(cursor: PdfCursor, height: number): void {
  if (cursor.y - height < pdfBottom) addPdfPage(cursor);
}

function drawPdfText(
  cursor: PdfCursor,
  text: string,
  options: {
    font?: PDFFont;
    size?: number;
    color?: ReturnType<typeof rgb>;
    indent?: number;
    lineHeight?: number;
    after?: number;
  } = {},
): void {
  const font = options.font ?? cursor.regular;
  const size = options.size ?? 10.5;
  const indent = options.indent ?? 0;
  const lineHeight = options.lineHeight ?? size * 1.35;
  const maxWidth = a4.width - pdfMargin * 2 - indent;
  for (const line of wrapPdfText(text, font, size, maxWidth)) {
    ensurePdfSpace(cursor, lineHeight);
    cursor.page.drawText(line, {
      x: pdfMargin + indent,
      y: cursor.y - size,
      size,
      font,
      color: options.color ?? rgb(0.13, 0.18, 0.16),
    });
    cursor.y -= lineHeight;
  }
  cursor.y -= options.after ?? 5;
}

function drawPdfTable(cursor: PdfCursor, rows: string[][]): void {
  if (rows.length === 0) return;
  const columnCount = Math.max(...rows.map((row) => row.length));
  const tableWidth = a4.width - pdfMargin * 2;
  const firstWidth = columnCount > 2 ? tableWidth * 0.42 : tableWidth / columnCount;
  const remainingWidth =
    columnCount > 1 ? (tableWidth - firstWidth) / (columnCount - 1) : firstWidth;
  const widths = Array.from({ length: columnCount }, (_, index) =>
    index === 0 ? firstWidth : remainingWidth,
  );

  rows.forEach((row, rowIndex) => {
    const font = rowIndex === 0 ? cursor.bold : cursor.regular;
    const wrapped = widths.map((width, columnIndex) =>
      wrapPdfText(row[columnIndex] ?? "", font, 8.5, width - 10),
    );
    const rowHeight = Math.max(22, Math.max(...wrapped.map((lines) => lines.length)) * 10 + 10);
    ensurePdfSpace(cursor, rowHeight + 2);
    let x = pdfMargin;

    widths.forEach((width, columnIndex) => {
      cursor.page.drawRectangle({
        x,
        y: cursor.y - rowHeight,
        width,
        height: rowHeight,
        color: rowIndex === 0 ? rgb(0.91, 0.94, 0.93) : rgb(1, 1, 1),
        borderColor: rgb(0.75, 0.8, 0.78),
        borderWidth: 0.6,
      });
      wrapped[columnIndex]!.forEach((line, lineIndex) => {
        cursor.page.drawText(line, {
          x: x + 5,
          y: cursor.y - 13 - lineIndex * 10,
          size: 8.5,
          font,
          color: rgb(0.13, 0.18, 0.16),
        });
      });
      x += width;
    });
    cursor.y -= rowHeight;
  });
  cursor.y -= 10;
}

export async function createPdfDocument(
  content: string,
  fallbackTitle = "AI Coworker document",
): Promise<Uint8Array> {
  const blocks = parseDocumentMarkdown(content);
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const cursor: PdfCursor = {
    document,
    page: document.addPage([a4.width, a4.height]),
    regular,
    bold,
    y: a4.height - pdfMargin,
  };
  const title = titleFromBlocks(blocks, fallbackTitle);
  document.setTitle(title);
  document.setAuthor("AI Coworker");
  document.setCreator("AI Coworker");

  for (const block of blocks) {
    if (block.type === "heading") {
      const size = block.level === 1 ? 22 : block.level === 2 ? 16 : 12.5;
      ensurePdfSpace(cursor, size * 2);
      if (cursor.y < a4.height - pdfMargin) cursor.y -= block.level === 1 ? 8 : 4;
      drawPdfText(cursor, block.text, {
        font: bold,
        size,
        lineHeight: size * 1.25,
        after: block.level === 1 ? 12 : 7,
        color: rgb(0.11, 0.28, 0.22),
      });
    } else if (block.type === "paragraph") {
      drawPdfText(cursor, block.text);
    } else if (block.type === "list") {
      block.items.forEach((item, index) => {
        const prefix = block.ordered ? `${index + 1}.` : "-";
        drawPdfText(cursor, `${prefix} ${item}`, { indent: 12, after: 1 });
      });
      cursor.y -= 4;
    } else if (block.type === "table") {
      drawPdfTable(cursor, block.rows);
    } else {
      ensurePdfSpace(cursor, 14);
      cursor.page.drawLine({
        start: { x: pdfMargin, y: cursor.y - 4 },
        end: { x: a4.width - pdfMargin, y: cursor.y - 4 },
        thickness: 0.8,
        color: rgb(0.72, 0.78, 0.76),
      });
      cursor.y -= 14;
    }
  }

  if (blocks.length === 0) drawPdfText(cursor, fallbackTitle);
  return document.save();
}

function docxHeading(level: number): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  if (level <= 1) return HeadingLevel.TITLE;
  if (level === 2) return HeadingLevel.HEADING_1;
  if (level === 3) return HeadingLevel.HEADING_2;
  return HeadingLevel.HEADING_3;
}

function docxTable(rows: string[][]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    alignment: AlignmentType.CENTER,
    margins: {
      top: 80,
      bottom: 80,
      left: 100,
      right: 100,
    },
    borders: {
      top: { style: BorderStyle.SINGLE, color: "BFCBC6", size: 4 },
      bottom: { style: BorderStyle.SINGLE, color: "BFCBC6", size: 4 },
      left: { style: BorderStyle.SINGLE, color: "BFCBC6", size: 4 },
      right: { style: BorderStyle.SINGLE, color: "BFCBC6", size: 4 },
      insideHorizontal: { style: BorderStyle.SINGLE, color: "D7DEDB", size: 3 },
      insideVertical: { style: BorderStyle.SINGLE, color: "D7DEDB", size: 3 },
    },
    rows: rows.map(
      (row, rowIndex) =>
        new TableRow({
          tableHeader: rowIndex === 0,
          cantSplit: true,
          children: row.map(
            (cell) =>
              new TableCell({
                shading:
                  rowIndex === 0
                    ? { fill: "E8EFEC", type: ShadingType.CLEAR }
                    : undefined,
                children: [
                  new Paragraph({
                    children: [
                      new TextRun({
                        text: cell,
                        bold: rowIndex === 0,
                        color: "213A31",
                        size: 19,
                      }),
                    ],
                  }),
                ],
              }),
          ),
        }),
    ),
  });
}

export async function createWordDocument(
  content: string,
  fallbackTitle = "AI Coworker document",
): Promise<Buffer> {
  const blocks = parseDocumentMarkdown(content);
  const children: FileChild[] = [];

  for (const block of blocks) {
    if (block.type === "heading") {
      children.push(
        new Paragraph({
          heading: docxHeading(block.level),
          text: block.text,
          spacing: { before: block.level === 1 ? 0 : 160, after: 120 },
        }),
      );
    } else if (block.type === "paragraph") {
      children.push(
        new Paragraph({
          text: block.text,
          spacing: { after: 120, line: 300 },
        }),
      );
    } else if (block.type === "list") {
      block.items.forEach((item, index) => {
        children.push(
          new Paragraph({
            ...(block.ordered
              ? { children: [new TextRun(`${index + 1}. ${item}`)] }
              : { text: item, bullet: { level: 0 } }),
            spacing: { after: 60 },
          }),
        );
      });
    } else if (block.type === "table") {
      children.push(docxTable(block.rows));
      children.push(new Paragraph({ text: "", spacing: { after: 100 } }));
    } else {
      children.push(
        new Paragraph({
          text: "",
          border: {
            bottom: { style: BorderStyle.SINGLE, color: "BFCBC6", size: 4 },
          },
          spacing: { after: 120 },
        }),
      );
    }
  }

  if (children.length === 0) children.push(new Paragraph(fallbackTitle));
  const title = titleFromBlocks(blocks, fallbackTitle);
  const document = new Document({
    title,
    creator: "AI Coworker",
    description: "Generated locally by AI Coworker",
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(0.7),
              right: convertInchesToTwip(0.7),
              bottom: convertInchesToTwip(0.7),
              left: convertInchesToTwip(0.7),
            },
          },
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(document);
}

export async function createDocument(
  format: DocumentFormat,
  content: string,
  fallbackTitle?: string,
): Promise<Uint8Array> {
  return format === "pdf"
    ? createPdfDocument(content, fallbackTitle)
    : createWordDocument(content, fallbackTitle);
}
