import {
  createProvider,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { redactProviderDiagnostic } from "./provider-error-logger";

export const chatGPTResponsesBaseUrl = "https://api.openai.com/v1";
export const chatGPTUsageLimitCode = "subscription_sharing_usage_limit_exceeded";

const unsupportedRequestFields = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_options",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "previous_response_id",
] as const;

export interface ChatGPTSubscriptionModelOptions {
  modelId: string;
  name?: string;
  supportsImages: boolean;
  contextWindow: number;
}

export interface ChatGPTProviderFailure extends Error {
  code?: string;
  status?: number;
}

export function createChatGPTSubscriptionModel(
  options: ChatGPTSubscriptionModelOptions,
): Model<"openai-responses"> {
  const contextWindow = Number.isFinite(options.contextWindow)
    ? Math.max(1_024, Math.floor(options.contextWindow))
    : 32_768;

  return {
    id: options.modelId,
    name: options.name ?? options.modelId,
    api: "openai-responses",
    provider: "openai",
    baseUrl: chatGPTResponsesBaseUrl,
    reasoning: false,
    input: options.supportsImages ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    // The subscription route disallows max_output_tokens, so this is only
    // Pi's local model metadata and never becomes a request limit.
    maxTokens: contextWindow,
    compat: {
      supportsDeveloperRole: true,
      supportsMidConvoSystemMessages: false,
      supportsLongCacheRetention: false,
      supportsStrictMode: false,
      supportsOpenAIGrammarTools: false,
      supportsAdditionalTools: false,
      supportsToolSearch: false,
      supportsExplicitPromptCacheMode: false,
      supportsMaxOutputTokens: false,
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function functionTools(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const result: Record<string, unknown>[] = [];
  for (const tool of value) {
    if (!isObject(tool)) continue;
    if (tool.type === "function" && typeof tool.name === "string") {
      result.push(tool);
    } else if (tool.type === "namespace" && Array.isArray(tool.tools)) {
      // A provider response can be replayed as history by Pi. Flatten its
      // function members before placing controlled tools in one stable namespace.
      result.push(...functionTools(tool.tools));
    }
  }
  return result;
}

/** Build the only request shape permitted for client-managed subscription history. */
export function restrictChatGPTSubscriptionPayload(payload: unknown): Record<string, unknown> {
  if (!isObject(payload) || !Array.isArray(payload.input)) {
    throw new Error("ChatGPT Responses requests require an input array.");
  }

  const safe: Record<string, unknown> = { ...payload, store: false, stream: true };
  for (const field of unsupportedRequestFields) delete safe[field];

  const tools = functionTools(payload.tools);
  const controlledNames = new Set(
    tools.flatMap((tool) => (typeof tool.name === "string" ? [tool.name] : [])),
  );
  safe.input = payload.input.map((item) => {
    if (!isObject(item)) return item;
    if (item.type === "message" && item.role === "system") {
      // Pi emits developer messages for reasoning models. Some account models
      // are non-reasoning, so normalize its leading system item here too.
      return { ...item, role: "developer" };
    }
    if (
      item.type === "function_call" &&
      typeof item.name === "string" &&
      controlledNames.has(item.name) &&
      item.namespace === undefined
    ) {
      // API-key history may contain Coworker calls created before the account
      // switched to subscription mode. Add the namespace only at the request
      // boundary so persisted call IDs, arguments, and checkpoints stay intact.
      return { ...item, namespace: "coworker" };
    }
    return item;
  });

  if (tools.length > 0) {
    safe.tools = [
      {
        type: "namespace",
        name: "coworker",
        description: "Coworker tools that run locally with the user's permissions.",
        tools,
      },
    ];
  } else {
    delete safe.tools;
  }
  // Hosted and deferred tools are not exposed by this adapter. Coworker's
  // agent owns its complete history and executes the controlled functions.
  delete safe.additional_tools;
  return safe;
}

function readFailureCode(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.code === "string") return value.code;
  const nested = value.error;
  if (isObject(nested) && typeof nested.code === "string") return nested.code;
  const response = value.response;
  if (isObject(response)) {
    const responseError = response.error;
    if (isObject(responseError) && typeof responseError.code === "string") {
      return responseError.code;
    }
  }
  return undefined;
}

function readFailureStatus(value: unknown): number | undefined {
  if (!isObject(value)) return undefined;
  const status = value.status ?? value.statusCode;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

export function formatChatGPTSubscriptionFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code =
    readFailureCode(error) ??
    raw.match(/\bsubscription_sharing_[a-z0-9_]+\b/)?.[0];
  const status =
    readFailureStatus(error) ??
    raw.match(/\b(?:HTTP\s*)?(\d{3})\b/i)?.[1];
  if (code === chatGPTUsageLimitCode) {
    const statusSuffix = status ? ", " + status : "";
    return "ChatGPT usage limit reached (" + chatGPTUsageLimitCode + statusSuffix +
      "). Manage usage in ChatGPT Settings → Usage.";
  }
  if (code === "subscription_sharing_user_not_eligible") {
    const statusSuffix = status ? ", " + status : "";
    return "ChatGPT plan usage is unavailable for this account or workspace (" + code +
      statusSuffix + "). Check the selected account and its usage permissions.";
  }
  const sanitized = redactProviderDiagnostic(raw).trim();
  const statusText = status ? " (" + status + ")" : "";
  const codeText = code && !sanitized.includes(code) ? " " + code : "";
  return ((sanitized || "ChatGPT plan request failed") + statusText + codeText).slice(0, 2_000);
}

export function createChatGPTSubscriptionFailure(
  message: string,
  code: string,
  status?: number,
): ChatGPTProviderFailure {
  const failure = new Error(message) as ChatGPTProviderFailure;
  failure.name = "ChatGPTSubscriptionError";
  failure.code = code;
  if (status !== undefined) failure.status = status;
  return failure;
}

/** Fail terminal events that Pi otherwise represents as a usable partial reply. */
export function chatGPTSubscriptionTerminalFailure(value: unknown): Error | null {
  if (typeof value !== "object" || value === null || !("type" in value)) return null;
  if (value.type === "response.incomplete") {
    const details =
      "response" in value && typeof value.response === "object" && value.response !== null &&
      "incomplete_details" in value.response
        ? value.response.incomplete_details
        : undefined;
    const reason =
      typeof details === "object" && details !== null && "reason" in details &&
      typeof details.reason === "string"
        ? details.reason
        : "unknown";
    return createChatGPTSubscriptionFailure(
      "ChatGPT response was incomplete (" + reason + "). Retry the task.",
      "response.incomplete",
    );
  }
  if (value.type === "response.failed") {
    const response =
      "response" in value && typeof value.response === "object" && value.response !== null
        ? value.response
        : undefined;
    const detail =
      response && "error" in response && typeof response.error === "object" && response.error !== null
        ? response.error
        : undefined;
    const code =
      detail && "code" in detail && typeof detail.code === "string" ? detail.code : "response.failed";
    const message =
      detail && "message" in detail && typeof detail.message === "string"
        ? detail.message
        : "ChatGPT request failed.";
    return createChatGPTSubscriptionFailure(code + ": " + message, code);
  }
  return null;
}

export function createChatGPTSubscriptionProvider(
  model: Model<"openai-responses">,
): Provider<"openai-responses"> {
  return createProvider({
    id: "openai",
    name: "OpenAI",
    baseUrl: chatGPTResponsesBaseUrl,
    // An explicit per-inference key is required. The resolver has no ambient
    // env lookup, and the worker rejects an absent token before streamSimple.
    auth: {
      apiKey: {
        name: "ChatGPT subscription token",
        async resolve({ credential }) {
          return {
            auth: {
              apiKey:
                credential?.type === "api_key" && credential.key
                  ? credential.key
                  : "",
            },
            source: "per-inference ChatGPT sign-in",
          };
        },
      },
    },
    models: [model],
    api: openAIResponsesApi(),
  });
}
