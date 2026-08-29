import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { extname, join } from "node:path";
import JSZip from "jszip";
import type { Skill } from "@shared/contracts";
import type { CoworkerDatabase } from "@main/db/database";

export const bundledWebSearchSkillId = "bundled:web-search";
export const bundledDocumentAuthoringSkillId = "bundled:document-authoring";
export const bundledTeamChannelSkillId = "bundled:team-channel-collaboration";
export const bundledFolderAccessSkillId = "bundled:folder-access";
export const bundledTelegramMessagingSkillId = "bundled:telegram-messaging";
export const bundledBrowserComputerUseSkillId = "bundled:browser-computer-use";

export interface PackagedSkillResource {
  path: string;
  mimeType: string;
  content: Uint8Array;
}

export interface ParsedSkillPackage {
  skill: Pick<Skill, "name" | "description" | "content">;
  resources: PackagedSkillResource[];
}

function loadBundledSkill(folderName: string, id: string) {
  const resourcesPath = Reflect.get(process, "resourcesPath");
  const candidates = [
    typeof resourcesPath === "string"
      ? join(resourcesPath, "skills", folderName, "SKILL.md")
      : null,
    join(process.cwd(), "skills", folderName, "SKILL.md"),
  ].filter((path): path is string => Boolean(path));
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error(`Bundled skill ${folderName} was not found`);
  const content = readFileSync(path, "utf8");
  return {
    id,
    ...parseSkillMarkdown(content),
    sourceUrl: null,
    bundled: true,
  } as const;
}

const maxSkillPackageBytes = 10_000_000;
const maxSkillPackageEntries = 200;

function resourceMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".txt":
    case ".log":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    case ".js":
    case ".mjs":
      return "text/javascript";
    case ".ts":
    case ".tsx":
      return "text/typescript";
    case ".py":
      return "text/x-python";
    case ".html":
      return "text/html";
    case ".css":
      return "text/css";
    case ".csv":
      return "text/csv";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

function safePackagePath(entryName: string): string {
  const normalized = entryName.replaceAll("\\", "/");
  if (
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[a-z]:\//i.test(normalized)
  ) {
    throw new Error(`Skill package contains an unsafe path: ${entryName}`);
  }
  const segments = normalized.replace(/\/$/, "").split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Skill package contains an unsafe path: ${entryName}`);
  }
  return normalized;
}

function isIgnorablePackageMetadata(path: string): boolean {
  const parts = path.replace(/\/$/, "").split("/");
  const fileName = parts.at(-1)?.toLowerCase() ?? "";
  return (
    parts[0]?.toLowerCase() === "__macosx" ||
    fileName === ".ds_store" ||
    fileName === "thumbs.db" ||
    fileName.startsWith("._")
  );
}

export async function parseSkillPackage(bytes: Uint8Array): Promise<ParsedSkillPackage> {
  if (bytes.byteLength === 0 || bytes.byteLength > maxSkillPackageBytes) {
    throw new Error("Skill packages must be between 1 byte and 10 MB");
  }
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false });
  } catch {
    throw new Error("The skill package is not a valid ZIP archive");
  }
  const entries = Object.values(archive.files);
  if (entries.length === 0 || entries.length > maxSkillPackageEntries) {
    throw new Error("Skill packages must contain 1–200 entries");
  }

  const roots = new Set<string>();
  const files: Array<{ archivePath: string; relativePath: string; entry: JSZip.JSZipObject }> = [];
  for (const entry of entries) {
    const originalName = entry.unsafeOriginalName ?? entry.name;
    const archivePath = safePackagePath(originalName);
    if (isIgnorablePackageMetadata(archivePath)) continue;
    const unixPermissions =
      typeof entry.unixPermissions === "string"
        ? Number.parseInt(entry.unixPermissions, 8)
        : entry.unixPermissions;
    if (unixPermissions !== null && unixPermissions !== undefined && (unixPermissions & 0o170000) === 0o120000) {
      throw new Error(`Skill packages cannot contain symbolic links: ${archivePath}`);
    }
    const withoutSlash = archivePath.replace(/\/$/, "");
    const [root, ...rest] = withoutSlash.split("/");
    roots.add(root!);
    if (!entry.dir) {
      if (rest.length === 0) {
        throw new Error("The ZIP must contain the skill folder as its single root");
      }
      files.push({ archivePath, relativePath: rest.join("/"), entry });
    }
  }
  if (files.length === 0) {
    throw new Error("The skill package does not contain any skill files");
  }
  if (roots.size !== 1) {
    const found = [...roots].sort().join(", ") || "none";
    throw new Error(
      `The ZIP must contain exactly one skill folder at its root. Found: ${found}`,
    );
  }
  const rootName = [...roots][0]!;
  const skillFiles = files.filter((file) => file.relativePath.toLowerCase() === "skill.md");
  if (skillFiles.length !== 1) {
    throw new Error("The root skill folder must contain exactly one skill.md file");
  }

  let extractedBytes = 0;
  const extracted = new Map<string, Uint8Array>();
  for (const file of files) {
    const content = await file.entry.async("uint8array");
    extractedBytes += content.byteLength;
    if (extractedBytes > maxSkillPackageBytes) {
      throw new Error("Expanded skill package content must be 10 MB or smaller");
    }
    extracted.set(file.relativePath, content);
  }
  let markdown: string;
  try {
    markdown = new TextDecoder("utf-8", { fatal: true }).decode(
      extracted.get(skillFiles[0]!.relativePath)!,
    );
  } catch {
    throw new Error("skill.md must be valid UTF-8 text");
  }
  const skill = parseSkillMarkdown(markdown);
  if (rootName !== skill.name) {
    throw new Error(`Skill folder “${rootName}” must match the declared name “${skill.name}”`);
  }
  const resources = [...extracted.entries()]
    .filter(([path]) => path.toLowerCase() !== "skill.md")
    .map(([path, content]) => ({ path, content, mimeType: resourceMimeType(path) }));
  return { skill, resources };
}

export const bundledWebSearchSkill = {
  id: bundledWebSearchSkillId,
  name: "web-search",
  description:
    "Searches the live web with Firecrawl, Tavily, Exa, or SerpAPI. Use for current facts, research, documentation, news, recommendations, or any question requiring internet sources.",
  content: `---
name: web-search
description: Searches the live web with Firecrawl, Tavily, Exa, or SerpAPI. Use for current facts, research, documentation, news, recommendations, or any question requiring internet sources.
---

# Web Search

Use the \`web.search\` tool whenever the request needs current or externally verified information.

- Send a focused query and request 3–8 results.
- Prefer primary or authoritative sources.
- Openly distinguish facts found in results from your own inference.
- Include the source URLs in the response.
- The app automatically chooses an available configured provider. A requested provider may fall back to another configured provider.
- If no provider is configured, tell the user to add a Firecrawl, Tavily, Exa, or SerpAPI key in Settings → Skills.
`,
  sourceUrl: null,
  bundled: true,
} as const;

