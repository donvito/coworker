import { z } from "zod";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { ModelOption, ModelProvider, RemoteModelProvider } from "@shared/contracts";
import {
  getModelProviderDefinition,
  isModelEndpointProvider,
  modelProviderBaseUrlKey,
  modelProviderCredentialKey,
  modelProviderName,
} from "@shared/model-providers";
import type { CredentialStore } from "@main/security/credential-store";
import type { ChatGPTAuthService } from "@main/security/chatgpt-auth";
import type { OpenAIAuthMode } from "@shared/chatgpt-auth";
import { redactProviderDiagnostic } from "@main/runtime/provider-error-logger";

export type ModelCatalogFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export const localModelCredentialMarker = "__coworker_local_provider__";

export interface ModelConnectionOptions {
  baseUrl?: string;
}

export interface RuntimeModelConfiguration {
  /** OpenAI's selected sign-in path; subscription tokens are resolved per request. */
  authMode: OpenAIAuthMode;
  /** Bound identity for subscription token requests; null for API-key and other providers. */
  chatgptAccountId: string | null;
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
      pricing: z
        .object({
          prompt: z.union([z.string(), z.number()]).optional(),
          completion: z.union([z.string(), z.number()]).optional(),
          request: z.union([z.string(), z.number()]).optional(),
        })
        .optional(),
    }),
  ),
});

