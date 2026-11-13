import { z } from "zod";
import { webSearchProviders, type WebSearchProvider } from "@shared/contracts";
import type { CredentialStore } from "@main/security/credential-store";
import { normalizeImageReferences, type ImageReference } from "@shared/message-images";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResponse {
  provider: WebSearchProvider;
  query: string;
  results: WebSearchResult[];
  /** Present only when images were requested; may be empty. */
  images?: ImageReference[];
}

interface ProviderSearchResult {
  results: WebSearchResult[];
  images: ImageReference[];
}

export function webSearchCredentialKey(provider: WebSearchProvider): string {
  return `web-search:${provider}`;
}

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

function records(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object",
  );
}

/** Tavily lists images for the query as bare URLs, or URL/description pairs. */
function tavilyImages(value: unknown): ImageReference[] {
  if (!Array.isArray(value)) return [];
  return normalizeImageReferences(
    value.map((item) =>
      typeof item === "string"
        ? { url: item }
        : item && typeof item === "object"
          ? { url: (item as { url?: unknown }).url, title: (item as { description?: unknown }).description }
          : null,
    ),
  );
}

/** Exa reports at most one representative image per result. */
function exaImages(value: unknown): ImageReference[] {
  return normalizeImageReferences(
    records(value).map((item) => ({ url: item.image, title: item.title, sourceUrl: item.url })),
  );
}

function firecrawlImages(value: unknown): ImageReference[] {
  return normalizeImageReferences(
    records(value).map((item) => ({
      url: item.imageUrl,
      title: item.title,
      sourceUrl: item.url,
      width: item.imageWidth,
      height: item.imageHeight,
    })),
  );
}

/** SerpAPI's inline image pack carries full-size originals; organic hits only thumbnails. */
function serpApiImages(inlineImages: unknown, organicResults: unknown): ImageReference[] {
  return normalizeImageReferences([
    ...records(inlineImages).map((item) => ({
      url: item.original ?? item.thumbnail,
      title: item.title,
      sourceUrl: item.source ?? item.link,
    })),
    ...records(organicResults).map((item) => ({
      url: item.thumbnail,
      title: item.title,
      sourceUrl: item.link,
    })),
  ]);
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
  includeImages: boolean,
  fetcher: typeof fetch,
): Promise<ProviderSearchResult> {
  const signal = AbortSignal.timeout(20_000);
  if (provider === "tavily") {
    const response = await fetcher("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: limit,
        search_depth: "advanced",
        ...(includeImages ? { include_images: true, include_image_descriptions: true } : {}),
      }),
      signal,
    });
    const body = (await jsonResponse(response, provider)) as { results?: unknown; images?: unknown };
    return {
      results: normalizeResults(body.results),
      images: includeImages ? tavilyImages(body.images) : [],
    };
  }
  if (provider === "exa") {
    const response = await fetcher("https://api.exa.ai/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ query, numResults: limit, contents: { text: { maxCharacters: 2_000 } } }),
      signal,
    });
    const body = (await jsonResponse(response, provider)) as { results?: unknown };
    return {
      results: normalizeResults(body.results),
      images: includeImages ? exaImages(body.results) : [],
    };
  }
  if (provider === "firecrawl") return searchFirecrawl(apiKey, query, limit, includeImages, fetcher);
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("num", String(limit));
  const response = await fetcher(url, { signal });
  const body = (await jsonResponse(response, provider)) as {
    organic_results?: unknown;
    inline_images?: unknown;
  };
  return {
    results: normalizeResults(body.organic_results),
    images: includeImages ? serpApiImages(body.inline_images, body.organic_results) : [],
  };
}

/** Without a key, Firecrawl serves a free tier capped per IP address per day. */
async function searchFirecrawl(
  apiKey: string | null,
  query: string,
  limit: number,
  includeImages: boolean,
  fetcher: typeof fetch,
): Promise<ProviderSearchResult> {
  const response = await fetcher("https://api.firecrawl.dev/v2/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ query, limit, ...(includeImages ? { sources: ["web", "images"] } : {}) }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!apiKey && response.status === 429) {
    throw new Error(
      "Firecrawl's free search limit for today is used up. Add a free Firecrawl API key, or a Tavily, Exa, or SerpAPI key, in Settings → Web search to keep searching.",
    );
  }
  const body = (await jsonResponse(response, "firecrawl")) as {
    data?: { web?: unknown; images?: unknown };
  };
  return {
    results: normalizeResults(body.data?.web),
    images: includeImages ? firecrawlImages(body.data?.images) : [],
  };
}

export async function searchWeb(input: {
  credentials: CredentialStore;
  query: string;
  limit?: number;
  preferredProvider?: WebSearchProvider;
  /** Also return image references the provider found for the query. */
  includeImages?: boolean;
  fetcher?: typeof fetch;
}): Promise<WebSearchResponse> {
  const query = z.string().trim().min(1).max(2_000).parse(input.query);
  const limit = z.number().int().min(1).max(10).default(5).parse(input.limit);
  const order = input.preferredProvider
    ? [input.preferredProvider, ...webSearchProviders.filter((item) => item !== input.preferredProvider)]
    : [...webSearchProviders];
  const includeImages = input.includeImages === true;
  const respond = (provider: WebSearchProvider, found: ProviderSearchResult): WebSearchResponse => ({
    provider,
    query,
    results: found.results,
    ...(includeImages ? { images: found.images } : {}),
  });
  const failures: string[] = [];
  for (const provider of order) {
    const apiKey = await input.credentials.get(webSearchCredentialKey(provider));
    if (!apiKey) continue;
    try {
      return respond(
        provider,
        await searchProvider(provider, apiKey, query, limit, includeImages, input.fetcher ?? fetch),
      );
    } catch (error) {
      failures.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(`All configured search providers failed. ${failures.join("; ")}`);
  // Reaching here means no key is configured; Firecrawl's free tier needs none.
  return respond(
    "firecrawl",
    await searchFirecrawl(null, query, limit, includeImages, input.fetcher ?? fetch),
  );
}
