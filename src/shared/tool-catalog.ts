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
    name: "skills.read",
    label: "Read enabled skill",
    description:
      "Load the instructions for an enabled skill and list its packaged resources. Call again with a relative path to read a text resource referenced by skill.md.",
    risk: "low",
    defaultPolicy: "automatic",
  },
  {
    name: "web.search",
    label: "Search the web",
    description:
      "Search the live web through an available configured Firecrawl, Tavily, Exa, or SerpAPI credential.",
    risk: "low",
    defaultPolicy: "automatic",
  },
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
    name: "folders.list",
    label: "List shared folders",
    description:
      "List the read-only folders the user granted this coworker, or browse the files inside one of them. Call without arguments to see every granted folder.",
    risk: "low",
    defaultPolicy: "automatic",
  },
  {
    name: "folders.read",
    label: "Read shared folder document",
    description:
      "Read a document or file from a user-granted read-only folder. Extracts text from PDF, Word DOCX, and Excel XLSX documents and reads text files directly. Granted folders can never be written to.",
    risk: "low",
    defaultPolicy: "automatic",
  },
  {
    name: "invoice.create",
    label: "Create invoice",
    description:
      "Create a deterministic invoice directly in the PDF, Word DOCX, Markdown, or plain-text format explicitly selected by the user. This creates the final file; do not call documents.export afterward.",
    risk: "low",
    defaultPolicy: "automatic",
  },
  {
    name: "documents.export",
    label: "Export office document",
    description:
      "Create PDF, Word DOCX, Excel XLSX, or CSV files directly from polished semantic Markdown, or convert an existing Markdown/text workspace file. Use a Markdown table with a header row for Excel or CSV. For new documents, supply the final content and name so no intermediate Markdown file is created.",
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
    name: "schedules.create",
    label: "Create schedule",
    description:
      "Create a durable one-time reminder or recurring schedule in the app's local scheduler. Use this by default whenever the user asks to schedule work, set a reminder, follow up later, or run something at a date or time. Do not create an ICS, Markdown, or other file for scheduling unless the user explicitly asks for a file export. The future task input must describe the work itself, not ask to create another schedule.",
    risk: "medium",
    defaultPolicy: "approval",
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
