import { z } from "zod";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { ModelOption, ModelProvider, RemoteModelProvider } from "@shared/contracts";
import {
  getModelProviderDefinition,
  modelProviderBaseUrlKey,
  modelProviderCredentialKey,
  modelProviderName,
} from "@shared/model-providers";
import type { CredentialStore } from "@main/security/credential-store";

export type ModelCatalogFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export const localModelCredentialMarker = "__coworker_local_provider__";

export interface ModelConnectionOptions {
  baseUrl?: string;
}

export interface RuntimeModelConfiguration {
  apiKey?: string;
  baseUrl?: string;
  supportsImages: boolean;
  contextWindow: number;
}

const openAiResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().optional(),
      type: z.string().optional(),
      architecture: z
        .object({ input_modalities: z.array(z.string()).optional() })
        .optional(),
      capabilities: z.array(z.string()).optional(),
    }),
  ),
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

const ollamaTagsSchema = z.object({
  models: z.array(
    z.object({
      name: z.string().min(1),
      model: z.string().optional(),
    }),
  ),
});

const ollamaShowSchema = z.object({
  capabilities: z.array(z.string()).optional().default([]),
});

const lmStudioResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      type: z.string().optional(),
      capabilities: z.array(z.string()).optional().default([]),
    }),
  ),
});

type BuiltInProvider = "anthropic" | "openai" | "google" | "openrouter";

function isBuiltInProvider(provider: ModelProvider): provider is BuiltInProvider {
  return ["anthropic", "openai", "google", "openrouter"].includes(provider);
}

function providerModels(provider: BuiltInProvider) {
  if (provider === "openai") return openaiProvider().getModels();
  if (provider === "anthropic") return anthropicProvider().getModels();
  if (provider === "google") return googleProvider().getModels();
  return openrouterProvider().getModels();
}

function supportedModels(provider: BuiltInProvider): readonly ModelOption[] {
  return providerModels(provider).map((model) => ({
    id: model.id,
    name: model.name,
    supportsImages: model.input.includes("image"),
  }));
}

export function modelSupportsImageInput(provider: ModelProvider, modelId: string): boolean {
  if (provider === "demo" || !isBuiltInProvider(provider)) return false;
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
  init: Omit<RequestInit, "headers" | "signal"> = {},
): Promise<unknown> {
  const label = modelProviderName(provider);
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      headers,
      method: init.method ?? "GET",
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
    throw new Error(`${modelProviderName(provider)} returned an invalid model-list response`);
  }
  return result.data;
}

function authorizationHeaders(apiKey: string): Record<string, string> {
  return apiKey && apiKey !== localModelCredentialMarker
    ? { Authorization: `Bearer ${apiKey}` }
    : {};
}

function normalizedBaseUrl(provider: RemoteModelProvider, configured?: string): string {
  const fallback = getModelProviderDefinition(provider).defaultBaseUrl;
  const value = configured?.trim() || fallback;
  if (!value) throw new Error(`Configure a base URL for ${modelProviderName(provider)} first`);
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function endpoint(baseUrl: string, relativePath: string): URL {
  return new URL(`${baseUrl.replace(/\/+$/, "")}/${relativePath.replace(/^\/+/, "")}`);
}

function nativeServerRoot(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function looksVisionCapable(modelId: string): boolean {
  return /(?:^|[-_.:/])(?:vision|vlm?|llava|bakllava|moondream)(?:$|[-_.:/])/i.test(modelId);
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

async function queryOpenRouterModels(
  apiKey: string,
  fetcher: ModelCatalogFetch,
): Promise<ModelOption[]> {
  const url = new URL("https://openrouter.ai/api/v1/models");
  url.searchParams.set("limit", "1000");
  const body = await requestJson(
    "openrouter",
    url,
    { Authorization: `Bearer ${apiKey}` },
    fetcher,
  );
  const parsed = parseResponse("openrouter", openAiResponseSchema, body);
  const available = new Set(parsed.data.map((model) => model.id));
  return supportedModels("openrouter").filter((model) => available.has(model.id));
}

async function queryOllamaModels(
  apiKey: string,
  baseUrl: string,
  fetcher: ModelCatalogFetch,
): Promise<ModelOption[]> {
  const root = nativeServerRoot(baseUrl);
  const headers = { "content-type": "application/json", ...authorizationHeaders(apiKey) };
  const body = await requestJson("ollama", endpoint(root, "api/tags"), headers, fetcher);
  const parsed = parseResponse("ollama", ollamaTagsSchema, body);
  return Promise.all(
    parsed.models.slice(0, 250).map(async (entry) => {
      const id = entry.model ?? entry.name;
      let supportsImages = looksVisionCapable(id);
      try {
        const details = await requestJson("ollama", endpoint(root, "api/show"), headers, fetcher, {
          method: "POST",
          body: JSON.stringify({ model: id }),
        });
        supportsImages = parseResponse("ollama", ollamaShowSchema, details).capabilities.includes(
          "vision",
        );
      } catch {
        // Older Ollama versions may not expose capabilities; retain the conservative name hint.
      }
      return { id, name: entry.name, supportsImages };
    }),
  );
}

async function queryLmStudioModels(
  apiKey: string,
  baseUrl: string,
  fetcher: ModelCatalogFetch,
): Promise<ModelOption[]> {
  const root = nativeServerRoot(baseUrl);
  const body = await requestJson(
    "lmstudio",
    endpoint(root, "api/v0/models"),
    authorizationHeaders(apiKey),
    fetcher,
  );
  const parsed = parseResponse("lmstudio", lmStudioResponseSchema, body);
  return parsed.data
    .filter((model) => !["embedding", "embeddings"].includes(model.type ?? ""))
    .map((model) => ({
      id: model.id,
      name: model.id,
      supportsImages:
        model.type === "vlm" ||
        model.capabilities.some((capability) => ["vision", "image"].includes(capability)) ||
        looksVisionCapable(model.id),
    }));
}

async function queryCompatibleModels(
  apiKey: string,
  baseUrl: string,
  fetcher: ModelCatalogFetch,
): Promise<ModelOption[]> {
  const body = await requestJson(
    "openai-compatible",
    endpoint(baseUrl, "models"),
    authorizationHeaders(apiKey),
    fetcher,
  );
  const parsed = parseResponse("openai-compatible", openAiResponseSchema, body);
  return parsed.data
    .filter((model) => !["embedding", "embeddings"].includes(model.type ?? ""))
    .map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      supportsImages:
        model.architecture?.input_modalities?.includes("image") === true ||
        model.capabilities?.some((capability) => ["vision", "image"].includes(capability)) ===
          true ||
        looksVisionCapable(model.id),
    }));
}

