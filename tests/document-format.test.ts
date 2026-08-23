import { describe, expect, it } from "vitest";
import {
  documentFormatInstruction,
  hasExplicitDocumentFormat,
  requestsDocumentCreation,
} from "@shared/document-format";
import { bundledDocumentAuthoringSkill } from "@main/integrations/skills";

describe("document format requirement", () => {
  it("packages professional office authoring as a model-selectable skill", () => {
    expect(bundledDocumentAuthoringSkill.description).toContain("office documents");
    expect(bundledDocumentAuthoringSkill.description).toContain("Do not use for merely reviewing");
    expect(bundledDocumentAuthoringSkill.content).toContain("exactly one `#` title");
    expect(bundledDocumentAuthoringSkill.content).toContain("Excel XLSX and CSV");
    expect(bundledDocumentAuthoringSkill.content).toContain("documents.export");
    expect(bundledDocumentAuthoringSkill.content).not.toContain("HDB");
  });

  it.each([
    "Create an invoice as PDF",
    "Make this a Word document",
    "Write the report in Markdown",
    "Build the receivables report in Excel",
    "Save these contacts as CSV",
    "Save the letter as plain text",
    "Export this proposal to report.docx",
  ])("recognizes an explicit format in %s", (input) => {
    expect(hasExplicitDocumentFormat(input)).toBe(true);
  });

  it.each([
    "Create an invoice for Acme",
    "Write a quarterly report",
    "I need a proposal for the client",
  ])("recognizes a document request without a format in %s", (input) => {
    expect(requestsDocumentCreation(input)).toBe(true);
    expect(hasExplicitDocumentFormat(input)).toBe(false);
  });

  it("states the format rule for the model instead of enforcing it in the gateway", () => {
    // The gateway used to deny file-creating tools by pattern-matching the task
    // input. The model is told the rule and decides; application code no longer
    // overrides that judgement.
    expect(documentFormatInstruction).toContain("confirm that the user explicitly chose");
    expect(documentFormatInstruction).toContain("Never choose Markdown");
  });
});
