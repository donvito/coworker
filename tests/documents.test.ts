import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPdfDocument,
  createWordDocument,
  parseDocumentMarkdown,
} from "@main/integrations/documents";
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
});
