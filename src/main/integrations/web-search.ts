import { z } from "zod";
import type { WebSearchProvider } from "@shared/contracts";
import type { CredentialStore } from "@main/security/credential-store";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export function webSearchCredentialKey(provider: WebSearchProvider): string {
  return `web-search:${provider}`;
}

const providerOrder: readonly WebSearchProvider[] = ["tavily", "exa", "firecrawl", "serpapi"];

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 4_000) : "";
}

function normalizeResults(value: unknown): WebSearchResult[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const url = text(record.url ?? record.link);
    if (!/^https?:\/\//i.test(url)) return [];
    return [{
      title: text(record.title ?? record.name) || url,
      url,
      snippet: text(record.content ?? record.text ?? record.snippet ?? record.description),
    }];
  });
}

async function jsonResponse(response: Response, provider: WebSearchProvider): Promise<unknown> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${provider} returned an invalid search response`);
  }
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body ? text(body.error) : "";
    throw new Error(`${provider} search failed (${response.status})${message ? `: ${message}` : ""}`);
  }
  return body;
}

async function searchProvider(
  provider: WebSearchProvider,
  apiKey: string,
  query: string,
  limit: number,
  fetcher: typeof fetch,
): Promise<WebSearchResult[]> {
  const signal = AbortSignal.timeout(20_000);
  if (provider === "tavily") {
    const response = await fetcher("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, query, max_results: limit, search_depth: "advanced" }),
      signal,
    });
    const body = (await jsonResponse(response, provider)) as { results?: unknown };
    return normalizeResults(body.results);
  }
  if (provider === "exa") {
    const response = await fetcher("https://api.exa.ai/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ query, numResults: limit, contents: { text: { maxCharacters: 2_000 } } }),
      signal,
    });
    const body = (await jsonResponse(response, provider)) as { results?: unknown };
    return normalizeResults(body.results);
  }
  if (provider === "firecrawl") {
    const response = await fetcher("https://api.firecrawl.dev/v1/search", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, limit }),
      signal,
    });
    const body = (await jsonResponse(response, provider)) as { data?: unknown };
    return normalizeResults(body.data);
  }
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("num", String(limit));
  const response = await fetcher(url, { signal });
  const body = (await jsonResponse(response, provider)) as { organic_results?: unknown };
  return normalizeResults(body.organic_results);
}

export async function searchWeb(input: {
  credentials: CredentialStore;
  query: string;
  limit?: number;
  preferredProvider?: WebSearchProvider;
  fetcher?: typeof fetch;
}): Promise<{ provider: WebSearchProvider; query: string; results: WebSearchResult[] }> {
  const query = z.string().trim().min(1).max(2_000).parse(input.query);
  const limit = z.number().int().min(1).max(10).default(5).parse(input.limit);
  const order = input.preferredProvider
    ? [input.preferredProvider, ...providerOrder.filter((item) => item !== input.preferredProvider)]
    : [...providerOrder];
  const failures: string[] = [];
  for (const provider of order) {
    const apiKey = await input.credentials.get(webSearchCredentialKey(provider));
    if (!apiKey) continue;
    try {
      const results = await searchProvider(provider, apiKey, query, limit, input.fetcher ?? fetch);
      return { provider, query, results };
    } catch (error) {
      failures.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(`All configured search providers failed. ${failures.join("; ")}`);
  throw new Error("Configure a Tavily, Exa, Firecrawl, or SerpAPI key in Settings first");
}
