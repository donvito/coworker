import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCsvDocument,
  createExcelDocument,
  createPdfDocument,
  createWordDocument,
  parseDocumentMarkdown,
} from "@main/integrations/documents";
import ExcelJS from "exceljs";
import { CoworkerDatabase } from "@main/db/database";
import { ToolGateway } from "@main/tools/tool-gateway";

const temporaryPaths: string[] = [];
const invoiceMarkdown = `# Invoice INV-100

**Bill to:** Acme Ltd
**Issued:** 2026-08-23

| Description | Quantity | Rate | Amount |
| --- | ---: | ---: | ---: |
| Consulting | 12 | $150.00 | $1,800.00 |

## Total: $1,800.00
`;

const receivablesMarkdown = `# Weekly receivables

| Customer | Due date | Amount | Overdue |
| --- | --- | ---: | --- |
| Acme Ltd | 2026-08-21 | 1800 | false |
| Northwind | 2026-08-23 | 725.5 | true |
`;

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("local document generation", () => {
  it("parses invoice structure and generates valid PDF and DOCX containers", async () => {
    const blocks = parseDocumentMarkdown(invoiceMarkdown);
    expect(blocks.some((block) => block.type === "table")).toBe(true);

    const pdf = Buffer.from(await createPdfDocument(invoiceMarkdown));
    const docx = await createWordDocument(invoiceMarkdown);

    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(docx.subarray(0, 2).toString()).toBe("PK");
    expect(pdf.byteLength).toBeGreaterThan(1_000);
    expect(docx.byteLength).toBeGreaterThan(1_000);
  });

  it("generates genuine styled XLSX workbooks and portable CSV data", async () => {
    const xlsx = await createExcelDocument(receivablesMarkdown);
    const csv = createCsvDocument(receivablesMarkdown);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Uint8Array.from(xlsx).buffer);
    const worksheet = workbook.worksheets[0]!;

    expect(xlsx.subarray(0, 2).toString()).toBe("PK");
    expect(worksheet.name).toBe("Weekly receivables");
    expect(worksheet.getCell("A2").value).toBe("Customer");
    expect(worksheet.getCell("C3").value).toBe(1800);
    expect(worksheet.getCell("D4").value).toBe(true);
    expect(worksheet.autoFilter).toBeTruthy();
    expect(csv.toString("utf8")).toContain("Customer,Due date,Amount,Overdue");
    expect(csv.toString("utf8")).toContain("Northwind,2026-08-23,725.5,true");
  });

  it("exports Excel and CSV files inside the confined workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-spreadsheets-"));
    temporaryPaths.push(root);
    const workspace = join(root, "workspace");
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    try {
      const coworker = database.createCoworker(
        {
          name: "Ava",
          role: "Accounting Coworker",
          systemPrompt: "Create accurate reports.",
          modelProvider: "demo",
          modelName: "faux-1",
          enabledTools: ["documents.export"],
        },
        workspace,
      );
      const task = database.createTask({
        coworkerId: coworker.id,
        title: "Weekly receivables",
        input: "Export the weekly receivables report as Excel and CSV.",
      });
      const gateway = new ToolGateway(
        database,
        {
          async set() {},
          async get() {
            return null;
          },
          async has() {
            return false;
          },
          async delete() {},
        },
        join(root, "outbox"),
      );

      const response = await gateway.request({
        task,
        coworker,
        toolCallId: "export-spreadsheets",
        toolName: "documents.export",
        arguments: {
          name: "reports/weekly-receivables.xlsx",
          content: receivablesMarkdown,
          formats: ["xlsx", "csv"],
        },
      });

      expect(response.kind).toBe("completed");
      expect((await readFile(join(workspace, "reports", "weekly-receivables.xlsx"))).subarray(0, 2).toString()).toBe("PK");
      expect(await readFile(join(workspace, "reports", "weekly-receivables.csv"), "utf8")).toContain("Acme Ltd");
      expect(database.listArtifacts(coworker.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "weekly-receivables.xlsx",
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          }),
          expect.objectContaining({
            name: "weekly-receivables.csv",
            mimeType: "text/csv",
          }),
        ]),
      );
    } finally {
      database.close();
    }
  });

  it("exports both formats inside the confined workspace and records artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-documents-"));
    temporaryPaths.push(root);
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, "invoices"), { recursive: true });
    await writeFile(join(workspace, "invoices", "INV-100.md"), invoiceMarkdown);

    const database = new CoworkerDatabase(join(root, "coworker.db"));
    try {
      const coworker = database.createCoworker(
        {
          name: "Ava",
          role: "Accounting Coworker",
          systemPrompt: "Create accurate documents.",
          modelProvider: "demo",
          modelName: "faux-1",
          enabledTools: ["documents.export"],
        },
        workspace,
      );
      const task = database.createTask({
        coworkerId: coworker.id,
        title: "Export invoice",
        input: "Export the invoice as PDF and Word.",
      });
      const credentials = {
        async set() {},
        async get() {
          return null;
        },
        async has() {
          return false;
        },
        async delete() {},
      };
      const gateway = new ToolGateway(
        database,
        credentials,
        join(root, "outbox"),
      );

      const response = await gateway.request({
        task,
        coworker,
        toolCallId: "export-1",
        toolName: "documents.export",
        arguments: {
          sourcePath: "invoices/INV-100.md",
          formats: ["pdf", "docx"],
        },
      });

      expect(response.kind).toBe("completed");
      const pdf = await readFile(join(workspace, "invoices", "INV-100.pdf"));
      const docx = await readFile(join(workspace, "invoices", "INV-100.docx"));
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
      expect(docx.subarray(0, 2).toString()).toBe("PK");
      expect(database.listArtifacts(coworker.id).map((artifact) => artifact.name).sort()).toEqual([
        "INV-100.docx",
        "INV-100.pdf",
      ]);
    } finally {
      database.close();
    }
  });

  it("blocks document creation until the user chooses a format", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-document-format-"));
    temporaryPaths.push(root);
    const workspace = join(root, "workspace");
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    try {
      const coworker = database.createCoworker(
        {
          name: "Ava",
          role: "Accounting Coworker",
          systemPrompt: "Create accurate documents.",
          modelProvider: "demo",
          modelName: "faux-1",
          enabledTools: ["invoice.create"],
        },
        workspace,
      );
      const task = database.createTask({
        coworkerId: coworker.id,
        title: "Create invoice",
        input: "Create an invoice for Acme for $2,000.",
      });
      const credentials = {
        async set() {},
        async get() {
          return null;
        },
        async has() {
          return false;
        },
        async delete() {},
      };
      const gateway = new ToolGateway(database, credentials, join(root, "outbox"));

      const response = await gateway.request({
        task,
        coworker,
        toolCallId: "ambiguous-invoice",
        toolName: "invoice.create",
        arguments: {
          client: "Acme",
          lineItems: [{ description: "Services", quantity: 1, rate: 2_000 }],
          currency: "USD",
          format: "pdf",
        },
      });

      expect(response.kind).toBe("denied");
      if (response.kind === "denied") {
        expect(response.reason).toMatch(/ask whether.*Word.*PDF.*Markdown.*plain text/i);
      }
      expect(database.listArtifacts(coworker.id)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("creates a PDF invoice directly without a Markdown artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-pdf-invoice-"));
    temporaryPaths.push(root);
    const workspace = join(root, "workspace");
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    try {
      const coworker = database.createCoworker(
        {
          name: "Ava",
          role: "Accounting Coworker",
          systemPrompt: "Create accurate documents.",
          modelProvider: "demo",
          modelName: "faux-1",
          enabledTools: ["invoice.create"],
        },
        workspace,
      );
      const task = database.createTask({
        coworkerId: coworker.id,
        title: "Create PDF invoice",
        input: "Create a PDF invoice for Acme for $2,000.",
      });
      const credentials = {
        async set() {},
        async get() {
          return null;
        },
        async has() {
          return false;
        },
        async delete() {},
      };
      const gateway = new ToolGateway(database, credentials, join(root, "outbox"));

      const response = await gateway.request({
        task,
        coworker,
        toolCallId: "pdf-invoice",
        toolName: "invoice.create",
        arguments: {
          client: "Acme",
          lineItems: [{ description: "Services", quantity: 1, rate: 2_000 }],
          currency: "USD",
          format: "pdf",
        },
      });

      expect(response.kind).toBe("completed");
      const artifacts = database.listArtifacts(coworker.id);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]).toMatchObject({ name: expect.stringMatching(/\.pdf$/), mimeType: "application/pdf" });
      const pdf = await readFile(artifacts[0]!.filePath);
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
      const invoiceFiles = await import("node:fs/promises").then(({ readdir }) =>
        readdir(join(workspace, "invoices")),
      );
      expect(invoiceFiles).toHaveLength(1);
      expect(invoiceFiles[0]).toMatch(/\.pdf$/);
    } finally {
      database.close();
    }
  });

  it("creates PDF directly from content without an intermediate source file", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-direct-document-"));
    temporaryPaths.push(root);
    const workspace = join(root, "workspace");
    const database = new CoworkerDatabase(join(root, "coworker.db"));
    try {
      const coworker = database.createCoworker(
        {
          name: "Ava",
          role: "Document Coworker",
          systemPrompt: "Create accurate documents.",
          modelProvider: "demo",
          modelName: "faux-1",
          enabledTools: ["documents.export"],
        },
        workspace,
      );
      const task = database.createTask({
        coworkerId: coworker.id,
        title: "Create PDF report",
        input: "Create a PDF project report.",
      });
      const credentials = {
        async set() {},
        async get() {
          return null;
        },
        async has() {
          return false;
        },
        async delete() {},
      };
      const gateway = new ToolGateway(database, credentials, join(root, "outbox"));

      const response = await gateway.request({
        task,
        coworker,
        toolCallId: "direct-pdf",
        toolName: "documents.export",
        arguments: {
          name: "reports/project-report",
          content: "# Project report\n\nReady for review.",
          formats: ["pdf"],
        },
      });

      expect(response.kind).toBe("completed");
      expect(database.listArtifacts(coworker.id).map((artifact) => artifact.name)).toEqual([
        "project-report.pdf",
      ]);
      await expect(readFile(join(workspace, "reports", "project-report.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      database.close();
    }
  });
});