export const bundledDocumentAuthoringSkill = {
  id: bundledDocumentAuthoringSkillId,
  name: "document-authoring",
  description:
    "Create or substantially revise polished office documents, presentations, and data reports in PDF, Word DOCX, Excel XLSX, CSV, PowerPoint PPTX, Markdown, or plain text. Use for drafting, restructuring, or improving a final document's content and presentation. Do not use for merely reviewing, summarizing, or answering questions about a document.",
  content: `---
name: document-authoring
description: Create or substantially revise polished office documents, presentations, and data reports in PDF, Word DOCX, Excel XLSX, CSV, PowerPoint PPTX, Markdown, or plain text. Use for drafting, restructuring, or improving a final document's content and presentation. Do not use for merely reviewing, summarizing, or answering questions about a document.
---

# Document authoring

Create a useful final deliverable, not a raw transcript with a file extension.

## Establish the brief

- Respect the format the user selected. If they did not select one, ask which format they want and wait.
- Identify the document's purpose, audience, required facts, and any template or constraints already supplied.
- Ask concise follow-up questions only for information that materially affects correctness. Never invent names, dates, recipients, amounts, terms, or other required facts.
- For a substantial collaborative document, agree on a short outline before drafting when the structure or desired outcome is unclear. Do not force a lengthy coauthoring workflow on a simple, well-specified request.

## Structure the content

For PDF and Word DOCX, give the exporter polished semantic Markdown:

- Use exactly one \`#\` title, then \`##\` major sections and \`###\` subsections where useful.
- Use meaningful paragraphs, real lists, bold field labels, and Markdown tables for aligned data.
- Adapt the structure to the deliverable. Letters use conventional correspondence structure; reports foreground purpose and findings; proposals make the recommendation and next steps scannable; agreements use consistent numbered clauses and signature areas where appropriate.
- Never simulate layout with ALL CAPS body text, repeated equals signs, tabs, repeated punctuation, or manual space padding.

For Excel XLSX and CSV:

- Put the data in a Markdown table with a descriptive header row and one record per row.
- Use XLSX when presentation, titles, explanatory sections, filters, or multiple tables matter.
- Use CSV for one portable data table. CSV supports exactly one table and does not preserve presentation layout.
- Keep amounts, dates, percentages, identifiers, and formulas unambiguous. Do not add decorative prose inside the data table.

For PowerPoint PPTX:

- The single \`#\` title becomes the cover slide; every \`##\` heading starts a new slide with that heading as the slide title.
- Write slide content as short bullet lists (about 4–7 bullets per slide); \`###\` renders as a bold lead-in line and \`---\` forces a slide break.
- Markdown tables render as slide tables. Long sections continue automatically onto follow-up slides.
- Call \`documents.export\` with the "pptx" format — never claim PowerPoint is unavailable, and do not export a different format than the user chose.

## Export and verify

- Call \`documents.export\` directly with a final name, content, and the requested format. Do not create an intermediate Markdown file first.
- Use \`files.write\` only when the requested final format is Markdown or plain text.
- Check the tool result for the requested extension and a saved artifact before saying the file is ready.
- If export fails, explain the actual error and preserve the draft for a corrected attempt. Never claim that a file was created when the tool did not succeed.
- Before finishing, re-read the complete content for hierarchy, consistency, missing placeholders, unsupported claims, and whether a reader without the conversation context can understand it.
`,
  sourceUrl: null,
  bundled: true,
} as const;

