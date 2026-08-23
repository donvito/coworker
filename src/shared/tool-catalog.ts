import type { RiskLevel, ToolPolicy } from "./contracts";

export interface ToolCatalogEntry {
  name: string;
  label: string;
  description: string;
  risk: RiskLevel;
  defaultPolicy: ToolPolicy;
}

export const toolCatalog = [
  {
    name: "files.list",
    label: "List workspace files",
    description: "List files and folders inside this coworker's approved workspace.",
    risk: "low",
    defaultPolicy: "automatic",
  },
  {
    name: "files.read",
    label: "Read workspace file",
    description: "Read a UTF-8 text file inside this coworker's approved workspace.",
    risk: "low",
    defaultPolicy: "automatic",
  },
  {
    name: "files.write",
    label: "Create workspace file",
    description: "Create or replace a UTF-8 file inside this coworker's approved workspace.",
    risk: "medium",
    defaultPolicy: "automatic",
  },
  {
    name: "invoice.create",
    label: "Create invoice",
    description: "Create a deterministic invoice document in the coworker's workspace.",
    risk: "low",
    defaultPolicy: "automatic",
  },
  {
    name: "documents.export",
    label: "Export PDF or Word document",
    description:
      "Convert an existing Markdown or text workspace file into sibling PDF, Word DOCX, or both files.",
    risk: "medium",
    defaultPolicy: "automatic",
  },
  {
    name: "email.create_draft",
    label: "Create email draft",
    description: "Create an RFC 822 email draft in the coworker's workspace.",
    risk: "low",
    defaultPolicy: "automatic",
  },
  {
    name: "email.send",
    label: "Send email",
    description: "Send an email through the configured email integration.",
    risk: "high",
    defaultPolicy: "approval",
  },
] as const satisfies readonly ToolCatalogEntry[];

export type ToolName = (typeof toolCatalog)[number]["name"];

export function getToolCatalogEntry(name: string): ToolCatalogEntry | undefined {
  return toolCatalog.find((tool) => tool.name === name);
}
