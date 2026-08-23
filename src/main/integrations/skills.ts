import { isIP } from "node:net";
import type { Skill } from "@shared/contracts";
import type { CoworkerDatabase } from "@main/db/database";

export const bundledWebSearchSkillId = "bundled:web-search";

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