export const bundledTeamChannelSkill = loadBundledSkill(
  "team-channel-collaboration",
  bundledTeamChannelSkillId,
);

export const bundledFolderAccessSkill = loadBundledSkill(
  "folder-access",
  bundledFolderAccessSkillId,
);

export const bundledTelegramMessagingSkill = loadBundledSkill(
  "telegram-messaging",
  bundledTelegramMessagingSkillId,
);

export const bundledBrowserComputerUseSkill = loadBundledSkill(
  "browser-computer-use",
  bundledBrowserComputerUseSkillId,
);

export const bundledSkills = [
  bundledWebSearchSkill,
  bundledDocumentAuthoringSkill,
  bundledTeamChannelSkill,
  bundledFolderAccessSkill,
  bundledTelegramMessagingSkill,
  bundledBrowserComputerUseSkill,
] as const;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replaceAll("\\n", "\n");
  }
  return trimmed;
}

export function parseSkillMarkdown(content: string): Pick<Skill, "name" | "description" | "content"> {
  const normalized = content.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) throw new Error("Skill must start with YAML frontmatter");
  const fields = new Map<string, string>();
  for (const line of match[1]!.split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0 || /^\s/.test(line)) continue;
    fields.set(line.slice(0, separator).trim(), unquote(line.slice(separator + 1)));
  }
  const name = fields.get("name")?.trim() ?? "";
  const description = fields.get("description")?.trim() ?? "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name) || name.includes("--")) {
    throw new Error("Skill name must use 1–64 lowercase letters, numbers, and single hyphens");
  }
  if (!description || description.length > 1_024) {
    throw new Error("Skill description must contain 1–1024 characters");
  }
  if (normalized.length > 1_000_000) throw new Error("Skill is larger than 1 MB");
  return { name, description, content: normalized };
}

function assertSafeRemoteUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Skill URLs must use HTTPS");
  if (url.username || url.password) throw new Error("Skill URLs cannot contain credentials");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ipVersion = isIP(hostname);
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    (ipVersion === 4 && /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(hostname)) ||
    (ipVersion === 6 && /^(?:::1$|fc|fd|fe8|fe9|fea|feb)/i.test(hostname))
  ) {
    throw new Error("Skill URLs cannot target this computer or a private network");
  }
  return url;
}

export async function downloadSkillFromUrl(
  value: string,
  fetcher: typeof fetch = fetch,
): Promise<Pick<Skill, "name" | "description" | "content" | "sourceUrl">> {
  let url = assertSafeRemoteUrl(value);
  let response: Response | null = null;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    response = await fetcher(url, {
      headers: { Accept: "text/markdown,text/plain;q=0.9" },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location");
    if (!location) throw new Error("Skill URL redirected without a destination");
    if (redirects === 5) throw new Error("Skill URL redirected too many times");
    url = assertSafeRemoteUrl(new URL(location, url).toString());
  }
  if (!response) throw new Error("Could not download skill");
  if (!response.ok) throw new Error(`Could not download skill (${response.status})`);
  if (response.url) assertSafeRemoteUrl(response.url);
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > 1_000_000) throw new Error("Skill is larger than 1 MB");
  const content = await response.text();
  return { ...parseSkillMarkdown(content), sourceUrl: response.url || url.toString() };
}

export function skillUrlFromPrompt(text: string): string | null {
  const trimmed = text.trim();
  const exact = /^https:\/\/\S+$/i.test(trimmed) ? trimmed : null;
  const explicit = trimmed.match(
    /^(?:install|add)(?:\s+(?:this|the|a))?\s+skill(?:\s+from)?\s+(https:\/\/\S+)$/i,
  )?.[1];
  const value = exact ?? explicit ?? null;
  return value ? value.replace(/[)>.,;]+$/, "") : null;
}

export async function installSkillFromUrl(
  database: CoworkerDatabase,
  url: string,
  coworkerId?: string,
  fetcher: typeof fetch = fetch,
): Promise<Skill> {
  const downloaded = await downloadSkillFromUrl(url, fetcher);
  const existing = database.getSkillByName(downloaded.name);
  if (existing?.bundled) {
    throw new Error(`The bundled skill “${downloaded.name}” cannot be replaced`);
  }
  const skill = database.upsertSkill({ ...downloaded, bundled: false });
  if (coworkerId) {
    const coworker = database.getCoworker(coworkerId);
    database.setCoworkerSkills(coworkerId, [...coworker.enabledSkillIds, skill.id]);
  }
  return skill;
}
