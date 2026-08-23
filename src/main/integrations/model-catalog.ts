import { z } from "zod";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type {
  ModelOption,
  ModelProvider,
  RemoteModelProvider,
} from "@shared/contracts";
import type { CredentialStore } from "@main/security/credential-store";

export type ModelCatalogFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

const openAiResponseSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) })),
});

const anthropicResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      display_name: z.string().optional(),
    }),
  ),
  has_more: z.boolean().optional().default(false),
  last_id: z.string().nullable().optional(),
});

const googleResponseSchema = z.object({
  models: z
    .array(
      z.object({
        name: z.string().min(1),
        displayName: z.string().optional(),
        supportedGenerationMethods: z.array(z.string()).optional(),
      }),
    )
    .optional()
    .default([]),
  nextPageToken: z.string().optional(),
});

function providerName(provider: RemoteModelProvider): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "anthropic") return "Anthropic";
  return "Google";
}

function providerModels(provider: RemoteModelProvider) {
  return (
    provider === "openai"
      ? openaiProvider().getModels()
      : provider === "anthropic"
        ? anthropicProvider().getModels()
        : googleProvider().getModels()
  );
}

function supportedModels(provider: RemoteModelProvider): readonly ModelOption[] {
  return providerModels(provider).map((model) => ({
    id: model.id,
    name: model.name,
    supportsImages: model.input.includes("image"),
  }));
}

export function modelSupportsImageInput(provider: ModelProvider, modelId: string): boolean {
  if (provider === "demo") return false;
  return (
    providerModels(provider).find((model) => model.id === modelId)?.input.includes("image") ?? false
  );
}

function errorMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const error = "error" in body ? body.error : null;
  if (error && typeof error === "object" && "message" in error) {
    const message = error.message;
    if (typeof message === "string" && message.trim()) return message.trim().slice(0, 300);
  }
  return null;
}

async function requestJson(
  provider: RemoteModelProvider,
  url: URL,
  headers: Record<string, string>,
  fetcher: ModelCatalogFetch,
): Promise<unknown> {
  const label = providerName(provider);
  let response: Response;
  try {
    response = await fetcher(url, {
      headers,
      method: "GET",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const detail =
      error instanceof Error && error.name === "TimeoutError"
        ? "the request timed out"
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`Could not query ${label} models: ${detail}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${label} returned an invalid model-list response`);
  }
  if (!response.ok) {
    const detail = errorMessage(body);
    throw new Error(
      `Could not query ${label} models (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  return body;
}

function parseResponse<T>(
  provider: RemoteModelProvider,
  schema: z.ZodType<T>,
  body: unknown,
): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new Error(`${providerName(provider)} returned an invalid model-list response`);
  }
  return result.data;
}

async function queryOpenAiModelIds(
  apiKey: string,
  fetcher: ModelCatalogFetch,
): Promise<Set<string>> {
  const body = await requestJson(
    "openai",
    new URL("https://api.openai.com/v1/models"),
    { Authorization: `Bearer ${apiKey}` },
    fetcher,
  );
  const parsed = parseResponse("openai", openAiResponseSchema, body);
  return new Set(parsed.data.map((model) => model.id));
}

async function queryAnthropicModelIds(
  apiKey: string,
  fetcher: ModelCatalogFetch,
): Promise<Set<string>> {
  const ids = new Set<string>();
  let afterId: string | undefined;

  for (let page = 0; page < 10; page += 1) {
    const url = new URL("https://api.anthropic.com/v1/models");
    url.searchParams.set("limit", "1000");
    if (afterId) url.searchParams.set("after_id", afterId);
    const body = await requestJson(
      "anthropic",
      url,
      {
        "anthropic-version": "2023-06-01",
        "x-api-key": apiKey,
      },
      fetcher,
    );
    const parsed = parseResponse("anthropic", anthropicResponseSchema, body);
    for (const model of parsed.data) ids.add(model.id);
    if (!parsed.has_more || !parsed.last_id || parsed.last_id === afterId) break;
    afterId = parsed.last_id;
  }

  return ids;
}

async function queryGoogleModelIds(
  apiKey: string,
  fetcher: ModelCatalogFetch,
): Promise<Set<string>> {
  const ids = new Set<string>();
  let pageToken: string | undefined;

  for (let page = 0; page < 10; page += 1) {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const body = await requestJson(
      "google",
      url,
      { "x-goog-api-key": apiKey },
      fetcher,
    );
    const parsed = parseResponse("google", googleResponseSchema, body);
    for (const model of parsed.models) {
      if (!model.supportedGenerationMethods?.includes("generateContent")) continue;
      ids.add(model.name.startsWith("models/") ? model.name.slice("models/".length) : model.name);
    }
    if (!parsed.nextPageToken || parsed.nextPageToken === pageToken) break;
    pageToken = parsed.nextPageToken;
  }

  return ids;
}

export async function queryProviderModels(
  provider: RemoteModelProvider,
  apiKey: string,
  fetcher: ModelCatalogFetch = fetch,
): Promise<ModelOption[]> {
  const remoteIds =
    provider === "openai"
      ? await queryOpenAiModelIds(apiKey, fetcher)
      : provider === "anthropic"
        ? await queryAnthropicModelIds(apiKey, fetcher)
        : await queryGoogleModelIds(apiKey, fetcher);

  return supportedModels(provider)
    .filter((model) => remoteIds.has(model.id))
    .sort((left, right) =>
      left.name.localeCompare(right.name, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
}

export async function listAvailableModels(
  provider: ModelProvider,
  credentials: CredentialStore,
  fetcher: ModelCatalogFetch = fetch,
): Promise<ModelOption[]> {
  if (provider === "demo") {
    return [{ id: "faux-1", name: "Built-in demo", supportsImages: false }];
  }

  const apiKey = await credentials.get(`model:${provider}`);
  if (!apiKey) {
    throw new Error(`Configure a ${providerName(provider)} API key in Settings first`);
  }
  return queryProviderModels(provider, apiKey, fetcher);
}
