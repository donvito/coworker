export const documentFormatInstruction = [
  "Document format rule: Before creating a document, invoice, report, letter, proposal, memo, or similar file, confirm that the user explicitly chose an output format.",
  "If no format was chosen, ask which format they want (for example Word DOCX, PDF, Excel XLSX, CSV, Markdown, or plain text), then stop and wait for their answer without creating a file.",
  "Never choose Markdown or any other format by default.",
  "If the user already named a format in the current request or recent conversation, proceed without asking again.",
].join(" ");

export const documentFormatClarification =
  "The user has not chosen an output format yet. Ask whether they want Word (DOCX), PDF, Excel (XLSX), CSV, Markdown, or plain text, then wait for their answer. Do not create a file or default to Markdown.";

const explicitDocumentFormatPattern =
  /(?:\.(?:pdf|docx?|md|markdown|txt|rtf|odt|html?|pages|csv|xlsx?|pptx?)\b|\b(?:pdf|portable document format|docx?|microsoft word|word document|markdown|plain[- ]text|text file|rtf|rich text|odt|open document|html?|apple pages|google doc|csv|xlsx?|excel(?: workbook| spreadsheet)?|spreadsheet|pptx?|powerpoint)\b)/i;

const documentNoun =
  "(?:document|doc|invoice|report|letter|proposal|memo|brief|contract|agreement|resume|résumé|cv|receipt|statement|agenda|minutes|form)";
const documentAction = "(?:create|make|write|draft|generate|prepare|produce|build|export|save)";
const documentCreationPattern = new RegExp(
  `(?:\\b${documentAction}\\b[\\s\\S]{0,120}\\b${documentNoun}\\b|\\b${documentNoun}\\b[\\s\\S]{0,120}\\b${documentAction}\\b|\\b(?:need|want)\\b[\\s\\S]{0,80}\\b${documentNoun}\\b)`,
  "i",
);

export function hasExplicitDocumentFormat(input: string): boolean {
  return explicitDocumentFormatPattern.test(input);
}

export function requestsDocumentCreation(input: string): boolean {
  return documentCreationPattern.test(input);
}

export function requiresDocumentFormatClarification(
  taskInput: string,
  toolName: string,
): boolean {
  if (hasExplicitDocumentFormat(taskInput)) return false;
  return (
    ["invoice.create", "documents.export", "files.write"].includes(toolName) &&
    requestsDocumentCreation(taskInput)
  );
}
