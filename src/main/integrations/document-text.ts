import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { extractText } from "unpdf";

export const maxDocumentBytes = 10_000_000;
export const maxExtractedCharacters = 400_000;

export interface DocumentTextContent {
  kind: "text";
  name: string;
  format: "text" | "pdf" | "docx" | "xlsx";
  content: string;
  truncated: boolean;
  totalPages?: number;
}

export interface DocumentBinaryInfo {
  kind: "binary";
  name: string;
  size: number;
  mimeType: string;
  message: string;
}

export type DocumentTextResult = DocumentTextContent | DocumentBinaryInfo;

const binaryMimeTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".doc": "application/msword",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xls": "application/vnd.ms-excel",
  ".numbers": "application/vnd.apple.numbers",
  ".pages": "application/vnd.apple.pages",
  ".key": "application/vnd.apple.keynote",
};

function truncated(content: string): { content: string; truncated: boolean } {
  if (content.length <= maxExtractedCharacters) return { content, truncated: false };
  return { content: content.slice(0, maxExtractedCharacters), truncated: true };
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replaceAll(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function extractDocxParagraphs(documentXml: string): string {
  const withBreaks = documentXml
    .replaceAll(/<w:tab\b[^>]*\/>/g, "<w:t>\t</w:t>")
    .replaceAll(/<w:br\b[^>]*\/>/g, "<w:t>\n</w:t>");
  const lines = withBreaks.split(/<\/w:p>/).map((paragraph) =>
    [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
      .map((match) => decodeXmlEntities(match[1] ?? ""))
      .join(""),
  );
  return lines.join("\n").replaceAll(/\n{3,}/g, "\n\n").trim();
}

async function readDocx(name: string, buffer: Buffer): Promise<DocumentTextContent> {
  const archive = await JSZip.loadAsync(buffer);
  const documentXml = archive.file("word/document.xml");
  if (!documentXml) {
    throw new Error(`${name} is not a readable Word document`);
  }
  const text = extractDocxParagraphs(await documentXml.async("string"));
  return { kind: "text", name, format: "docx", ...truncated(text) };
}

async function readXlsx(name: string, buffer: Buffer): Promise<DocumentTextContent> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const lines: string[] = [];
  let length = 0;
  for (const sheet of workbook.worksheets) {
    lines.push(`# Sheet: ${sheet.name}`);
    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (length > maxExtractedCharacters) return;
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        cells.push(String(cell.text ?? "").trim());
      });
      const line = cells.join(" | ").trimEnd();
      lines.push(line);
      length += line.length + 1;
    });
    lines.push("");
    if (length > maxExtractedCharacters) break;
  }
  return { kind: "text", name, format: "xlsx", ...truncated(lines.join("\n").trim()) };
}

async function readPdf(name: string, buffer: Buffer): Promise<DocumentTextContent> {
  const { totalPages, text } = await extractText(new Uint8Array(buffer), { mergePages: true });
  return { kind: "text", name, format: "pdf", totalPages, ...truncated(text.trim()) };
}

function decodeText(buffer: Buffer): string | null {
  // Windows editors commonly write UTF-16 text files with a byte-order mark.
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(buffer);
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(buffer);
  }
  if (buffer.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

const knownTextExtensions = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".htm",
  ".log",
  ".rtf",
]);

/**
 * Read a document or file as prompt-ready text. Extracts text from PDF, Word
 * DOCX, and Excel XLSX documents; reads text files directly; and reports
 * metadata for binary files that have no text representation.
 */
export async function readDocumentText(path: string): Promise<DocumentTextResult> {
  const name = basename(path);
  const stats = await stat(path);
  if (stats.isDirectory()) {
    throw new Error(`${name} is a directory, not a file`);
  }
  if (!stats.isFile()) {
    throw new Error(`${name} is not a regular file`);
  }
  const extension = extname(name).toLowerCase();
  if (stats.size > maxDocumentBytes) {
    if (extension === ".pdf" || extension === ".docx" || extension === ".xlsx" || knownTextExtensions.has(extension)) {
      throw new Error(`${name} is larger than ${Math.round(maxDocumentBytes / 1_000_000)} MB and cannot be read`);
    }
    return {
      kind: "binary",
      name,
      size: stats.size,
      mimeType: binaryMimeTypes[extension] ?? "application/octet-stream",
      message: `${name} is too large to read (${stats.size} bytes).`,
    };
  }

  const buffer = await readFile(path);
  if (extension === ".pdf") return readPdf(name, buffer);
  if (extension === ".docx") return readDocx(name, buffer);
  if (extension === ".xlsx") return readXlsx(name, buffer);

  const text = decodeText(buffer);
  if (text !== null) {
    return { kind: "text", name, format: "text", ...truncated(text) };
  }
  if (knownTextExtensions.has(extension)) {
    // Non-UTF-8 legacy text encodings still deserve a best-effort read.
    return {
      kind: "text",
      name,
      format: "text",
      ...truncated(new TextDecoder("utf-8").decode(buffer)),
    };
  }
  return {
    kind: "binary",
    name,
    size: stats.size,
    mimeType: binaryMimeTypes[extension] ?? "application/octet-stream",
    message: `${name} is a binary file without a text representation. Tell the user what you found instead of guessing its contents.`,
  };
}
