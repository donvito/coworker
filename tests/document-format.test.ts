import { describe, expect, it } from "vitest";
import { hasExplicitDocumentFormat, requestsDocumentCreation } from "@shared/document-format";
import { bundledDocumentAuthoringSkill } from "@main/integrations/skills";

describe("document format requirement", () => {
  it("packages written-content authoring as a model-selectable skill", () => {
    expect(bundledDocumentAuthoringSkill.description).toContain("office documents");
    expect(bundledDocumentAuthoringSkill.description).toContain("user-facing written content");
    expect(bundledDocumentAuthoringSkill.description).toContain("creative text, poems, and simple notes");
    expect(bundledDocumentAuthoringSkill.description).toContain("saving content from the conversation");
    expect(bundledDocumentAuthoringSkill.description).toContain("user requests a document or file artifact");
    expect(bundledDocumentAuthoringSkill.description).toContain("drafting, rewriting, or creative writing that stays in chat");
    expect(bundledDocumentAuthoringSkill.description).toContain("for code, configuration, or raw operational file writes");
    expect(bundledDocumentAuthoringSkill.description).toContain("creative writing that stays in chat without an artifact request");
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

  it("keeps format confirmation and memory preference handling in the selectable skill", () => {
    const content = bundledDocumentAuthoringSkill.content;
    expect(content).toContain("accepted format suggestion from the previous turn");
    expect(content).toContain("use the latest clearly identified content when the referent is clear");
    expect(content).toContain("Do not ask the user to repeat the poem or other content");
    expect(content).toContain("does not count as the user's selection for a new or different document");
    expect(content).toContain("even if an earlier assistant-created artifact was Markdown");
    expect(content).toContain("one unambiguous, suitable saved document-format preference");
    expect(content).toContain(
      "Your saved default is PDF. Shall I use PDF for this document, or would you prefer a different format?",
    );
    expect(content).toContain("do not create or export the file before they confirm");
    expect(content).toContain("Do not update or mutate saved context");
    expect(content).toContain("a one-off alternate format does not replace the saved preference");
    expect(content).toContain("conflicting, ambiguous, or unsuitable format preferences");
    expect(content).toContain("“Add to a document” alone does not select or confirm an output format");
    expect(content).toContain("otherwise apply the saved-default confirmation or ask for the normal format options");
  });

  it("keeps final office-file export guidance with document authoring", () => {
    const content = bundledDocumentAuthoringSkill.content;
    expect(content).toContain("invoice.create");
    expect(content).toContain("pass content directly to `documents.export` with a name");
    expect(content).toContain("genuine XLSX and CSV files");
  });
});
