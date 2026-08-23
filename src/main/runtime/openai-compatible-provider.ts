import {
  createProvider,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { RemoteModelProvider } from "@shared/contracts";
import { modelProviderName } from "@shared/model-providers";

export interface OpenAiCompatibleRuntimeProviderInput {
  provider: Extract<RemoteModelProvider, "ollama" | "lmstudio" | "openai-compatible">;
  modelId: string;
  baseUrl: string;
  apiKey?: string;
  supportsImages: boolean;
  contextWindow: number;
}

export function createOpenAiCompatibleRuntimeProvider(
  input: OpenAiCompatibleRuntimeProviderInput,
): Provider<"openai-completions"> {
  const fallbackApiKey = input.apiKey || "local";
  const model: Model<"openai-completions"> = {
    id: input.modelId,
    name: input.modelId,
    api: "openai-completions",
    provider: input.provider,
    baseUrl: input.baseUrl,
    reasoning: false,
    input: input.supportsImages ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: input.contextWindow,
    maxTokens: Math.min(16_384, input.contextWindow),
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: false,
      supportsStrictMode: false,
      maxTokensField: "max_tokens",
    },
  };

  return createProvider({
    id: input.provider,
    name: modelProviderName(input.provider),
    baseUrl: input.baseUrl,
    auth: {
      apiKey: {
        name: `${modelProviderName(input.provider)} API key`,
        async resolve({ credential }) {
          const apiKey =
            credential?.type === "api_key" && credential.key ? credential.key : fallbackApiKey;
          return {
            auth: { apiKey },
            source: input.apiKey ? "Stored API key" : "Local provider",
          };
        },
      },
    },
    models: [model],
    api: openAICompletionsApi(),
  });
}
