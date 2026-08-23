import type { ModelProvider, RemoteModelProvider } from "./contracts";

export interface ModelProviderDefinition {
  id: ModelProvider;
  label: string;
  apiKeyRequired: boolean;
  baseUrlMode: "none" | "optional" | "required";
  defaultBaseUrl?: string;
  apiKeyPlaceholder: string;
}

export const modelProviderDefinitions: readonly ModelProviderDefinition[] = [
  {
    id: "demo",
    label: "Built-in demo",
    apiKeyRequired: false,
    baseUrlMode: "none",
    apiKeyPlaceholder: "",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    apiKeyRequired: true,
    baseUrlMode: "none",
    apiKeyPlaceholder: "sk-ant-…",
  },
  {
    id: "openai",
    label: "OpenAI",
    apiKeyRequired: true,
    baseUrlMode: "none",
    apiKeyPlaceholder: "sk-…",
  },
  {
    id: "google",
    label: "Google",
    apiKeyRequired: true,
    baseUrlMode: "none",
    apiKeyPlaceholder: "Google AI API key",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    apiKeyRequired: true,
    baseUrlMode: "none",
    apiKeyPlaceholder: "sk-or-v1-…",
  },
  {
    id: "ollama",
    label: "Ollama",
    apiKeyRequired: false,
    baseUrlMode: "optional",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    apiKeyPlaceholder: "Optional API key",
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    apiKeyRequired: false,
    baseUrlMode: "optional",
    defaultBaseUrl: "http://127.0.0.1:1234/v1",
    apiKeyPlaceholder: "Optional API token",
  },
  {
    id: "openai-compatible",
    label: "OpenAI-compatible",
    apiKeyRequired: false,
    baseUrlMode: "required",
    apiKeyPlaceholder: "Optional API key",
  },
] as const;

export const remoteModelProviderDefinitions = modelProviderDefinitions.filter(
  (provider): provider is ModelProviderDefinition & { id: RemoteModelProvider } =>
    provider.id !== "demo",
);

export function getModelProviderDefinition(provider: ModelProvider): ModelProviderDefinition {
  const definition = modelProviderDefinitions.find((candidate) => candidate.id === provider);
  if (!definition) throw new Error(`Unsupported model provider: ${provider}`);
  return definition;
}

export function modelProviderName(provider: ModelProvider): string {
  return getModelProviderDefinition(provider).label;
}

export function modelProviderCredentialKey(provider: RemoteModelProvider): string {
  return `model:${provider}`;
}

export function modelProviderBaseUrlKey(provider: RemoteModelProvider): string {
  return `${modelProviderCredentialKey(provider)}:base-url`;
}