const chatgptSubscriptionModelsSchema = z.object({
  models: z.array(
    z.object({
      slug: z.string().min(1),
      display_name: z.string().min(1),
      visibility: z.string(),
    }).passthrough(),
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

function requestFailureDetail(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") return "the request timed out";
  return error instanceof Error ? error.message : String(error);
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
    throw new Error(`Could not query ${label} models: ${requestFailureDetail(error)}`);
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
  // Coworkers always expose controlled tools to their model. OpenRouter's catalog
  // changes independently of Pi's generated catalog, so require current tool
  // support as well as a matching Pi runtime definition.
  url.searchParams.set("supported_parameters", "tools");
  const body = await requestJson(
    "openrouter",
    url,
    { Authorization: `Bearer ${apiKey}` },
    fetcher,
  );
  const parsed = parseResponse("openrouter", openAiResponseSchema, body);
  const available = new Map(parsed.data.map((model) => [model.id, model]));
  return supportedModels("openrouter").flatMap((model) => {
    const liveModel = available.get(model.id);
    if (!liveModel) return [];
    const inputPerMillion = pricePerMillion(liveModel.pricing?.prompt);
    const outputPerMillion = pricePerMillion(liveModel.pricing?.completion);
    const request = price(liveModel.pricing?.request);
    const hasPricing =
      inputPerMillion !== undefined || outputPerMillion !== undefined || request !== undefined;
    return [
      {
        ...model,
        ...(hasPricing
          ? {
              pricing: {
                currency: "USD" as const,
                ...(inputPerMillion === undefined ? {} : { inputPerMillion }),
                ...(outputPerMillion === undefined ? {} : { outputPerMillion }),
                ...(request === undefined ? {} : { request }),
              },
            }
          : {}),
      },
    ];
  });
}

/**
 * OpenRouter's model list is public and answers any bearer token, so it cannot
 * tell a mistyped key from a real one. The key endpoint authenticates it.
 */
async function verifyOpenRouterKey(apiKey: string, fetcher: ModelCatalogFetch): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(new URL("https://openrouter.ai/api/v1/key"), {
      headers: { Authorization: `Bearer ${apiKey}` },
      method: "GET",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(`Could not verify the OpenRouter API key: ${requestFailureDetail(error)}`);
  }
  if (response.ok) return;
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      'OpenRouter did not accept this API key. Copy the full key from openrouter.ai/settings/keys; it starts with "sk-or-".',
    );
  }
  const detail = errorMessage(await response.json().catch(() => null));
  throw new Error(
    `Could not verify the OpenRouter API key (${response.status})${detail ? `: ${detail}` : ""}`,
  );
}

function price(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function pricePerMillion(value: string | number | undefined): number | undefined {
  const parsed = price(value);
  return parsed === undefined ? undefined : parsed * 1_000_000;
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
  provider: RemoteModelProvider,
  apiKey: string,
  baseUrl: string,
  fetcher: ModelCatalogFetch,
): Promise<ModelOption[]> {
  const body = await requestJson(
    provider,
    endpoint(baseUrl, "models"),
    authorizationHeaders(apiKey),
    fetcher,
  );
  const parsed = parseResponse(provider, openAiResponseSchema, body);
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

/** Rejects a key that listing models alone would accept. */
export async function verifyModelCredential(
  provider: RemoteModelProvider,
  apiKey: string,
  fetcher: ModelCatalogFetch = fetch,
): Promise<void> {
  if (provider === "openrouter") await verifyOpenRouterKey(apiKey, fetcher);
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
  if (isModelEndpointProvider(provider)) {
    return sortModels(
      await queryCompatibleModels(
        provider,
        apiKey,
        normalizedBaseUrl(provider, options.baseUrl),
        fetcher,
      ),
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

/** The subscription catalog is account scoped and intentionally preserves server order. */
async function queryChatgptSubscriptionModels(
  auth: ChatGPTAuthService,
  fetcher: ModelCatalogFetch,
): Promise<ModelOption[]> {
  let accessToken: string | undefined;
  try {
    const status = await auth.status();
    if (status.mode !== "chatgpt-subscription") {
      throw new Error("Choose ChatGPT subscription sign-in to use this model catalog");
    }
    if (status.state !== "connected" || !status.activeAccountId) {
      throw new Error("Connect a ChatGPT account before choosing a model");
    }
    accessToken = await auth.getAccessToken(status.activeAccountId);
    const body = await requestJson(
      "openai",
      new URL("https://api.openai.com/v1/models"),
      { Authorization: `Bearer ${accessToken}` },
      fetcher,
    );
    const parsed = parseResponse("openai", chatgptSubscriptionModelsSchema, body);
    return parsed.models
      .filter((model) => model.visibility === "list")
      .map((model) => {
        // Server availability is authoritative; bundled metadata only adds capabilities
        // when the exact returned slug is known to this version of Pi.
        const known = providerModels("openai").find((candidate) => candidate.id === model.slug);
        return {
          id: model.slug,
          name: model.display_name,
          supportsImages: known?.input.includes("image") ?? false,
        };
      });
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const redacted = redactProviderDiagnostic(raw)
      .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,"'}]+/gi, "$1[REDACTED]")
      .replace(/(bearer\s+)[^\s,"'}]+/gi, "$1[REDACTED]");
    const safeMessage = accessToken ? redacted.replaceAll(accessToken, "[REDACTED]") : redacted;
    throw new Error(safeMessage);
  }
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
  chatgptAuth?: ChatGPTAuthService,
): Promise<ModelOption[]> {
  if (provider === "demo") {
    return [{ id: "faux-1", name: "Built-in demo", supportsImages: false }];
  }
  if (provider === "openai" && chatgptAuth && (await chatgptAuth.status()).mode === "chatgpt-subscription") {
    return queryChatgptSubscriptionModels(chatgptAuth, fetcher);
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
  chatgptAuth?: ChatGPTAuthService,
): Promise<{ supportsImages: boolean }> {
  if (provider === "openai" && chatgptAuth && (await chatgptAuth.status()).mode === "chatgpt-subscription") {
    const models = await queryChatgptSubscriptionModels(chatgptAuth, fetcher);
    const selected = models.find((model) => model.id === modelId);
    if (!selected) {
      throw new Error(`Model ${modelId} is not available to the selected ChatGPT account. Choose a listed model.`);
    }
    return { supportsImages: selected.supportsImages };
  }
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
  chatgptAuth?: ChatGPTAuthService,
  fetcher: ModelCatalogFetch = fetch,
): Promise<RuntimeModelConfiguration> {
  if (provider === "demo") {
    return { authMode: "api-key", chatgptAccountId: null, supportsImages: false, contextWindow: 128_000 };
  }
  if (provider === "openai" && chatgptAuth && (await chatgptAuth.status()).mode === "chatgpt-subscription") {
    const status = await chatgptAuth.status();
    const models = await queryChatgptSubscriptionModels(chatgptAuth, fetcher);
    if (!models.some((model) => model.id === modelId)) {
      throw new Error(`Model ${modelId} is not available to the selected ChatGPT account. Choose a listed model.`);
    }
    return {
      authMode: "chatgpt-subscription",
      chatgptAccountId: status.activeAccountId,
      supportsImages: providerModels("openai").find((model) => model.id === modelId)?.input.includes("image") ?? false,
      contextWindow: providerModels("openai").find((model) => model.id === modelId)?.contextWindow ?? 32_768,
    };
  }
  const connection = await configuredConnection(provider, credentials);
  if (isBuiltInProvider(provider)) {
    const model = providerModels(provider).find((candidate) => candidate.id === modelId);
    if (!model) throw new Error(`Model ${modelId} is not available from ${modelProviderName(provider)}`);
    return {
      authMode: "api-key",
      chatgptAccountId: null,
      apiKey: connection.apiKey,
      supportsImages: model.input.includes("image"),
      contextWindow: model.contextWindow,
    };
  }
  const models = await queryProviderModels(provider, connection.apiKey, fetcher, {
    baseUrl: connection.baseUrl,
  });
  const model = models.find((candidate) => candidate.id === modelId);
  if (!model) throw new Error(`Model ${modelId} is not available from ${modelProviderName(provider)}`);
  return {
    authMode: "api-key",
    chatgptAccountId: null,
    apiKey:
      connection.apiKey === localModelCredentialMarker ? undefined : connection.apiKey,
    baseUrl: connection.baseUrl,
    supportsImages: model.supportsImages,
    contextWindow: provider === "ollama" ? 128_000 : 32_768,
  };
}
