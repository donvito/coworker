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
import ExcelJS from "exceljs";
import PptxGenJS from "pptxgenjs";

export type DocumentFormat = "pdf" | "docx" | "xlsx" | "csv" | "pptx";

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

function spreadsheetCellValue(value: string): string | number | boolean {
  const normalized = value.trim();
  if (/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(normalized)) {
    const number = Number(normalized.replaceAll(",", ""));
    if (Number.isFinite(number)) return number;
  }
  if (/^(?:true|false)$/i.test(normalized)) return normalized.toLowerCase() === "true";
  return normalized;
}

function worksheetName(value: string): string {
  const normalized = value.replace(/[\\/?*:[\]]/g, " ").replace(/\s+/g, " ").trim();
  return (normalized || "Report").slice(0, 31);
}

function csvCell(value: string): string {
  const safe = /^[=+@]/.test(value) || /^-\D/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function createCsvDocument(content: string): Buffer {
  const tables = parseDocumentMarkdown(content).filter(
    (block): block is Extract<DocumentBlock, { type: "table" }> => block.type === "table",
  );
  if (tables.length === 0) {
    throw new Error("CSV export requires a Markdown table with a header row");
  }
  if (tables.length > 1) {
    throw new Error("CSV export supports one table; use XLSX for a multi-section report");
  }
  const csv = tables[0]!.rows
    .map((row) => row.map((cell) => csvCell(cell)).join(","))
    .join("\r\n");
  return Buffer.from(`\uFEFF${csv}\r\n`, "utf8");
}

export async function createExcelDocument(
  content: string,
  fallbackTitle = "Coworker report",
): Promise<Buffer> {
  const blocks = parseDocumentMarkdown(content);
  const tables = blocks.filter(
    (block): block is Extract<DocumentBlock, { type: "table" }> => block.type === "table",
  );
  if (tables.length === 0) {
    throw new Error("Excel export requires at least one Markdown table with a header row");
  }

  const title = titleFromBlocks(blocks, fallbackTitle);
  const columnCount = Math.max(1, ...tables.flatMap((table) => table.rows.map((row) => row.length)));
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Coworker";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.subject = "Generated locally by Coworker";
  workbook.title = title;

  const worksheet = workbook.addWorksheet(worksheetName(title), {
    properties: { defaultRowHeight: 20 },
    pageSetup: { fitToPage: true, fitToWidth: 1, orientation: "landscape" },
    views: [{ showGridLines: false }],
  });
  let firstTableHeaderRow: number | null = null;
  let firstTableEndRow: number | null = null;

  for (const block of blocks) {
    if (block.type === "heading") {
      const row = worksheet.addRow([block.text]);
      if (columnCount > 1) worksheet.mergeCells(row.number, 1, row.number, columnCount);
      row.height = block.level === 1 ? 30 : 24;
      const cell = row.getCell(1);
      cell.font = {
        bold: true,
        color: { argb: "FF173A2F" },
        size: block.level === 1 ? 18 : block.level === 2 ? 14 : 12,
      };
      cell.alignment = { vertical: "middle" };
      if (block.level === 1) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EFEC" } };
      }
    } else if (block.type === "paragraph") {
      const row = worksheet.addRow([block.text]);
      if (columnCount > 1) worksheet.mergeCells(row.number, 1, row.number, columnCount);
      row.getCell(1).alignment = { vertical: "top", wrapText: true };
      row.height = Math.max(20, Math.ceil(block.text.length / 90) * 18);
    } else if (block.type === "list") {
      block.items.forEach((item, index) => {
        const marker = block.ordered ? `${index + 1}.` : "•";
        const row = worksheet.addRow([`${marker} ${item}`]);
        if (columnCount > 1) worksheet.mergeCells(row.number, 1, row.number, columnCount);
        row.getCell(1).alignment = { wrapText: true };
      });
    } else if (block.type === "table") {
      const startRow = worksheet.rowCount + 1;
      block.rows.forEach((values, rowIndex) => {
        const row = worksheet.addRow(values.map(spreadsheetCellValue));
        row.height = rowIndex === 0 ? 24 : 21;
        row.eachCell({ includeEmpty: true }, (cell) => {
          cell.alignment = { vertical: "middle", wrapText: true };
          cell.border = {
            top: { style: "thin", color: { argb: "FFD7DEDB" } },
            left: { style: "thin", color: { argb: "FFD7DEDB" } },
            bottom: { style: "thin", color: { argb: "FFD7DEDB" } },
            right: { style: "thin", color: { argb: "FFD7DEDB" } },
          };
          if (rowIndex === 0) {
            cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF245845" } };
          } else if (rowIndex % 2 === 0) {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF4F7F5" } };
          }
        });
      });
      if (firstTableHeaderRow === null) {
        firstTableHeaderRow = startRow;
        firstTableEndRow = worksheet.rowCount;
      }
      worksheet.addRow([]);
    } else {
      worksheet.addRow([]);
    }
  }

  for (let columnIndex = 1; columnIndex <= columnCount; columnIndex += 1) {
    let width = 12;
    for (const table of tables) {
      for (const row of table.rows) {
        width = Math.max(width, Math.min(42, (row[columnIndex - 1] ?? "").length + 3));
      }
    }
    worksheet.getColumn(columnIndex).width = width;
  }
  if (firstTableHeaderRow !== null && firstTableEndRow !== null) {
    worksheet.autoFilter = {
      from: { row: firstTableHeaderRow, column: 1 },
      to: { row: firstTableEndRow, column: columnCount },
    };
    worksheet.views = [
      { state: "frozen", ySplit: firstTableHeaderRow, showGridLines: false },
    ];
  }

  const bytes = await workbook.xlsx.writeBuffer();
  return Buffer.from(bytes);
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
  fallbackTitle = "Coworker document",
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
  document.setAuthor("Coworker");
  document.setCreator("Coworker");

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
  fallbackTitle = "Coworker document",
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
    creator: "Coworker",
    description: "Generated locally by Coworker",
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

interface SlideDraft {
  title: string;
  body: Array<{ text: string; bullet: boolean; bold: boolean }>;
  tables: string[][][];
}

const slideBodyLineLimit = 9;

/**
 * Markdown → PowerPoint: `#` becomes the cover slide, every `##` starts a
 * slide, `###` renders as a bold lead-in line, lists become bullets, tables
 * become slide tables, and `---` forces a slide break.
 */
export async function createPptxDocument(
  content: string,
  fallbackTitle = "Coworker presentation",
): Promise<Buffer> {
  const blocks = parseDocumentMarkdown(content);
  const title = titleFromBlocks(blocks, fallbackTitle);

  const slides: SlideDraft[] = [];
  let current: SlideDraft | null = null;
  const openSlide = (slideTitle: string): SlideDraft => {
    const draft: SlideDraft = { title: slideTitle, body: [], tables: [] };
    slides.push(draft);
    current = draft;
    return draft;
  };

  let coverConsumed = false;
  for (const block of blocks) {
    if (block.type === "heading" && block.level <= 2) {
      if (!coverConsumed && block.level === 1 && slides.length === 0) {
        coverConsumed = true; // The document title is already the cover slide.
        continue;
      }
      openSlide(plainText(block.text));
      continue;
    }
    if (block.type === "rule") {
      current = null; // The next content opens a fresh slide.
      continue;
    }
    const slide = current ?? openSlide("");
    if (block.type === "heading") {
      slide.body.push({ text: plainText(block.text), bullet: false, bold: true });
    } else if (block.type === "paragraph") {
      slide.body.push({ text: plainText(block.text), bullet: false, bold: false });
    } else if (block.type === "list") {
      for (const item of block.items) {
        slide.body.push({ text: plainText(item), bullet: true, bold: false });
      }
    } else if (block.type === "table") {
      slide.tables.push(block.rows);
    }
  }

  // Long sections continue onto follow-up slides instead of overflowing.
  const paged: SlideDraft[] = [];
  for (const slide of slides) {
    if (slide.body.length <= slideBodyLineLimit) {
      paged.push(slide);
      continue;
    }
    for (let start = 0; start < slide.body.length; start += slideBodyLineLimit) {
      paged.push({
        title: start === 0 ? slide.title : `${slide.title} (cont.)`,
        body: slide.body.slice(start, start + slideBodyLineLimit),
        tables: start === 0 ? slide.tables : [],
      });
    }
  }

  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "COWORKER_WIDE", width: 13.33, height: 7.5 });
  pptx.layout = "COWORKER_WIDE";
  pptx.author = "Coworker";
  pptx.subject = "Generated locally by Coworker";
  pptx.title = title;

  const cover = pptx.addSlide();
  cover.background = { color: "F5F3EC" };
  cover.addText(title, {
    x: 0.9,
    y: 2.5,
    w: 11.5,
    h: 1.8,
    fontSize: 40,
    bold: true,
    color: "1E3A2F",
  });
  cover.addText("Generated locally by Coworker", {
    x: 0.9,
    y: 4.3,
    w: 11.5,
    h: 0.5,
    fontSize: 14,
    color: "5E6B64",
  });

  for (const draft of paged) {
    const slide = pptx.addSlide();
    slide.background = { color: "FFFFFF" };
    if (draft.title) {
      slide.addText(draft.title, {
        x: 0.7,
        y: 0.45,
        w: 12,
        h: 0.8,
        fontSize: 26,
        bold: true,
        color: "1E3A2F",
      });
    }
    const contentTop = draft.title ? 1.5 : 0.8;
    if (draft.body.length > 0) {
      slide.addText(
        draft.body.map((line) => ({
          text: line.text,
          options: {
            bullet: line.bullet ? { indent: 12 } : (false as const),
            bold: line.bold,
            breakLine: true,
            fontSize: line.bold ? 17 : 15,
            color: "26312B",
          },
        })),
        { x: 0.8, y: contentTop, w: 11.8, h: 5.6, valign: "top" },
      );
    }
    let tableY = draft.body.length > 0
      ? Math.min(contentTop + draft.body.length * 0.42 + 0.2, 5.4)
      : contentTop;
    for (const rows of draft.tables) {
      const [head, ...rest] = rows;
      slide.addTable(
        [
          (head ?? []).map((cell) => ({
            text: cell,
            options: { bold: true, fill: { color: "E7EEE9" } },
          })),
          ...rest.map((row) => row.map((cell) => ({ text: cell }))),
        ],
        {
          x: 0.8,
          y: tableY,
          w: 11.8,
          fontSize: 12,
          color: "26312B",
          border: { type: "solid", color: "C9D4CD", pt: 0.5 },
          autoPage: true,
        },
      );
      tableY = Math.min(tableY + (rows.length + 1) * 0.36 + 0.3, 6.4);
    }
  }

  const output = await pptx.write({ outputType: "nodebuffer" });
  return Buffer.isBuffer(output) ? output : Buffer.from(output as ArrayBuffer);
}

export async function createDocument(
  format: DocumentFormat,
  content: string,
  fallbackTitle?: string,
): Promise<Uint8Array> {
  if (format === "pdf") return createPdfDocument(content, fallbackTitle);
  if (format === "docx") return createWordDocument(content, fallbackTitle);
  if (format === "xlsx") return createExcelDocument(content, fallbackTitle);
  if (format === "pptx") return createPptxDocument(content, fallbackTitle);
  return createCsvDocument(content);
}