function sortModels(models: readonly ModelOption[]): ModelOption[] {
  return [...models].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );
}

export async function queryProviderModels(
  provider: RemoteModelProvider,
  apiKey: string,
  fetcher: ModelCatalogFetch = fetch,
  options: ModelConnectionOptions = {},
): Promise<ModelOption[]> {
  if (provider === "openrouter") {
    return sortModels(await queryOpenRouterModels(apiKey, fetcher));
  }
  if (provider === "ollama") {
    return sortModels(
      await queryOllamaModels(apiKey, normalizedBaseUrl(provider, options.baseUrl), fetcher),
    );
  }
  if (provider === "lmstudio") {
    return sortModels(
      await queryLmStudioModels(apiKey, normalizedBaseUrl(provider, options.baseUrl), fetcher),
    );
  }
  if (provider === "openai-compatible") {
    return sortModels(
      await queryCompatibleModels(apiKey, normalizedBaseUrl(provider, options.baseUrl), fetcher),
    );
  }

  const remoteIds =
    provider === "openai"
      ? await queryOpenAiModelIds(apiKey, fetcher)
      : provider === "anthropic"
        ? await queryAnthropicModelIds(apiKey, fetcher)
        : await queryGoogleModelIds(apiKey, fetcher);
  return sortModels(supportedModels(provider).filter((model) => remoteIds.has(model.id)));
}

async function configuredConnection(
  provider: RemoteModelProvider,
  credentials: CredentialStore,
): Promise<{ apiKey: string; baseUrl?: string }> {
  const apiKey = await credentials.get(modelProviderCredentialKey(provider));
  if (!apiKey) {
    throw new Error(`Configure ${modelProviderName(provider)} in Settings first`);
  }
  const definition = getModelProviderDefinition(provider);
  if (definition.baseUrlMode === "none") return { apiKey };
  const configuredBaseUrl = await credentials.get(modelProviderBaseUrlKey(provider));
  return {
    apiKey,
    baseUrl: normalizedBaseUrl(provider, configuredBaseUrl ?? undefined),
  };
}

export async function listAvailableModels(
  provider: ModelProvider,
  credentials: CredentialStore,
  fetcher: ModelCatalogFetch = fetch,
): Promise<ModelOption[]> {
  if (provider === "demo") {
    return [{ id: "faux-1", name: "Built-in demo", supportsImages: false }];
  }
  const connection = await configuredConnection(provider, credentials);
  return queryProviderModels(provider, connection.apiKey, fetcher, {
    baseUrl: connection.baseUrl,
  });
}

export async function getModelCapabilities(
  provider: ModelProvider,
  modelId: string,
  credentials: CredentialStore,
  fetcher: ModelCatalogFetch = fetch,
): Promise<{ supportsImages: boolean }> {
  if (provider === "demo" || isBuiltInProvider(provider)) {
    return { supportsImages: modelSupportsImageInput(provider, modelId) };
  }
  const models = await listAvailableModels(provider, credentials, fetcher);
  return { supportsImages: models.find((model) => model.id === modelId)?.supportsImages ?? false };
}

export async function getRuntimeModelConfiguration(
  provider: ModelProvider,
  modelId: string,
  credentials: CredentialStore,
): Promise<RuntimeModelConfiguration> {
  if (provider === "demo") {
    return { supportsImages: false, contextWindow: 128_000 };
  }
  const connection = await configuredConnection(provider, credentials);
  if (isBuiltInProvider(provider)) {
    const model = providerModels(provider).find((candidate) => candidate.id === modelId);
    if (!model) throw new Error(`Model ${modelId} is not available from ${modelProviderName(provider)}`);
    return {
      apiKey: connection.apiKey,
      supportsImages: model.input.includes("image"),
      contextWindow: model.contextWindow,
    };
  }
  const models = await queryProviderModels(provider, connection.apiKey, fetch, {
    baseUrl: connection.baseUrl,
  });
  const model = models.find((candidate) => candidate.id === modelId);
  if (!model) throw new Error(`Model ${modelId} is not available from ${modelProviderName(provider)}`);
  return {
    apiKey:
      connection.apiKey === localModelCredentialMarker ? undefined : connection.apiKey,
    baseUrl: connection.baseUrl,
    supportsImages: model.supportsImages,
    contextWindow: provider === "ollama" ? 128_000 : 32_768,
  };
}
