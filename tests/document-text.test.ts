import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { afterEach, describe, expect, it } from "vitest";
import {
  maxDocumentBytes,
  maxExtractedCharacters,
  readDocumentText,
} from "@main/integrations/document-text";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "coworker-document-text-"));
  temporaryPaths.push(path);
  return path;
}

describe("document text extraction", () => {
  it("reads UTF-8 text files of any kind directly", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "notes.rb");
    await writeFile(path, "puts 'héllo'\n");

    await expect(readDocumentText(path)).resolves.toEqual({
      kind: "text",
      name: "notes.rb",
      format: "text",
      content: "puts 'héllo'\n",
      truncated: false,
    });
  });

  it("decodes UTF-16 text files written with a byte-order mark", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "windows-notes.txt");
    await writeFile(
      path,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Wörld report", "utf16le")]),
    );

    const result = await readDocumentText(path);
    expect(result).toMatchObject({ kind: "text", content: "Wörld report" });
  });

  it("truncates very large text instead of flooding the model", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "huge.log");
    await writeFile(path, "a".repeat(maxExtractedCharacters + 5));

    const result = await readDocumentText(path);
    expect(result).toMatchObject({ kind: "text", truncated: true });
    if (result.kind === "text") {
      expect(result.content).toHaveLength(maxExtractedCharacters);
    }
  });

  it("extracts paragraphs, tabs, and entities from Word documents", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "contract.docx");
    const archive = new JSZip();
    archive.file(
      "word/document.xml",
      `<?xml version="1.0"?><w:document><w:body>` +
        `<w:p><w:r><w:t>Lease &amp; Terms</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t xml:space="preserve">Rent:</w:t></w:r><w:tab/><w:r><w:t>2,000</w:t></w:r></w:p>` +
        `</w:body></w:document>`,
    );
    await writeFile(path, await archive.generateAsync({ type: "nodebuffer" }));

    const result = await readDocumentText(path);
    expect(result).toMatchObject({ kind: "text", format: "docx", truncated: false });
    if (result.kind === "text") {
      expect(result.content).toBe("Lease & Terms\nRent:\t2,000");
    }
  });

  it("extracts worksheet rows from Excel workbooks", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "costs.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Costs");
    sheet.addRow(["Item", "Amount"]);
    sheet.addRow(["Pens", 12]);
    await workbook.xlsx.writeFile(path);

    const result = await readDocumentText(path);
    expect(result).toMatchObject({ kind: "text", format: "xlsx" });
    if (result.kind === "text") {
      expect(result.content).toContain("# Sheet: Costs");
      expect(result.content).toContain("Item | Amount");
      expect(result.content).toContain("Pens | 12");
    }
  });

  it("extracts text from PDF documents", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "summary.pdf");
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    page.drawText("Coworker reads shared PDFs", { x: 40, y: 700, size: 14 });
    await writeFile(path, await pdf.save());

    const result = await readDocumentText(path);
    expect(result).toMatchObject({ kind: "text", format: "pdf", totalPages: 1 });
    if (result.kind === "text") {
      expect(result.content).toContain("Coworker reads shared PDFs");
    }
  });

  it("returns metadata for binary files instead of garbage", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "photo.png");
    await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a]));

    const result = await readDocumentText(path);
    expect(result).toMatchObject({
      kind: "binary",
      name: "photo.png",
      size: 7,
      mimeType: "image/png",
    });
  });

  it("rejects directories and oversized documents", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "folder"));
    await expect(readDocumentText(join(root, "folder"))).rejects.toThrow(/is a directory/i);

    const oversized = join(root, "big.txt");
    await writeFile(oversized, Buffer.alloc(maxDocumentBytes + 1, 97));
    await expect(readDocumentText(oversized)).rejects.toThrow(/larger than/i);
  });
});
